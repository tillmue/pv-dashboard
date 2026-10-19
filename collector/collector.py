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
import json, logging, os, signal, socket, struct, threading, time, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.getenv("TZ", "Europe/Berlin"))
PV_IP = os.getenv("PV_IP", "192.168.178.104")
BAT_IP = os.getenv("BAT_IP", "192.168.178.92")
METER_IP = os.getenv("METER_IP", "192.168.178.103")
POLL_S = int(os.getenv("POLL_S", "10"))
LIVE_S = int(os.getenv("LIVE_S", "15"))
POINT_S = int(os.getenv("POINT_S", "300"))
DRY_RUN = os.getenv("DRY_RUN") == "1"
LAT = float(os.getenv("LAT", "52.27"))
LON = float(os.getenv("LON", "8.05"))
KWP = float(os.getenv("KWP", "4.0"))
TILT = int(os.getenv("TILT", "45"))
AZIMUTH = int(os.getenv("AZIMUTH", "45"))  # Open-Meteo: 0 = Sued, 45 = Suedwest
PR = float(os.getenv("PR", "0.85"))        # Performance Ratio (Verluste)
AC_MAX = int(os.getenv("AC_MAX", "4000"))
BAT_KWH = float(os.getenv("BAT_KWH", "9.02"))
CRED = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "/run/secrets/service-account.json")

log = logging.getLogger("pv")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")

# ---------- Modbus (nur lesen) ----------
# Pro Gerät und Durchlauf genau EINE TCP-Verbindung, danach sofort schliessen,
# damit die gridBox (steuert die Anlage ebenfalls per Modbus) nie um Verbindungen konkurrieren muss.
_tid = 0

class Device:
    def __init__(self, ip):
        self.s = socket.create_connection((ip, 502), timeout=3)
        self.ip = ip

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.s.close()

    def read(self, reg, count):
        global _tid
        _tid = (_tid + 1) & 0xFFFF
        self.s.sendall(struct.pack(">HHHBBHH", _tid, 0, 6, 3, 0x04, reg, count))
        resp = b""
        while len(resp) < 9 + 2 * count:
            chunk = self.s.recv(256)
            if not chunk:
                break
            resp += chunk
            if len(resp) >= 9 and resp[7] & 0x80:
                break
        if len(resp) < 9 or resp[7] & 0x80:
            raise IOError(f"Modbus-Fehler {self.ip}:{reg}")
        return resp[9:9 + resp[8]]

    def val(self, reg, fmt):
        b = self.read(reg, {">i": 2, ">I": 2, ">Q": 4}[fmt])
        raw = struct.unpack(">I" if fmt == ">i" else fmt, b)[0]
        nan = {">i": (0x80000000,), ">I": (0x80000000, 0xFFFFFFFF), ">Q": (0x8000000000000000, 0xFFFFFFFFFFFFFFFF)}[fmt]
        if raw in nan:
            return None
        return struct.unpack(fmt, b)[0]

def read_devices():
    d = {}
    try:
        with Device(PV_IP) as dev:
            d["pv_w"] = max(0, dev.val(30775, ">i") or 0)  # nachts NaN -> 0
            d["pv_day_wh"] = dev.val(30535, ">I")
            d["pv_total_wh"] = dev.val(30529, ">I")
    except Exception as e:
        log.warning("Tripower nicht lesbar: %s", e)
    try:
        with Device(BAT_IP) as dev:
            d["bat_w"] = dev.val(30775, ">i")  # positiv = Entladen, negativ = Laden
            d["soc"] = dev.val(30845, ">I")
            t = dev.val(30849, ">i")
            d["bat_temp"] = None if t is None else t / 10
            d["bat_health"] = dev.val(30847, ">I")
            d["bat_in_wh"] = dev.val(31397, ">Q")
            d["bat_out_wh"] = dev.val(31401, ">Q")
            # Netzzaehler, die der Sunny Island per Unicast vom Energy Meter bekommt (10-Wh-Schritte)
            d["grid_in_si_wh"] = dev.val(30581, ">I")
            d["grid_out_si_wh"] = dev.val(30583, ">I")
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

    def append(self, path, field, item, extra=None):
        if not self.db:
            log.info("DRY %s +%s %s", path, field, item)
            return
        self.db.document(path).set({**(extra or {}), field: self.fs.ArrayUnion([item])}, merge=True)

    def inc(self, path, data):
        """Zahlen in verschachteltem dict als Firestore-Increment schreiben (neustartsicher)."""
        if not self.db:
            log.info("DRY %s +=%s", path, json.dumps(data)[:300])
            return
        def conv(x):
            return {k: conv(v) for k, v in x.items()} if isinstance(x, dict) else self.fs.Increment(x)
        self.db.document(path).set(conv(data), merge=True)

