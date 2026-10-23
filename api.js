// Verbindung zu Supabase. Ohne eingetragene Zugangsdaten in config.js
// läuft die Seite im Demo-Modus (nur im eigenen Browser).
import { DEMO_MODE, SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js';
import { ApiError } from './errors.js';
import * as demo from './mock-backend.js';
import { deviceId } from './storage.js';

const COLUMNS = 'id,created_at,lat,lng,level,category,comment,flag_count';

function headers() {
  const h = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  // Ältere "anon"-Keys sind JWTs und gehören zusätzlich in den Authorization-Header,
  // neuere "sb_publishable_..."-Keys nicht.
  if (SUPABASE_ANON_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return h;
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: headers() });
  } catch {
    throw new ApiError('network');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* leer */
  }
  if (!res.ok) throw new ApiError(`http_${res.status}`);
  return data;
}

async function rpc(name, params) {
  const data = await request(`rpc/${name}`, { method: 'POST', body: JSON.stringify(params) });
  if (!data?.ok) throw new ApiError(data?.error ?? 'unknown');
  return data;
}

export async function fetchReports({ hours, categories }) {
  if (DEMO_MODE) return demo.fetchReports({ hours, categories });
  if (categories.length === 0) return [];
  const params = new URLSearchParams({
    select: COLUMNS,
    created_at: `gte.${new Date(Date.now() - hours * 3600_000).toISOString()}`,
    order: 'created_at.desc',
    limit: '5000',
  });
  if (categories.length < 5) params.set('category', `in.(${categories.join(',')})`);
  return request(`reports?${params}`);
}

export async function submitReport({ lat, lng, level, category, comment }) {
  if (DEMO_MODE) return demo.submitReport({ lat, lng, level, category, comment });
  return rpc('submit_report', {
    p_lat: lat,
    p_lng: lng,
    p_level: level,
    p_category: category,
    p_comment: comment,
    p_device_id: deviceId(),
  });
}

export async function flagReport({ reportId }) {
  if (DEMO_MODE) return demo.flagReport({ reportId });
  return rpc('flag_report', { p_report_id: reportId, p_device_id: deviceId() });
}

export const resetDemo = demo.resetDemo;
