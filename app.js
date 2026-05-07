/* ═══════════════════════════════════════════════════════════════════════
   Gridlytics — Frontend Dashboard
   Vanilla JS + Leaflet + Chart.js  |  No build step required
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

// ─── Global state ────────────────────────────────────────────────────────────
const STATE = {
  dashboardMode: 'local',          // 'india' | 'local' (LOCAL is the default — BESCOM Theme 8 focus)
  mapView      : 'sm',             // 'tampering' | 'htls' | 'sm' (India sub-view)
  localView    : 'meters',         // 'meters' | 'zones' | 'inspector' | 'whatif' — Meter Anomalies default
  density      : 'meter',          // 'meter' | 'zone' — within Meter Anomalies view
  selectedZone : null,             // currently focused zone (for drill-down)
  pinnedMeter  : null,             // currently pinned meter (right panel locked)
  layerOn      : { critical: true, high: true, moderate: true, normal: false },
  iexDays      : 60,
  genDays      : 60,
  battCapacity : 1.0,
  data: {
    intelligence : [],
    arbitrage    : [],
    atc          : [],
    forecast     : [],
    histPrices   : [],
    generation   : [],
    battery      : [],
    models       : [],
    hindi        : null,
    // Local mode datasets
    meters       : [],
    feeders      : [],
    zoneForecast : [],
    evidence     : [],
    whatif       : [],
  },
};

// Chart.js global defaults (dark theme)
Chart.defaults.color            = '#8899aa';
Chart.defaults.borderColor      = '#1e2d42';
Chart.defaults.font.family      = "'Inter', system-ui, sans-serif";
Chart.defaults.font.size        = 11;
Chart.defaults.plugins.legend.labels.boxWidth  = 10;
Chart.defaults.plugins.legend.labels.padding   = 14;
Chart.defaults.plugins.tooltip.backgroundColor = '#0e1623';
Chart.defaults.plugins.tooltip.borderColor     = '#1e2d42';
Chart.defaults.plugins.tooltip.borderWidth     = 1;
Chart.defaults.plugins.tooltip.titleColor      = '#e8edf5';
Chart.defaults.plugins.tooltip.bodyColor       = '#8899aa';
Chart.defaults.plugins.tooltip.padding         = 10;
Chart.defaults.animation        = false;

const charts = {};
let map, markerLayer, stateLayer;
const INDIA_GEOJSON = 'https://raw.githubusercontent.com/geohacker/india/master/state/india_state.geojson';

// ─── API helpers ─────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const r = await fetch(path);
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${txt.slice(0,200)}`);
  }
  const data = await r.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

function showApiError(msg) {
  let el = document.getElementById('api-error-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'api-error-banner';
    el.style.cssText = `position:fixed;bottom:0;left:0;right:0;background:#7f1d1d;color:#fca5a5;
      padding:8px 16px;font-size:12px;z-index:9998;display:flex;align-items:center;gap:10px;`;
    document.body.appendChild(el);
  }
  el.innerHTML = `<b>⚠ API Error:</b> ${msg} &nbsp;
    <a href="/api/debug" target="_blank" style="color:#fcd34d;text-decoration:underline">debug</a>
    <button onclick="this.parentElement.remove()" style="margin-left:auto;background:transparent;border:none;color:#fca5a5;cursor:pointer;font-size:16px">×</button>`;
}

// ─── Utility ─────────────────────────────────────────────────────────────────
const fmt = {
  cr   : raw => { const v = parseFloat(raw) || 0; return v >= 1e4 ? `₹${(v/1e4).toFixed(1)}L Cr` : v >= 100 ? `₹${Math.round(v).toLocaleString('en-IN')} Cr` : `₹${v.toFixed(1)} Cr`; },
  kwh  : raw => `₹${(parseFloat(raw) || 0).toFixed(2)}/kWh`,
  pct  : raw => `${(parseFloat(raw) || 0).toFixed(1)}%`,
  m    : raw => { const v = parseFloat(raw) || 0; return v >= 1e7 ? `${(v/1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v/1e5).toFixed(1)}L` : Math.round(v).toLocaleString('en-IN'); },
};

function toFloat(v) { return parseFloat(v) || 0; }

function stateNorm(name) {
  const m = { 'Orissa': 'Odisha', 'Uttaranchal': 'Uttarakhand', 'Uttarakhand': 'Uttarakhand',
               'Jammu & Kashmir': 'Jammu and Kashmir', 'Delhi': 'Delhi', 'NCT of Delhi': 'Delhi' };
  return m[name] || name;
}

function riskColor(label) {
  return { Critical: '#ef4444', High: '#f97316', Moderate: '#f59e0b', Low: '#10b981' }[label] || '#8899aa';
}

function riskClass(label) {
  return { Critical: 'risk-critical', High: 'risk-high', Moderate: 'risk-moderate', Low: 'risk-low' }[label] || '';
}

// ─── Loader progress bar (bumpy, genuine-looking) ────────────────────────────
let _loaderTimer = null;

function runLoader(onDone) {
  const fill   = document.getElementById('loader-fill');
  const status = document.getElementById('loader-status');
  const steps = [
    // [target%, delay ms, status message]
    [18,  150,  'Connecting to Delta Lake…'],
    [35,  220,  'Loading IEX DAM prices…'],
    [52,  190,  'Fetching AT&C loss data…'],
    [68,  420,  'Running anomaly scores…'],   // deliberate bump — feels like real computation
    [68,  580,  'Building grid intelligence…'], // hold at 68%
    [74,  110,  'Loading battery dispatch…'],
    [83,  210,  'Fetching price forecast…'],
    [91,  160,  'Loading generation mix…'],
    [96,  140,  'Rendering dashboard…'],
    [100, 100,  'Ready!'],
  ];
  let i = 0;
  function tick() {
    if (i >= steps.length) { onDone(); return; }
    const [pct, delay, msg] = steps[i++];
    fill.style.transition = `width ${Math.round(delay * 0.75)}ms ease`;
    fill.style.width = pct + '%';
    if (status) status.textContent = msg;
    _loaderTimer = setTimeout(tick, delay);
  }
  tick();
}

function hideLoader() {
  if (_loaderTimer) clearTimeout(_loaderTimer);
  const fill   = document.getElementById('loader-fill');
  const loader = document.getElementById('page-loader');
  if (fill)   { fill.style.transition = 'width 200ms ease'; fill.style.width = '100%'; }
  setTimeout(() => { if (loader) loader.classList.add('hidden'); }, 250);
}

// ─── Shimmer placeholders ─────────────────────────────────────────────────────
function shimmerChart(canvasId, height = '100%') {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.closest('.chart-wrap');
  if (!wrap) return;
  canvas.style.display = 'none';
  if (!wrap.querySelector('.shimmer-block')) {
    const s = document.createElement('div');
    s.className = 'shimmer-block';
    s.style.height = wrap.style.height || height;
    wrap.appendChild(s);
  }
}

function unshimmerChart(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.closest('.chart-wrap');
  if (!wrap) return;
  canvas.style.display = '';
  wrap.querySelectorAll('.shimmer-block').forEach(s => s.remove());
}

function shimmerEl(id, lines = 3) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = Array.from({length: lines}, (_, i) =>
    `<div class="shimmer-block" style="height:14px;width:${70 + (i % 3) * 10}%;margin-bottom:6px;border-radius:4px"></div>`
  ).join('');
}

function applyAllShimmers() {
  shimmerEl('model-table', 4);
  shimmerEl('discom-table', 5);
  // KPI values
  ['kpi-theft','kpi-htls','kpi-sm','kpi-signal','kpi-spread'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = '<span class="shimmer-inline"></span>'; }
  });
}

// ─── FETCH ALL DATA (parallel) ───────────────────────────────────────────────
const API_ROUTES = {
  intelligence : '/api/intelligence',
  arbitrage    : '/api/arbitrage',
  atc          : '/api/atc',
  forecast     : '/api/forecast',
  histPrices   : '/api/hist-prices',
  generation   : '/api/generation',
  battery      : '/api/battery',
  models       : '/api/models',
  hindi        : '/api/hindi',
  // Local mode endpoints (BESCOM smart meter data)
  meters       : '/api/meters',
  feeders      : '/api/feeders',
  zoneForecast : '/api/zone-forecasts',
  evidence     : '/api/evidence-packets',
  whatif       : '/api/whatif-scenarios',
};

// Fetch one key, store result, then immediately render that panel
async function fetchAndRender(key) {
  try {
    const data = await apiFetch(API_ROUTES[key]);
    STATE.data[key] = Array.isArray(data) ? data : (data ? [data] : []);
    if (key === 'hindi' && STATE.data[key].length) STATE.data.hindi = STATE.data[key][0];
    console.log(`[${key}] ✓ ${STATE.data[key].length} rows`);
  } catch (e) {
    console.error(`[${key}] ✗`, e.message);
    showApiError(`[${key}] ${e.message}`);
    // Always unblock the map on intelligence failure — don't leave spinner stuck
    if (key === 'intelligence') {
      document.getElementById('map-loading').classList.add('hidden');
    }
    return;
  }

  // Render just this panel immediately
  switch (key) {
    case 'arbitrage':
      unshimmerChart('chart-iex');
      renderIexChart();
      renderKPIs();
      break;
    case 'atc':
      unshimmerChart('chart-atc');
      renderAtcChart();
      break;
    case 'battery':
      unshimmerChart('chart-battery');
      renderBatteryChart();
      break;
    case 'forecast':
    case 'histPrices':
      // Need both before rendering forecast
      if (STATE.data.forecast.length && STATE.data.histPrices.length) {
        unshimmerChart('chart-forecast');
        renderForecastChart();
      }
      break;
    case 'generation':
      unshimmerChart('chart-gen');
      renderGenChart();
      break;
    case 'models':
    case 'hindi':
      renderModelTable();
      break;
    case 'intelligence':
      renderKPIs();
      renderDiscomTable();
      // Only render DISCOM markers in India mode — Local mode uses meter dots instead
      if (map && STATE.dashboardMode === 'india') renderMapMarkers();
      document.getElementById('map-loading').classList.add('hidden');
      STATE._tamperingRendered = false;
      STATE._htlsRendered = false;
      STATE._smRendered = false;
      switchViewDashboard(STATE.mapView);
      break;
    case 'meters':
    case 'feeders':
    case 'zoneForecast':
    case 'evidence':
    case 'whatif':
      STATE._localZonesRendered = false;
      STATE._localMetersRendered = false;
      STATE._localInspectorRendered = false;
      STATE._localWhatifRendered = false;
      if (STATE.dashboardMode === 'local') {
        renderLocalKPIs();
        populateZoneChips();
        renderLocalSubView(STATE.localView);
        // CRITICAL: render meter dots on the map as soon as meter data arrives
        if (map) renderMeterMapMarkers();
      }
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════ MAP

async function initMap() {
  map = L.map('india-map', {
    center              : [22.0, 80.5],
    zoom                : 5,
    zoomControl         : true,
    attributionControl  : true,
    preferCanvas        : true,  // better performance for many circle markers
  });

  // Leaflet must know the container size — recalculate after CSS grid settles
  setTimeout(() => { map.invalidateSize(); map.setView([22.0, 80.5], 5); }, 100);
  setTimeout(() => { map.invalidateSize(); }, 500);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    subdomains : 'abcd',
    maxZoom    : 18,
  }).addTo(map);

  // Load India state boundaries for choropleth (4s timeout — GitHub may be blocked in Databricks env)
  try {
    const gj = await Promise.race([
      fetch(INDIA_GEOJSON).then(r => r.json()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('GeoJSON fetch timed out')), 6000)),
    ]);
    const stateAgg = buildStateAggregates();
    stateLayer = L.geoJSON(gj, {
      style   : (f) => stateStyle(f, stateAgg),
      onEachFeature: (f, layer) => {
        const name = stateNorm(f.properties.NAME_1);
        const agg  = stateAgg[name];
        if (agg) {
          layer.bindTooltip(`<b>${name}</b><br/>Avg tampering: ${agg.tampering.toFixed(0)}/100<br/>Est theft: ₹${Math.round(agg.theft_cr).toLocaleString('en-IN')} Cr`, {
            className: 'leaflet-dark-tooltip', sticky: true,
          });
        }
      },
    }).addTo(map);
  } catch (e) {
    console.warn('GeoJSON load failed (map will show dots only):', e.message);
  }

  markerLayer = L.layerGroup().addTo(map);
  renderMapMarkers();
}

function buildStateAggregates() {
  const agg = {};
  for (const d of STATE.data.intelligence) {
    const s = d.state;
    if (!agg[s]) agg[s] = { tampering: 0, htls_cr: 0, sm_pct: 0, theft_cr: 0, n: 0 };
    agg[s].tampering += toFloat(d.tampering_index);
    agg[s].htls_cr   += toFloat(d.htls_annual_saving_cr);
    agg[s].sm_pct    += toFloat(d.sm_installation_pct);
    agg[s].theft_cr  += toFloat(d.est_theft_rev_loss_cr);
    agg[s].n++;
  }
  for (const k of Object.keys(agg)) {
    const a = agg[k];
    a.tampering /= a.n;
    a.sm_pct    /= a.n;
    // htls_cr and theft_cr are totals
  }
  return agg;
}

function stateStyle(feature, agg) {
  const name = stateNorm(feature.properties.NAME_1);
  const data = agg[name];
  const base = { weight: 0.8, color: '#2a3f5a', fillOpacity: 0.35 };
  if (!data) return { ...base, fillColor: 'rgba(30,45,66,0.3)' };

  let val, lo, hi, from, to;
  if (STATE.mapView === 'tampering') {
    val = data.tampering; lo = 0; hi = 100;
    from = [30, 58, 100]; to = [127, 29, 29]; // #1e3a64 → #7f1d1d
  } else if (STATE.mapView === 'htls') {
    val = data.htls_cr / data.n; lo = 0; hi = 2000;
    from = [14, 42, 86]; to = [29, 78, 216]; // #0e2a56 → #1d4ed8
  } else {
    val = 100 - data.sm_pct; lo = 0; hi = 100;
    from = [5, 46, 22]; to = [21, 128, 61]; // #052e16 → #15803d
  }
  const t = Math.min(1, Math.max(0, (val - lo) / (hi - lo)));
  const r = Math.round(from[0] + (to[0] - from[0]) * t);
  const g = Math.round(from[1] + (to[1] - from[1]) * t);
  const b = Math.round(from[2] + (to[2] - from[2]) * t);
  return { ...base, fillColor: `rgb(${r},${g},${b})` };
}

function renderMapMarkers() {
  markerLayer.clearLayers();
  for (const d of STATE.data.intelligence) {
    const lat = toFloat(d.lat);
    const lon = toFloat(d.lon);
    if (!lat || !lon) continue;

    let val, color, size;
    if (STATE.mapView === 'tampering') {
      val   = toFloat(d.tampering_index);
      color = val >= 65 ? '#ef4444' : val >= 40 ? '#f97316' : val >= 20 ? '#f59e0b' : '#10b981';
      size  = Math.max(4, Math.min(13, toFloat(d.est_theft_rev_loss_cr) / 600 * 11));
    } else if (STATE.mapView === 'htls') {
      val   = toFloat(d.htls_annual_saving_cr);
      color = val >= 1000 ? '#1d4ed8' : val >= 400 ? '#3b82f6' : val >= 100 ? '#60a5fa' : '#93c5fd';
      size  = Math.max(4, Math.min(13, val / 1200 * 12));
    } else {
      const pct = toFloat(d.sm_installation_pct);
      val   = 100 - pct;
      color = pct < 15 ? '#15803d' : pct < 30 ? '#16a34a' : pct < 55 ? '#22c55e' : '#86efac';
      size  = Math.max(4, Math.min(13, val / 100 * 12));
    }

    const marker = L.circleMarker([lat, lon], {
      radius     : size,
      fillColor  : color,
      color      : 'rgba(255,255,255,0.25)',
      weight     : 1,
      fillOpacity: 0.85,
    });

    marker.bindTooltip(`<b>${d.discom}</b><br/>${d.state} · ${d.tampering_label || ''}`, { sticky: true, className: 'leaflet-dark-tooltip' });
    marker.on('click', () => openDiscomDrawer(d));
    markerLayer.addLayer(marker);
  }
}

function buildPopup(d) {
  const tLabel = d.tampering_label || 'N/A';
  const tColor = riskColor(tLabel);
  return `
    <div class="popup-discom">
      <h4>${d.discom} <span style="color:${tColor};font-size:11px">(${tLabel})</span></h4>
      <div class="popup-row"><span class="popup-label">State</span><span class="popup-val">${d.state}</span></div>
      <div class="popup-row"><span class="popup-label">AT&C Loss</span><span class="popup-val">${fmt.pct(d.atc_pct_2024)}</span></div>
      <div class="popup-row"><span class="popup-label">Commercial theft</span><span class="popup-val" style="color:${tColor}">${fmt.pct(d.commercial_loss_ppt)} ppt</span></div>
      <div class="popup-row"><span class="popup-label">Billing gap</span><span class="popup-val">${fmt.pct(d.billing_gap_pct)}</span></div>
      <div class="popup-row"><span class="popup-label">Est. theft loss</span><span class="popup-val">${fmt.cr(d.est_theft_rev_loss_cr)}/yr</span></div>
      <hr style="border-color:#1e2d42;margin:5px 0"/>
      <div class="popup-row"><span class="popup-label">HTLS saving</span><span class="popup-val" style="color:#3b82f6">${fmt.cr(d.htls_annual_saving_cr)}/yr</span></div>
      <div class="popup-row"><span class="popup-label">HTLS payback</span><span class="popup-val">${toFloat(d.htls_payback_yr).toFixed(1)} yrs</span></div>
      <hr style="border-color:#1e2d42;margin:5px 0"/>
      <div class="popup-row"><span class="popup-label">SM installed</span><span class="popup-val">${fmt.pct(d.sm_installation_pct)}</span></div>
      <div class="popup-row"><span class="popup-label">Meters pending</span><span class="popup-val">${fmt.m(d.sm_remaining)}</span></div>
      <div class="popup-row"><span class="popup-label">ToU saving</span><span class="popup-val" style="color:#10b981">${fmt.cr(d.sm_annual_tou_saving_cr)}/yr</span></div>
      <div class="popup-row" style="margin-top:4px"><span class="popup-label">ML flag</span><span style="font-size:10px;color:#8b5cf6">${(d.anomaly_type||'').replace(/_/g,' ')}</span></div>
    </div>`;
}

function updateMapView(view) {
  STATE.mapView = view;
  renderMapMarkers();
  if (STATE.data.intelligence.length) renderDiscomTable();
  if (stateLayer) {
    const agg = buildStateAggregates();
    stateLayer.setStyle((f) => stateStyle(f, agg));
  }
  updateLegend();
  switchViewDashboard(view);
}

function switchViewDashboard(view) {
  ['tampering','htls','sm'].forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.style.display = v === view ? '' : 'none';
  });
  if (view === 'tampering' && STATE.data.intelligence.length && !STATE._tamperingRendered) {
    renderTamperingDashboard();
    STATE._tamperingRendered = true;
  }
  if (view === 'htls' && STATE.data.intelligence.length && !STATE._htlsRendered) {
    renderHtlsDashboard();
    STATE._htlsRendered = true;
  }
  if (view === 'sm' && STATE.data.intelligence.length && !STATE._smRendered) {
    renderSmDashboard();
    STATE._smRendered = true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//                    LOCAL MODE (BESCOM Smart-Meter Intelligence)
// ═══════════════════════════════════════════════════════════════════════════

const BENGALURU_CENTER = [12.9716, 77.5946];
const INDIA_CENTER     = [22.0, 80.5];

function switchDashboardMode(mode) {
  STATE.dashboardMode = mode;
  try { localStorage.setItem('gridlytics_mode', mode); } catch (e) {}

  const indiaPanel = document.getElementById('mode-india');
  const localPanel = document.getElementById('mode-local');
  const indiaTog   = document.getElementById('map-view-toggle');
  const localTog   = document.getElementById('local-view-toggle');
  const mlStrip    = document.getElementById('ml-perf-strip');
  const logoSub    = document.querySelector('.logo-sub');

  if (mode === 'local') {
    if (indiaPanel) indiaPanel.style.display = 'none';
    if (localPanel) localPanel.style.display = '';
    if (indiaTog) indiaTog.style.display = 'none';
    if (localTog) localTog.style.display = '';
    if (mlStrip) mlStrip.style.display = 'none';
    if (logoSub) logoSub.textContent = 'Smart Meter Intelligence · Bengaluru';

    if (map) {
      if (markerLayer) markerLayer.clearLayers();
      if (stateLayer) map.removeLayer(stateLayer);
    }

    // Step 1: apply layout (toggles fullbleed body attribute → CSS swaps map width to 100%)
    applyLocalSubView(STATE.localView);

    // Step 2: AFTER layout has applied, recalc map size AND set Bengaluru view
    setTimeout(() => {
      if (map) {
        map.invalidateSize();
        map.setView(BENGALURU_CENTER, 11, { animate: false });
        renderMeterMapMarkers();
      }
    }, 120);

    renderLocalKPIs();
    renderLocalSubView(STATE.localView);
    populateZoneChips();
  } else {
    if (indiaPanel) indiaPanel.style.display = '';
    if (localPanel) localPanel.style.display = 'none';
    if (indiaTog) indiaTog.style.display = '';
    if (localTog) localTog.style.display = 'none';
    if (mlStrip && STATE.data.models.length) mlStrip.style.display = '';
    if (logoSub) logoSub.textContent = 'Energy P&L Intelligence · India';

    document.body.removeAttribute('data-fullbleed');
    const tactical = document.getElementById('tactical-overlay');
    if (tactical) tactical.style.display = 'none';

    setTimeout(() => {
      if (map) {
        map.invalidateSize();
        map.setView(INDIA_CENTER, 5, { animate: false });
        if (stateLayer && !map.hasLayer(stateLayer)) map.addLayer(stateLayer);
        renderMapMarkers();
      }
    }, 120);
  }
}

// Apply visual layout for a Local sub-view (toggles fullbleed / tactical overlay)
function applyLocalSubView(view) {
  const tactical = document.getElementById('tactical-overlay');
  if (view === 'meters') {
    document.body.setAttribute('data-fullbleed', '1');
    if (tactical) tactical.style.display = 'block';
  } else {
    document.body.removeAttribute('data-fullbleed');
    if (tactical) tactical.style.display = 'none';
  }
  // Force map size recalc on layout change (caller is expected to setView afterwards if needed)
  setTimeout(() => {
    if (map) {
      map.invalidateSize();
      if (STATE.dashboardMode === 'local') {
        // Keep current center if already in Bengaluru area, else snap to it
        const z = map.getZoom();
        if (z < 9) map.setView(BENGALURU_CENTER, 11, { animate: false });
      }
    }
  }, 100);
}

function switchLocalView(view) {
  STATE.localView = view;
  STATE.pinnedMeter = null;  // clear pinned state on view change
  ['zones','meters','inspector','whatif'].forEach(v => {
    const el = document.getElementById(`lview-${v}`);
    if (el) el.style.display = v === view ? '' : 'none';
  });
  applyLocalSubView(view);
  renderLocalSubView(view);
  if (map && STATE.dashboardMode === 'local') {
    renderMeterMapMarkers();
  }
  // Refresh KPIs + chips when entering Meters view (also auto-populates right panel)
  if (view === 'meters') {
    renderLocalKPIs();
    populateZoneChips();
  }
}

function renderLocalSubView(view) {
  if (view === 'zones' && STATE.data.zoneForecast.length && !STATE._localZonesRendered) {
    renderZoneForecastView();
    STATE._localZonesRendered = true;
  }
  if (view === 'meters' && STATE.data.meters.length && !STATE._localMetersRendered) {
    renderMeterAnomalyView();
    STATE._localMetersRendered = true;
  }
  if (view === 'inspector' && STATE.data.evidence.length && !STATE._localInspectorRendered) {
    renderInspectorQueue();
    STATE._localInspectorRendered = true;
  }
  if (view === 'whatif' && STATE.data.whatif.length && !STATE._localWhatifRendered) {
    renderWhatIfView();
    STATE._localWhatifRendered = true;
  }
}

// ── Local KPIs (both inline + bottom-overlay) ──────────────────────────────
function renderLocalKPIs() {
  const meters = STATE.data.meters || [];
  const zones  = STATE.data.zoneForecast || [];
  if (!meters.length) return;

  const flagged = meters.filter(m => m.is_theft);
  const peakZone = zones.length ? zones.reduce((a, b) => a.peak_mw > b.peak_mw ? a : b) : null;
  const monthlyLoss = flagged.reduce((s, m) => s + (m.est_revenue_loss_inr || 0), 0);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  // Inline KPI cards (used in non-fullbleed sub-views)
  set('lkpi-meters', meters.length.toLocaleString('en-IN'));
  set('lkpi-flagged', `${flagged.length}`);
  set('lkpi-peak', peakZone ? `${peakZone.peak_mw} MW` : '–');
  set('lkpi-peak-zone', peakZone ? `${peakZone.zone_name} · ${peakZone.peak_hour}:00` : 'next 24h');
  set('lkpi-loss', `₹${(monthlyLoss / 100000).toFixed(1)}L`);

  // Bottom tactical-overlay KPI strip (Meter Anomalies fullbleed view)
  set('bm-meters', meters.length.toLocaleString('en-IN'));
  set('bm-flagged', `${flagged.length}`);
  set('bm-peak', peakZone ? `${peakZone.peak_mw}` : '–');
  set('bm-peak-zone', peakZone ? `${peakZone.zone_name} @ ${peakZone.peak_hour}:00` : 'next 24h');
  set('bm-loss', `₹${(monthlyLoss / 100000).toFixed(1)}L`);

  // Layer counts
  const sevCount = { Critical: 0, High: 0, Moderate: 0, Low: 0 };
  meters.forEach(m => sevCount[m.severity] = (sevCount[m.severity] || 0) + 1);
  set('lyr-critical', sevCount.Critical);
  set('lyr-high', sevCount.High);
  set('lyr-moderate', sevCount.Moderate);
  set('lyr-normal', sevCount.Low);

  // Default detail panel content: top alert
  if (!STATE.pinnedMeter) {
    const top = (STATE.data.evidence || [])[0];
    if (top) updateDetailPanelForMeter(findMeterById(top.meter_id) || top, false);
  }
}

function findMeterById(id) {
  return (STATE.data.meters || []).find(m => m.meter_id === id);
}

// ── Detail panel (right floating) ──────────────────────────────────────────
function updateDetailPanelForMeter(m, pinned) {
  const panel = document.getElementById('detail-panel');
  if (!panel || !m) return;

  // Look up evidence for richer content if this meter has a packet
  const ev = (STATE.data.evidence || []).find(e => e.meter_id === m.meter_id);

  const sev = m.severity || ev?.severity || 'Low';
  const pinClass = sev === 'Critical' ? 'pin-critical' : sev === 'High' ? 'pin-high' : sev === 'Moderate' ? 'pin-moderate' : 'pin-low';

  if (!ev) {
    // Hover/quick view
    panel.innerHTML = `
      <div class="detail-head">
        <span class="detail-id">${m.meter_id || 'METER'}</span>
        <span class="detail-pin ${pinClass}">${sev}</span>
      </div>
      <div class="detail-body">
        <h4>METER PROFILE</h4>
        <div class="detail-row"><span>Zone</span><b>${m.zone_name || '–'}</b></div>
        <div class="detail-row"><span>Feeder</span><b>${m.feeder_id || '–'}</b></div>
        <div class="detail-row"><span>Category</span><b>${m.category_label || '–'}</b></div>
        <div class="detail-row"><span>Peer Cohort</span><b><small>${m.peer_cohort || '–'}</small></b></div>

        <h4>CONSUMPTION</h4>
        <div class="detail-row"><span>Last 24h</span><b class="v-num">${(m.last_24h_kwh || 0).toFixed(1)} kWh</b></div>
        <div class="detail-row"><span>Avg load</span><b class="v-num">${(m.avg_load_kw || 0).toFixed(2)} kW</b></div>
        <div class="detail-row"><span>Monthly</span><b class="v-num">${(m.monthly_kwh || 0).toFixed(0)} kWh</b></div>

        <h4>ANOMALY SCORE</h4>
        <div class="detail-bar">
          <span class="detail-bar-label">${sev}</span>
          <div class="detail-bar-track"><div class="detail-bar-fill" style="width:${m.anomaly_score || 0}%"></div></div>
          <span class="detail-bar-val">${m.anomaly_score || 0}</span>
        </div>
        ${m.is_theft ? `<div class="detail-row" style="margin-top:6px"><span>Archetype</span><b>${m.theft_label}</b></div>` : ''}
      </div>
    `;
    return;
  }

  // Full evidence packet
  const shapHtml = (ev.shap_features || []).map(f => `
    <div class="detail-bar">
      <span class="detail-bar-label">${f.feature}</span>
      <div class="detail-bar-track"><div class="detail-bar-fill ${f.impact < 0 ? 'neg' : ''}" style="width:${Math.abs(f.impact * 100)}%"></div></div>
      <span class="detail-bar-val">${f.impact > 0 ? '+' : ''}${f.impact.toFixed(2)}</span>
    </div>
  `).join('');

  panel.innerHTML = `
    <div class="detail-head">
      <span class="detail-id">${ev.meter_id}</span>
      <span class="detail-pin ${pinClass}">${sev}</span>
    </div>
    <div class="detail-body">
      <h4>⚡ 24H · 15-MIN CONSUMPTION</h4>
      <div class="detail-chart-legend">
        <span><span class="legend-dot legend-peer"></span>Peer baseline</span>
        <span><span class="legend-dot legend-obs"></span>Observed</span>
      </div>
      <canvas id="detail-ts-chart" class="detail-spark"></canvas>

      <h4>📍 LOCATION</h4>
      <div class="detail-row"><span>Zone</span><b>${ev.zone_name}</b></div>
      <div class="detail-row"><span>Feeder</span><b>${ev.feeder_id}</b></div>
      <div class="detail-row"><span>Category</span><b>${ev.category_label}</b></div>

      <h4>⚠ THEFT INDICATORS</h4>
      <div class="detail-row"><span>Archetype</span><b>${ev.theft_label}</b></div>
      <div class="detail-row"><span>Anomaly score</span><b class="v-num">${ev.anomaly_score}/100</b></div>
      <div class="detail-row"><span>Confidence</span><b class="v-num">${ev.confidence_pct}%</b></div>
      <div class="detail-row"><span>Est. monthly loss</span><b class="v-num" style="color:#fbbf24">₹${(ev.est_revenue_loss_inr || 0).toLocaleString('en-IN')}</b></div>

      <h4>🔬 SHAP ATTRIBUTION</h4>
      ${shapHtml}

      <h4>🧠 CAUSAL CHAIN</h4>
      <ol class="detail-causal">
        ${(ev.causal_chain || []).map(c => `<li>${c}</li>`).join('')}
      </ol>

      <h4>🤖 AI BRIEF</h4>
      <div class="detail-brief">
        <div class="detail-brief-label">LOCAL LLAMA 3.1 · OFFLINE</div>
        ${ev.llm_brief}
      </div>

      <div class="detail-action">
        <b>RECOMMENDED:</b> ${ev.recommended_action}
      </div>
    </div>
    <div class="detail-actions-row">
      <button class="detail-act-btn primary" onclick="dispatchInspection('${ev.meter_id}')">DISPATCH INSPECTION</button>
      <button class="detail-act-btn" onclick="clearPinned()">CLEAR</button>
    </div>
  `;

  // Render the 1-day (24h, 96 × 15-min) time-series chart inside the right panel
  setTimeout(() => {
    const ctx = document.getElementById('detail-ts-chart');
    if (!ctx || !ev.observed_kw_15min || !ev.peer_baseline_kw_15min) return;
    if (charts.detailTs) charts.detailTs.destroy();

    // Slice to the last day only (last 96 intervals = 24h × 4)
    const peer = ev.peer_baseline_kw_15min.slice(-96);
    const obs  = ev.observed_kw_15min.slice(-96);
    // Hour labels at 00:00 / 06:00 / 12:00 / 18:00 / 23:45
    const labels = Array.from({ length: 96 }, (_, i) => {
      if (i % 24 === 0) {
        const h = Math.floor(i / 4);
        return `${String(h).padStart(2,'0')}:00`;
      }
      return '';
    });

    charts.detailTs = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Peer baseline',
            data: peer,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16,185,129,0.08)',
            borderWidth: 1.4,
            pointRadius: 0,
            tension: 0.3,
            fill: false,
          },
          {
            label: 'Observed',
            data: obs,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239,68,68,0.12)',
            borderWidth: 1.6,
            pointRadius: 0,
            tension: 0.3,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 320 },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const i = items[0].dataIndex;
                const h = Math.floor(i / 4);
                const mm = (i % 4) * 15;
                return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
              },
              label: (c) => `${c.dataset.label}: ${c.raw.toFixed(2)} kW`,
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: '#64748b',
              font: { size: 9 },
              autoSkip: false,
              maxRotation: 0,
              callback: function(val) { const lbl = this.getLabelForValue(val); return lbl || ''; },
            },
            grid: { color: 'rgba(30,45,66,0.4)', drawTicks: false },
          },
          y: {
            ticks: {
              color: '#64748b',
              font: { size: 9 },
              callback: v => `${v} kW`,
              maxTicksLimit: 4,
            },
            grid: { color: 'rgba(30,45,66,0.3)' },
          },
        },
      },
    });
  }, 30);
}

function updateDetailPanelForZone(z, pinned) {
  const panel = document.getElementById('detail-panel');
  if (!panel || !z) return;

  const driversBars = Object.entries(z.drivers || {}).map(([k, v]) => `
    <div class="detail-bar">
      <span class="detail-bar-label">${k.replace(/_/g, ' ')}</span>
      <div class="detail-bar-track"><div class="detail-bar-fill" style="width:${(v * 100).toFixed(0)}%"></div></div>
      <span class="detail-bar-val">${(v * 100).toFixed(0)}%</span>
    </div>
  `).join('');

  const pinClass = z.risk_level === 'Critical' ? 'pin-critical' : z.risk_level === 'High' ? 'pin-high' : z.risk_level === 'Moderate' ? 'pin-moderate' : 'pin-low';

  panel.innerHTML = `
    <div class="detail-head">
      <span class="detail-id">${z.zone_name.toUpperCase()}</span>
      <span class="detail-pin ${pinClass}">${z.risk_level}</span>
    </div>
    <div class="detail-body">
      <h4>📊 ZONE METRICS</h4>
      <div class="detail-row"><span>Type</span><b>${z.type.replace(/_/g, ' ')}</b></div>
      <div class="detail-row"><span>Meters monitored</span><b class="v-num">${z.n_meters}</b></div>
      <div class="detail-row"><span>Flagged</span><b class="v-num" style="color:#fca5a5">${z.n_flagged}</b></div>

      <h4>⚡ FORECAST (next 24h)</h4>
      <div class="detail-row"><span>Peak load</span><b class="v-num">${z.peak_mw} MW @ ${z.peak_hour}:00</b></div>
      <div class="detail-row"><span>Avg load</span><b class="v-num">${z.avg_mw} MW</b></div>
      <div class="detail-row"><span>AT&C loss</span><b class="v-num">${z.atc_pct}%</b></div>
      <div class="detail-row"><span>AC penetration</span><b class="v-num">${(z.ac_penetration * 100).toFixed(0)}%</b></div>

      <h4>🌡️ DRIVER ATTRIBUTION</h4>
      ${driversBars}
    </div>
    ${STATE.localView === 'meters' && STATE.density === 'zone' ? `
      <div class="detail-actions-row">
        <button class="detail-act-btn primary" onclick="drillIntoZone('${z.zone_id}')">DRILL INTO METERS</button>
      </div>` : ''}
  `;
}

window.dispatchInspection = function(meterId) {
  alert(`Inspection dispatched for ${meterId}.\n\n(Demo: in production, this triggers field-team workflow + audit log.)`);
};
window.clearPinned = function() {
  STATE.pinnedMeter = null;
  const panel = document.getElementById('detail-panel');
  if (panel) panel.innerHTML = `
    <div class="detail-empty">
      <div class="detail-empty-icon">📡</div>
      <div class="detail-empty-text">Hover or click a meter to inspect</div>
    </div>`;
};
window.drillIntoZone = function(zoneId) {
  const z = (STATE.data.zoneForecast || []).find(zz => zz.zone_id === zoneId);
  if (!z) return;
  STATE.selectedZone = zoneId;
  STATE.density = 'meter';
  document.querySelectorAll('.density-btn').forEach(b => b.classList.toggle('active', b.dataset.density === 'meter'));
  const dEl = document.getElementById('bm-density'); if (dEl) dEl.textContent = 'METER';
  const dSub = document.getElementById('bm-density-sub'); if (dSub) dSub.textContent = `drilled into ${z.zone_name}`;
  const metaView = document.getElementById('meta-view'); if (metaView) metaView.textContent = 'METER · ' + z.zone_name.toUpperCase();
  if (map) map.flyTo([z.lat, z.lon], 13, { duration: 0.6 });
  renderMeterMapMarkers();
};

// ── Zone chip list (left toolbar) ─────────────────────────────────────────
function populateZoneChips() {
  const list = document.getElementById('zone-chip-list');
  if (!list) return;
  const zones = STATE.data.zoneForecast || [];
  list.innerHTML = zones.map(z => `
    <span class="zone-chip ${z.n_flagged > 0 ? 'zone-chip-flagged' : ''}" data-zone-id="${z.zone_id}">
      ${z.zone_name}
    </span>
  `).join('');
  list.querySelectorAll('.zone-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const z = zones.find(zz => zz.zone_id === chip.dataset.zoneId);
      if (!z) return;
      list.querySelectorAll('.zone-chip').forEach(c => c.classList.remove('active'));
      if (STATE.selectedZone === z.zone_id) {
        STATE.selectedZone = null;
        if (map) map.flyTo(BENGALURU_CENTER, 11, { duration: 0.5 });
      } else {
        STATE.selectedZone = z.zone_id;
        chip.classList.add('active');
        if (map) map.flyTo([z.lat, z.lon], 13, { duration: 0.6 });
      }
      const metaZ = document.getElementById('meta-zone');
      if (metaZ) metaZ.textContent = STATE.selectedZone ? z.zone_name.toUpperCase() : 'BENGALURU';
      renderMeterMapMarkers();
      updateDetailPanelForZone(z, true);
    });
  });
}

// ── Local Map Markers (Meter Anomalies = density toggle, others = zones) ──
function renderMeterMapMarkers() {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();

  const meters = STATE.data.meters || [];
  const zones  = STATE.data.zoneForecast || [];
  if (!meters.length) return;

  // Zone Forecast / What-If: show zone bubbles (one per zone)
  if (STATE.localView === 'zones' || STATE.localView === 'whatif') {
    drawZoneBubbles(zones);
    return;
  }

  // Inspector queue: highlight only top-20 evidence meters
  if (STATE.localView === 'inspector') {
    const ev = STATE.data.evidence || [];
    ev.forEach(e => {
      const color =
        e.severity === 'Critical' ? '#ef4444' :
        e.severity === 'High'     ? '#f97316' : '#f59e0b';
      const marker = L.circleMarker([e.lat, e.lon], {
        radius: 7, color, fillColor: color, fillOpacity: 0.85, weight: 2,
      }).addTo(markerLayer);
      marker.bindTooltip(`<b>${e.meter_id}</b><br/>${e.zone_name}`, { sticky: true, className: 'leaflet-dark-tooltip' });
      marker.on('click', () => openMeterEvidence(e.meter_id));
    });
    return;
  }

  // Meter Anomalies — depends on density toggle
  if (STATE.density === 'zone') {
    drawZoneBubbles(zones);
  } else {
    drawMeterDots(meters);
  }
}

function drawZoneBubbles(zones) {
  if (!zones || !zones.length) return;
  const focusZone = STATE.selectedZone;

  zones.forEach(z => {
    const isActive = focusZone && z.zone_id === focusZone;
    const flaggedRatio = z.n_flagged / Math.max(1, z.n_meters);
    const radius = 14 + Math.min(28, flaggedRatio * 90);
    const color =
      z.risk_level === 'Critical' ? '#ef4444' :
      z.risk_level === 'High'     ? '#f97316' :
      z.risk_level === 'Moderate' ? '#f59e0b' : '#10b981';

    const marker = L.circleMarker([z.lat, z.lon], {
      radius,
      color,
      fillColor: color,
      fillOpacity: isActive ? 0.45 : 0.30,
      weight: isActive ? 3 : 2,
      className: 'zone-bubble',
    }).addTo(markerLayer);

    marker.bindTooltip(
      `<b>${z.zone_name}</b><br/>Peak ${z.peak_mw} MW · ${z.risk_level}<br/>${z.n_flagged}/${z.n_meters} flagged`,
      { sticky: true, className: 'leaflet-dark-tooltip' }
    );
    marker.on('mouseover', () => updateDetailPanelForZone(z, false));
    marker.on('click', () => {
      // In Meter Anomalies + zone density: drill down to meter level for that zone
      if (STATE.localView === 'meters' && STATE.density === 'zone') {
        STATE.selectedZone = z.zone_id;
        STATE.density = 'meter';
        document.querySelectorAll('.density-btn').forEach(b => b.classList.toggle('active', b.dataset.density === 'meter'));
        const dEl = document.getElementById('bm-density'); if (dEl) dEl.textContent = 'METER';
        const dSub = document.getElementById('bm-density-sub'); if (dSub) dSub.textContent = `drilled into ${z.zone_name}`;
        const metaView = document.getElementById('meta-view'); if (metaView) metaView.textContent = 'METER · ' + z.zone_name.toUpperCase();
        // Zoom into zone
        map.flyTo([z.lat, z.lon], 13, { duration: 0.6 });
        renderMeterMapMarkers();
      } else {
        // Zone Forecast / What-If: just select zone for charts
        STATE.selectedZone = z.zone_id;
        if (STATE.localView === 'zones') {
          renderZoneHourlyChart(z);
          renderZoneDriversChart(z);
        }
        updateDetailPanelForZone(z, true);
      }
    });
  });
}

function drawMeterDots(allMeters) {
  // Filter by zone if drilled-in
  let meters = STATE.selectedZone
    ? allMeters.filter(m => m.zone_id === STATE.selectedZone)
    : allMeters;

  // Apply layer toggles
  meters = meters.filter(m => {
    if (m.severity === 'Critical' && !STATE.layerOn.critical) return false;
    if (m.severity === 'High'     && !STATE.layerOn.high)     return false;
    if (m.severity === 'Moderate' && !STATE.layerOn.moderate) return false;
    if (m.severity === 'Low'      && !STATE.layerOn.normal)   return false;
    return true;
  });

  meters.forEach(m => {
    const isFlagged = m.is_theft;
    const color =
      m.severity === 'Critical' ? '#ef4444' :
      m.severity === 'High'     ? '#f97316' :
      m.severity === 'Moderate' ? '#f59e0b' : '#10b981';
    const radius = isFlagged ? 5 : 2.2;
    const marker = L.circleMarker([m.lat, m.lon], {
      radius, color, fillColor: color, fillOpacity: isFlagged ? 0.85 : 0.45, weight: isFlagged ? 1.5 : 0,
    }).addTo(markerLayer);

    marker.on('mouseover', () => {
      if (!STATE.pinnedMeter) updateDetailPanelForMeter(m, false);
    });
    marker.on('click', () => {
      STATE.pinnedMeter = m.meter_id;
      updateDetailPanelForMeter(m, true);
    });
  });

  // If drilled-in, show a "back to all zones" pseudo-marker
  if (STATE.selectedZone) {
    const z = (STATE.data.zoneForecast || []).find(zz => zz.zone_id === STATE.selectedZone);
    if (z) {
      const back = L.circleMarker([z.lat, z.lon], {
        radius: 26, color: '#3b82f6', weight: 2, fillOpacity: 0.0, dashArray: '4 4',
      }).addTo(markerLayer);
      back.bindTooltip(`<b>Drilled: ${z.zone_name}</b><br/>Click to return to Bengaluru-wide`, { sticky: true, className: 'leaflet-dark-tooltip' });
      back.on('click', () => {
        STATE.selectedZone = null;
        const dSub = document.getElementById('bm-density-sub'); if (dSub) dSub.textContent = 'click zone to drill in';
        const metaView = document.getElementById('meta-view'); if (metaView) metaView.textContent = STATE.density === 'zone' ? 'ZONE' : 'METER';
        map.flyTo(BENGALURU_CENTER, 11, { duration: 0.5 });
        renderMeterMapMarkers();
      });
    }
  }
}

// ── SUB-VIEW 1: Zone Demand Forecast ───────────────────────────────────────
function renderZoneForecastView() {
  const zones = STATE.data.zoneForecast || [];
  if (!zones.length) return;

  // Default selected zone = highest peak
  if (!STATE.selectedZone) {
    STATE.selectedZone = zones.reduce((a, b) => a.peak_mw > b.peak_mw ? a : b).zone_id;
  }
  const sel = zones.find(z => z.zone_id === STATE.selectedZone) || zones[0];

  renderZoneHourlyChart(sel);
  renderZonePeakChart(zones);
  renderZoneDriversChart(sel);
  renderZoneTable(zones);
}

function renderZoneHourlyChart(zone) {
  const ctx = document.getElementById('chart-zone-forecast');
  if (!ctx) return;
  if (charts.zoneForecast) charts.zoneForecast.destroy();

  const labels = zone.hourly_forecast.map(h => `${h.hour}:00`);
  const predicted = zone.hourly_forecast.map(h => h.predicted_mw);
  const lo = zone.hourly_forecast.map(h => h.confidence_low);
  const hi = zone.hourly_forecast.map(h => h.confidence_high);

  charts.zoneForecast = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Confidence high',
          data: hi,
          borderColor: 'rgba(139,92,246,0.0)',
          backgroundColor: 'rgba(139,92,246,0.18)',
          fill: '+1', pointRadius: 0, tension: 0.35,
        },
        {
          label: 'Confidence low',
          data: lo,
          borderColor: 'rgba(139,92,246,0.0)',
          backgroundColor: 'rgba(139,92,246,0.18)',
          fill: false, pointRadius: 0, tension: 0.35,
        },
        {
          label: `${zone.zone_name} predicted MW`,
          data: predicted,
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139,92,246,0.10)',
          borderWidth: 2.5, pointRadius: 3, tension: 0.35, fill: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#8899aa', filter: i => i.text.includes('predicted') || i.text.includes('high') } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw} MW` } },
      },
      scales: {
        x: { ticks: { color: '#8899aa', font: { size: 9 } }, grid: { color: '#1e2d42' } },
        y: { ticks: { color: '#8899aa', callback: v => `${v} MW` }, grid: { color: '#1e2d42' } },
      },
    },
  });
}

function renderZonePeakChart(zones) {
  const ctx = document.getElementById('chart-zone-peak');
  if (!ctx) return;
  if (charts.zonePeak) charts.zonePeak.destroy();

  const sorted = [...zones].sort((a, b) => b.peak_mw - a.peak_mw);
  const colors = sorted.map(z =>
    z.risk_level === 'Critical' ? 'rgba(239,68,68,0.85)' :
    z.risk_level === 'High'     ? 'rgba(249,115,22,0.85)' :
    z.risk_level === 'Moderate' ? 'rgba(245,158,11,0.75)' : 'rgba(16,185,129,0.75)'
  );

  charts.zonePeak = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(z => z.zone_name),
      datasets: [{
        label: 'Peak MW',
        data: sorted.map(z => z.peak_mw),
        backgroundColor: colors,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${sorted[c.dataIndex].risk_level}: ${c.raw} MW` } },
      },
      scales: {
        x: { ticks: { color: '#8899aa', callback: v => `${v} MW` }, grid: { color: '#1e2d42' } },
        y: { ticks: { color: '#8899aa', font: { size: 10 } }, grid: { display: false } },
      },
      onClick: (_, elements) => {
        if (elements.length) {
          STATE.selectedZone = sorted[elements[0].index].zone_id;
          const sel = STATE.data.zoneForecast.find(z => z.zone_id === STATE.selectedZone);
          if (sel) {
            renderZoneHourlyChart(sel);
            renderZoneDriversChart(sel);
          }
        }
      },
    },
  });
}

function renderZoneDriversChart(zone) {
  const ctx = document.getElementById('chart-zone-drivers');
  if (!ctx) return;
  if (charts.zoneDrivers) charts.zoneDrivers.destroy();

  const sub = document.getElementById('lzone-driver-sub');
  if (sub) sub.textContent = `${zone.zone_name} · peak ${zone.peak_mw} MW`;

  const drivers = zone.drivers || {};
  charts.zoneDrivers = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(drivers).map(k => k.replace(/_/g, ' ')),
      datasets: [{
        data: Object.values(drivers).map(v => v * 100),
        backgroundColor: ['#ef4444', '#3b82f6', '#8b5cf6', '#f59e0b'],
        borderColor: '#0e1623', borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8899aa', font: { size: 10 }, padding: 10 } },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.raw.toFixed(1)}%` } },
      },
    },
  });
}

function renderZoneTable(zones) {
  const el = document.getElementById('zone-table');
  if (!el) return;
  const sorted = [...zones].sort((a, b) => b.peak_mw - a.peak_mw);
  el.innerHTML = `
    <table class="dt">
      <thead><tr>
        <th>Zone</th><th>Type</th><th class="num">Peak MW</th><th class="num">Avg MW</th>
        <th class="num">AT&C %</th><th class="num">Flagged</th><th>Risk</th>
      </tr></thead>
      <tbody>
      ${sorted.map(z => `
        <tr class="dt-clickable" data-zone-id="${z.zone_id}">
          <td><b>${z.zone_name}</b></td>
          <td><small>${z.type.replace(/_/g, ' ')}</small></td>
          <td class="num">${z.peak_mw}</td>
          <td class="num">${z.avg_mw}</td>
          <td class="num">${z.atc_pct}%</td>
          <td class="num">${z.n_flagged}/${z.n_meters}</td>
          <td><span class="risk-badge risk-${z.risk_level.toLowerCase()}">${z.risk_level}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  el.querySelectorAll('.dt-clickable').forEach(tr => {
    tr.addEventListener('click', () => {
      STATE.selectedZone = tr.dataset.zoneId;
      const sel = zones.find(z => z.zone_id === STATE.selectedZone);
      if (sel) { renderZoneHourlyChart(sel); renderZoneDriversChart(sel); }
    });
  });
}

// ── SUB-VIEW 2: Meter-Level Anomaly Detection ──────────────────────────────
function renderMeterAnomalyView() {
  const meters = STATE.data.meters || [];
  if (!meters.length) return;

  // Anomaly count by zone (stacked by severity)
  const byZone = {};
  meters.forEach(m => {
    if (!byZone[m.zone_name]) byZone[m.zone_name] = { Critical: 0, High: 0, Moderate: 0 };
    if (m.is_theft) byZone[m.zone_name][m.severity]++;
  });
  const zones = Object.keys(byZone).sort((a, b) => {
    const sa = byZone[a].Critical + byZone[a].High + byZone[a].Moderate;
    const sb = byZone[b].Critical + byZone[b].High + byZone[b].Moderate;
    return sb - sa;
  });

  const ctx1 = document.getElementById('chart-anomaly-zone');
  if (ctx1) {
    if (charts.anomalyZone) charts.anomalyZone.destroy();
    charts.anomalyZone = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: zones,
        datasets: [
          { label: 'Critical', data: zones.map(z => byZone[z].Critical), backgroundColor: 'rgba(239,68,68,0.85)' },
          { label: 'High',     data: zones.map(z => byZone[z].High),     backgroundColor: 'rgba(249,115,22,0.85)' },
          { label: 'Moderate', data: zones.map(z => byZone[z].Moderate), backgroundColor: 'rgba(245,158,11,0.75)' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { color: '#8899aa', font: { size: 10 } } } },
        scales: {
          x: { stacked: true, ticks: { color: '#8899aa', font: { size: 9 } }, grid: { color: '#1e2d42' } },
          y: { stacked: true, ticks: { color: '#8899aa' }, grid: { color: '#1e2d42' } },
        },
      },
    });
  }

  // Theft archetype mix
  const archCount = {};
  meters.forEach(m => { if (m.theft_label) archCount[m.theft_label] = (archCount[m.theft_label] || 0) + 1; });
  const ctx2 = document.getElementById('chart-archetype');
  if (ctx2) {
    if (charts.archetype) charts.archetype.destroy();
    charts.archetype = new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: Object.keys(archCount),
        datasets: [{
          data: Object.values(archCount),
          backgroundColor: ['#ef4444', '#f97316', '#8b5cf6', '#06b6d4'],
          borderColor: '#0e1623', borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#8899aa', font: { size: 10 }, padding: 10 } },
          tooltip: { callbacks: { label: c => `${c.label}: ${c.raw} cases` } },
        },
      },
    });
  }

  // Severity distribution (incl. Low)
  const sev = { Critical: 0, High: 0, Moderate: 0, Low: 0 };
  meters.forEach(m => sev[m.severity] = (sev[m.severity] || 0) + 1);
  const ctx3 = document.getElementById('chart-severity');
  if (ctx3) {
    if (charts.severityDist) charts.severityDist.destroy();
    charts.severityDist = new Chart(ctx3, {
      type: 'bar',
      data: {
        labels: ['Critical', 'High', 'Moderate', 'Low'],
        datasets: [{
          data: ['Critical','High','Moderate','Low'].map(k => sev[k]),
          backgroundColor: ['rgba(239,68,68,0.85)','rgba(249,115,22,0.85)','rgba(245,158,11,0.75)','rgba(16,185,129,0.7)'],
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8899aa' }, grid: { color: '#1e2d42' } },
          y: { ticks: { color: '#8899aa' }, grid: { color: '#1e2d42' } },
        },
      },
    });
  }

  // Top flagged meters table
  const flagged = meters.filter(m => m.is_theft).sort((a, b) => b.anomaly_score - a.anomaly_score).slice(0, 30);
  const tbl = document.getElementById('meter-table');
  if (tbl) {
    tbl.innerHTML = `
      <table class="dt">
        <thead><tr>
          <th>Meter ID</th><th>Zone</th><th>Category</th><th>Archetype</th>
          <th class="num">Score</th><th class="num">Loss ₹/mo</th><th>Severity</th>
        </tr></thead>
        <tbody>
        ${flagged.map(m => `
          <tr class="dt-clickable" data-meter-id="${m.meter_id}">
            <td><code>${m.meter_id}</code></td>
            <td>${m.zone_name}</td>
            <td><small>${m.category_label}</small></td>
            <td><small>${m.theft_label}</small></td>
            <td class="num"><b>${m.anomaly_score}</b></td>
            <td class="num">₹${(m.est_revenue_loss_inr || 0).toLocaleString('en-IN')}</td>
            <td><span class="risk-badge risk-${m.severity.toLowerCase()}">${m.severity}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    tbl.querySelectorAll('.dt-clickable').forEach(tr => {
      tr.addEventListener('click', () => openMeterEvidence(tr.dataset.meterId));
    });
  }
}

// ── SUB-VIEW 3: Inspector Queue ────────────────────────────────────────────
function renderInspectorQueue() {
  const evidence = STATE.data.evidence || [];
  const el = document.getElementById('inspector-queue');
  if (!el || !evidence.length) return;

  el.innerHTML = evidence.map((e, i) => `
    <div class="inspector-card severity-${e.severity}" data-meter-id="${e.meter_id}">
      <div class="inspector-card-head">
        <span class="inspector-card-id">#${(i+1).toString().padStart(2,'0')} · ${e.meter_id}</span>
        <span class="inspector-card-arch">${e.theft_label}</span>
      </div>
      <div class="inspector-card-meta">
        <span>📍 <b>${e.zone_name}</b></span>
        <span>Confidence <b>${e.confidence_pct}%</b></span>
        <span>Loss <b>₹${(e.est_revenue_loss_inr || 0).toLocaleString('en-IN')}/mo</b></span>
        <span>Action: <b>${e.recommended_action}</b></span>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('.inspector-card').forEach(card => {
    card.addEventListener('click', () => openMeterEvidence(card.dataset.meterId));
  });
}

// ── Meter evidence drawer (opens the existing DISCOM drawer with meter content) ─
function openMeterEvidence(meterId) {
  const ev = (STATE.data.evidence || []).find(e => e.meter_id === meterId);
  if (!ev) return;

  const drawer = document.getElementById('discom-drawer');
  const overlay = document.getElementById('discom-overlay');
  if (!drawer) return;

  // Build evidence drawer content
  drawer.innerHTML = `
    <div class="dd-header">
      <button class="dd-back" id="dd-back" title="Back">← Back</button>
      <div class="dd-header-center">
        <div class="dd-title">${ev.meter_id}</div>
        <div class="dd-sub">${ev.zone_name} · ${ev.feeder_id} · ${ev.category_label}</div>
      </div>
    </div>

    <div class="dd-body">
      <div class="dd-section">
        <div class="dd-kpi-row" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:14px">
          <div class="dd-kpi"><div class="dd-kpi-label">Anomaly Score</div><div class="dd-kpi-value" style="color:#ef4444">${ev.anomaly_score}</div></div>
          <div class="dd-kpi"><div class="dd-kpi-label">Confidence</div><div class="dd-kpi-value">${ev.confidence_pct}%</div></div>
          <div class="dd-kpi"><div class="dd-kpi-label">Est. Loss</div><div class="dd-kpi-value" style="color:#f59e0b">₹${(ev.est_revenue_loss_inr || 0).toLocaleString('en-IN')}/mo</div></div>
        </div>
      </div>

      <div class="dd-section">
        <div class="dd-section-title">⚡ 7-day 15-min consumption (observed vs peer baseline)</div>
        <div class="chart-wrap" style="height:200px"><canvas id="chart-evidence-ts"></canvas></div>
      </div>

      <div class="dd-section">
        <div class="dd-section-title">🔬 SHAP-style feature attribution</div>
        <div class="chart-wrap" style="height:180px"><canvas id="chart-evidence-shap"></canvas></div>
      </div>

      <div class="dd-section">
        <div class="dd-section-title">🧠 Causal reasoning chain</div>
        <ol style="padding:8px 24px;line-height:1.7;font-size:13px;color:#cbd5e1">
          ${ev.causal_chain.map(c => `<li>${c}</li>`).join('')}
        </ol>
      </div>

      <div class="dd-section" style="background:linear-gradient(135deg,#1e1b4b 0%,#0e1623 100%);border-radius:8px;margin:8px;padding:14px;border:1px solid #4f46e5">
        <div class="dd-section-title">🤖 AI Brief (local Llama 3.1)</div>
        <p style="color:#e0e7ff;font-size:13px;line-height:1.6;margin:8px 0 0">${ev.llm_brief}</p>
      </div>

      <div class="dd-section">
        <div class="dd-section-title">📋 Recommended Action</div>
        <div style="padding:12px;background:rgba(239,68,68,0.08);border-left:3px solid #ef4444;border-radius:4px;margin:8px;color:#fecaca">
          <b>${ev.recommended_action}</b>
        </div>
      </div>
    </div>
  `;

  drawer.classList.add('open');
  if (overlay) overlay.classList.add('open');

  // Wire back button
  const backBtn = document.getElementById('dd-back');
  if (backBtn) backBtn.addEventListener('click', () => {
    drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  });
  if (overlay) overlay.addEventListener('click', () => {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
  }, { once: true });

  // Render time-series chart
  setTimeout(() => {
    const ctxTs = document.getElementById('chart-evidence-ts');
    if (ctxTs && ev.observed_kw_15min) {
      const labels = ev.observed_kw_15min.map((_, i) => i % 96 === 0 ? `D${Math.floor(i/96)+1}` : '');
      new Chart(ctxTs, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Peer cohort baseline', data: ev.peer_baseline_kw_15min, borderColor: '#10b981', borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
            { label: 'Observed (this meter)', data: ev.observed_kw_15min,     borderColor: '#ef4444', borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'top', labels: { color: '#8899aa', font: { size: 10 } } } },
          scales: {
            x: { ticks: { color: '#8899aa', font: { size: 9 }, autoSkip: false }, grid: { color: '#1e2d42' } },
            y: { ticks: { color: '#8899aa', callback: v => `${v} kW` }, grid: { color: '#1e2d42' } },
          },
        },
      });
    }

    const ctxShap = document.getElementById('chart-evidence-shap');
    if (ctxShap && ev.shap_features) {
      new Chart(ctxShap, {
        type: 'bar',
        data: {
          labels: ev.shap_features.map(s => s.feature),
          datasets: [{
            data: ev.shap_features.map(s => s.impact),
            backgroundColor: ev.shap_features.map(s => s.impact > 0 ? 'rgba(239,68,68,0.85)' : 'rgba(16,185,129,0.7)'),
            borderRadius: 4,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `Impact: ${c.raw > 0 ? '+' : ''}${c.raw.toFixed(2)}` } } },
          scales: {
            x: { ticks: { color: '#8899aa' }, grid: { color: '#1e2d42' } },
            y: { ticks: { color: '#8899aa', font: { size: 11 } }, grid: { display: false } },
          },
        },
      });
    }
  }, 50);
}

// ── SUB-VIEW 4: What-If Counterfactual ─────────────────────────────────────
function renderWhatIfView() {
  updateWhatIfScenario();
}

function updateWhatIfScenario() {
  const scenarios = STATE.data.whatif || [];
  if (!scenarios.length) return;

  const heat = parseInt(document.getElementById('whatif-heat')?.value || 0);
  const acRaw = parseInt(document.getElementById('whatif-ac')?.value || 0);
  const ac = acRaw / 100;
  const festival = document.getElementById('whatif-festival')?.checked || false;

  const heatEl = document.getElementById('whatif-heat-val');
  const acEl = document.getElementById('whatif-ac-val');
  if (heatEl) heatEl.textContent = `+${heat}°C`;
  if (acEl) acEl.textContent = `${acRaw > 0 ? '+' : ''}${acRaw}%`;

  // Snap to nearest pre-computed scenario key
  const heatSnap = [0, 2, 4, 6, 8].reduce((p, c) => Math.abs(c - heat) < Math.abs(p - heat) ? c : p);
  const acSnap = [-0.2, -0.1, 0, 0.1, 0.2, 0.3].reduce((p, c) => Math.abs(c - ac) < Math.abs(p - ac) ? c : p);
  const key = `h${heatSnap}_a${Math.round(acSnap * 100)}_f${festival ? 1 : 0}`;
  const scenario = scenarios.find(s => s.key === key) || scenarios[0];

  // Update narrative
  const narEl = document.getElementById('whatif-narrative');
  if (narEl) narEl.textContent = scenario.narrative;

  // Update peak chart
  const ctx1 = document.getElementById('chart-whatif-peak');
  if (ctx1) {
    if (charts.whatifPeak) charts.whatifPeak.destroy();
    const sortedZones = [...scenario.zones].sort((a, b) => b.peak_mw - a.peak_mw);
    charts.whatifPeak = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: sortedZones.map(z => z.zone_name),
        datasets: [{
          label: 'Peak MW (re-projected)',
          data: sortedZones.map(z => z.peak_mw),
          backgroundColor: sortedZones.map(z =>
            z.risk_level === 'Critical' ? 'rgba(239,68,68,0.85)' :
            z.risk_level === 'High'     ? 'rgba(249,115,22,0.85)' :
            z.risk_level === 'Moderate' ? 'rgba(245,158,11,0.75)' : 'rgba(16,185,129,0.75)'
          ),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8899aa', callback: v => `${v} MW` }, grid: { color: '#1e2d42' } },
          y: { ticks: { color: '#8899aa', font: { size: 10 } }, grid: { display: false } },
        },
      },
    });
  }

  // Update flagged chart
  const ctx2 = document.getElementById('chart-whatif-flagged');
  if (ctx2) {
    if (charts.whatifFlagged) charts.whatifFlagged.destroy();
    const sortedExtra = [...scenario.zones].sort((a, b) => b.extra_flagged - a.extra_flagged).slice(0, 8);
    charts.whatifFlagged = new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: sortedExtra.map(z => z.zone_name),
        datasets: [{
          label: 'Extra flagged meters',
          data: sortedExtra.map(z => z.extra_flagged),
          backgroundColor: 'rgba(139,92,246,0.75)',
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8899aa', font: { size: 9 } }, grid: { color: '#1e2d42' } },
          y: { ticks: { color: '#8899aa' }, grid: { color: '#1e2d42' } },
        },
      },
    });
  }
}

// ── Tampering / Theft Analytics Dashboard ─────────────────────────────────
function renderTamperingDashboard() {
  const intel = STATE.data.intelligence;

  // Aggregate by state
  const byState = {};
  for (const d of intel) {
    if (!byState[d.state]) byState[d.state] = { theft: 0, atc21: [], atc24: [], n: 0 };
    byState[d.state].theft += toFloat(d.est_theft_rev_loss_cr);
    byState[d.state].atc21.push(toFloat(d.atc_pct_2021));
    byState[d.state].atc24.push(toFloat(d.atc_pct_2024));
    byState[d.state].n++;
  }

  // Chart 1: Revenue leakage by state (top 14)
  const topStates = Object.keys(byState).sort((a,b) => byState[b].theft - byState[a].theft).slice(0,14);
  const ctx1 = document.getElementById('chart-theft-revenue');
  if (ctx1) new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: topStates,
      datasets: [{
        label: 'Est. Revenue Leakage ₹Cr/yr',
        data: topStates.map(s => byState[s].theft),
        backgroundColor: topStates.map(s => byState[s].theft > 5000 ? 'rgba(239,68,68,0.85)' : byState[s].theft > 2000 ? 'rgba(249,115,22,0.8)' : 'rgba(245,158,11,0.7)'),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `₹${Math.round(c.raw).toLocaleString('en-IN')} Cr/yr` } } },
      scales: {
        x: { ticks: { color: '#8899aa', font: { size: 9 }, maxRotation: 40 }, grid: { color: '#1e2d42' } },
        y: { ticks: { color: '#8899aa', callback: v => `₹${v}Cr` }, grid: { color: '#1e2d42' } },
      },
    },
  });

  // Chart 2: Tampering severity donut
  const severity = { Critical: 0, High: 0, Moderate: 0, Low: 0 };
  for (const d of intel) { if (d.tampering_label) severity[d.tampering_label] = (severity[d.tampering_label] || 0) + 1; }
  const ctx2 = document.getElementById('chart-theft-severity');
  if (ctx2) new Chart(ctx2, {
    type: 'doughnut',
    data: {
      labels: Object.keys(severity),
      datasets: [{
        data: Object.values(severity),
        backgroundColor: ['rgba(239,68,68,0.85)', 'rgba(249,115,22,0.8)', 'rgba(245,158,11,0.75)', 'rgba(16,185,129,0.75)'],
        borderColor: ['#ef4444', '#f97316', '#f59e0b', '#10b981'],
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8899aa', font: { size: 10 }, padding: 12 } },
        tooltip: { callbacks: { label: c => `${c.label}: ${c.raw} DISCOMs (${(c.raw / intel.length * 100).toFixed(0)}%)` } },
      },
    },
  });

  // Chart 3: AT&C improvement 2021→2024 (top 12 states by improvement delta)
  const avgOf = arr => arr.reduce((s,v)=>s+v,0) / (arr.length || 1);
  const trendStates = Object.keys(byState).sort((a,b) =>
    (avgOf(byState[b].atc21) - avgOf(byState[b].atc24)) - (avgOf(byState[a].atc21) - avgOf(byState[a].atc24))
  ).slice(0, 12);
  const ctx3 = document.getElementById('chart-theft-atc-trend');
  if (ctx3) new Chart(ctx3, {
    type: 'bar',
    data: {
      labels: trendStates,
      datasets: [
        { label: 'AT&C 2021 %', data: trendStates.map(s => avgOf(byState[s].atc21)), backgroundColor: 'rgba(239,68,68,0.6)', borderRadius: 3 },
        { label: 'AT&C 2024 %', data: trendStates.map(s => avgOf(byState[s].atc24)), backgroundColor: 'rgba(16,185,129,0.7)',  borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8899aa', font: { size: 10 } } },
                 tooltip: { callbacks: { afterLabel: (c) => {
                   const s = trendStates[c.dataIndex];
                   const imp = avgOf(byState[s].atc21) - avgOf(byState[s].atc24);
                   return c.datasetIndex === 1 ? `Improved: ${imp.toFixed(1)} pp` : '';
                 }}}},
      scales: {
        x: { ticks: { color: '#8899aa', font: { size: 9 }, maxRotation: 40 }, grid: { color: '#1e2d42' } },
        y: { ticks: { color: '#8899aa', callback: v => `${v}%` }, grid: { color: '#1e2d42' } },
      },
    },
  });

  // Chart 4: ML Anomaly Detection (flagged DISCOMs by tampering index)
  const anomalies = intel.filter(d => d.is_anomaly == 1 || d.is_anomaly === true || d.is_anomaly === 'true' || d.is_anomaly === '1').slice(0, 14);
  const ctx4 = document.getElementById('chart-theft-anomaly');
  if (ctx4 && anomalies.length > 0) {
    new Chart(ctx4, {
      type: 'bar',
      data: {
        labels: anomalies.map(d => d.discom),
        datasets: [{
          label: 'Tampering Index',
          data: anomalies.map(d => toFloat(d.tampering_index)),
          backgroundColor: anomalies.map(d => {
            const t = (d.anomaly_type || '').toLowerCase();
            return t.includes('billing') ? 'rgba(239,68,68,0.8)' : t.includes('collect') ? 'rgba(249,115,22,0.8)' : 'rgba(139,92,246,0.8)';
          }),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
                   tooltip: { callbacks: { afterLabel: c => `Type: ${anomalies[c.dataIndex]?.anomaly_type || 'anomalous'}` } } },
        scales: {
          x: { ticks: { color: '#8899aa' }, grid: { color: '#1e2d42' }, max: 100, title: { display: true, text: 'Tampering Index (0–100)', color: '#8899aa', font: { size: 10 } } },
          y: { ticks: { color: '#8899aa', font: { size: 9 } }, grid: { color: '#1e2d42' } },
        },
      },
    });
  } else if (ctx4) {
    const c = ctx4.getContext('2d');
    c.fillStyle = '#10b981'; c.font = '600 13px Inter'; c.textAlign = 'center';
    c.fillText(`✓ No ML anomalies detected across ${intel.length} DISCOMs`, ctx4.width / 2, ctx4.height / 2);
  }

  // Summary KPI strip
  const totalTheft   = intel.reduce((s,d) => s + toFloat(d.est_theft_rev_loss_cr), 0);
  const avgBilling   = intel.reduce((s,d) => s + toFloat(d.billing_gap_pct), 0) / intel.length;
  const avgCollect   = intel.reduce((s,d) => s + toFloat(d.collection_gap_pct), 0) / intel.length;
  const critCount    = intel.filter(d => d.tampering_label === 'Critical').length;
  const strip = document.getElementById('theft-summary-strip');
  if (strip) strip.innerHTML = [
    { label: 'Total Revenue Leakage', value: fmt.cr(totalTheft),                  sub: 'commercial AT&C losses/yr',        color: '#ef4444' },
    { label: 'Avg Billing Gap',       value: avgBilling.toFixed(1) + '%',          sub: 'billed vs supplied units',         color: '#f97316' },
    { label: 'Avg Collection Gap',    value: avgCollect.toFixed(1) + '%',          sub: 'collected vs billed revenue',      color: '#f59e0b' },
    { label: 'Critical DISCOMs',      value: critCount + ' / ' + intel.length,    sub: 'need immediate enforcement action', color: '#dc2626' },
    { label: 'ML Anomalies Flagged',  value: anomalies.length + ' detected',       sub: 'IsolationForest · unusual patterns', color: '#8b5cf6' },
  ].map(k => `<div class="view-kpi-item">
    <div class="vk-label">${k.label}</div>
    <div class="vk-value" style="color:${k.color}">${k.value}</div>
    <div class="vk-sub">${k.sub}</div>
  </div>`).join('');
}

// ── HTLS Wire-Loss Dashboard ──────────────────────────────────────────────
function renderHtlsDashboard() {
  const intel = STATE.data.intelligence;
  const top15 = [...intel].sort((a,b) => toFloat(b.htls_annual_saving_cr) - toFloat(a.htls_annual_saving_cr)).slice(0,15);

  // Chart 1: Capex vs Annual Saving grouped bar
  const ctx1 = document.getElementById('chart-htls-capex');
  if (ctx1) new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: top15.map(d => d.discom),
      datasets: [
        { label: 'Capex ₹Cr',        data: top15.map(d => toFloat(d.htls_capex_cr)),          backgroundColor: 'rgba(59,130,246,0.7)',  borderRadius: 3 },
        { label: 'Annual Saving ₹Cr', data: top15.map(d => toFloat(d.htls_annual_saving_cr)),  backgroundColor: 'rgba(16,185,129,0.7)',  borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color:'#8899aa', font:{size:10} } },
                 tooltip: { callbacks: { afterLabel: (c) => c.datasetIndex===1 ? `Payback: ${toFloat(top15[c.dataIndex].htls_payback_yr).toFixed(1)} yr` : '' } } },
      scales: {
        x: { ticks: { color:'#8899aa', font:{size:9}, maxRotation:45 }, grid:{color:'#1e2d42'} },
        y: { ticks: { color:'#8899aa', callback: v=>`₹${v}Cr` }, grid:{color:'#1e2d42'} },
      },
    },
  });

  // Chart 2: Tech loss vs 8.5% benchmark (horizontal bar)
  const byState = {};
  for (const d of intel) {
    if (!byState[d.state]) byState[d.state] = { tech:[], n:0 };
    byState[d.state].tech.push(toFloat(d.tech_loss_pct));
    byState[d.state].n++;
  }
  const states = Object.keys(byState).sort();
  const avgTech = states.map(s => byState[s].tech.reduce((a,b)=>a+b,0)/byState[s].tech.length);
  const benchmark = 8.5;
  const ctx2 = document.getElementById('chart-htls-loss');
  if (ctx2) new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: states,
      datasets: [
        { label: 'Avg Tech Loss %', data: avgTech, backgroundColor: avgTech.map(v => v > 12 ? 'rgba(239,68,68,0.7)' : v > 9 ? 'rgba(245,158,11,0.7)' : 'rgba(16,185,129,0.7)'), borderRadius:3 },
        { label: 'CEA Benchmark 8.5%', data: states.map(()=>benchmark), type:'line', borderColor:'rgba(139,92,246,0.8)', borderDash:[4,3], borderWidth:2, pointRadius:0, fill:false },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{ labels:{color:'#8899aa',font:{size:10}} } },
      scales: {
        x: { ticks:{color:'#8899aa',callback:v=>`${v}%`}, grid:{color:'#1e2d42'}, max: Math.ceil(Math.max(...avgTech)*1.1) },
        y: { ticks:{color:'#8899aa',font:{size:9}}, grid:{color:'#1e2d42'} },
      },
    },
  });

  // Chart 3: Capex vs Saving scatter (bubble)
  const ctx3 = document.getElementById('chart-htls-scatter');
  if (ctx3) new Chart(ctx3, {
    type: 'bubble',
    data: { datasets: [{
      label: 'DISCOM',
      data: intel.map(d => ({
        x: toFloat(d.htls_capex_cr),
        y: toFloat(d.htls_annual_saving_cr),
        r: Math.max(3, Math.min(14, toFloat(d.htls_payback_yr) * 1.2)),
      })),
      backgroundColor: 'rgba(59,130,246,0.5)', borderColor:'rgba(59,130,246,0.9)', borderWidth:1,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{display:false},
        tooltip:{ callbacks:{ label: c => {
          const d = intel[c.dataIndex];
          return `${d.discom}: capex ₹${c.raw.x.toFixed(0)}Cr → saving ₹${c.raw.y.toFixed(0)}Cr/yr (${toFloat(d.htls_payback_yr).toFixed(1)}yr payback)`;
        }}}},
      scales: {
        x: { title:{display:true,text:'Capex ₹Cr',color:'#8899aa',font:{size:10}}, ticks:{color:'#8899aa',callback:v=>`₹${v}`}, grid:{color:'#1e2d42'}, min:0 },
        y: { title:{display:true,text:'Annual Saving ₹Cr/yr',color:'#8899aa',font:{size:10}}, ticks:{color:'#8899aa',callback:v=>`₹${v}`}, grid:{color:'#1e2d42'}, min:0 },
      },
    },
  });

  // Chart 4: Payback period histogram
  const ctx4 = document.getElementById('chart-htls-payback');
  const bins = [0,2,4,6,8,10,15,99];
  const labels4 = ['<2yr','2-4yr','4-6yr','6-8yr','8-10yr','10-15yr','>15yr'];
  const counts = Array(labels4.length).fill(0);
  for (const d of intel) {
    const py = toFloat(d.htls_payback_yr);
    for (let i=0;i<bins.length-1;i++) if (py>=bins[i]&&py<bins[i+1]) { counts[i]++; break; }
  }
  if (ctx4) new Chart(ctx4, {
    type: 'bar',
    data: { labels: labels4, datasets:[{ label:'DISCOMs', data:counts, backgroundColor:'rgba(59,130,246,0.7)', borderRadius:4 }]},
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}, title:{display:true, text:'Payback Period Distribution', color:'#8899aa', font:{size:11}}},
      scales:{ x:{ticks:{color:'#8899aa'},grid:{color:'#1e2d42'}}, y:{ticks:{color:'#8899aa'},grid:{color:'#1e2d42'}} },
    },
  });

  // Summary KPI strip
  const totalCapex   = intel.reduce((s,d)=>s+toFloat(d.htls_capex_cr),0);
  const totalSaving  = intel.reduce((s,d)=>s+toFloat(d.htls_annual_saving_cr),0);
  const avgPayback   = intel.reduce((s,d)=>s+toFloat(d.htls_payback_yr),0)/intel.length;
  const techAbove    = intel.filter(d=>toFloat(d.tech_loss_pct)>benchmark).length;
  const strip = document.getElementById('htls-summary-strip');
  if (strip) strip.innerHTML = [
    { label:'Total Upgrade Capex',  value: fmt.cr(totalCapex),    sub:'across 46 DISCOMs',    color:'#3b82f6' },
    { label:'Annual Wire Saving',   value: fmt.cr(totalSaving),   sub:'₹Cr/yr post-upgrade',  color:'#10b981' },
    { label:'Avg Payback Period',   value: avgPayback.toFixed(1)+'yr', sub:'capital recovery', color:'#f59e0b' },
    { label:'DISCOMs Above 8.5%',   value: techAbove+' / '+intel.length, sub:'need HTLS upgrade', color:'#ef4444' },
    { label:'Simple ROI',           value: (totalSaving/totalCapex*100).toFixed(0)+'%', sub:'annual return on capex', color:'#8b5cf6' },
  ].map(k=>`<div class="view-kpi-item">
    <div class="vk-label">${k.label}</div>
    <div class="vk-value" style="color:${k.color}">${k.value}</div>
    <div class="vk-sub">${k.sub}</div>
  </div>`).join('');
}

// ── Smart Meter Dashboard ─────────────────────────────────────────────────
function renderSmDashboard() {
  const intel = STATE.data.intelligence;

  // Chart 0A: IEX Price vs Flat Tariff (Why Smart Meters Matter)
  const arbData = STATE.data.arbitrage.slice(-30);
  const avgFlatTariff = intel.length ? intel.reduce((s,d) => s + toFloat(d.tou_flat_tariff_rs), 0) / intel.length : 5.0;
  const avgOffPeak    = intel.length ? intel.reduce((s,d) => s + toFloat(d.tou_off_peak_price_rs), 0) / intel.length : 3.0;
  const ctx0a = document.getElementById('chart-sm-iex');
  if (ctx0a && arbData.length) {
    new Chart(ctx0a, {
      type: 'line',
      data: {
        labels: arbData.map(d => d.trade_date ? d.trade_date.slice(5) : ''),
        datasets: [
          { label: 'IEX Peak ₹/kWh',    data: arbData.map(d => toFloat(d.peak_price)),    borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.08)', fill: true,  borderWidth: 1.5, pointRadius: 0, tension: 0.4 },
          { label: 'IEX Off-Peak ₹/kWh', data: arbData.map(d => toFloat(d.off_peak_price)), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', fill: true,  borderWidth: 1.5, pointRadius: 0, tension: 0.4 },
          { label: `Flat Tariff ₹${avgFlatTariff.toFixed(1)}/kWh`, data: arbData.map(() => avgFlatTariff), borderColor: '#f59e0b', borderDash: [5,4], borderWidth: 2, pointRadius: 0, fill: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#8899aa', font: { size: 10 } } },
                   tooltip: { callbacks: { afterBody: items => {
                     const offPk = toFloat(items[1]?.raw) || 0;
                     const gap = avgFlatTariff - offPk;
                     return gap > 0 ? [`Off-peak saving vs flat: ₹${gap.toFixed(2)}/kWh`] : [];
                   }}}},
        scales: {
          x: { ticks: { color: '#8899aa', font: { size: 9 }, maxTicksLimit: 10 }, grid: { color: '#1e2d42' } },
          y: { ticks: { color: '#8899aa', callback: v => `₹${v}` }, grid: { color: '#1e2d42' } },
        },
      },
    });
  }

  // Chart 0B: 7-day price forecast for ToU planning
  const fc = STATE.data.forecast;
  const ctx0b = document.getElementById('chart-sm-forecast');
  if (ctx0b && fc.length) {
    const fcAvg  = fc.map(d => toFloat(d.avg_price));
    const fcHigh = fc.map(d => toFloat(d.conf_high));
    const fcLow  = fc.map(d => toFloat(d.conf_low));
    new Chart(ctx0b, {
      type: 'bar',
      data: {
        labels: fc.map(d => d.forecast_date ? d.forecast_date.slice(5) : ''),
        datasets: [
          { label: 'Forecast Avg ₹/kWh', data: fcAvg, backgroundColor: 'rgba(245,158,11,0.6)', borderRadius: 4 },
          { label: 'Confidence High',     data: fcHigh, type: 'line', borderColor: 'rgba(245,158,11,0.3)', borderWidth: 1, pointRadius: 0, fill: false, borderDash: [3,2] },
          { label: 'Confidence Low',      data: fcLow,  type: 'line', borderColor: 'rgba(245,158,11,0.3)', borderWidth: 1, pointRadius: 0, fill: false, borderDash: [3,2] },
          { label: `Flat Tariff ₹${avgFlatTariff.toFixed(1)}/kWh`, data: fc.map(() => avgFlatTariff), type: 'line', borderColor: '#ef4444', borderDash: [5,4], borderWidth: 2, pointRadius: 0, fill: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#8899aa', font: { size: 10 },
          filter: item => !item.text.includes('Confidence') } } },
        scales: {
          x: { ticks: { color: '#8899aa', font: { size: 10 } }, grid: { color: '#1e2d42' } },
          y: { ticks: { color: '#8899aa', callback: v => `₹${v}` }, grid: { color: '#1e2d42' }, title: { display: true, text: '₹/kWh', color: '#8899aa', font: { size: 10 } } },
        },
      },
    });
  }

  // Aggregate by state
  const byState = {};
  for (const d of intel) {
    if (!byState[d.state]) byState[d.state] = { installed:0, remaining:0, saving:0, capex:0, paybacks:[] };
    byState[d.state].installed  += toFloat(d.sm_installed);
    byState[d.state].remaining  += toFloat(d.sm_remaining);
    byState[d.state].saving     += toFloat(d.sm_annual_tou_saving_cr);
    byState[d.state].capex      += toFloat(d.sm_capex_cr);
    byState[d.state].paybacks.push(toFloat(d.sm_payback_yr));
  }
  const states = Object.keys(byState).sort((a,b)=>byState[b].remaining-byState[a].remaining).slice(0,14);

  // Chart 1: Stacked progress bar
  const ctx1 = document.getElementById('chart-sm-progress');
  if (ctx1) new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: states,
      datasets: [
        { label:'Installed (lakh)', data: states.map(s=>byState[s].installed/100000), backgroundColor:'rgba(16,185,129,0.75)', borderRadius:3, stack:'a' },
        { label:'Remaining (lakh)', data: states.map(s=>byState[s].remaining/100000), backgroundColor:'rgba(239,68,68,0.5)', borderRadius:3, stack:'a' },
      ],
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{labels:{color:'#8899aa',font:{size:10}}} },
      scales:{
        x:{ticks:{color:'#8899aa',font:{size:9},maxRotation:40},grid:{color:'#1e2d42'}},
        y:{ticks:{color:'#8899aa',callback:v=>`${v}L`},grid:{color:'#1e2d42'},stacked:true},
      },
    },
  });

  // Chart 2: ToU saving by state
  const statesBySaving = Object.keys(byState).sort((a,b)=>byState[b].saving-byState[a].saving).slice(0,14);
  const ctx2 = document.getElementById('chart-sm-saving');
  if (ctx2) new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: statesBySaving,
      datasets:[{ label:'Annual ToU Saving ₹Cr', data:statesBySaving.map(s=>byState[s].saving), backgroundColor:'rgba(16,185,129,0.7)', borderRadius:3 }],
    },
    options: {
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        x:{ticks:{color:'#8899aa',callback:v=>`₹${v}Cr`},grid:{color:'#1e2d42'}},
        y:{ticks:{color:'#8899aa',font:{size:9}},grid:{color:'#1e2d42'}},
      },
    },
  });

  // Chart 3: Capex vs ToU saving scatter per DISCOM
  const ctx3 = document.getElementById('chart-sm-scatter');
  if (ctx3) new Chart(ctx3, {
    type: 'bubble',
    data:{ datasets:[{
      label:'DISCOM',
      data: intel.filter(d=>toFloat(d.sm_remaining)>0).map(d=>({
        x: toFloat(d.sm_capex_cr),
        y: toFloat(d.sm_annual_tou_saving_cr),
        r: Math.max(3, Math.min(14, toFloat(d.sm_remaining)/50000)),
      })),
      backgroundColor:'rgba(16,185,129,0.5)', borderColor:'rgba(16,185,129,0.9)', borderWidth:1,
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{ label: (c) => {
          const d = intel.filter(x=>toFloat(x.sm_remaining)>0)[c.dataIndex];
          return `${d?.discom||''}: capex ₹${c.raw.x.toFixed(0)}Cr → saving ₹${c.raw.y.toFixed(0)}Cr/yr`;
        }}}},
      scales:{
        x:{ title:{display:true,text:'Capex ₹Cr',color:'#8899aa',font:{size:10}}, ticks:{color:'#8899aa',callback:v=>`₹${v}`}, grid:{color:'#1e2d42'}, min:0 },
        y:{ title:{display:true,text:'Annual ToU Saving ₹Cr/yr',color:'#8899aa',font:{size:10}}, ticks:{color:'#8899aa',callback:v=>`₹${v}`}, grid:{color:'#1e2d42'}, min:0 },
      },
    },
  });

  // Chart 4: Payback histogram
  const ctx4 = document.getElementById('chart-sm-payback');
  const bins = [0,2,4,6,8,10,15,99];
  const labels4 = ['<2yr','2-4yr','4-6yr','6-8yr','8-10yr','10-15yr','>15yr'];
  const counts = Array(labels4.length).fill(0);
  for (const d of intel) {
    const py = toFloat(d.sm_payback_yr);
    for (let i=0;i<bins.length-1;i++) if (py>=bins[i]&&py<bins[i+1]) { counts[i]++; break; }
  }
  if (ctx4) new Chart(ctx4, {
    type:'bar',
    data:{ labels:labels4, datasets:[{ label:'DISCOMs', data:counts, backgroundColor:'rgba(16,185,129,0.7)', borderRadius:4 }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}, title:{display:true,text:'SM Payback Period Distribution',color:'#8899aa',font:{size:11}}},
      scales:{ x:{ticks:{color:'#8899aa'},grid:{color:'#1e2d42'}}, y:{ticks:{color:'#8899aa'},grid:{color:'#1e2d42'}} },
    },
  });

  // Summary KPI strip
  const totalCapex  = Object.values(byState).reduce((s,v)=>s+v.capex,0);
  const totalSaving = Object.values(byState).reduce((s,v)=>s+v.saving,0);
  const totalRem    = Object.values(byState).reduce((s,v)=>s+v.remaining,0);
  const totalInst   = Object.values(byState).reduce((s,v)=>s+v.installed,0);
  const pctDone     = totalInst/(totalInst+totalRem)*100;
  const avgPayback  = intel.reduce((s,d)=>s+toFloat(d.sm_payback_yr),0)/intel.length;
  const strip = document.getElementById('sm-summary-strip');
  if (strip) strip.innerHTML = [
    { label:'Total Meter Capex',     value: fmt.cr(totalCapex),         sub:`${fmt.m(totalRem)} meters pending`, color:'#3b82f6' },
    { label:'Annual ToU Saving',     value: fmt.cr(totalSaving),        sub:'₹Cr/yr when fully deployed',        color:'#10b981' },
    { label:'Deployment Progress',   value: pctDone.toFixed(1)+'%',     sub:'meters installed under RDSS',       color:'#f59e0b' },
    { label:'Avg Payback Period',    value: avgPayback.toFixed(1)+'yr', sub:'capital recovery time',             color:'#8b5cf6' },
    { label:'Annual ROI on Capex',   value: (totalSaving/totalCapex*100).toFixed(0)+'%', sub:'ToU saving / meter capex', color:'#06b6d4' },
  ].map(k=>`<div class="view-kpi-item">
    <div class="vk-label">${k.label}</div>
    <div class="vk-value" style="color:${k.color}">${k.value}</div>
    <div class="vk-sub">${k.sub}</div>
  </div>`).join('');
}

function updateLegend() {
  const title = document.getElementById('legend-title');
  const scale = document.getElementById('legend-scale');
  if (STATE.mapView === 'tampering') {
    title.textContent = 'Tampering Index';
    scale.innerHTML = `
      <div class="legend-row"><span class="dot" style="background:#ef4444"></span><span>Critical (65–100)</span></div>
      <div class="legend-row"><span class="dot" style="background:#f97316"></span><span>High (40–65)</span></div>
      <div class="legend-row"><span class="dot" style="background:#f59e0b"></span><span>Moderate (20–40)</span></div>
      <div class="legend-row"><span class="dot" style="background:#10b981"></span><span>Low (0–20)</span></div>`;
  } else if (STATE.mapView === 'htls') {
    title.textContent = 'HTLS Saving (₹Cr/yr)';
    scale.innerHTML = `
      <div class="legend-row"><span class="dot" style="background:#1d4ed8"></span><span>&gt; ₹1,000 Cr</span></div>
      <div class="legend-row"><span class="dot" style="background:#3b82f6"></span><span>₹400 – 1,000 Cr</span></div>
      <div class="legend-row"><span class="dot" style="background:#60a5fa"></span><span>₹100 – 400 Cr</span></div>
      <div class="legend-row"><span class="dot" style="background:#93c5fd"></span><span>&lt; ₹100 Cr</span></div>`;
  } else {
    title.textContent = 'Smart Meter Gap';
    scale.innerHTML = `
      <div class="legend-row"><span class="dot" style="background:#15803d"></span><span>&lt; 15% installed</span></div>
      <div class="legend-row"><span class="dot" style="background:#22c55e"></span><span>15 – 30%</span></div>
      <div class="legend-row"><span class="dot" style="background:#4ade80"></span><span>30 – 55%</span></div>
      <div class="legend-row"><span class="dot" style="background:#86efac"></span><span>&gt; 55% installed</span></div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════ KPIs

function renderKPIs() {
  const intel = STATE.data.intelligence;
  const arb   = STATE.data.arbitrage;

  if (intel.length) {
    const theft = intel.reduce((s, d) => s + toFloat(d.est_theft_rev_loss_cr), 0);
    const htls  = intel.reduce((s, d) => s + toFloat(d.htls_annual_saving_cr), 0);
    const smRem = intel.reduce((s, d) => s + toFloat(d.sm_remaining), 0);
    document.getElementById('kpi-theft').textContent = fmt.cr(theft);
    document.getElementById('kpi-htls').textContent  = fmt.cr(htls);
    document.getElementById('kpi-sm').textContent    = fmt.m(smRem);
  }

  if (arb.length) {
    const latest = arb[arb.length - 1];
    const sig    = latest.signal || 'N/A';
    document.getElementById('kpi-signal').textContent = sig;
    document.getElementById('kpi-signal').style.color =
      sig.includes('STRONG') ? '#ef4444' : sig.includes('BUY') ? '#f59e0b' : '#8899aa';
    document.getElementById('kpi-spread').textContent = `Spread: ${fmt.kwh(latest.gross_spread)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════ CHARTS

// ── IEX Prices ──
function renderIexChart() {
  const raw  = STATE.data.arbitrage;
  const data = raw.slice(-STATE.iexDays);
  const labels   = data.map(d => d.trade_date);
  const peak     = data.map(d => toFloat(d.peak_price));
  const offpeak  = data.map(d => toFloat(d.off_peak_price));
  const spread   = data.map(d => toFloat(d.gross_spread));

  const cfg = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Evening Peak ₹/kWh', data: peak,
          type: 'line', borderColor: '#ef4444', backgroundColor: 'transparent',
          borderWidth: 1.5, pointRadius: 0, yAxisID: 'y',
        },
        {
          label: 'Off-Peak ₹/kWh', data: offpeak,
          type: 'line', borderColor: '#3b82f6', backgroundColor: 'transparent',
          borderWidth: 1.5, pointRadius: 0, yAxisID: 'y',
        },
        {
          label: 'Arbitrage Spread', data: spread,
          backgroundColor: 'rgba(16,185,129,0.4)', borderColor: 'rgba(16,185,129,0.8)',
          borderWidth: 1, yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y:  { position: 'left',  title: { display: true, text: '₹/kWh' } },
        y2: { position: 'right', title: { display: true, text: 'Spread' }, grid: { drawOnChartArea: false } },
      },
    },
  };

  if (charts.iex) charts.iex.destroy();
  const _iexEl = document.getElementById('chart-iex');
  if (_iexEl) charts.iex = new Chart(_iexEl, cfg);
}

// ── AT&C Losses (horizontal bar) ──
function renderAtcChart() {
  const data = [...STATE.data.atc].sort((a, b) => toFloat(b.avg_atc) - toFloat(a.avg_atc));

  const labels   = data.map(d => d.state);
  const tech     = data.map(d => toFloat(d.tech_loss));
  const comm     = data.map(d => Math.max(0, toFloat(d.avg_atc) - toFloat(d.tech_loss)));
  const colors   = data.map(d => d.heatmap_color === 'RED' ? 'rgba(239,68,68,0.75)' : d.heatmap_color === 'AMBER' ? 'rgba(245,158,11,0.75)' : 'rgba(16,185,129,0.75)');

  const cfg = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Tech Loss (8.5%)', data: tech, backgroundColor: 'rgba(59,130,246,0.5)', borderWidth: 0 },
        { label: 'Commercial Loss',  data: comm, backgroundColor: colors, borderWidth: 0 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { stacked: true, title: { display: true, text: 'AT&C %' } },
        y: { stacked: true, ticks: { font: { size: 10 } } },
      },
    },
  };

  if (charts.atc) charts.atc.destroy();
  const _atcEl = document.getElementById('chart-atc');
  if (_atcEl) charts.atc = new Chart(_atcEl, cfg);
}

// ── Battery P&L ──
function renderBatteryChart() {
  const raw  = STATE.data.battery;
  const cap  = STATE.battCapacity;
  const data = raw.slice(-60);
  const labels  = data.map(d => d.trade_date);
  const profits = data.map(d => toFloat(d.profit_rs) * cap);
  const colors  = profits.map(p => p >= 0 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)');

  const cfg = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: `Daily Profit (${cap} MWh)`,
        data: profits,
        backgroundColor: colors,
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, maxRotation: 0 } },
        y: { title: { display: true, text: '₹/day' } },
      },
    },
  };

  if (charts.battery) charts.battery.destroy();
  const _battEl = document.getElementById('chart-battery');
  if (_battEl) charts.battery = new Chart(_battEl, cfg);

  // Battery metrics
  const total  = profits.reduce((s, v) => s + v, 0);
  const avg    = total / (profits.length || 1);
  const annual = avg * 300;
  const capex  = cap * 4_000_000;
  const pb     = capex / Math.max(annual, 1);

  const _bm = document.getElementById('battery-metrics');
  if (_bm) _bm.innerHTML = `
    <div class="bat-metric"><div class="bat-metric-label">Avg Daily</div><div class="bat-metric-val">₹${Math.round(avg).toLocaleString('en-IN')}</div></div>
    <div class="bat-metric"><div class="bat-metric-label">Annual Est.</div><div class="bat-metric-val">₹${(annual/1e7).toFixed(2)} Cr</div></div>
    <div class="bat-metric"><div class="bat-metric-label">Payback</div><div class="bat-metric-val">${pb.toFixed(1)} yr</div></div>`;
}

// ── Price Forecast ──
function renderForecastChart() {
  const hist = [...STATE.data.histPrices].sort((a, b) => a.date > b.date ? 1 : -1);
  const fc   = STATE.data.forecast;

  const histLabels = hist.map(d => d.date);
  const histVals   = hist.map(d => toFloat(d.avg_price));
  const fcLabels   = fc.map(d => d.forecast_date);
  const fcAvg      = fc.map(d => toFloat(d.avg_price));
  const fcHigh     = fc.map(d => toFloat(d.conf_high));
  const fcLow      = fc.map(d => toFloat(d.conf_low));

  // Confidence band (fill between)
  const bandLabels = fcLabels;
  const bandData   = fcHigh.map((h, i) => ({ x: fcLabels[i], high: h, low: fcLow[i] }));

  const allLabels = [...histLabels, ...fcLabels];
  const histFull  = [...histVals, ...new Array(fcLabels.length).fill(null)];
  const fcFull    = [...new Array(histLabels.length).fill(null), ...fcAvg];
  const highFull  = [...new Array(histLabels.length).fill(null), ...fcHigh];
  const lowFull   = [...new Array(histLabels.length).fill(null), ...fcLow];

  const cfg = {
    type: 'line',
    data: {
      labels: allLabels,
      datasets: [
        {
          label: 'Historical', data: histFull,
          borderColor: '#3b82f6', backgroundColor: 'transparent',
          borderWidth: 2, pointRadius: 0,
        },
        {
          label: 'Forecast (GBT)', data: fcFull,
          borderColor: '#ef4444', backgroundColor: 'transparent',
          borderWidth: 2, borderDash: [5, 3], pointRadius: 3, pointBackgroundColor: '#ef4444',
        },
        {
          label: 'Confidence High', data: highFull,
          borderColor: 'transparent', backgroundColor: 'rgba(239,68,68,0.12)',
          fill: '+1', pointRadius: 0, borderWidth: 0,
        },
        {
          label: 'Confidence Low', data: lowFull,
          borderColor: 'transparent', backgroundColor: 'rgba(239,68,68,0.12)',
          fill: false, pointRadius: 0, borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: {
          filter: (item) => !item.text.includes('Confidence'),
        }},
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } },
        y: { title: { display: true, text: '₹/kWh' } },
      },
    },
  };

  if (charts.forecast) charts.forecast.destroy();
  const _fcEl = document.getElementById('chart-forecast');
  if (_fcEl) charts.forecast = new Chart(_fcEl, cfg);
}

// ── Generation Mix ──
function renderGenChart() {
  const raw  = STATE.data.generation;
  const data = raw.slice(-STATE.genDays);
  const labels = data.map(d => d.date);
  const coal   = data.map(d => toFloat(d.coal));
  const solar  = data.map(d => toFloat(d.solar));
  const wind   = data.map(d => toFloat(d.wind));
  const hydro  = data.map(d => toFloat(d.hydro));

  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Coal',  data: coal,  borderColor: '#6b7280', backgroundColor: 'rgba(107,114,128,0.5)', fill: true, borderWidth: 1, pointRadius: 0, stack: 'gen' },
        { label: 'Hydro', data: hydro, borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.5)',   fill: true, borderWidth: 1, pointRadius: 0, stack: 'gen' },
        { label: 'Wind',  data: wind,  borderColor: '#8b5cf6', backgroundColor: 'rgba(139,92,246,0.5)',  fill: true, borderWidth: 1, pointRadius: 0, stack: 'gen' },
        { label: 'Solar', data: solar, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.5)',  fill: true, borderWidth: 1, pointRadius: 0, stack: 'gen' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, maxRotation: 0 } },
        y: { stacked: true, title: { display: true, text: 'MU/day' } },
      },
    },
  };

  if (charts.gen) charts.gen.destroy();
  const _genEl = document.getElementById('chart-gen');
  if (_genEl) charts.gen = new Chart(_genEl, cfg);
}

// ═══════════════════════════════════════════════════════════════════════ TABLES

function renderModelTable() {
  const data = STATE.data.models;
  if (!data.length) return;

  const rows = data.map(d => `
    <tr>
      <td><span class="tag tag-blue">${(d.model_name || '').replace('gridlytics_', '')}</span></td>
      <td style="color:#8899aa;font-size:10px">${(d.algorithm || '').split('(')[0]}</td>
      <td style="color:#10b981;font-weight:600">${toFloat(d.rmse).toFixed(3)}</td>
      <td style="color:#f59e0b">${toFloat(d.r2).toFixed(3)}</td>
      <td style="color:#6b7280">${d.run_date || '–'}</td>
    </tr>`).join('');

  document.getElementById('model-table').innerHTML = `
    <table>
      <thead><tr><th>Model</th><th>Algorithm</th><th>RMSE</th><th>R²</th><th>Run Date</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  // Hindi insight
  if (STATE.data.hindi) {
    const h = STATE.data.hindi;
    document.getElementById('hindi-card').style.display = 'grid';
    document.getElementById('hindi-en').textContent = (h.insight_english || '').slice(0, 160) + '…';
    document.getElementById('hindi-hi').textContent = (h.insight_hindi   || '').slice(0, 160) + '…';
  }
}

function renderDiscomTable() {
  const view = STATE.mapView;

  // View-specific config
  const VIEW_CFG = {
    tampering: {
      title   : '🔴 Top DISCOM Opportunities — Tampering & Theft',
      sub     : 'Sorted by commercial loss + billing gap · estimated annual revenue at risk',
      sortKey : 'tampering_index',
      hlCol   : 'theft',   // which column to highlight
    },
    htls: {
      title   : '🔵 Top DISCOM Opportunities — Wire Loss (HTLS Upgrade)',
      sub     : 'Sorted by annual saving from High-Temp Low-Sag conductor upgrade',
      sortKey : 'htls_annual_saving_cr',
      hlCol   : 'htls',
    },
    sm: {
      title   : '🟢 Top DISCOM Opportunities — Smart Meter Gap',
      sub     : 'Sorted by Time-of-Use saving potential from remaining meter installations',
      sortKey : 'sm_annual_tou_saving_cr',
      hlCol   : 'sm',
    },
  };
  const cfg = VIEW_CFG[view] || VIEW_CFG.tampering;

  // Update panel header
  const titleEl = document.getElementById('discom-table-title');
  const subEl   = document.getElementById('discom-table-sub');
  if (titleEl) titleEl.textContent = cfg.title;
  if (subEl)   subEl.textContent   = cfg.sub;

  const data = [...STATE.data.intelligence]
    .sort((a, b) => toFloat(b[cfg.sortKey]) - toFloat(a[cfg.sortKey]))
    .slice(0, 20);

  // Column highlight styles
  const hl = (col) => col === cfg.hlCol
    ? 'font-weight:700;font-size:12px;'
    : '';

  const rows = data.map((d, i) => {
    const score = toFloat(d.overall_opportunity_score);
    const theftStyle = 'color:#ef4444;' + hl('theft');
    const htlsStyle  = 'color:#3b82f6;' + hl('htls');
    const smStyle    = 'color:#10b981;' + hl('sm');
    return `
      <tr ${cfg.hlCol === 'htls' ? 'style="border-left:2px solid rgba(59,130,246,0.3)"'
           : cfg.hlCol === 'sm'  ? 'style="border-left:2px solid rgba(16,185,129,0.3)"'
           : 'style="border-left:2px solid rgba(239,68,68,0.3)"'}>
        <td style="color:#4a6080;font-size:10px">${i + 1}</td>
        <td style="font-weight:600">${d.discom}</td>
        <td style="color:#8899aa">${d.state}</td>
        <td><span class="${riskClass(d.tampering_label)}">${d.tampering_label || '–'}</span></td>
        <td>${toFloat(d.atc_pct_2024).toFixed(1)}%</td>
        <td style="${theftStyle}">${fmt.cr(d.est_theft_rev_loss_cr)}</td>
        <td style="${htlsStyle}">${fmt.cr(d.htls_annual_saving_cr)}</td>
        <td style="${smStyle}">${fmt.cr(d.sm_annual_tou_saving_cr)}</td>
        <td>
          <div class="score-bar">
            <div class="score-track"><div class="score-fill" style="width:${score}%"></div></div>
            <span style="font-size:10px;font-weight:600">${score.toFixed(0)}</span>
          </div>
        </td>
      </tr>`;
  }).join('');

  document.getElementById('discom-table').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th><th>DISCOM</th><th>State</th><th>Risk</th>
          <th>AT&C%</th>
          <th style="${hl('theft')}color:#ef4444">Theft/yr</th>
          <th style="${hl('htls')}color:#3b82f6">HTLS/yr</th>
          <th style="${hl('sm')}color:#10b981">SM ToU/yr</th>
          <th>Score</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ═══════════════════════════════════════════════════════════════════════ EVENTS

function bindEvents() {
  // INDIA sub-view toggle (scoped to #map-view-toggle)
  document.querySelectorAll('#map-view-toggle .toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#map-view-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      updateMapView(e.currentTarget.dataset.view);
    });
  });

  // BIG INDIA / LOCAL MODE TOGGLE
  document.querySelectorAll('#mode-toggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#mode-toggle .mode-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      switchDashboardMode(e.currentTarget.dataset.mode);
    });
  });

  // LOCAL sub-view toggle (Zone Forecast / Meter Anomalies / Inspector / What-If)
  document.querySelectorAll('#local-view-toggle .toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#local-view-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      switchLocalView(e.currentTarget.dataset.localView);
    });
  });

  // What-If sliders (live re-projection)
  ['whatif-heat', 'whatif-ac', 'whatif-festival'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateWhatIfScenario);
  });

  // Tactical overlay: density toggle (Meter Level / Zone Level)
  document.querySelectorAll('.density-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.density = btn.dataset.density;
      // Reset zone drill-down when switching to zone density
      if (STATE.density === 'zone') STATE.selectedZone = null;
      const dEl = document.getElementById('bm-density'); if (dEl) dEl.textContent = STATE.density.toUpperCase();
      const dSub = document.getElementById('bm-density-sub');
      if (dSub) dSub.textContent = STATE.density === 'zone' ? 'click zone to drill in' : (STATE.selectedZone ? 'drilled view' : 'all 576 meters visible');
      const metaView = document.getElementById('meta-view'); if (metaView) metaView.textContent = STATE.density.toUpperCase();
      if (map && STATE.dashboardMode === 'local') {
        map.flyTo(BENGALURU_CENTER, 11, { duration: 0.5 });
        renderMeterMapMarkers();
      }
    });
  });

  // Tactical overlay: layer toggles
  document.querySelectorAll('input[data-layer]').forEach(input => {
    input.addEventListener('change', (e) => {
      const layer = e.currentTarget.dataset.layer;
      STATE.layerOn[layer] = e.currentTarget.checked;
      if (STATE.density === 'meter' && STATE.dashboardMode === 'local') renderMeterMapMarkers();
    });
  });

  // Tactical overlay: scenes
  document.querySelectorAll('.scene-row').forEach(row => {
    row.addEventListener('click', () => {
      const scene = row.dataset.scene;
      if (!map) return;
      if (scene === 'bengaluru') {
        STATE.selectedZone = null;
        map.flyTo(BENGALURU_CENTER, 11, { duration: 0.6 });
      } else if (scene === 'flagged') {
        STATE.layerOn = { critical: true, high: true, moderate: true, normal: false };
        document.querySelectorAll('input[data-layer]').forEach(i => {
          i.checked = STATE.layerOn[i.dataset.layer];
        });
      } else if (scene === 'rural') {
        // fly to peri-urban centroid
        map.flyTo([13.07, 77.55], 12, { duration: 0.6 });
      }
      renderMeterMapMarkers();
    });
  });

  // IEX date range
  document.querySelectorAll('#iex-range .pill').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#iex-range .pill').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      STATE.iexDays = parseInt(e.currentTarget.dataset.days);
      renderIexChart();
    });
  });

  // Generation date range
  document.querySelectorAll('#gen-range .pill').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#gen-range .pill').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      STATE.genDays = parseInt(e.currentTarget.dataset.days);
      renderGenChart();
    });
  });

  // Battery slider (only exists in tampering view)
  const slider = document.getElementById('battery-slider');
  const label  = document.getElementById('battery-val');
  if (slider) slider.addEventListener('input', (e) => {
    STATE.battCapacity = parseFloat(e.target.value);
    label.textContent  = `${STATE.battCapacity} MWh`;
    renderBatteryChart();
  });

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    await fetch('/api/refresh', { method: 'POST' });
    await fetchAll();
    renderAll();
    btn.classList.remove('spinning');
    document.getElementById('last-updated').textContent = 'Refreshed ' + new Date().toLocaleTimeString();
  });
}

// ═══════════════════════════════════════════════════════════════════════ RENDER ALL

function renderAll() {
  renderKPIs();
  renderIexChart();
  renderAtcChart();
  renderBatteryChart();
  renderForecastChart();
  renderGenChart();
  renderModelTable();
  renderDiscomTable();
}

// ═══════════════════════════════════════════════════════════════════════ BOOT

async function boot() {
  bindEvents();

  // Apply shimmers immediately so UI isn't blank
  applyAllShimmers();

  // Run the 2-second branded loader with bumpy progress
  // Meanwhile kick off all data fetches in parallel + map init in background
  const dataPromises = Object.keys(API_ROUTES).map(key => fetchAndRender(key));
  const mapPromise   = initMap();

  // The loader runs its full animation (~2s), then hides regardless of data state
  await new Promise(resolve => runLoader(resolve));
  hideLoader();

  // Update timestamp once loader hides
  document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();

  // Wait for map to be ready (usually done by now), then invalidate size
  await mapPromise;
  // Compute the initial view based on saved mode (avoids a flash of India zoom 5 before flying to Bengaluru)
  let initialMode = 'local';
  try { initialMode = localStorage.getItem('gridlytics_mode') || 'local'; } catch (e) {}
  setTimeout(() => {
    if (map) {
      map.invalidateSize();
      if (initialMode === 'local') {
        map.setView(BENGALURU_CENTER, 11, { animate: false });
      } else {
        map.setView(INDIA_CENTER, 5, { animate: false });
      }
    }
  }, 200);

  // Safety net: hide map spinner after 12s no matter what (cold warehouse can be slow)
  setTimeout(() => document.getElementById('map-loading').classList.add('hidden'), 12000);

  // When intelligence data arrives, update map (fetchAndRender handles it incrementally)
  // But also do a final full render once everything is settled
  Promise.allSettled(dataPromises).then(() => {
    renderAll();
    // Remove any leftover shimmers
    document.querySelectorAll('.shimmer-block').forEach(s => s.remove());
    document.querySelectorAll('canvas').forEach(c => c.style.display = '');
    document.getElementById('map-loading').classList.add('hidden');

    const fc = STATE.data.models.find(m => (m.model_name || '').includes('forecast'));
    if (fc) {
      const _rmse = document.getElementById('model-rmse');
      if (_rmse) _rmse.textContent = `GBT Model · RMSE: ${toFloat(fc.rmse).toFixed(3)} ₹/kWh · R²: ${toFloat(fc.r2).toFixed(3)}`;
    }
    document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();

    // Restore mode (LOCAL is default — BESCOM Theme 8 focus)
    let savedMode = 'local';
    try { savedMode = localStorage.getItem('gridlytics_mode') || 'local'; } catch (e) {}
    document.querySelectorAll('#mode-toggle .mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === savedMode);
    });
    switchDashboardMode(savedMode);

    // Live REC clock (mimics Delhi Kavach)
    const tickRec = () => {
      const el = document.getElementById('meta-time');
      if (el) {
        const d = new Date();
        el.textContent = d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
      }
    };
    tickRec(); setInterval(tickRec, 1000);
  });
}

window.addEventListener('DOMContentLoaded', boot);

// ═══════════════════════════════════════════════════ DISCOM DETAIL DRAWER
(function initDrawer() {
  const drawer   = document.getElementById('discom-drawer');
  const overlay  = document.getElementById('discom-overlay');
  const ddBack   = document.getElementById('dd-back');
  const ddName   = document.getElementById('dd-name');
  const ddState  = document.getElementById('dd-state');
  const ddRisk   = document.getElementById('dd-risk-badge');
  const ddScFill = document.getElementById('dd-score-fill');
  const ddScVal  = document.getElementById('dd-score-val');
  const ddAtcVal = document.getElementById('ddk-atc-val');
  const ddTheft  = document.getElementById('ddk-theft-val');
  const ddHtls   = document.getElementById('ddk-htls-val');
  const ddSm     = document.getElementById('ddk-sm-val');
  const ddCards  = document.getElementById('dd-cards');
  const ddBench  = document.getElementById('dd-benchmark-badge');
  const ddLangs  = document.querySelectorAll('.dd-lang');
  const invSlider = document.getElementById('dd-inv-slider');

  let currentDiscom = null;
  let currentLang   = 'en';
  const dc = {};  // chart instance registry — destroy before recreating

  function killChart(key) { if (dc[key]) { dc[key].destroy(); dc[key] = null; } }

  // ── Close ────────────────────────────────────────────────────────────
  function closeDrawer() {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
  }
  ddBack.addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);

  ddLangs.forEach(btn => btn.addEventListener('click', () => {
    ddLangs.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentLang = btn.dataset.lang;
    if (currentDiscom) fetchInsights(currentDiscom, currentLang);
  }));

  // ── Open ─────────────────────────────────────────────────────────────
  window.openDiscomDrawer = function(d) {
    currentDiscom = d;
    currentLang = 'en';
    ddLangs.forEach(b => b.classList.toggle('active', b.dataset.lang === 'en'));
    ddBench.style.display = 'none';

    ddName.textContent = d.discom || '–';
    const anomaly = d.is_anomaly === 'true' || d.is_anomaly === true
      ? ` · ⚠ ${(d.anomaly_type||'').replace(/_/g,' ')}` : '';
    ddState.textContent = `${d.state || '–'}${anomaly}`;

    const label = (d.tampering_label || 'low').toLowerCase();
    ddRisk.textContent = d.tampering_label || '–';
    ddRisk.className   = `dd-risk-badge dd-risk-${label}`;

    const score = toFloat(d.overall_opportunity_score);
    ddScFill.style.width = score + '%';
    ddScVal.textContent  = score.toFixed(0) + '/100';
    ddAtcVal.textContent = fmt.pct(d.atc_pct_2024);
    ddTheft.textContent  = fmt.cr(d.est_theft_rev_loss_cr);
    ddHtls.textContent   = fmt.cr(d.htls_annual_saving_cr);
    ddSm.textContent     = fmt.pct(d.sm_installation_pct);

    ddCards.innerHTML = `<div class="dd-thinking-wrap" style="grid-column:1/-1"><div class="dd-thinking"><span></span><span></span><span></span></div></div>`;

    drawer.classList.add('open');
    overlay.classList.add('open');

    // Render all data-driven charts immediately (no LLM needed)
    renderRadar(d);
    renderWaterfall(d);
    initSlider(d);
    renderBubble(null);  // placeholder until LLM returns

    fetchInsights(d, currentLang);
  };

  // ── A: RADAR GAP CHART ───────────────────────────────────────────────
  const AXES   = ['AT&C Efficiency','Tampering Control','Wire Infra','SM Penetration','Collection Rate'];
  const BEST   = [91.5, 95, 88, 85, 98];  // best-in-class scores (0–100, higher=better)

  function toScores(d) {
    return [
      Math.max(0, 100 - toFloat(d.atc_pct_2024)),
      Math.max(0, 100 - toFloat(d.tampering_index)),
      Math.max(0, 100 - toFloat(d.tech_opportunity_score || 50)),
      Math.min(100, toFloat(d.sm_installation_pct)),
      Math.max(0, 100 - toFloat(d.collection_gap_pct)),
    ];
  }

  function stateAvgScores(state) {
    const peers = STATE.data.intelligence.filter(x => x.state === state);
    if (!peers.length) return BEST.map(v => v * 0.7);
    const avg = k => peers.reduce((s,x) => s + toFloat(x[k]), 0) / peers.length;
    return [
      Math.max(0, 100 - avg('atc_pct_2024')),
      Math.max(0, 100 - avg('tampering_index')),
      Math.max(0, 100 - (avg('tech_opportunity_score') || 50)),
      Math.min(100, avg('sm_installation_pct')),
      Math.max(0, 100 - avg('collection_gap_pct')),
    ];
  }

  function renderRadar(d) {
    killChart('radar');
    const ctx = document.getElementById('dd-radar');
    if (!ctx) return;
    const mine  = toScores(d);
    const state = stateAvgScores(d.state);
    dc.radar = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: AXES,
        datasets: [
          { label: 'Best-in-Class', data: BEST,  borderColor:'#10b981', backgroundColor:'rgba(16,185,129,0.08)', borderWidth:2, pointRadius:3, borderDash:[4,4] },
          { label: 'State Avg',     data: state, borderColor:'#f59e0b', backgroundColor:'rgba(245,158,11,0.10)', borderWidth:1.5, pointRadius:2 },
          { label: d.discom,        data: mine,  borderColor:'#ef4444', backgroundColor:'rgba(239,68,68,0.18)',  borderWidth:2,   pointRadius:4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { r: {
          min: 0, max: 100,
          ticks: { display: false, stepSize: 25 },
          grid:       { color: '#1e2d42' },
          angleLines:  { color: '#1e2d42' },
          pointLabels: { color: '#8899aa', font: { size: 10 } },
        }},
        plugins: { legend: { display: false } },
        animation: { duration: 600 },
      },
    });
  }

  // ── B: REVENUE WATERFALL ─────────────────────────────────────────────
  function renderWaterfall(d) {
    killChart('waterfall');
    const ctx = document.getElementById('dd-waterfall');
    if (!ctx) return;
    const theft = toFloat(d.est_theft_rev_loss_cr);
    const htls  = toFloat(d.htls_annual_saving_cr);
    const sm    = toFloat(d.sm_annual_tou_saving_cr);
    const billing = toFloat(d.billing_gap_pct) * toFloat(d.atc_pct_2024) * 5; // rough ₹Cr proxy
    const total = theft + htls + sm + billing;

    document.getElementById('dd-waterfall-total').textContent =
      `Total recovery potential: ₹${total.toFixed(0)} Cr/yr`;

    // Floating bars: [start, end]
    let run = total;
    const data = [
      { label: 'Current Loss', v: [0, total],           color: '#ef4444' },
      { label: '− Theft',      v: [run -= theft, run + theft], color: '#10b981' },
      { label: '− HTLS Wire',  v: [run -= htls, run + htls],   color: '#3b82f6' },
      { label: '− SM ToU',     v: [run -= sm, run + sm],       color: '#06b6d4' },
      { label: '− Billing',    v: [run -= billing, run + billing], color: '#f59e0b' },
      { label: 'Net Remaining',v: [0, Math.max(0, run)],       color: '#8b5cf6' },
    ];

    dc.waterfall = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(x => x.label),
        datasets: [{
          data              : data.map(x => x.v),
          backgroundColor   : data.map(x => x.color + 'cc'),
          borderColor       : data.map(x => x.color),
          borderWidth       : 1,
          borderRadius      : 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: ctx => `₹${(ctx.raw[1] - ctx.raw[0]).toFixed(0)} Cr`,
          }},
        },
        scales: {
          x: { ticks: { color:'#8899aa', font:{size:9} }, grid:{display:false} },
          y: { ticks: { color:'#8899aa', font:{size:9},
            callback: v => `₹${v.toFixed(0)}` }, grid:{color:'#1e2d42'} },
        },
      },
    });
  }

  // ── D: INVESTMENT ROI SIMULATOR ───────────────────────────────────────
  function calcROI(inv, d) {
    const htlsCapex  = Math.max(1, toFloat(d.htls_capex_cr));
    const htlsSaving = toFloat(d.htls_annual_saving_cr);
    const smRemain   = Math.max(1, toFloat(d.sm_remaining));
    const smSaving   = toFloat(d.sm_annual_tou_saving_cr);

    const htlsInv = Math.min(inv, htlsCapex);
    const smInv   = Math.max(0, inv - htlsCapex);
    const htlsFrac = htlsInv / htlsCapex;
    // Cost per SM meter ≈ ₹5000 → smRemain * 5000 / 1e7 Cr
    const smTotalCost = Math.max(1, smRemain * 5000 / 1e7);
    const smFrac = Math.min(1, smInv / smTotalCost);

    const htlsAnn = htlsFrac * htlsSaving;
    const smAnn   = smFrac   * smSaving;
    const totalAnn = htlsAnn + smAnn;
    const roi     = inv > 0 ? (totalAnn / inv * 100) : 0;
    const payback = totalAnn > 0 ? Math.min(30, inv / totalAnn) : 30;
    const atcRed  = htlsFrac * 4.0 + smFrac * 1.5;  // approx pp reduction

    return { htlsAnn, smAnn, totalAnn, roi, payback, atcRed, htlsFrac, smFrac };
  }

  function initSlider(d) {
    killChart('roi');
    const maxInv = Math.ceil((toFloat(d.htls_capex_cr) + toFloat(d.sm_remaining) * 5000 / 1e7) / 50) * 50;
    invSlider.max   = Math.max(500, Math.min(5000, maxInv));
    invSlider.value = Math.round(toFloat(d.htls_capex_cr) * 0.3 / 25) * 25 || 100;

    const update = () => {
      const inv = parseFloat(invSlider.value);
      document.getElementById('dd-inv-display').textContent = `₹${inv} Cr`;
      const r = calcROI(inv, d);
      document.getElementById('dd-roi-annual').textContent  = fmt.cr(r.totalAnn) + '/yr';
      document.getElementById('dd-roi-pct').textContent     = r.roi.toFixed(0) + '%';
      document.getElementById('dd-roi-payback').textContent = r.payback.toFixed(1) + ' yrs';
      document.getElementById('dd-roi-atc').textContent     = r.atcRed.toFixed(1) + ' pp';
      // Allocation bar
      const htlsPct = inv <= toFloat(d.htls_capex_cr) ? 100 : toFloat(d.htls_capex_cr)/inv*100;
      document.getElementById('dd-alloc-htls').style.width = htlsPct + '%';
      document.getElementById('dd-alloc-htls').textContent = htlsPct > 15 ? 'HTLS' : '';
      document.getElementById('dd-alloc-sm').textContent   = (100-htlsPct) > 15 ? 'SM' : '';
    };

    invSlider.addEventListener('input', () => { update(); renderROICurve(d); });
    update();
    renderROICurve(d);
  }

  function renderROICurve(d) {
    killChart('roi');
    const ctx = document.getElementById('dd-roi-curve');
    if (!ctx) return;
    const maxInv = parseFloat(invSlider.max);
    const steps  = 20;
    const labels = Array.from({length:steps+1}, (_,i) => Math.round(i/steps*maxInv));
    const savingData = labels.map(inv => calcROI(inv, d).totalAnn);
    const current    = parseFloat(invSlider.value);
    dc.roi = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { data: savingData, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)',
            fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 },
          { data: labels.map(l => l === current ? calcROI(l,d).totalAnn : null),
            pointRadius: 6, pointBackgroundColor: '#fff', borderWidth: 0,
            showLine: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend:{display:false}, tooltip:{
          callbacks:{ label: c => `₹${c.raw?.toFixed(0)} Cr/yr` }
        }},
        scales: {
          x: { display: false },
          y: { display: false },
        },
      },
    });
  }

  // ── C: BUBBLE PRIORITY MATRIX ─────────────────────────────────────────
  const CAT_COLORS = {
    'Theft & Tampering':'#ef4444','Wire Infrastructure':'#3b82f6',
    'Smart Metering':'#10b981','Billing & Collection':'#f59e0b','Regulatory':'#8b5cf6',
  };

  function renderBubble(suggestions) {
    killChart('bubble');
    const ctx = document.getElementById('dd-bubble');
    const loadingEl = document.getElementById('dd-bubble-loading');
    if (!ctx) return;

    const items = suggestions || [];
    if (!items.length) {
      if (loadingEl) loadingEl.style.display = 'flex';
      return;
    }
    if (loadingEl) loadingEl.style.display = 'none';

    const confSize = { critical:28, high:20, medium:13 };
    const datasets = items.map(s => ({
      label      : s.title || s.category,
      data       : [{ x: parseFloat(s.timeline_months)||12, y: parseFloat(s.saving_cr)||0,
                      r: confSize[(s.priority||'medium').toLowerCase()] || 15 }],
      backgroundColor: (CAT_COLORS[s.category]||'#8b5cf6') + 'aa',
      borderColor    :  CAT_COLORS[s.category]||'#8b5cf6',
      borderWidth    : 2,
    }));

    dc.bubble = new Chart(ctx, {
      type: 'bubble',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position:'right', labels:{color:'#8899aa',font:{size:10},boxWidth:10} },
          tooltip: { callbacks: { label: c => `${c.dataset.label} · ₹${c.raw.y.toFixed(0)}Cr · ${c.raw.x}mo` }},
        },
        scales: {
          x: { title:{display:true,text:'Timeline (months)',color:'#8899aa',font:{size:10}},
               ticks:{color:'#8899aa'}, grid:{color:'#1e2d42'}, min:0 },
          y: { title:{display:true,text:'Annual Saving (₹ Cr)',color:'#8899aa',font:{size:10}},
               ticks:{color:'#8899aa',callback:v=>`₹${v}`}, grid:{color:'#1e2d42'}, min:0 },
        },
      },
    });
  }

  // ── AI SUGGESTIONS FETCH ──────────────────────────────────────────────
  const CATEGORY_COLORS = {
    'Theft & Tampering':'#ef4444','Wire Infrastructure':'#3b82f6',
    'Smart Metering':'#10b981','Billing & Collection':'#f59e0b','Regulatory':'#8b5cf6',
  };

  async function fetchInsights(d, lang) {
    ddCards.innerHTML = `<div class="dd-thinking-wrap" style="grid-column:1/-1"><div class="dd-thinking"><span></span><span></span><span></span></div></div>`;
    try {
      const resp = await fetch('/api/discom-insights', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({...d, lang}),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      if (data.has_benchmark) ddBench.style.display = '';
      if (data.suggestions?.length) {
        renderCards(data.suggestions);
        renderBubble(data.suggestions);  // update bubble with real LLM data
      } else if (data.raw) {
        renderFallback(data.raw);
      } else throw new Error('No suggestions returned');
    } catch (e) {
      ddCards.innerHTML = `<div class="dd-error" style="grid-column:1/-1">⚠ ${esc(e.message)}</div>`;
    }
  }

  function renderCards(suggestions) {
    ddCards.innerHTML = suggestions.map((s, i) => {
      const accent = CATEGORY_COLORS[s.category] || '#3b82f6';
      const pCls   = `priority-${(s.priority||'medium').toLowerCase()}`;
      const lower  = s.direction !== 'higher_better';
      const cur    = parseFloat(s.current_val)||0, tgt = parseFloat(s.target_val)||0;
      const maxV   = lower ? Math.max(cur,tgt)*1.1 : 100;
      const curP   = Math.min(100, cur/maxV*100), tgtP = Math.min(100, tgt/maxV*100);
      const saving = parseFloat(s.saving_cr)||0;
      return `
      <div class="dd-card" style="--card-accent:${accent};animation-delay:${i*70}ms">
        <div class="dd-card-head">
          <div class="dd-card-icon-cat">
            <span class="dd-card-icon">${s.icon||'📊'}</span>
            <span class="dd-card-cat" style="color:${accent}">${esc(s.category||'')}</span>
          </div>
          <span class="dd-card-priority ${pCls}">${esc(s.priority||'')}</span>
        </div>
        <div class="dd-card-title">${esc(s.title||'')}</div>
        <div class="dd-card-action">${esc(s.action||'')}</div>
        <div class="dd-card-metric">
          <div class="dd-card-metric-row">
            <span class="dd-card-metric-label">${esc(s.metric_label||'')} (${esc(s.unit||'')})</span>
            <div class="dd-card-metric-vals">
              <span class="dd-card-metric-cur">${cur.toFixed(1)}</span>
              <span class="dd-card-metric-arrow">→</span>
              <span class="dd-card-metric-tgt">${tgt.toFixed(1)}</span>
            </div>
          </div>
          <div class="dd-card-bar-track">
            <div class="dd-card-bar-tgt" style="width:${lower?curP:tgtP}%"></div>
            <div class="dd-card-bar-cur" style="width:${lower?tgtP:curP}%"></div>
          </div>
        </div>
        <div class="dd-card-impact">
          <div class="dd-card-saving">₹${saving>=1000?(saving/1000).toFixed(1)+'K':saving.toFixed(0)} Cr/yr</div>
          <div class="dd-card-saving-sub">${esc(s.saving_description||'')}</div>
          <div class="dd-card-meta">
            <span class="dd-card-timeline">⏱ ${s.timeline_months||'?'} months</span>
            <span class="dd-card-basis">${esc(s.data_basis||'')}</span>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function renderFallback(text) {
    const lines = text.split(/\n+/).map(l=>l.trim()).filter(Boolean);
    const items = []; let cur = '';
    for (const l of lines) {
      if (/^(\d+)[.)]\s+/.test(l)) { if(cur) items.push(cur); cur=l.replace(/^(\d+)[.)]\s+/,''); }
      else cur += ' '+l;
    }
    if (cur) items.push(cur);
    ddCards.innerHTML = `<div style="grid-column:1/-1;display:flex;flex-direction:column;gap:10px">` +
      (items.length>1?items:[text]).map((item,i) => `
        <div style="display:flex;gap:10px;padding:12px;background:var(--bg-panel);border:1px solid var(--border);border-radius:10px">
          <div style="width:22px;height:22px;background:var(--blue-dim);color:var(--blue);border-radius:50%;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i+1}</div>
          <div style="font-size:13px;line-height:1.6">${esc(item).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')}</div>
        </div>`).join('') + '</div>';
  }

  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();

// ══════════════════════════════════════════════════════ GENIE CHATBOT
(function initGenie() {
  const fab      = document.getElementById('genie-fab');
  const panel    = document.getElementById('genie-panel');
  const closeBtn = document.getElementById('genie-close');
  const input    = document.getElementById('genie-input');
  const sendBtn  = document.getElementById('genie-send');
  const messages = document.getElementById('genie-messages');

  let conversationId = null;
  let busy = false;

  function togglePanel() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  }
  fab.addEventListener('click', togglePanel);
  closeBtn.addEventListener('click', () => panel.classList.remove('open'));

  // Chip quick-questions
  messages.addEventListener('click', e => {
    const chip = e.target.closest('.genie-chip');
    if (chip) sendQuestion(chip.dataset.q);
  });

  sendBtn.addEventListener('click', () => {
    const q = input.value.trim();
    if (q) { input.value = ''; sendQuestion(q); }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const q = input.value.trim();
      if (q) { input.value = ''; sendQuestion(q); }
    }
  });

  function appendMsg(html, cls) {
    const div = document.createElement('div');
    div.className = cls;
    div.innerHTML = html;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  function showThinking() {
    const div = document.createElement('div');
    div.className = 'genie-bot-msg';
    div.id = 'genie-thinking';
    div.innerHTML = '<div class="genie-thinking"><span></span><span></span><span></span></div>';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }
  function removeThinking() {
    const el = document.getElementById('genie-thinking');
    if (el) el.remove();
  }

  // ── Detect best chart type from column names + values ────────────────
  function detectChartSpec(rows) {
    if (!rows || rows.length < 2) return null;
    const cols = Object.keys(rows[0]);
    if (cols.length < 2) return null;

    const isDate  = k => /date|day|month|year|time/i.test(k);
    const isNum   = (k) => rows.slice(0, 5).every(r => r[k] !== null && r[k] !== '' && !isNaN(Number(r[k])));
    const isCat   = k => !isDate(k) && !isNum(k);

    const dateCol = cols.find(isDate);
    const numCols = cols.filter(k => k !== dateCol && isNum(k));
    const catCol  = cols.find(isCat);

    if (dateCol && numCols.length >= 1) {
      return { type: 'line', labelCol: dateCol, valueCols: numCols.slice(0, 3) };
    }
    if (catCol && numCols.length >= 1) {
      return { type: 'bar', labelCol: catCol, valueCols: numCols.slice(0, 2) };
    }
    // All numeric — line with index as x
    if (numCols.length >= 2) {
      return { type: 'line', labelCol: cols[0], valueCols: numCols.slice(0, 3) };
    }
    return null;
  }

  const CHART_PALETTE = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4'];

  function buildChartConfig(spec, rows) {
    const labels = rows.map(r => String(r[spec.labelCol] ?? ''));
    const datasets = spec.valueCols.map((col, i) => ({
      label: col.replace(/_/g, ' '),
      data : rows.map(r => Number(r[col]) || 0),
      backgroundColor: spec.type === 'bar'
        ? rows.map((_, j) => CHART_PALETTE[j % CHART_PALETTE.length] + 'cc')
        : CHART_PALETTE[i] + '33',
      borderColor : CHART_PALETTE[i],
      borderWidth : spec.type === 'bar' ? 0 : 2,
      pointRadius : spec.type === 'line' ? 3 : undefined,
      fill        : spec.type === 'line',
      tension     : 0.3,
    }));

    const isHorizontal = spec.type === 'bar' && rows.length > 5;
    return {
      type: isHorizontal ? 'bar' : spec.type,
      data: { labels, datasets },
      options: {
        indexAxis   : isHorizontal ? 'y' : 'x',
        responsive  : true,
        maintainAspectRatio: false,
        animation   : { duration: 400 },
        plugins: {
          legend: { display: datasets.length > 1, labels: { color:'#8899aa', font:{ size:11 } } },
          tooltip: { mode:'index', intersect:false },
        },
        scales: {
          x: { ticks:{ color:'#8899aa', maxRotation:30, font:{size:10} }, grid:{ color:'#1e2d42' } },
          y: { ticks:{ color:'#8899aa', font:{size:10} }, grid:{ color:'#1e2d42' } },
        },
      },
    };
  }

  function renderBotResponse(data) {
    let html = '';

    // Main answer — render markdown bold (**text**) simply
    if (data.text) {
      const safe = escapeHtml(data.text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html += `<div style="line-height:1.6">${safe}</div>`;
    }

    const rows = data.queryResult && data.queryResult.length > 0 ? data.queryResult : null;
    const spec  = rows ? detectChartSpec(rows) : null;
    const chartId = 'gc_' + Math.random().toString(36).slice(2);

    // Chart (when we can detect a useful shape)
    if (spec) {
      const h = spec.type === 'bar' && rows.length > 6 ? Math.min(40 + rows.length * 22, 300) : 180;
      html += `<div class="genie-chart-wrap" style="height:${h}px;margin-top:10px"><canvas id="${chartId}"></canvas></div>`;
    }

    // Collapsible data table
    if (rows) {
      const cols = Object.keys(rows[0]);
      html += `<details style="margin-top:8px">
        <summary style="font-size:11px;color:var(--text-muted);cursor:pointer;user-select:none">
          View data table (${rows.length} rows) ↕
        </summary>
        <div style="overflow-x:auto;margin-top:6px"><table class="genie-table"><thead><tr>`;
      cols.forEach(c => { html += `<th>${escapeHtml(c)}</th>`; });
      html += `</tr></thead><tbody>`;
      rows.slice(0, 20).forEach(row => {
        html += '<tr>';
        cols.forEach(c => { html += `<td>${escapeHtml(String(row[c] ?? ''))}</td>`; });
        html += '</tr>';
      });
      if (rows.length > 20) {
        html += `<tr><td colspan="${cols.length}" style="color:var(--text-muted);text-align:center">… ${rows.length - 20} more rows</td></tr>`;
      }
      html += `</tbody></table></div></details>`;
    }

    // SQL collapsible
    if (data.sql) {
      html += `<details style="margin-top:4px">
        <summary style="font-size:11px;color:var(--text-muted);cursor:pointer;user-select:none">View generated SQL ↕</summary>
        <div class="genie-sql-block">${escapeHtml(data.sql)}</div>
      </details>`;
    }

    if (!html) html = '<em style="color:var(--text-sub)">No response received.</em>';
    const el = appendMsg(html, 'genie-bot-msg');

    // Mount chart after element is in DOM
    if (spec) {
      const canvas = document.getElementById(chartId);
      if (canvas) new Chart(canvas, buildChartConfig(spec, rows));
    }
  }

  async function sendQuestion(question) {
    if (busy) return;
    busy = true;
    sendBtn.disabled = true;

    appendMsg(escapeHtml(question), 'genie-user-msg');
    showThinking();

    try {
      const endpoint = conversationId ? '/api/genie/followup' : '/api/genie/start';
      const body = conversationId
        ? { conversation_id: conversationId, question }
        : { question };

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();

      removeThinking();

      if (data.error) {
        appendMsg(`<span style="color:var(--red)">Error: ${escapeHtml(data.error)}</span>`, 'genie-bot-msg');
        conversationId = null; // reset on error
      } else {
        if (data.conversation_id) conversationId = data.conversation_id;
        renderBotResponse(data);
      }
    } catch (err) {
      removeThinking();
      appendMsg(`<span style="color:var(--red)">Network error: ${escapeHtml(err.message)}</span>`, 'genie-bot-msg');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();

// ── ML Model Performance Strip ────────────────────────────────────────────
(async function mlPerfStrip() {
  const strip = document.getElementById('ml-perf-strip');
  const cards = document.getElementById('ml-perf-cards');
  if (!strip || !cards) return;

  try {
    const data = await apiFetch('/api/models');
    if (!data || !data.length) return;

    cards.innerHTML = data.map(m => {
      const best    = parseFloat(m.best_metric)    || 0;
      const def     = parseFloat(m.default_metric) || 0;
      const impr    = parseFloat(m.improvement_pct)|| 0;
      const trials  = parseInt(m.n_trials)         || 0;
      const isGbt   = m.model_name === 'gbt_forecast';
      // For GBT: lower RMSE = better (positive improvement = good)
      // For IF:  higher sep = better (positive improvement = good)
      const improved = impr > 0.5;
      const badgeClass = improved ? 'up' : impr < -0.5 ? 'down' : 'flat';
      const sign = impr > 0 ? '+' : '';
      const fmtVal = v => isGbt ? v.toFixed(3) : v.toFixed(4);
      const arrow = isGbt
        ? (best < def ? '↓' : '↑')   // lower RMSE is better
        : (best > def ? '↑' : '↓');  // higher sep is better
      const dt = m.updated_at ? new Date(m.updated_at).toLocaleDateString('en-IN', {day:'numeric',month:'short'}) : '';

      return `<div class="ml-perf-card" title="Last tuned: ${dt}">
        <span class="ml-perf-card-name">${esc(m.display_name || m.model_name)}</span>
        <span class="ml-perf-card-metric">${esc(m.metric_label||'')}</span>
        <span class="ml-perf-card-arrow">:</span>
        <span class="ml-perf-card-metric">${fmtVal(def)}</span>
        <span style="font-size:10px;color:var(--text-muted)">${arrow}</span>
        <span class="ml-perf-card-best">${fmtVal(best)}</span>
        <span class="ml-perf-badge ${badgeClass}">${sign}${impr.toFixed(1)}%</span>
        <span class="ml-perf-trials">${trials} trials</span>
      </div>`;
    }).join('');

    strip.style.display = 'flex';
  } catch (e) {
    // Table doesn't exist yet — strip stays hidden until job runs
    console.log('[ml-perf] best_hyperparams not yet available:', e.message);
  }
})();
