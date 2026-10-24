// Supabase Edge Function "submit-report"
// Im Supabase-Dashboard unter Edge Functions als Funktion mit genau diesem
// Namen anlegen und den kompletten Inhalt dieser Datei einfügen.
//
// Ablauf: Eingaben prüfen → Captcha bei Cloudflare prüfen → Datenbank-Funktion
// submit_report aufrufen (die prüft Bremen-Grenze, Ratenbegrenzung usw.).
// Benötigtes Secret: TURNSTILE_SECRET_KEY
import { createClient } from "npm:@supabase/supabase-js@2";

const CATEGORIES = ["verkehr", "baustelle", "gastronomie", "industrie", "sonstiges"];
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

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const level = Number(body.level);
  const { category, comment, deviceId } = body;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(400, "invalid_location");
  if (![1, 2, 3].includes(level)) return fail(400, "invalid_level");
  if (typeof category !== "string" || !CATEGORIES.includes(category)) return fail(400, "invalid_category");
  if (comment != null && (typeof comment !== "string" || comment.length > 1000)) return fail(400, "invalid_comment");
  if (typeof deviceId !== "string" || !UUID_RE.test(deviceId)) return fail(400, "invalid_device");

  const captchaError = await captchaOk(body.turnstileToken, "report");
  if (captchaError) return fail(captchaError === "server_misconfigured" ? 500 : 403, captchaError);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.rpc("submit_report", {
    p_lat: lat,
    p_lng: lng,
    p_level: level,
    p_category: category,
    p_comment: comment ?? null,
    p_device_id: deviceId,
  });
  if (error) {
    console.error(error);
    return fail(500, "db_error");
  }
  if (!data?.ok) return json(String(data?.error).startsWith("rate_limit") || data?.error === "busy" ? 429 : 400, data);
  return json(201, data);
});
