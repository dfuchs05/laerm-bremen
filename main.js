// Leaflet und leaflet.heat werden in index.html als klassische Skripte
// geladen und stellen das globale `L` bereit.
import { fetchReports, flagReport, resetDemo, submitReport } from './api.js';
import {
  BREMEN_BBOX, BREMEN_CENTER, CATEGORIES, DEMO_MODE, LEVELS,
  categoryLabel, errorMessage, inBremen,
} from './config.js';
import { load, save } from './storage.js';
import { mountTurnstile } from './turnstile.js';

const { L } = window;

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

const allCategoryIds = CATEGORIES.map((c) => c.id);
const saved = load('laermkarte.filter', {});
const state = {
  view: saved.view === 'heat' ? 'heat' : 'markers',
  hours: [24, 168, 720].includes(saved.hours) ? saved.hours : 168,
  categories: Array.isArray(saved.categories)
    ? saved.categories.filter((c) => allCategoryIds.includes(c))
    : [...allCategoryIds],
  reports: [],
  flagged: new Set(load('laermkarte.flagged', [])),
  draft: null, // { lat, lng, source, accuracy }
  flagTarget: null,
};

const persistFilter = () =>
  save('laermkarte.filter', { view: state.view, hours: state.hours, categories: state.categories });

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

const bounds = L.latLngBounds(
  [BREMEN_BBOX.minLat, BREMEN_BBOX.minLng],
  [BREMEN_BBOX.maxLat, BREMEN_BBOX.maxLng],
);

const map = L.map('map', {
  center: BREMEN_CENTER,
  zoom: 12,
  minZoom: 10,
  maxBounds: bounds.pad(0.5),
  zoomControl: false,
  tapTolerance: 20,
});
L.control.zoom({ position: 'topright', zoomInTitle: 'Vergrößern', zoomOutTitle: 'Verkleinern' }).addTo(map);
map.attributionControl.setPrefix(false);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

// Legende als Karten-Control, damit sie nie mit Kopfzeile/Banner kollidiert.
const legend = L.control({ position: 'topleft' });
legend.onAdd = () => {
  const node = $('.legend');
  L.DomEvent.disableClickPropagation(node);
  return node;
};
legend.addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const heatLayer = L.heatLayer([], {
  radius: 28,
  blur: 22,
  maxZoom: 15,
  minOpacity: 0.35,
  gradient: { 0.3: '#f5c400', 0.6: '#f07d00', 1.0: '#b3001b' },
});
let positionLayer = null;

const dateFmt = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin',
});
const relFmt = new Intl.RelativeTimeFormat('de', { numeric: 'auto' });

function relativeTime(iso) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return relFmt.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return relFmt.format(hours, 'hour');
  return relFmt.format(Math.round(hours / 24), 'day');
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

// Popup-Inhalt ausschließlich per DOM/textContent, nie innerHTML mit Nutzertext.
function popupContent(r) {
  const flagged = state.flagged.has(r.id);
  const flagBtn = el('button', {
    type: 'button',
    className: 'btn btn--small btn--ghost-danger',
    textContent: flagged ? 'Bereits markiert' : 'Meldung melden',
    disabled: flagged,
  });
  flagBtn.setAttribute('aria-label', flagged ? 'Bereits als unangemessen markiert' : 'Diese Meldung als unangemessen melden');
  flagBtn.addEventListener('click', () => openFlagDialog(r));

  return el('div', { className: 'popup' },
    el('p', { className: `popup__level popup__level--${r.level}` },
      el('span', { className: `dot dot--${r.level}`, textContent: String(r.level), ariaHidden: 'true' }),
      ` ${LEVELS[r.level]}`),
    el('dl', {},
      el('dt', { textContent: 'Art' }), el('dd', { textContent: categoryLabel(r.category) }),
      el('dt', { textContent: 'Zeitpunkt' }),
      el('dd', {}, el('time', {
        dateTime: r.created_at,
        textContent: `${dateFmt.format(new Date(r.created_at))} (${relativeTime(r.created_at)})`,
      })),
      r.comment ? el('dt', { textContent: 'Kommentar' }) : null,
      r.comment ? el('dd', { textContent: r.comment }) : null,
    ),
    flagBtn,
  );
}

