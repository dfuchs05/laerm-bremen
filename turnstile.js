// Cloudflare Turnstile (Captcha). Wird erst geladen, wenn ein Formular
// geöffnet wird, damit beim reinen Ansehen der Karte keine Verbindung zu
// Cloudflare entsteht. Im Demo-Modus wird nichts geladen.
import { DEMO_MODE, TURNSTILE_SITE_KEY } from './config.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise = null;

function loadScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error('turnstile_load_failed'));
    };
    document.head.append(s);
  });
  return scriptPromise;
}

/**
 * Rendert ein Widget in `container` und gibt { getToken, reset, remove } zurück.
 */
export async function mountTurnstile(container, action) {
  container.replaceChildren();
  if (DEMO_MODE) return { getToken: () => 'demo', reset() {}, remove() {} };
  if (!TURNSTILE_SITE_KEY) throw new Error('turnstile_site_key_missing');

  let token = '';
  const ts = await loadScript();
  const widgetId = ts.render(container, {
    sitekey: TURNSTILE_SITE_KEY,
    action,
    language: 'de',
    appearance: 'interaction-only',
    callback: (t) => { token = t; },
    'expired-callback': () => { token = ''; },
    'error-callback': () => { token = ''; },
  });
  return {
    getToken: () => token,
    reset() {
      token = '';
      ts.reset(widgetId);
    },
    remove() {
      ts.remove(widgetId);
    },
  };
}
