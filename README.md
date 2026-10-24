# Lärmkarte Bremen – mit Captcha (GitHub Pages + Supabase + Turnstile)

Wie die einfache Version, aber Melden und „Meldung melden“ sind zusätzlich durch
ein Captcha (Cloudflare Turnstile) geschützt. Das Captcha wird von zwei kleinen
Supabase Edge Functions geprüft; erst danach schreiben sie in die Datenbank.
Direkt aus dem Browser kann niemand mehr schreiben.

```
GitHub Pages ── Meldung + Captcha-Token ──> Edge Function ── prüft Captcha bei Cloudflare
                                                 └──> Datenbank-Funktion (Bremen, Ratenbegrenzung …)
GitHub Pages ── Meldungen lesen ──────────> Datenbank (nur Lesen erlaubt)
```

Hosting bleibt GitHub Pages. Von Cloudflare wird nur Turnstile gebraucht (kostenlos).

## Dateien, die neu oder anders sind als in der einfachen Version

| Datei | Zweck |
|---|---|
| `turnstile.js` | lädt das Captcha-Widget, sobald ein Formular geöffnet wird |
| `edge-function-submit-report.ts` | Code für die Edge Function `submit-report` (nicht Teil der Website) |
| `edge-function-flag-report.ts` | Code für die Edge Function `flag-report` (nicht Teil der Website) |
| `supabase-update-captcha.sql` | sperrt die Datenbank-Funktionen für den Browser (für dein bestehendes Projekt) |
| `supabase-setup.sql` | komplette Einrichtung für ein neues Projekt, bereits mit Sperre |
| `config.js` | zusätzlich `TURNSTILE_SITE_KEY` |
| `api.js`, `main.js`, `index.html`, `config.js` | schicken das Captcha-Token mit |

## Umstellung deines bestehenden Projekts – bitte in dieser Reihenfolge

Bis Schritt 6 läuft deine jetzige Seite ganz normal weiter.

### 1. Turnstile-Widget anlegen (Cloudflare)

1. Auf <https://dash.cloudflare.com> kostenlos registrieren bzw. anmelden.
2. Links **Turnstile** → **Add widget**.
3. Name: `Lärmkarte Bremen`. Unter **Hostnames** hinzufügen: `dfuchs05.github.io`
   (und `localhost`, falls du lokal testen willst).
4. Widget mode: **Managed** → **Create**.
5. Du bekommst einen **Site Key** (öffentlich) und einen **Secret Key** (geheim!).

### 2. Edge Functions anlegen (Supabase-Dashboard)

Für **beide** Funktionen nacheinander:

1. Links **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name genau: `submit-report` (bzw. beim zweiten Mal `flag-report`).
3. Den vorhandenen Beispielcode komplett löschen und den Inhalt von
   `edge-function-submit-report.ts` (bzw. `edge-function-flag-report.ts`) einfügen.
4. **Deploy function**.
5. Danach in der Funktion unter **Details/Settings** die Option
   **„Verify JWT“ / „Enforce JWT verification“ ausschalten** und speichern.
   (Nötig, weil die Seite ohne Anmeldung funktioniert und dein Key ein
   `sb_publishable_…`-Key ist. Der Schutz kommt stattdessen vom Captcha.)

### 3. Secret eintragen (Supabase-Dashboard)

1. **Edge Functions** → **Secrets** (bzw. „Manage secrets“).
2. Neues Secret: Name `TURNSTILE_SECRET_KEY`, Wert: der **Secret Key** aus Schritt 1.
3. Optional ein zweites: `ALLOWED_ORIGIN` = `https://dfuchs05.github.io`
   (dann akzeptieren die Funktionen nur Anfragen von deiner Seite).

Den Secret Key **nirgendwo sonst** eintragen, nicht in `config.js`, nicht in GitHub.

### 4. Site Key in `config.js` eintragen

In `config.js` bei `TURNSTILE_SITE_KEY` den **Site Key** zwischen die Anführungszeichen setzen.
Supabase-URL und Key sind schon eingetragen.

### 5. Website hochladen und testen

1. Im GitHub-Repo **Add file → Upload files**, alle Dateien dieses Ordners hineinziehen → **Commit changes**.
2. Nach 1–2 Minuten die Seite neu laden (Cmd + Shift + R) und eine Testmeldung absetzen.
   Erscheint sie, laufen Captcha und Edge Function.

### 6. Direkten Zugriff sperren (Supabase-Dashboard)

Erst wenn Schritt 5 klappt: **SQL Editor** → Inhalt von `supabase-update-captcha.sql` einfügen → **Run**.
Ab jetzt geht Melden nur noch mit Captcha. Noch einmal eine Testmeldung absetzen.

Zurück zur Version ohne Captcha geht jederzeit: die zwei auskommentierten Zeilen
am Ende von `supabase-update-captcha.sql` ausführen und die einfache Version hochladen.

## Fehlersuche

| Meldung auf der Seite | Ursache |
|---|---|
| „Die Sicherheitsprüfung konnte nicht geladen werden“ | `TURNSTILE_SITE_KEY` fehlt in `config.js`, oder der Hostname fehlt im Turnstile-Widget |
| „Die Sicherheitsprüfung ist fehlgeschlagen“ | falscher `TURNSTILE_SECRET_KEY` in Supabase (Site- und Secret Key vertauscht?) |
| „Etwas ist schiefgelaufen“ | Edge Function nicht deployt, falscher Name, oder „Verify JWT“ noch an. Details: Supabase → Edge Functions → Funktion → **Logs** |

## Was insgesamt geprüft wird

- **Captcha** bei jeder Meldung und jeder Markierung (serverseitig, IP wird nicht an Cloudflare geschickt)
- Ort innerhalb Bremens (Bounding Box, ohne Bremerhaven)
- pro Gerät max. 1 Meldung in 30 Minuten im Umkreis von 100 m und max. 10 pro 24 Stunden
- insgesamt max. 300 Meldungen pro Stunde
- Kommentar ohne HTML, max. 200 Zeichen
- 3 Markierungen von verschiedenen Geräten → ausgeblendet; max. 20 Markierungen pro Gerät und Tag
- nach 30 Tagen unsichtbar, danach gelöscht
- keine IP-Adressen in der Datenbank; Geräte-ID nur als gesalzener Hash

## Moderation (im Supabase-Dashboard)

- **Meldung löschen:** Table Editor → `reports` → Zeile auswählen → Delete.
- **Fälschlich ausgeblendete Meldung zurückholen:** `flag_count` auf 0 setzen und die
  zugehörigen Zeilen in `report_flags` löschen.

## Hinweise

- Die Datenschutz-Vorlage nennt jetzt auch Cloudflare Turnstile. Impressum und Datenschutz
  sind weiterhin **Vorlagen** und müssen ausgefüllt und geprüft werden.
- Supabase pausiert kostenlose Projekte nach etwa einer Woche ohne Zugriffe;
  im Dashboard lässt sich das Projekt mit einem Klick wieder starten.
- Lokal ansehen: `python3 -m http.server 8000` in diesem Ordner, dann <http://localhost:8000>.
