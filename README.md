# PV Zuhause

Live-Dashboard für die PV-Anlage (SMA Sunny Tripower, Sunny Island, Energy Meter) als Web-App.

- `collector/`: Sammler (Python, Docker) läuft im Heimnetz, liest die Geräte **nur lesend** (Modbus TCP, Energy-Meter-Multicast) und schreibt nach Firestore.
- Web-App (`index.html`, `app.js`): GitHub Pages, Login per Firebase Auth, Freigabe durch Admin.
- `firestore.rules`: Lesen nur für freigegebene Personen, Schreiben nur durch den Sammler.

Lokal testen ohne Firebase: `python3 -m http.server 8765` und `http://localhost:8765/?demo=1` öffnen.

Geheimnisse (`collector/.env`, `collector/service-account.json`) gehören nie ins Repo.