# ---------- Börsenpreise und PV-Prognose (alle 30 min) ----------
PRICES = {}    # "JJJJ-MM-TT" -> [(unix, EUR/kWh)]
FORECAST = {}  # "JJJJ-MM-TT" -> {"m": [...], "w": [...], "kwh": x}

def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pv-dashboard-collector"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def fetch_prices(store, days):
    for dk in days:
        try:
            j = http_json(f"https://api.energy-charts.info/price?bzn=DE-LU&start={dk}&end={dk}")
            rows = [(t, p / 1000) for t, p in zip(j["unix_seconds"], j["price"])
                    if p is not None and datetime.fromtimestamp(t, TZ).strftime("%Y-%m-%d") == dk]
            if len(rows) < 80 or rows == PRICES.get(dk):
                continue
            PRICES[dk] = rows
            store.set(f"prices/{dk}", {
                "m": [datetime.fromtimestamp(t, TZ).hour * 60 + datetime.fromtimestamp(t, TZ).minute for t, _ in rows],
                "p": [round(p, 5) for _, p in rows], "unit": "EUR/kWh netto (Day-Ahead)", "ts": int(time.time())})
            log.info("Preise %s: %d Werte", dk, len(rows))
        except Exception as e:
            log.warning("Preise %s nicht abrufbar: %s", dk, e)

def fetch_forecast(store):
    try:
        j = http_json(f"https://api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}"
                      f"&minutely_15=global_tilted_irradiance&tilt={TILT}&azimuth={AZIMUTH}"
                      f"&forecast_days=2&timezone=Europe%2FBerlin")
        q = j["minutely_15"]
        by = {}
        for t, g in zip(q["time"], q["global_tilted_irradiance"]):
            dk, hm_ = t.split("T")
            h, mi = map(int, hm_.split(":"))
            w = 0 if g is None else min(AC_MAX, round(KWP * g * PR))
            by.setdefault(dk, {"m": [], "w": []})
            by[dk]["m"].append(h * 60 + mi)
            by[dk]["w"].append(w)
        for dk, f in by.items():
            f["kwh"] = round(sum(f["w"]) * 0.25 / 1000, 2)
            if FORECAST.get(dk, {}).get("w") == f["w"]:
                continue
            FORECAST[dk] = f
            store.set(f"forecast/{dk}", {**f, "ts": int(time.time())})
            log.info("Prognose %s: %.1f kWh", dk, f["kwh"])
    except Exception as e:
        log.warning("Prognose nicht abrufbar: %s", e)

def fetch_loop(store, stop):
    while not stop.is_set():
        today = datetime.now(TZ)
        tomorrow = datetime.fromtimestamp(time.time() + 86400, TZ)
        fetch_prices(store, [today.strftime("%Y-%m-%d"), tomorrow.strftime("%Y-%m-%d")])
        fetch_forecast(store)
        stop.wait(1800)

def price_at(ts):
    rows = PRICES.get(datetime.fromtimestamp(ts, TZ).strftime("%Y-%m-%d"))
    if not rows:
        return None
    cur = None
    for t, p in rows:
        if t <= ts:
            cur = p
        else:
            break
    return cur

# ---------- Hauptschleife ----------
COUNTERS = ("grid_in_si_wh", "grid_out_si_wh", "bat_in_wh", "bat_out_wh", "pv_total_wh")
EST_WINDOW_S = int(os.getenv("EST_WINDOW_S", "180"))
BTG_ON, BTG_OFF = 300, 150
SI_STALE_S = int(os.getenv("SI_STALE_S", "600"))  # SI-Netzzaehler laenger unveraendert -> Schaetzung ungueltig  # Batterie -> Netz: Ereignis ab 300 W, Ende unter 150 W

def r1(x):
    return None if x is None else round(x, 1)

