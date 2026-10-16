"""PV-Sammler: liest SMA-Geräte im Heimnetz (nur lesend) und schreibt nach Firebase.

Quellen
- Sunny Tripower (Modbus TCP): PV-Leistung, Tagesertrag
- Sunny Island (Modbus TCP): Batterie-Leistung, Ladestand, Temperatur, Lade-/Entladezähler
- Energy Meter (Speedwire-Multicast 239.12.255.254:9522): Netzbezug/Einspeisung live + Zähler

Ziele in Firestore
- live/current          alle LIVE_S Sekunden
- days/{JJJJ-MM-TT}     alle POINT_S Sekunden ein gemittelter Punkt + Tagessummen
- months/{JJJJ-MM}      Tagessummen je Tag (für Monats-/Jahresansicht)

Es werden ausschliesslich Lese-Funktionen (Modbus FC 0x04) verwendet.
"""
import json, logging, os, signal, socket, struct, threading, time
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.getenv("TZ", "Europe/Berlin"))
PV_IP = os.getenv("PV_IP", "192.168.178.104")
BAT_IP = os.getenv("BAT_IP", "192.168.178.92")
METER_IP = os.getenv("METER_IP", "192.168.178.103")
POLL_S = int(os.getenv("POLL_S", "5"))
LIVE_S = int(os.getenv("LIVE_S", "15"))
POINT_S = int(os.getenv("POINT_S", "300"))
DRY_RUN = os.getenv("DRY_RUN") == "1"
CRED = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "/run/secrets/service-account.json")

log = logging.getLogger("pv")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

# ---------- Modbus (nur lesen) ----------
_tid = 0

def mb_read(ip, reg, count):
    global _tid
    _tid = (_tid + 1) & 0xFFFF
    req = struct.pack(">HHHBBHH", _tid, 0, 6, 3, 0x04, reg, count)
    with socket.create_connection((ip, 502), timeout=3) as s:
        s.sendall(req)
        resp = b""
        while len(resp) < 9 + 2 * count:
            chunk = s.recv(256)
            if not chunk:
                break
            resp += chunk
            if len(resp) >= 9 and resp[7] & 0x80:
                break
    if len(resp) < 9 or resp[7] & 0x80:
        raise IOError(f"Modbus-Fehler {ip}:{reg}")
    return resp[9:9 + resp[8]]

NAN = {(">i", 0x80000000), (">I", 0xFFFFFFFF), (">I", 0x80000000), (">Q", 0xFFFFFFFFFFFFFFFF), (">Q", 0x8000000000000000)}

def val(ip, reg, fmt):
    n = {">i": 2, ">I": 2, ">Q": 4}[fmt]
    b = mb_read(ip, reg, n)
    raw = struct.unpack(">I" if fmt == ">i" else fmt, b)[0]
    if (fmt, raw) in NAN or (fmt == ">i" and raw == 0x80000000):
        return None
    return struct.unpack(fmt, b)[0]

def read_devices():
    d = {}
    try:
        d["pv_w"] = max(0, val(PV_IP, 30775, ">i") or 0)  # nachts NaN -> 0
        d["pv_day_wh"] = val(PV_IP, 30535, ">I")
        d["pv_total_wh"] = val(PV_IP, 30529, ">I")
    except Exception as e:
        log.warning("Tripower nicht lesbar: %s", e)
    try:
        ac = val(BAT_IP, 30775, ">i")
        d["bat_w"] = ac  # positiv = Entladen, negativ = Laden
        d["soc"] = val(BAT_IP, 30845, ">I")
        t = val(BAT_IP, 30849, ">i")
        d["bat_temp"] = None if t is None else t / 10
        d["bat_health"] = val(BAT_IP, 30847, ">I")
        d["bat_in_wh"] = val(BAT_IP, 31397, ">Q")
        d["bat_out_wh"] = val(BAT_IP, 31401, ">Q")
    except Exception as e:
        log.warning("Sunny Island nicht lesbar: %s", e)
    return d

# ---------- Energy Meter (Multicast mithören) ----------
meter = {"ts": 0}

def meter_listener():
    while True:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if hasattr(socket, "SO_REUSEPORT"):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            s.bind(("0.0.0.0", 9522))
            s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                         struct.pack("4s4s", socket.inet_aton("239.12.255.254"), socket.inet_aton("0.0.0.0")))
            s.settimeout(30)
            while True:
                data, addr = s.recvfrom(2048)
                if addr[0] != METER_IP or data[:3] != b"SMA":
                    continue
                vals, i = {}, 28
                while i + 4 <= len(data):
                    idx, typ = data[i + 1], data[i + 2]
                    i += 4
                    if typ == 4:
                        vals[(idx, 4)] = struct.unpack(">I", data[i:i + 4])[0]; i += 4
                    elif typ == 8:
                        vals[(idx, 8)] = struct.unpack(">Q", data[i:i + 8])[0]; i += 8
                    else:
                        break
                if (1, 4) in vals and (2, 4) in vals:
                    meter.update(ts=time.time(),
                                 grid_in_w=vals[(1, 4)] / 10, grid_out_w=vals[(2, 4)] / 10,
                                 grid_in_wh=vals.get((1, 8), 0) / 3600, grid_out_wh=vals.get((2, 8), 0) / 3600)
        except socket.timeout:
            log.warning("Energy Meter: 30 s keine Daten")
        except Exception as e:
            log.warning("Energy Meter Fehler: %s", e)
            time.sleep(5)

