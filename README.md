# Lärmkarte Bremen – einfache Version (GitHub Pages + Supabase)

Meldungen aller Nutzer*innen werden gespeichert und sind für alle sichtbar,
ohne Anmeldung. Gegenüber der vollen Version fallen Cloudflare, Edge Functions,
Turnstile, Node und der Build-Schritt weg. Die Dateien in diesem Ordner sind
direkt die fertige Website.

Solange in `config.js` nichts eingetragen ist, läuft die Seite im **Demo-Modus**
(wie die statische Demo).

## Einrichten (ca. 10 Minuten, ohne Terminal)

### 1. Supabase-Projekt anlegen

1. Auf <https://supabase.com> kostenlos registrieren → **New project**.
2. Name z. B. `laermkarte-bremen`, Region **Central EU (Frankfurt)**,
   ein Datenbank-Passwort vergeben (im Passwort-Manager speichern, wird hier nicht gebraucht).
3. Warten, bis das Projekt bereit ist (1–2 Minuten).

### 2. Datenbank einrichten

1. Links **SQL Editor** → **New query**.
2. Den kompletten Inhalt von `supabase-setup.sql` einfügen → **Run**.
3. Es sollte „Success. No rows returned“ erscheinen.

### 3. Zugangsdaten in `config.js` eintragen

1. In Supabase **Project Settings → API** (bzw. **API Keys**) öffnen.
2. **Project URL** kopieren und in `config.js` bei `SUPABASE_URL` zwischen die Anführungszeichen setzen.
3. Den **anon public** Key (beginnt mit `eyJ…`) oder den **publishable** Key (`sb_publishable_…`)
   bei `SUPABASE_ANON_KEY` eintragen.

   Diese beiden Werte sind öffentlich und dürfen auf GitHub stehen.
   **Niemals** den `service_role`- bzw. `secret`-Key verwenden!

### 4. Auf GitHub hochladen

1. Im Repo **Add file → Upload files**, alle Dateien dieses Ordners hineinziehen
   (die Dateien selbst, nicht den Ordner) → **Commit changes**.
   `supabase-setup.sql` und `README.md` dürfen mit hochgeladen werden, sie stören nicht.
2. Falls noch nicht geschehen: **Settings → Pages** → Source **Deploy from a branch**,
   Branch **main**, Ordner **/ (root)**.
3. Nach 1–2 Minuten die Seite öffnen. Das gelbe Demo-Banner darf **nicht** mehr erscheinen.
   Eine Testmeldung absetzen und auf einem zweiten Gerät prüfen, ob sie dort auch erscheint.

## Was die Datenbank prüft

- Ort innerhalb Bremens (Bounding Box, ohne Bremerhaven)
- pro Gerät max. 1 Meldung in 30 Minuten im Umkreis von 100 m und max. 10 pro 24 Stunden
- insgesamt max. 300 Meldungen pro Stunde (Notbremse gegen Bots)
- Kommentar ohne HTML, max. 200 Zeichen
- 3 Markierungen von verschiedenen Geräten → Meldung ausgeblendet
- nach 30 Tagen unsichtbar, danach gelöscht
- keine IP-Adressen in der Datenbank; Geräte-ID nur als gesalzener Hash

## Moderation (im Supabase-Dashboard)

- **Meldung löschen:** Table Editor → `reports` → Zeile auswählen → Delete.
- **Fälschlich ausgeblendete Meldung zurückholen:** `flag_count` auf 0 setzen und die
  zugehörigen Zeilen in `report_flags` löschen.
- **Alles auf einmal löschen** (SQL Editor): `delete from reports;`

## Grenzen dieser Version

- **Kein Captcha.** Wer technisch versiert ist, kann per Skript ständig neue Geräte-IDs
  erzeugen und so die Begrenzung pro Gerät umgehen. Die Obergrenze von 300 pro Stunde
  begrenzt den Schaden; Spam lässt sich im Dashboard löschen. Für mehr Schutz wäre
  die volle Version mit Cloudflare Turnstile nötig.
- Drei Personen (oder ein Skript) können gemeinsam eine Meldung ausblenden.
- Supabase pausiert kostenlose Projekte nach etwa einer Woche ohne Zugriffe;
  im Dashboard lässt sich das Projekt mit einem Klick wieder starten.
- Die Bounding Box enthält Randbereiche von Nachbargemeinden (z. B. Stuhr, Lilienthal).
- Impressum und Datenschutz sind **Vorlagen** und müssen ausgefüllt und geprüft werden.

## Lokal ansehen

```bash
python3 -m http.server 8000
```

Dann <http://localhost:8000> öffnen (Doppelklick auf `index.html` funktioniert nicht).
