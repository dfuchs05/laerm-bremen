// localStorage kann in privaten Fenstern fehlen oder werfen.
export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignorieren */
  }
}

// Zufällige Geräte-ID. Wird nur an die Edge Function geschickt und dort
// mit geheimem Salt gehasht; gespeichert wird ausschließlich der Hash.
let memoryId = null;
export function deviceId() {
  let id = load('laermkarte.device', null);
  if (typeof id !== 'string') {
    id = memoryId ?? crypto.randomUUID();
    memoryId = id;
    save('laermkarte.device', id);
  }
  return id;
}