def main():
    store = Store()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *a: stop.set())
    threading.Thread(target=meter_listener, daemon=True).start()
    threading.Thread(target=fetch_loop, args=(store, stop), daemon=True).start()

    day, start, acc = None, {}, []
    hist = []      # (Zeit, Bezug Wh, Einspeisung Wh) aus dem Sunny Island fuer die Schaetzung
    extra = {}     # Tageswerte, die nicht aus Zaehlern kommen (Spitzen, Batterie->Netz)
    pend = {}      # aufgelaufene Energie seit dem letzten Schreiben
    ev = None      # laufendes Ereignis Batterie -> Netz
    last_si, si_changed = None, 0  # letzter SI-Zaehlerstand und Zeitpunkt der letzten Aenderung
    last_dir = 0   # letzte starke Batterie-Richtung: +1 entladen, -1 laden (fuer Richtungswechsel)
    last_live = last_point = 0
    prev = time.time()
    log.info("Sammler gestartet (DRY_RUN=%s)", DRY_RUN)
    while not stop.is_set():
        now = time.time()
        e_h = min(60, now - prev) / 3600  # Stunden seit dem letzten Durchlauf
        prev = now
        dt = datetime.now(TZ)
        d = read_devices()
        m = dict(meter) if now - meter.get("ts", 0) < 30 else {}
        d.update({k: v for k, v in m.items() if k != "ts"})

        grid, grid_est = None, False
        if d.get("grid_in_si_wh") is not None and d.get("grid_out_si_wh") is not None:
            hist.append((now, d["grid_in_si_wh"], d["grid_out_si_wh"]))
            hist = [h for h in hist if now - h[0] <= 900]
        if "grid_in_w" in d:
            grid = d["grid_in_w"] - d["grid_out_w"]  # positiv = Bezug, negativ = Einspeisung
        si = (d.get("grid_in_si_wh"), d.get("grid_out_si_wh"))
        if si[0] is not None and si != last_si:
            if last_si is not None:
                si_changed = now
            last_si = si
        if "grid_in_w" in d:
            pass
        elif now - si_changed > SI_STALE_S:
            pass  # Zaehler stehen still: Netz unbekannt statt falsch 0
        elif hist and now - hist[0][0] >= 60:
            # Rueckfall: mittlere Netzleistung aus Zaehlerdifferenz der letzten EST_WINDOW_S Sekunden
            old = next((h for h in hist if now - h[0] <= EST_WINDOW_S), hist[0])
            if now - old[0] >= 60:
                grid = ((d["grid_in_si_wh"] - old[1]) - (d["grid_out_si_wh"] - old[2])) * 3600 / (now - old[0])
                grid_est = True
        house = None
        if grid is not None and "pv_w" in d and d.get("bat_w") is not None:
            house = max(0, d["pv_w"] + d["bat_w"] + grid)
        d["grid_w"], d["house_w"] = grid, house

        # Tageswechsel: Startzähler und Tageswerte aus dem Tagesdokument holen
        key = dt.strftime("%Y-%m-%d")
        if key != day:
            doc = store.get(f"days/{key}")
            start = doc.get("start", {})
            t0 = doc.get("totals", {})
            extra = {k: t0[k] for k in ("peak_pv", "peak_house", "bat_grid", "bat_from_grid", "flips", "tmin", "tmax") if k in t0}
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

        # Spitzen, Temperaturen
        if d.get("pv_w") is not None:
            extra["peak_pv"] = max(extra.get("peak_pv", 0), round(d["pv_w"]))
        if house is not None and not grid_est:
            extra["peak_house"] = max(extra.get("peak_house", 0), round(house))
        if d.get("bat_temp") is not None:
            extra["tmin"] = min(extra.get("tmin", 99), d["bat_temp"])
            extra["tmax"] = max(extra.get("tmax", -99), d["bat_temp"])

        # Auffaelligkeiten, auch ohne Energy Meter messbar:
        # 1) Richtungswechsel: Batterie springt zwischen starkem Laden und Entladen (> 1 kW)
        # 2) Laden aus dem Netz: Ladeleistung groesser als PV-Leistung
        flip = 0
        bw = d.get("bat_w")
        if bw is not None:
            dir_ = 1 if bw > 1000 else -1 if bw < -1000 else 0
            if dir_ and last_dir and dir_ != last_dir:
                flip = 1
                extra["flips"] = extra.get("flips", 0) + 1
            if dir_:
                last_dir = dir_
        bfg = 0
        if bw is not None and d.get("pv_w") is not None:
            bfg = max(0, -bw - d["pv_w"])
            if bfg >= 300:
                extra["bat_from_grid"] = round(extra.get("bat_from_grid", 0) + bfg * e_h, 1)

        # Batterie speist ins Netz (z. B. Fremdsteuerung): Anteil der Entladung, der rausgeht
        btg = 0
        if grid is not None and d.get("bat_w") is not None:
            btg = min(max(d["bat_w"], 0), max(-grid, 0))
        if btg >= 100:
            extra["bat_grid"] = round(extra.get("bat_grid", 0) + btg * e_h, 1)
        if btg >= BTG_ON:
            if not ev:
                ev = {"start": int(now), "wh": 0.0, "peak": 0, "above": now}
                log.info("Batterie speist ins Netz: %d W", btg)
            ev["above"] = now
        if ev:
            ev["wh"] += btg * e_h
            ev["peak"] = max(ev["peak"], round(btg))
            if btg < BTG_OFF and now - ev["above"] > 60:
                item = {"start": ev["start"], "end": int(now), "wh": round(ev["wh"]), "peak": ev["peak"], "soc": d.get("soc")}
                ev = None
                if item["wh"] >= 30:
                    log.info("Ereignis Batterie -> Netz beendet: %s", item)
                    try:
                        store.append(f"days/{key}", "events", item)
                        store.append("stats/batgrid", "events", item)
                    except Exception as e:
                        log.warning("Ereignis schreiben fehlgeschlagen: %s", e)

        # Energie fuer Stundenwerte und Boersenpreis-Rechnung aufsummieren
        hh = f"{dt.hour:02d}"
        price = price_at(now)
        imp = max(grid or 0, 0) * e_h / 1000   # kWh
        exp = max(-(grid or 0), 0) * e_h / 1000
        def add(path, val):
            if val:
                pend[path] = pend.get(path, 0) + val
        add(("h", key, "pv", hh), (d.get("pv_w") or 0) * e_h)
        add(("h", key, "house", hh), (house or 0) * e_h)
        add(("h", key, "imp", hh), imp * 1000)
        add(("h", key, "exp", hh), exp * 1000)
        add(("h", key, "flips", hh), flip)
        add(("h", key, "bfg", hh), bfg * e_h if bfg >= 300 else 0)
        if price is not None:
            add(("s", key, "imp_kwh"), imp)
            add(("s", key, "imp_eur"), imp * price)
            add(("s", key, "exp_kwh"), exp)
            add(("s", key, "exp_eur"), exp * price)

        totals = {}
        if d.get("pv_day_wh") is not None:
            totals["pv"] = d["pv_day_wh"]
        for k, name in (("grid_in_si_wh", "grid_in"), ("grid_out_si_wh", "grid_out"), ("bat_in_wh", "bat_in"), ("bat_out_wh", "bat_out")):
            if k in d and k in start:
                totals[name] = round(d[k] - start[k])
        if all(k in totals for k in ("pv", "grid_in", "grid_out", "bat_in", "bat_out")):
            totals["house"] = max(0, totals["pv"] + totals["grid_in"] - totals["grid_out"] + totals["bat_out"] - totals["bat_in"])
        totals.update({k: (round(v, 1) if isinstance(v, float) else v) for k, v in extra.items()})
        if d.get("bat_health") is not None:
            totals["health"] = d["bat_health"]

        if now - last_live >= LIVE_S:
            last_live = now
            live = {k: d.get(k) for k in ("pv_w", "bat_w", "grid_w", "house_w", "soc", "bat_temp", "bat_health")}
            live = {k: r1(v) for k, v in live.items()}
            tomorrow = datetime.fromtimestamp(now + 86400, TZ).strftime("%Y-%m-%d")
            live.update(ts=int(now), day=key, today=totals,
                        pv_total_kwh=r1((d.get("pv_total_wh") or 0) / 1000),
                        bat_in_total_kwh=r1((d.get("bat_in_wh") or 0) / 1000),
                        bat_out_total_kwh=r1((d.get("bat_out_wh") or 0) / 1000),
                        bat_kwh=BAT_KWH, btg_w=round(btg), bfg_w=round(bfg),
                        price=None if price is None else round(price, 5),
                        fc_today=FORECAST.get(key, {}).get("kwh"), fc_tomorrow=FORECAST.get(tomorrow, {}).get("kwh"),
                        today_since=start.get("m", 0), meter_ok=bool(m), grid_est=grid_est)
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
                store.append(f"days/{key}", "points", point, {"date": key, "totals": totals})
                store.set(f"months/{key[:7]}", {"days": {key[8:]: totals}}, merge=True)
                # Stundenwerte je Monat: hours/JJJJ-MM -> {TT: {pv|house|imp|exp: {HH: Wh}}}
                # Boersenpreis-Summen: days/{tag}.spot und months/{JJJJ-MM}.days.TT.spot
                by_doc = {}
                for k, v in pend.items():
                    if k[0] == "h":
                        _, dk, metric, h = k
                        by_doc.setdefault(f"hours/{dk[:7]}", {}).setdefault(dk[8:], {}).setdefault(metric, {})[h] = round(v, 1)
                    else:
                        _, dk, metric = k
                        by_doc.setdefault(f"days/{dk}", {}).setdefault("spot", {})[metric] = round(v, 6)
                        by_doc.setdefault(f"months/{dk[:7]}", {}).setdefault("days", {}).setdefault(dk[8:], {}).setdefault("spot", {})[metric] = round(v, 6)
                for path, data in by_doc.items():
                    store.inc(path, data)
                pend = {}
            except Exception as e:
                log.warning("Verlauf schreiben fehlgeschlagen: %s", e)

        stop.wait(max(0.5, POLL_S - (time.time() - now)))

if __name__ == "__main__":
    main()