# ---------- Firestore ----------
class Store:
    def __init__(self):
        if DRY_RUN:
            self.db = None
            return
        import firebase_admin
        from firebase_admin import credentials, firestore
        firebase_admin.initialize_app(credentials.Certificate(CRED))
        self.fs = firestore
        self.db = firestore.client()

    def get(self, path):
        if not self.db:
            return {}
        snap = self.db.document(path).get()
        return snap.to_dict() or {}

    def set(self, path, data, merge=False):
        if not self.db:
            log.info("DRY %s %s", path, json.dumps(data, default=str)[:300])
            return
        self.db.document(path).set(data, merge=merge)

    def append_point(self, path, point, extra):
        if not self.db:
            log.info("DRY %s +Punkt %s %s", path, point, extra)
            return
        self.db.document(path).set({**extra, "points": self.fs.ArrayUnion([point])}, merge=True)

# ---------- Hauptschleife ----------
COUNTERS = ("grid_in_wh", "grid_out_wh", "bat_in_wh", "bat_out_wh", "pv_total_wh")

def r1(x):
    return None if x is None else round(x, 1)

def main():
    store = Store()
    threading.Thread(target=meter_listener, daemon=True).start()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *a: stop.set())

    day, start, acc = None, {}, []
    last_live = last_point = 0
    log.info("Sammler gestartet (DRY_RUN=%s)", DRY_RUN)
    while not stop.is_set():
        now = time.time()
        dt = datetime.now(TZ)
        d = read_devices()
        m = dict(meter) if now - meter.get("ts", 0) < 30 else {}
        d.update({k: v for k, v in m.items() if k != "ts"})

        grid = None
        if "grid_in_w" in d:
            grid = d["grid_in_w"] - d["grid_out_w"]  # positiv = Bezug, negativ = Einspeisung
        house = None
        if grid is not None and "pv_w" in d and d.get("bat_w") is not None:
            house = max(0, d["pv_w"] + d["bat_w"] + grid)
        d["grid_w"], d["house_w"] = grid, house

        # Tageswechsel: Startzähler aus dem Tagesdokument holen oder neu setzen
        key = dt.strftime("%Y-%m-%d")
        if key != day:
            start = store.get(f"days/{key}").get("start", {})
            day, acc = key, []
            log.info("Tag %s, Startzähler aus Firestore %s", key, start)
        # Fehlende Startzähler nachtragen (z. B. Energy Meter erst später erreichbar)
        missing = {k: d[k] for k in COUNTERS if k in d and k not in start}
        if missing:
            start.update(missing)
            start.setdefault("m", dt.hour * 60 + dt.minute)  # >15: Tag erst ab dieser Minute gezählt
            if any(k.startswith("grid") for k in missing) and start["m"] < dt.hour * 60 + dt.minute:
                start["m"] = dt.hour * 60 + dt.minute
            try:
                store.set(f"days/{key}", {"date": key, "start": start}, merge=True)
                log.info("Startzähler ergänzt: %s", missing)
            except Exception as e:
                log.warning("Startzähler schreiben fehlgeschlagen: %s", e)

        acc.append(d)

        totals = {}
        if d.get("pv_day_wh") is not None:
            totals["pv"] = d["pv_day_wh"]
        for k, name in (("grid_in_wh", "grid_in"), ("grid_out_wh", "grid_out"), ("bat_in_wh", "bat_in"), ("bat_out_wh", "bat_out")):
            if k in d and k in start:
                totals[name] = round(d[k] - start[k])
        if all(k in totals for k in ("pv", "grid_in", "grid_out", "bat_in", "bat_out")):
            totals["house"] = max(0, totals["pv"] + totals["grid_in"] - totals["grid_out"] + totals["bat_out"] - totals["bat_in"])

        if now - last_live >= LIVE_S:
            last_live = now
            live = {k: d.get(k) for k in ("pv_w", "bat_w", "grid_w", "house_w", "soc", "bat_temp", "bat_health")}
            live = {k: r1(v) for k, v in live.items()}
            live.update(ts=int(now), day=key, today=totals,
                        pv_total_kwh=r1((d.get("pv_total_wh") or 0) / 1000),
                        today_since=start.get("m", 0), meter_ok=bool(m))
            try:
                store.set("live/current", live)
            except Exception as e:
                log.warning("Live schreiben fehlgeschlagen: %s", e)

        if now - last_point >= POINT_S and acc:
            last_point = now
            def avg(k):
                xs = [x[k] for x in acc if x.get(k) is not None]
                return round(sum(xs) / len(xs)) if xs else None
            point = {"m": dt.hour * 60 + dt.minute, "pv": avg("pv_w"), "bat": avg("bat_w"),
                     "grid": avg("grid_w"), "house": avg("house_w"), "soc": avg("soc")}
            acc = []
            try:
                store.append_point(f"days/{key}", point, {"date": key, "totals": totals})
                store.set(f"months/{key[:7]}", {"days": {key[8:]: totals}}, merge=True)
            except Exception as e:
                log.warning("Verlauf schreiben fehlgeschlagen: %s", e)

        stop.wait(max(0.5, POLL_S - (time.time() - now)))

if __name__ == "__main__":
    main()