function markerFor(r) {
  const label = `${categoryLabel(r.category)}, ${LEVELS[r.level]}`;
  const icon = L.divIcon({
    className: 'pin-wrap',
    html: `<span class="pin pin--${r.level}">${r.level}</span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -16],
  });
  return L.marker([r.lat, r.lng], { icon, title: label, alt: label, keyboard: true, riseOnHover: true })
    .bindPopup(() => popupContent(r), { minWidth: 220, maxWidth: 280 });
}

function render() {
  markerLayer.clearLayers();
  // Lautere Meldungen zuletzt zeichnen, damit sie oben liegen.
  const sorted = [...state.reports].sort((a, b) => a.level - b.level);
  if (state.view === 'markers') {
    if (map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    sorted.forEach((r) => markerLayer.addLayer(markerFor(r)));
  } else {
    heatLayer.setLatLngs(sorted.map((r) => [r.lat, r.lng, r.level / 3]));
    if (!map.hasLayer(heatLayer)) heatLayer.addTo(map);
  }
  const n = state.reports.length;
  const range = { 24: '24 Stunden', 168: '7 Tagen', 720: '30 Tagen' }[state.hours];
  setStatus(`${n === 1 ? '1 Meldung' : `${n} Meldungen`} in den letzten ${range}`);
}

let loadSeq = 0;
async function refresh() {
  const seq = ++loadSeq;
  setStatus('Lade Meldungen …');
  try {
    const reports = await fetchReports({ hours: state.hours, categories: state.categories });
    if (seq !== loadSeq) return;
    state.reports = reports;
    render();
  } catch (err) {
    if (seq !== loadSeq) return;
    setStatus(errorMessage(err.code), true);
  }
}

// ---------------------------------------------------------------------------
// Statuszeile / Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function setStatus(text, isError = false) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('status--error', isError);
}

function toast(text, isError = false) {
  clearTimeout(toastTimer);
  setStatus(text, isError);
  $('#status').classList.add('status--toast');
  toastTimer = setTimeout(() => {
    $('#status').classList.remove('status--toast');
    render();
  }, 5000);
}

// ---------------------------------------------------------------------------
// Dialoge
// ---------------------------------------------------------------------------

function openDialog(dlg) {
  if (!dlg.open) dlg.showModal();
}

document.querySelectorAll('dialog').forEach((dlg) => {
  // Klick auf den abgedunkelten Hintergrund schließt den Dialog.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
});

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Dein Browser unterstützt keine Standortabfrage.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      (err) => reject(new Error(
        err.code === err.PERMISSION_DENIED
          ? 'Standortzugriff wurde nicht erlaubt. Du kannst den Ort auch auf der Karte wählen.'
          : 'Dein Standort konnte nicht ermittelt werden.',
      )),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

function showPosition(coords) {
  const latlng = [coords.latitude, coords.longitude];
  positionLayer?.remove();
  positionLayer = L.layerGroup([
    L.circle(latlng, { radius: coords.accuracy, className: 'me-accuracy', interactive: false }),
    L.circleMarker(latlng, { radius: 8, className: 'me-dot', interactive: false }),
  ]).addTo(map);
  map.flyTo(latlng, Math.max(map.getZoom(), 16));
}

$('#locate-btn').addEventListener('click', async () => {
  const btn = $('#locate-btn');
  btn.setAttribute('aria-busy', 'true');
  try {
    const coords = await getPosition();
    showPosition(coords);
    if (!inBremen(coords.latitude, coords.longitude)) toast('Du befindest dich außerhalb von Bremen.');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.removeAttribute('aria-busy');
  }
});

// ---------------------------------------------------------------------------
// Melden: Ort wählen
// ---------------------------------------------------------------------------

$('#report-btn').addEventListener('click', () => openDialog($('#where-dialog')));

$('#where-gps').addEventListener('click', async () => {
  const btn = $('#where-gps');
  btn.disabled = true;
  btn.textContent = 'Standort wird ermittelt …';
  try {
    const coords = await getPosition();
    $('#where-dialog').close();
    showPosition(coords);
    if (!inBremen(coords.latitude, coords.longitude)) {
      toast(errorMessage('outside_bremen'), true);
      return;
    }
    openReportForm({ lat: coords.latitude, lng: coords.longitude, source: 'gps', accuracy: coords.accuracy });
  } catch (e) {
    $('#where-dialog').close();
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Meine aktuelle Position';
  }
});

function setPickMode(on) {
  if (on) {
    // Fadenkreuz exakt über die Kartenmitte legen (map.getCenter()).
    const r = map.getContainer().getBoundingClientRect();
    const cross = $('.pick__crosshair');
    cross.style.left = `${r.left + r.width / 2}px`;
    cross.style.top = `${r.top + r.height / 2}px`;
  }
  $('#pick-overlay').hidden = !on;
  document.body.classList.toggle('picking', on);
  if (on) $('#pick-confirm').focus();
}

$('#where-map').addEventListener('click', () => {
  $('#where-dialog').close();
  if (map.getZoom() < 15) map.setZoom(15);
  setPickMode(true);
});

$('#pick-cancel').addEventListener('click', () => setPickMode(false));
$('#pick-confirm').addEventListener('click', () => {
  const c = map.getCenter();
  if (!inBremen(c.lat, c.lng)) {
    toast(errorMessage('outside_bremen'), true);
    return;
  }
  setPickMode(false);
  openReportForm({ lat: c.lat, lng: c.lng, source: 'map' });
});

// ---------------------------------------------------------------------------
// Melden: Formular
// ---------------------------------------------------------------------------

function radioChoice(name, value, label, type = 'radio', checked = false) {
  return el('label', { className: 'choice' },
    el('input', { type, name, value, checked }),
    el('span', { textContent: label }));
}

$('#category-choices').append(...CATEGORIES.map((c) => radioChoice('category', c.id, c.label)));

const form = $('#report-form');
const comment = $('#comment');
comment.addEventListener('input', () => {
  $('#comment-counter').textContent = `${comment.value.length} / 200`;
});

let reportWidget = null;

async function openReportForm(draft) {
  state.draft = draft;
  form.reset();
  $('#comment-counter').textContent = '0 / 200';
  $('#report-error').textContent = '';
  $('#report-location').textContent = draft.source === 'gps'
    ? `Ort: deine aktuelle Position (Genauigkeit ca. ${Math.round(draft.accuracy)} m)`
    : 'Ort: der gewählte Punkt auf der Karte';
  openDialog($('#report-dialog'));
  try {
    reportWidget = await mountTurnstile($('#report-turnstile'), 'report');
  } catch {
    $('#report-error').textContent = errorMessage('captcha_unavailable');
  }
}

$('#report-dialog').addEventListener('close', () => {
  reportWidget?.remove();
  reportWidget = null;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const level = Number(data.get('level'));
  const category = data.get('category');
  const errorBox = $('#report-error');

  if (!level) return void (errorBox.textContent = errorMessage('invalid_level'));
  if (!category) return void (errorBox.textContent = errorMessage('invalid_category'));
  const token = reportWidget?.getToken();
  if (!token) return void (errorBox.textContent = errorMessage('captcha_missing'));

  const submit = $('#report-submit');
  submit.disabled = true;
  submit.textContent = 'Wird gesendet …';
  errorBox.textContent = '';
  try {
    const { report } = await submitReport({
      lat: Number(state.draft.lat.toFixed(6)),
      lng: Number(state.draft.lng.toFixed(6)),
      level,
      category,
      comment: String(data.get('comment') || '').trim() || null,
      turnstileToken: token,
    });
    $('#report-dialog').close();
    // Eigene Meldung sofort sichtbar machen, falls sie zum Filter passt.
    if (state.categories.includes(report.category)) {
      state.reports = [report, ...state.reports];
      render();
    }
    map.panTo([report.lat, report.lng]);
    toast('Danke! Deine Meldung ist jetzt auf der Karte.');
  } catch (err) {
    errorBox.textContent = errorMessage(err.code);
    reportWidget?.reset();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Meldung senden';
  }
});

// ---------------------------------------------------------------------------
// Missbrauch melden
// ---------------------------------------------------------------------------

let flagWidget = null;

async function openFlagDialog(report) {
  state.flagTarget = report;
  map.closePopup();
  $('#flag-error').textContent = '';
  openDialog($('#flag-dialog'));
  try {
    flagWidget = await mountTurnstile($('#flag-turnstile'), 'flag');
  } catch {
    $('#flag-error').textContent = errorMessage('captcha_unavailable');
  }
}

$('#flag-dialog').addEventListener('close', () => {
  flagWidget?.remove();
  flagWidget = null;
});

$('#flag-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = flagWidget?.getToken();
  if (!token) return void ($('#flag-error').textContent = errorMessage('captcha_missing'));
  const btn = $('#flag-submit');
  btn.disabled = true;
  try {
    const res = await flagReport({ reportId: state.flagTarget.id, turnstileToken: token });
    state.flagged.add(state.flagTarget.id);
    save('laermkarte.flagged', [...state.flagged].slice(-500));
    $('#flag-dialog').close();
    if (res.hidden) {
      state.reports = state.reports.filter((r) => r.id !== state.flagTarget.id);
      render();
      toast('Danke. Die Meldung wurde ausgeblendet.');
    } else {
      toast(res.already_flagged ? 'Du hast diese Meldung bereits markiert.' : 'Danke für den Hinweis.');
    }
  } catch (err) {
    $('#flag-error').textContent = errorMessage(err.code);
    flagWidget?.reset();
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

$('#filter-categories').append(
  ...CATEGORIES.map((c) => radioChoice('categories', c.id, c.label, 'checkbox', state.categories.includes(c.id))),
);
const filterForm = $('#filter-form');
filterForm.elements.view.value = state.view;
filterForm.elements.hours.value = String(state.hours);

filterForm.addEventListener('change', (e) => {
  const name = e.target.name;
  if (name === 'view') {
    state.view = e.target.value;
    render();
  } else {
    state.hours = Number(filterForm.elements.hours.value);
    state.categories = [...filterForm.querySelectorAll('input[name="categories"]:checked')].map((i) => i.value);
    refresh();
  }
  persistFilter();
  updateFilterBadge();
});

function updateFilterBadge() {
  const active = state.hours !== 168 || state.categories.length !== allCategoryIds.length;
  $('#filter-btn').classList.toggle('icon-btn--active', active);
}

$('#filter-btn').addEventListener('click', () => openDialog($('#filter-dialog')));
$('#menu-btn').addEventListener('click', () => openDialog($('#info-dialog')));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$('#reset-demo').addEventListener('click', () => {
  resetDemo();
  state.flagged.clear();
  save('laermkarte.flagged', []);
  $('#info-dialog').close();
  refresh();
  toast('Eigene Meldungen und Markierungen wurden gelöscht.');
});

document.body.classList.toggle('demo', DEMO_MODE);
updateFilterBadge();
refresh();
// Ohne Demo-Modus alle 2 Minuten neue Meldungen anderer laden.
if (!DEMO_MODE) {
  setInterval(() => {
    if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) refresh();
  }, 120_000);
}
