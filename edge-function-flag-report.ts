// Supabase Edge Function "flag-report"
// Im Supabase-Dashboard unter Edge Functions als Funktion mit genau diesem
// Namen anlegen und den kompletten Inhalt dieser Datei einfügen.
//
// Ablauf: Eingaben prüfen → Captcha bei Cloudflare prüfen → Datenbank-Funktion
// flag_report aufrufen (zählt pro Gerät und Meldung höchstens einmal).
// Benötigtes Secret: TURNSTILE_SECRET_KEY
import { createClient } from "npm:@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Max-Age": "86400",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (status: number, error: string) => json(status, { ok: false, error });

// Captcha-Token serverseitig prüfen. Die IP wird bewusst nicht mitgeschickt.
async function captchaOk(token: unknown, action: string): Promise<string | null> {
  if (typeof token !== "string" || !token || token.length > 2048) return "captcha_missing";
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return "server_misconfigured";
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const result = await res.json();
    if (!result.success) return "captcha_failed";
    // Die Test-Keys von Cloudflare liefern keine action zurück.
    if (result.action && result.action !== action) return "captcha_failed";
    return null;
  } catch {
    return "captcha_unavailable";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const text = await req.text();
  if (text.length > 4096) return fail(413, "payload_too_large");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "invalid_json");
  }

  const { reportId, deviceId } = body;
  if (typeof reportId !== "string" || !UUID_RE.test(reportId)) return fail(400, "invalid_report");
  if (typeof deviceId !== "string" || !UUID_RE.test(deviceId)) return fail(400, "invalid_device");

  const captchaError = await captchaOk(body.turnstileToken, "flag");
  if (captchaError) return fail(captchaError === "server_misconfigured" ? 500 : 403, captchaError);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.rpc("flag_report", { p_report_id: reportId, p_device_id: deviceId });
  if (error) {
    console.error(error);
    return fail(500, "db_error");
  }
  if (!data?.ok) return json(data?.error === "not_found" ? 404 : String(data?.error).startsWith("rate_limit") ? 429 : 400, data);
  return json(200, data);
});
