// Demo-Backend der statischen Version: alles läuft im Browser.
// Beispielmeldungen werden bei jedem Aufruf relativ zur aktuellen Zeit erzeugt,
// eigene Meldungen und Markierungen liegen nur im localStorage dieses Browsers.
// Die Regeln (Bremen-Grenze, Ratenbegrenzung, 3 Markierungen = ausgeblendet)
// entsprechen denen der Supabase-Version.
import { ApiError } from './errors.js';
import { CATEGORIES, inBremen } from './config.js';
import { load, save } from './storage.js';

const KEY = 'laermkarte.static.reports';
const FLAGS_KEY = 'laermkarte.static.flags';
const HOUR = 3600_000;
const ME = 'me';

function distanceM(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

const SPOTS = [
  [53.0758, 8.8072], [53.0826, 8.8133], [53.0697, 8.8361], [53.0905, 8.7852],
  [53.0641, 8.7835], [53.1023, 8.8471], [53.0548, 8.7911], [53.1335, 8.7354],
  [53.0466, 8.8655], [53.0975, 8.8836], [53.1702, 8.6224], [53.0789, 8.7700],
];
const SEED_COMMENTS = ['Laubbläser seit 7 Uhr', 'Presslufthammer', 'Musik bis spät in die Nacht'];

function seed() {
  const now = Date.now();
  return SPOTS.flatMap(([lat, lng], i) =>
    Array.from({ length: 1 + (i % 3) }, (_, j) => ({
      id: `seed-${i}-${j}`,
      created_at: new Date(now - ((i * 7 + j * 13) % 400) * HOUR - j * 600_000).toISOString(),
      lat: lat + (j - 1) * 0.0012,
      lng: lng + (j - 1) * 0.0015,
      level: ((i + j) % 3) + 1,
      category: CATEGORIES[(i + j) % CATEGORIES.length].id,
      comment: j === 0 && i % 4 === 0 ? SEED_COMMENTS[(i / 4) % SEED_COMMENTS.length] : null,
      device: 'seed',
    })),
  );
}

function ownReports() {
  const list = load(KEY, []);
  const cutoff = Date.now() - 30 * 24 * HOUR;
  return Array.isArray(list) ? list.filter((r) => Date.parse(r.created_at) > cutoff) : [];
}

// Markierungen: { [reportId]: Anzahl }.
const flags = () => load(FLAGS_KEY, {});

function all() {
  const f = flags();
  return [...ownReports(), ...seed()].map((r) => ({ ...r, flag_count: f[r.id] ?? 0 }));
}

const delay = () => new Promise((r) => setTimeout(r, 150));
const publicView = ({ device, ...rest }) => rest;

export async function fetchReports({ hours, categories }) {
  await delay();
  const since = Date.now() - hours * HOUR;
  return all()
    .filter((r) => r.flag_count < 3 && Date.parse(r.created_at) >= since && categories.includes(r.category))
    .map(publicView);
}

export async function submitReport({ lat, lng, level, category, comment }) {
  await delay();
  if (!inBremen(lat, lng)) throw new ApiError('outside_bremen');
  if (![1, 2, 3].includes(level)) throw new ApiError('invalid_level');
  if (!CATEGORIES.some((c) => c.id === category)) throw new ApiError('invalid_category');

  const mine = ownReports();
  const now = Date.now();
  if (mine.filter((r) => now - Date.parse(r.created_at) < 24 * HOUR).length >= 10) {
    throw new ApiError('rate_limit_daily');
  }
  if (mine.some((r) => now - Date.parse(r.created_at) < 0.5 * HOUR && distanceM(r.lat, r.lng, lat, lng) < 100)) {
    throw new ApiError('rate_limit_nearby');
  }

  const cleaned = (comment ?? '').replace(/<[^>]*>?/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const report = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    lat, lng, level, category,
    comment: cleaned,
    device: ME,
  };
  save(KEY, [report, ...mine]);
  return { ok: true, report: publicView({ ...report, flag_count: 0 }) };
}

export async function flagReport({ reportId }) {
  await delay();
  const report = all().find((r) => r.id === reportId);
  if (!report) throw new ApiError('not_found');
  const f = flags();
  // Damit man in der Demo das Ausblenden sehen kann, zählt jede Markierung
  // gleich dreifach: eine Markierung blendet die Meldung aus.
  f[reportId] = 3;
  save(FLAGS_KEY, f);
  return { ok: true, already_flagged: false, hidden: true };
}

export function resetDemo() {
  save(KEY, []);
  save(FLAGS_KEY, {});
}
