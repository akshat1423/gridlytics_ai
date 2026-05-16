/* ═══════════════════════════════════════════════════════════════════════
   Gridlytics — Frontend Dashboard
   Vanilla JS + Leaflet + Chart.js  |  No build step required
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

// ─── Global state ────────────────────────────────────────────────────────────
const STATE = {
  dashboardMode: 'local',          // 'india' | 'local' (LOCAL is the default — BESCOM Theme 8 focus)
  mapView      : 'sm',             // 'tampering' | 'htls' | 'sm' (India sub-view)
  localView    : 'meters',         // 'meters' | 'zones' | 'inspector' | 'whatif' | 'tod' | 'deploy'
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
    zoneBounds   : null,         // GeoJSON FeatureCollection
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
let mlMap = null;        // MapLibre GL satellite map (Local mode)
let mlPopup = null;
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
  zoneBounds   : '/api/zone-boundaries',
};

// Fetch one key, store result, then immediately render that panel
async function fetchAndRender(key) {
  try {
    const data = await apiFetch(API_ROUTES[key]);
    if (key === 'zoneBounds') {
      // GeoJSON FeatureCollection — store as-is (not array-wrapped)
      STATE.data.zoneBounds = data;
      console.log(`[${key}] ✓ ${(data?.features || []).length} polygons`);
    } else {
      STATE.data[key] = Array.isArray(data) ? data : (data ? [data] : []);
      if (key === 'hindi' && STATE.data[key].length) STATE.data.hindi = STATE.data[key][0];
      console.log(`[${key}] ✓ ${STATE.data[key].length} rows`);
    }
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
    case 'zoneBounds':
      STATE._localZonesRendered = false;
      STATE._localMetersRendered = false;
      STATE._localInspectorRendered = false;
      STATE._localWhatifRendered = false;
      if (STATE.dashboardMode === 'local') {
        renderLocalKPIs();
        populateZoneChips();
        renderLocalSubView(STATE.localView);
        if (key === 'meters' && !STATE._localFitted) {
          fitMapToBengaluru();
          STATE._localFitted = true;
        }
        renderMeterMapMarkers();
        // Belt-and-suspenders: re-push data after a delay so MapLibre sources
        // are guaranteed to exist even if the map loaded before this fetch completed
        if (key === 'meters' || key === 'zoneBounds' || key === 'zoneForecast') {
          setTimeout(refreshMapLibreData, 400);
          setTimeout(refreshMapLibreData, 1200);
        }
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

  // Esri World Imagery (satellite) — same source Delhi Kavach uses, no API key required
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
    className: 'satellite-tiles',
  }).addTo(map);

  // Subtle place/road labels overlay (so the satellite isn't unreadable)
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    opacity: 0.55,
    className: 'satellite-labels',
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

// ═══════════════════════════════════════════════════════════════════════
//   MapLibre GL — 3D tilted satellite view for Local mode (Delhi-Kavach style)
// ═══════════════════════════════════════════════════════════════════════
function initMapLibre() {
  if (mlMap) return mlMap;
  if (!window.maplibregl) return null;

  mlMap = new maplibregl.Map({
    container: 'bengaluru-map',
    style: {
      version: 8,
      glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
      sources: {
        'esri-imagery': {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Imagery © Esri, Maxar',
        },
        'esri-labels': {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          maxzoom: 19,
        },
      },
      layers: [
        { id: 'imagery', type: 'raster', source: 'esri-imagery' },
        { id: 'labels',  type: 'raster', source: 'esri-labels', paint: { 'raster-opacity': 0.55 } },
      ],
    },
    center: [BENGALURU_CENTER[1], BENGALURU_CENTER[0]],   // [lon, lat]
    zoom: 11,
    pitch: 55,                  // 3D tilt — the key Delhi-Kavach look
    bearing: -12,
    antialias: true,
    attributionControl: { compact: true },
  });

  mlMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  mlPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'ml-popup' });

  mlMap.on('load', () => {
    addMapLibreLayers();
    refreshMapLibreData();  // always refresh — state check inside
  });

  return mlMap;
}

// Empty source/layer scaffolding — populated on data refresh
function addMapLibreLayers() {
  if (!mlMap) return;

  // Zone polygons
  mlMap.addSource('zone-bounds', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  mlMap.addLayer({
    id: 'zone-bounds-fill',
    type: 'fill',
    source: 'zone-bounds',
    paint: {
      'fill-color': [
        'match', ['get', 'risk_level'],
        'Critical', '#ef4444',
        'High',     '#f97316',
        'Moderate', '#f59e0b',
        '#10b981',
      ],
      'fill-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 0.20, 0.06],
    },
  });
  mlMap.addLayer({
    id: 'zone-bounds-line',
    type: 'line',
    source: 'zone-bounds',
    paint: {
      'line-color': [
        'match', ['get', 'risk_level'],
        'Critical', '#ef4444',
        'High',     '#f97316',
        'Moderate', '#f59e0b',
        '#10b981',
      ],
      'line-width': ['case', ['boolean', ['feature-state', 'active'], false], 2.5, 1.2],
      'line-opacity': 0.85,
      'line-dasharray': [3, 3],
    },
  });
  mlMap.addLayer({
    id: 'zone-bounds-label',
    type: 'symbol',
    source: 'zone-bounds',
    layout: {
      'text-field': ['get', 'zone_name'],
      'text-size': 11,
      'text-letter-spacing': 0.08,
      'text-transform': 'uppercase',
      'text-offset': [0, 0],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#7dd3fc',
      'text-halo-color': '#0e1623',
      'text-halo-width': 1.2,
      'text-opacity': 0.9,
    },
  });

  // Meter dots
  mlMap.addSource('meters', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  mlMap.addLayer({
    id: 'meters-circle',
    type: 'circle',
    source: 'meters',
    paint: {
      // Severity-based radius — red biggest, then orange, then yellow, then green
      'circle-radius': [
        'match', ['get', 'severity'],
        'Critical', 9,
        'High',     7,
        'Moderate', 5,
        'Low',      3.5,
        4,
      ],
      'circle-color': [
        'match', ['get', 'severity'],
        'Critical', '#ef4444',
        'High',     '#f97316',
        'Moderate', '#f59e0b',
        '#10b981',
      ],
      'circle-opacity': [
        'match', ['get', 'severity'],
        'Critical', 1.0,
        'High',     0.95,
        'Moderate', 0.92,
        'Low',      0.85,
        0.85,
      ],
      'circle-stroke-color': [
        'match', ['get', 'severity'],
        'Critical', '#7f1d1d',
        'High',     '#9a3412',
        'Moderate', '#78350f',
        'Low',      '#064e3b',
        '#0e1623',
      ],
      'circle-stroke-width': ['case', ['get', 'is_theft'], 1.6, 1],
      'circle-stroke-opacity': 0.85,
      // Subtle outer glow ring (a second smaller "core")
      'circle-blur': 0.05,
    },
  });

  // Zone bubbles (used in zone-density mode)
  mlMap.addSource('zone-bubbles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  mlMap.addLayer({
    id: 'zone-bubbles-circle',
    type: 'circle',
    source: 'zone-bubbles',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'flagged_ratio'], 0, 14, 1, 36],
      'circle-color': [
        'match', ['get', 'risk_level'],
        'Critical', '#ef4444',
        'High',     '#f97316',
        'Moderate', '#f59e0b',
        '#10b981',
      ],
      'circle-opacity': 0.35,
      'circle-stroke-color': [
        'match', ['get', 'risk_level'],
        'Critical', '#ef4444',
        'High',     '#f97316',
        'Moderate', '#f59e0b',
        '#10b981',
      ],
      'circle-stroke-width': 2,
    },
  });

  // Hover handlers
  mlMap.on('mousemove', 'meters-circle', (e) => {
    if (!e.features.length || STATE.pinnedMeter) return;
    const id = e.features[0].properties.meter_id;
    const m = findMeterById(id);
    if (m) {
      updateDetailPanelForMeter(m, false);
      mlMap.getCanvas().style.cursor = 'pointer';
    }
  });
  mlMap.on('mouseleave', 'meters-circle', () => { mlMap.getCanvas().style.cursor = ''; });
  mlMap.on('click', 'meters-circle', (e) => {
    if (!e.features.length) return;
    const id = e.features[0].properties.meter_id;
    STATE.pinnedMeter = id;
    const m = findMeterById(id);
    if (m) updateDetailPanelForMeter(m, true);
  });

  // Zone polygon click → drill-in
  mlMap.on('click', 'zone-bounds-fill', (e) => {
    if (!e.features.length) return;
    const zid = e.features[0].properties.zone_id;
    const zone = (STATE.data.zoneForecast || []).find(z => z.zone_id === zid);
    if (!zone) return;

    if (STATE.localView === 'meters') {
      STATE.selectedZone = zid;
      STATE.density = 'meter';
      document.querySelectorAll('.density-btn').forEach(b => b.classList.toggle('active', b.dataset.density === 'meter'));
      const dEl = document.getElementById('bm-density'); if (dEl) dEl.textContent = 'METER';
      const dSub = document.getElementById('bm-density-sub'); if (dSub) dSub.textContent = `drilled into ${zone.zone_name}`;
      const metaView = document.getElementById('meta-view'); if (metaView) metaView.textContent = 'METER · ' + zone.zone_name.toUpperCase();
      const metaZ = document.getElementById('meta-zone'); if (metaZ) metaZ.textContent = zone.zone_name.toUpperCase();
      // Fit camera to the zone polygon
      const coords = e.features[0].geometry.coordinates[0];
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      mlMap.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 60, pitch: 55, bearing: -12, maxZoom: 14, duration: 700 });
      updateBackButton();
      refreshMapLibreData();
    }
    updateDetailPanelForZone(zone, true);
  });
  mlMap.on('mouseenter', 'zone-bounds-fill', (e) => {
    mlMap.getCanvas().style.cursor = 'pointer';
    if (e.features.length) {
      const zid = e.features[0].properties.zone_id;
      const zone = (STATE.data.zoneForecast || []).find(z => z.zone_id === zid);
      if (zone && !STATE.pinnedMeter) updateDetailPanelForZone(zone, false);
    }
  });
  mlMap.on('mouseleave', 'zone-bounds-fill', () => { mlMap.getCanvas().style.cursor = ''; });
}

// Sync meter / zone data into MapLibre sources (call whenever data or filter state changes)
function refreshMapLibreData() {
  if (!mlMap || !mlMap.isStyleLoaded()) {
    if (mlMap) mlMap.once('load', refreshMapLibreData);
    return;
  }
  // Sources not added yet (addMapLibreLayers hasn't run) — retry shortly
  if (!mlMap.getSource('meters')) {
    setTimeout(refreshMapLibreData, 150);
    return;
  }

  // Zone boundaries with risk_level prop (lookup per zone)
  const zonesById = {};
  (STATE.data.zoneForecast || []).forEach(z => { zonesById[z.zone_id] = z; });
  const fc = STATE.data.zoneBounds;
  let zoneBoundsFC = { type: 'FeatureCollection', features: [] };
  if (fc && fc.features) {
    zoneBoundsFC = {
      type: 'FeatureCollection',
      features: fc.features.map(f => {
        const z = zonesById[f.properties.zone_id];
        return {
          ...f,
          properties: {
            ...f.properties,
            risk_level: z ? z.risk_level : 'Low',
          },
        };
      }),
    };
  }
  // In deploy view the map is owned by _updateDeployMap — don't clobber its colors
  if (STATE.localView === 'deploy') return;

  mlMap.getSource('zone-bounds').setData(zoneBoundsFC);

  // Meters (filtered by layer toggles + zone drill-down)
  const allMeters = STATE.data.meters || [];
  const meters = allMeters.filter(m => {
    if (STATE.selectedZone && m.zone_id !== STATE.selectedZone) return false;
    if (m.severity === 'Critical' && !STATE.layerOn.critical) return false;
    if (m.severity === 'High'     && !STATE.layerOn.high)     return false;
    if (m.severity === 'Moderate' && !STATE.layerOn.moderate) return false;
    if (m.severity === 'Low'      && !STATE.layerOn.normal)   return false;
    return true;
  });
  const meterFC = {
    type: 'FeatureCollection',
    features: meters.map(m => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
      properties: {
        meter_id: m.meter_id,
        is_theft: !!m.is_theft,
        severity: m.severity,
      },
    })),
  };
  mlMap.getSource('meters').setData(meterFC);

  // Zone bubbles (only shown when density === 'zone' and view === 'meters')
  let bubbleFC = { type: 'FeatureCollection', features: [] };
  if ((STATE.localView === 'meters' && STATE.density === 'zone') ||
      STATE.localView === 'zones' || STATE.localView === 'whatif') {
    bubbleFC = {
      type: 'FeatureCollection',
      features: (STATE.data.zoneForecast || []).map(z => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [z.lon, z.lat] },
        properties: {
          zone_id: z.zone_id,
          zone_name: z.zone_name,
          risk_level: z.risk_level,
          flagged_ratio: z.n_flagged / Math.max(1, z.n_meters),
        },
      })),
    };
  }
  mlMap.getSource('zone-bubbles').setData(bubbleFC);

  // Toggle layer visibility based on density
  const meterVis = (STATE.localView === 'meters' && STATE.density === 'meter') ? 'visible' : 'none';
  const bubbleVis = ((STATE.localView === 'meters' && STATE.density === 'zone') ||
                     STATE.localView === 'zones' || STATE.localView === 'whatif') ? 'visible' : 'none';
  mlMap.setLayoutProperty('meters-circle', 'visibility', meterVis);
  mlMap.setLayoutProperty('zone-bubbles-circle', 'visibility', bubbleVis);
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

// Computes a Leaflet LatLngBounds covering all 576 meter coordinates,
// so the default view always frames the actual data rather than guessing zoom.
function getBengaluruBounds() {
  const meters = STATE.data.meters || [];
  if (!meters.length) return null;
  const lats = meters.map(m => m.lat);
  const lons = meters.map(m => m.lon);
  return L.latLngBounds(
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)]
  );
}

function fitMapToBengaluru() {
  // Local (MapLibre) — fit to the actual meter bounds with a tasteful zoom + 3D pitch
  if (STATE.dashboardMode === 'local' && mlMap) {
    const meters = STATE.data.meters || [];
    if (meters.length) {
      const lats = meters.map(m => m.lat);
      const lons = meters.map(m => m.lon);
      const sw = [Math.min(...lons), Math.min(...lats)];
      const ne = [Math.max(...lons), Math.max(...lats)];
      mlMap.fitBounds([sw, ne], {
        padding: { top: 80, right: 400, bottom: 110, left: 300 },  // leave room for floating panels
        maxZoom: 12.2,
        pitch: 55,
        bearing: -12,
        animate: false,
      });
    } else {
      mlMap.jumpTo({ center: [BENGALURU_CENTER[1], BENGALURU_CENTER[0]], zoom: 11.5, pitch: 55, bearing: -12 });
    }
    return;
  }
  // India (Leaflet)
  if (!map) return;
  const b = getBengaluruBounds();
  if (b && b.isValid()) {
    map.fitBounds(b, { padding: [40, 40], animate: false, maxZoom: 12 });
  } else {
    map.setView(BENGALURU_CENTER, 11, { animate: false });
  }
}

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

    // Hide Leaflet map, show MapLibre satellite map
    document.getElementById('india-map').style.display = 'none';
    document.getElementById('bengaluru-map').style.display = '';

    applyLocalSubView(STATE.localView);

    // Initialize MapLibre on first entry
    if (!mlMap) initMapLibre();
    setTimeout(() => {
      if (mlMap) {
        mlMap.resize();
        refreshMapLibreData();
      }
    }, 200);

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

    // Show Leaflet, hide MapLibre
    document.getElementById('india-map').style.display = '';
    document.getElementById('bengaluru-map').style.display = 'none';

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
  setTimeout(() => {
    if (STATE.dashboardMode === 'local') {
      if (mlMap) {
        mlMap.resize();
        if (mlMap.getZoom() < 9) {
          mlMap.setCenter([BENGALURU_CENTER[1], BENGALURU_CENTER[0]]);
          mlMap.setZoom(11);
        }
      }
    } else if (map) {
      map.invalidateSize();
    }
  }, 100);
}

function switchLocalView(view) {
  STATE.localView = view;
  STATE.pinnedMeter = null;  // clear pinned state on view change
  ['zones','meters','inspector','whatif','tod','deploy'].forEach(v => {
    const el = document.getElementById(`lview-${v}`);
    if (el) el.style.display = v === view ? '' : 'none';
  });
  applyLocalSubView(view);
  renderLocalSubView(view);
  if (map && STATE.dashboardMode === 'local') {
    renderMeterMapMarkers();
  }
  if (view === 'meters') {
    renderLocalKPIs();
    populateZoneChips();
  }
  // Restore zone layers when leaving deploy / tod / whatif tab
  if (view !== 'deploy' && view !== 'tod' && view !== 'whatif' && mlMap) {
    try {
      mlMap.setPaintProperty('zone-bounds-fill', 'fill-color', ['match',['get','risk_level'],'Critical','#ef4444','High','#f97316','Moderate','#f59e0b','#10b981']);
      mlMap.setPaintProperty('zone-bounds-fill', 'fill-opacity', 0.06);
      mlMap.setPaintProperty('zone-bounds-line', 'line-color', ['match',['get','risk_level'],'Critical','#ef4444','High','#f97316','Moderate','#f59e0b','#10b981']);
      mlMap.setPaintProperty('zone-bounds-line', 'line-width', 1.2);
      mlMap.setPaintProperty('zone-bounds-line', 'line-opacity', 0.85);
      mlMap.setLayoutProperty('zone-bounds-label', 'text-field', ['get','zone_name']);
      mlMap.setLayoutProperty('zone-bounds-label', 'text-size', 11);
      mlMap.setPaintProperty('zone-bounds-label', 'text-color', '#7dd3fc');
      mlMap.setPaintProperty('zone-bounds-label', 'text-opacity', 0.9);
    } catch(e) {}
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
  if (view === 'tod' && STATE.data.zoneForecast.length && !STATE._localTodRendered) {
    renderToDView();
    STATE._localTodRendered = true;
  }
  if (view === 'deploy' && STATE.data.zoneForecast.length && !STATE._localDeployRendered) {
    renderDeployView();
    STATE._localDeployRendered = true;
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

// Helper — render Lucide SVG icons after any dynamic HTML update
function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try { window.lucide.createIcons(); } catch (e) { /* ignore */ }
  }
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
      <h4><i data-lucide="zap"></i> 24H · 15-MIN CONSUMPTION</h4>
      <div class="detail-chart-legend">
        <span><span class="legend-dot legend-peer"></span>Peer baseline</span>
        <span><span class="legend-dot legend-obs"></span>Observed</span>
      </div>
      <canvas id="detail-ts-chart" class="detail-spark"></canvas>

      <h4><i data-lucide="map-pin"></i> LOCATION</h4>
      <div class="detail-row"><span>Zone</span><b>${ev.zone_name}</b></div>
      <div class="detail-row"><span>Feeder</span><b>${ev.feeder_id}</b></div>
      <div class="detail-row"><span>Category</span><b>${ev.category_label}</b></div>

      <h4><i data-lucide="alert-triangle"></i> THEFT INDICATORS</h4>
      <div class="detail-row"><span>Archetype</span><b>${ev.theft_label}</b></div>
      <div class="detail-row"><span>Anomaly score</span><b class="v-num">${ev.anomaly_score}/100</b></div>
      <div class="detail-row"><span>Confidence</span><b class="v-num">${ev.confidence_pct}%</b></div>
      <div class="detail-row"><span>Est. monthly loss</span><b class="v-num" style="color:#fbbf24">₹${(ev.est_revenue_loss_inr || 0).toLocaleString('en-IN')}</b></div>

      <h4><i data-lucide="microscope"></i> SHAP ATTRIBUTION</h4>
      ${shapHtml}

      <h4><i data-lucide="brain-circuit"></i> CAUSAL CHAIN</h4>
      <ol class="detail-causal">
        ${(ev.causal_chain || []).map(c => `<li>${c}</li>`).join('')}
      </ol>

      <h4><i data-lucide="bot"></i> AI BRIEF</h4>
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

  refreshIcons();

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
        layout: { padding: { left: 4, right: 8, top: 6, bottom: 0 } },
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

  const pinClass = z.risk_level === 'Critical' ? 'pin-critical' : z.risk_level === 'High' ? 'pin-high' : z.risk_level === 'Moderate' ? 'pin-moderate' : 'pin-low';

  // Zone meters + computed sub-metrics
  const zoneMeters = (STATE.data.meters || []).filter(m => m.zone_id === z.zone_id);
  const flagged = zoneMeters.filter(m => m.is_theft);
  const sev = { Critical: 0, High: 0, Moderate: 0, Low: 0 };
  zoneMeters.forEach(m => sev[m.severity] = (sev[m.severity] || 0) + 1);
  const archCount = {};
  flagged.forEach(m => { if (m.theft_label) archCount[m.theft_label] = (archCount[m.theft_label] || 0) + 1; });
  const topFlagged = [...flagged].sort((a, b) => b.anomaly_score - a.anomaly_score).slice(0, 3);
  const monthlyLoss = flagged.reduce((s, m) => s + (m.est_revenue_loss_inr || 0), 0);

  // Driver bars
  const driversBars = Object.entries(z.drivers || {}).map(([k, v]) => `
    <div class="detail-bar">
      <span class="detail-bar-label">${k.replace(/_/g, ' ')}</span>
      <div class="detail-bar-track"><div class="detail-bar-fill" style="width:${(v * 100).toFixed(0)}%"></div></div>
      <span class="detail-bar-val">${(v * 100).toFixed(0)}%</span>
    </div>
  `).join('');

  // Severity bars (analog of SHAP attribution)
  const sevColors = { Critical: '#ef4444', High: '#f97316', Moderate: '#f59e0b', Low: '#10b981' };
  const sevTotal = Math.max(1, zoneMeters.length);
  const sevBars = ['Critical', 'High', 'Moderate', 'Low'].map(level => {
    const count = sev[level] || 0;
    const pct = (count / sevTotal) * 100;
    return `
      <div class="detail-bar">
        <span class="detail-bar-label" style="color:${sevColors[level]}">● ${level}</span>
        <div class="detail-bar-track"><div class="detail-bar-fill" style="width:${pct}%; background:${sevColors[level]}"></div></div>
        <span class="detail-bar-val">${count}</span>
      </div>`;
  }).join('');

  // Archetype mix (analog of theft indicators detail)
  const archetypeRows = Object.entries(archCount).map(([label, count]) => `
    <div class="detail-row"><span>${label}</span><b class="v-num">${count} cases</b></div>
  `).join('') || '<div class="detail-row" style="opacity:0.55"><span>No theft signatures detected</span></div>';

  // Top flagged meters in zone (clickable, analog of "recommended next case")
  const topFlaggedHtml = topFlagged.length ? topFlagged.map(m => `
    <div class="zone-top-meter" onclick="openMeterFromZone('${m.meter_id}')">
      <div class="zone-tm-id">${m.meter_id}</div>
      <div class="zone-tm-meta">
        <span class="zone-tm-arch">${m.theft_label}</span>
        <span class="zone-tm-score" style="color:${sevColors[m.severity]}">${m.anomaly_score}</span>
      </div>
    </div>
  `).join('') : '<div style="opacity:0.55;font-size:11px;padding:6px 0">No flagged meters in this zone.</div>';

  // 24h forecast sparkline (analog of meter's 24h chart)
  const hourly = z.hourly_forecast || [];
  const hourlyData = hourly.map(h => h.predicted_mw);
  const hourlyHi   = hourly.map(h => h.confidence_high);
  const hourlyLo   = hourly.map(h => h.confidence_low);
  const hourLabels = hourly.map(h => h.hour % 6 === 0 ? `${String(h.hour).padStart(2,'0')}:00` : '');

  // Auto-generated AI brief (template — would be Llama-generated in production)
  const topDriver = Object.entries(z.drivers || {}).sort((a, b) => b[1] - a[1])[0];
  const driverPct = topDriver ? Math.round(topDriver[1] * 100) : 0;
  const driverName = topDriver ? topDriver[0].replace(/_/g, ' ') : 'mixed factors';
  const aiBrief = `${z.zone_name} (${z.type.replace(/_/g, ' ')}) operates at ${z.atc_pct}% AT&C with ${flagged.length}/${z.n_meters} meters flagged. Demand peaks at ${z.peak_mw} MW around ${z.peak_hour}:00, driven ${driverPct}% by ${driverName}. ${sev.Critical > 0 ? `Critical severity in ${sev.Critical} meter${sev.Critical > 1 ? 's' : ''} — ` : ''}${flagged.length > 0 ? `dominant archetype is ${Object.entries(archCount).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'mixed'}.` : 'no theft signatures detected.'} Estimated monthly loss: ₹${(monthlyLoss / 1000).toFixed(1)}K.`;

  // Zone-level recommended action
  const action = sev.Critical > 2
    ? `Deploy mobile inspection unit — ${sev.Critical} critical cases concentrated in this zone`
    : sev.Critical > 0
      ? `Inspect top ${Math.min(3, flagged.length)} flagged meters; verify feeder mass-balance`
      : flagged.length > 0
        ? `Routine spot-check on ${flagged.length} suspect meters`
        : 'No action required — zone within normal envelope';

  panel.innerHTML = `
    <div class="detail-head">
      <span class="detail-id">${z.zone_name.toUpperCase()}</span>
      <span class="detail-pin ${pinClass}">${z.risk_level}</span>
    </div>
    <div class="detail-body">
      <h4><i data-lucide="zap"></i> 24H DEMAND FORECAST</h4>
      <div class="detail-chart-legend">
        <span><span class="legend-dot legend-peer"></span>Confidence band</span>
        <span><span class="legend-dot legend-obs" style="background:#8b5cf6"></span>Predicted MW</span>
      </div>
      <canvas id="zone-ts-chart" class="detail-spark"></canvas>

      <h4><i data-lucide="map-pin"></i> ZONE PROFILE</h4>
      <div class="detail-row"><span>Type</span><b>${z.type.replace(/_/g, ' ')}</b></div>
      <div class="detail-row"><span>Meters monitored</span><b class="v-num">${z.n_meters}</b></div>
      <div class="detail-row"><span>Flagged</span><b class="v-num" style="color:#fca5a5">${flagged.length}</b></div>
      <div class="detail-row"><span>Avg load</span><b class="v-num">${z.avg_mw} MW</b></div>
      <div class="detail-row"><span>AT&C loss</span><b class="v-num">${z.atc_pct}%</b></div>
      <div class="detail-row"><span>AC penetration</span><b class="v-num">${(z.ac_penetration * 100).toFixed(0)}%</b></div>
      <div class="detail-row"><span>Est. monthly loss</span><b class="v-num" style="color:#fbbf24">₹${(monthlyLoss / 1000).toFixed(1)}K</b></div>

      <h4><i data-lucide="bar-chart-3"></i> SEVERITY MIX</h4>
      ${sevBars}

      <h4><i data-lucide="drama"></i> THEFT ARCHETYPES</h4>
      ${archetypeRows}

      <h4><i data-lucide="thermometer"></i> DEMAND DRIVER ATTRIBUTION</h4>
      ${driversBars}

      <h4><i data-lucide="siren"></i> TOP FLAGGED METERS IN ZONE</h4>
      <div class="zone-top-meters">
        ${topFlaggedHtml}
      </div>

      <h4><i data-lucide="bot"></i> AI BRIEF</h4>
      <div class="detail-brief">
        <div class="detail-brief-label">LOCAL LLAMA 3.1 · OFFLINE</div>
        ${aiBrief}
      </div>

      <div class="detail-action">
        <b>RECOMMENDED:</b> ${action}
      </div>
    </div>
    ${STATE.localView === 'meters' && STATE.density === 'zone' ? `
      <div class="detail-actions-row">
        <button class="detail-act-btn primary" onclick="drillIntoZone('${z.zone_id}')">DRILL INTO METERS</button>
        <button class="detail-act-btn" onclick="clearPinned()">CLEAR</button>
      </div>` : ''}
  `;

  refreshIcons();

  // Render zone forecast chart
  setTimeout(() => {
    const ctx = document.getElementById('zone-ts-chart');
    if (!ctx || !hourly.length) return;
    if (charts.zoneDetailTs) charts.zoneDetailTs.destroy();
    charts.zoneDetailTs = new Chart(ctx, {
      type: 'line',
      data: {
        labels: hourLabels,
        datasets: [
          {
            label: 'Confidence high',
            data: hourlyHi,
            borderColor: 'rgba(139,92,246,0.0)',
            backgroundColor: 'rgba(139,92,246,0.18)',
            fill: '+1', pointRadius: 0, tension: 0.35,
          },
          {
            label: 'Confidence low',
            data: hourlyLo,
            borderColor: 'rgba(139,92,246,0.0)',
            backgroundColor: 'rgba(139,92,246,0.18)',
            fill: false, pointRadius: 0, tension: 0.35,
          },
          {
            label: 'Predicted MW',
            data: hourlyData,
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139,92,246,0.10)',
            borderWidth: 1.6, pointRadius: 0, tension: 0.35, fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 320 },
        layout: { padding: { left: 4, right: 8, top: 6, bottom: 0 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            filter: (item) => item.dataset.label === 'Predicted MW',
            callbacks: {
              title: (items) => items.length ? `${String(items[0].dataIndex).padStart(2,'0')}:00` : '',
              label: (c) => `${c.raw} MW`,
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
              callback: v => `${v} MW`,
              maxTicksLimit: 4,
            },
            grid: { color: 'rgba(30,45,66,0.3)' },
          },
        },
      },
    });
  }, 30);
}

window.openMeterFromZone = function(meterId) {
  const m = (STATE.data.meters || []).find(mm => mm.meter_id === meterId);
  if (!m) return;
  STATE.pinnedMeter = meterId;
  updateDetailPanelForMeter(m, true);
};

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
  if (mlMap) mlMap.flyTo({ center: [z.lon, z.lat], zoom: 13.2, pitch: 55, bearing: -12, duration: 700 });
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
        if (mlMap) mlMap.flyTo({ center: [BENGALURU_CENTER[1], BENGALURU_CENTER[0]], zoom: 11, pitch: 55, bearing: -12, duration: 600 });
      } else {
        STATE.selectedZone = z.zone_id;
        chip.classList.add('active');
        if (mlMap) mlMap.flyTo({ center: [z.lon, z.lat], zoom: 13.2, pitch: 55, bearing: -12, duration: 700 });
      }
      const metaZ = document.getElementById('meta-zone');
      if (metaZ) metaZ.textContent = STATE.selectedZone ? z.zone_name.toUpperCase() : 'BENGALURU';
      renderMeterMapMarkers();
      updateDetailPanelForZone(z, true);
    });
  });
}

// ── Local Map Markers — when in Local mode, dispatch to MapLibre. ──────────
// (Leaflet path retained as no-op fallback so India view continues to work.)
function renderMeterMapMarkers() {
  if (STATE.dashboardMode === 'local') {
    if (mlMap) refreshMapLibreData();
    return;
  }
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();

  const meters = STATE.data.meters || [];
  const zones  = STATE.data.zoneForecast || [];
  if (!meters.length) return;

  // Render zone boundary polygons (always, as soft outlines under the markers)
  renderZoneBoundaries();

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

// ── Zone boundary polygons (real Bengaluru neighborhood extents) ─────────
function renderZoneBoundaries() {
  const fc = STATE.data.zoneBounds;
  if (!fc || !fc.features) return;
  const zones = STATE.data.zoneForecast || [];

  fc.features.forEach(f => {
    const zid = f.properties.zone_id;
    const zone = zones.find(z => z.zone_id === zid);
    const isActive = STATE.selectedZone === zid;

    const color = zone
      ? (zone.risk_level === 'Critical' ? '#ef4444'
        : zone.risk_level === 'High'    ? '#f97316'
        : zone.risk_level === 'Moderate' ? '#f59e0b' : '#10b981')
      : '#64748b';

    L.geoJSON(f, {
      style: () => ({
        color,
        weight: isActive ? 2.5 : 1,
        opacity: isActive ? 0.9 : 0.5,
        fillColor: color,
        fillOpacity: isActive ? 0.18 : 0.06,
        dashArray: isActive ? null : '4 6',
        className: 'zone-boundary',
      }),
      onEachFeature: (feature, layer) => {
        layer.bindTooltip(
          `<b>${feature.properties.zone_name}</b><br/>${feature.properties.type.replace(/_/g, ' ')} · AT&C ${feature.properties.atc_pct}%`,
          { sticky: true, className: 'leaflet-dark-tooltip' }
        );
        layer.on('click', () => {
          if (zone) {
            // Click on polygon = drill into that zone
            STATE.selectedZone = zid;
            STATE.density = 'meter';
            document.querySelectorAll('.density-btn').forEach(b => b.classList.toggle('active', b.dataset.density === 'meter'));
            const dEl = document.getElementById('bm-density'); if (dEl) dEl.textContent = 'METER';
            const dSub = document.getElementById('bm-density-sub'); if (dSub) dSub.textContent = `drilled into ${zone.zone_name}`;
            const metaView = document.getElementById('meta-view'); if (metaView) metaView.textContent = 'METER · ' + zone.zone_name.toUpperCase();
            const metaZone = document.getElementById('meta-zone'); if (metaZone) metaZone.textContent = zone.zone_name.toUpperCase();
            // Fit map to the zone polygon bounds
            const b = layer.getBounds();
            map.flyToBounds(b, { padding: [40, 40], duration: 0.6, maxZoom: 14 });
            updateBackButton();
            renderMeterMapMarkers();
          }
        });
        layer.on('mouseover', () => {
          if (zone) updateDetailPanelForZone(zone, false);
        });
      },
    }).addTo(markerLayer);
  });
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

  // Drill-back is now handled by the floating button (see updateBackButton)
  updateBackButton();
}

// "← Back to Bengaluru" button — appears only when drilled into a zone
function updateBackButton() {
  let btn = document.getElementById('zone-back-btn');
  if (STATE.selectedZone) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'zone-back-btn';
      btn.className = 'zone-back-btn';
      btn.addEventListener('click', () => {
        STATE.selectedZone = null;
        const dSub = document.getElementById('bm-density-sub'); if (dSub) dSub.textContent = 'click zone to drill in';
        const metaView = document.getElementById('meta-view'); if (metaView) metaView.textContent = STATE.density === 'zone' ? 'ZONE' : 'METER';
        const metaZone = document.getElementById('meta-zone'); if (metaZone) metaZone.textContent = 'BENGALURU';
        document.querySelectorAll('.zone-chip').forEach(c => c.classList.remove('active'));
        if (mlMap) mlMap.flyTo({ center: [BENGALURU_CENTER[1], BENGALURU_CENTER[0]], zoom: 11, pitch: 55, bearing: -12, duration: 700 });
        renderMeterMapMarkers();
        updateBackButton();
      });
      const overlay = document.getElementById('tactical-overlay');
      if (overlay) overlay.appendChild(btn);
    }
    const z = (STATE.data.zoneForecast || []).find(zz => zz.zone_id === STATE.selectedZone);
    btn.innerHTML = `← All zones <span style="opacity:0.55;margin-left:6px">·  exit ${z ? z.zone_name : ''}</span>`;
    btn.style.display = '';
  } else if (btn) {
    btn.style.display = 'none';
  }
}

// ── SUB-VIEW 1: Zone Demand Forecast ───────────────────────────────────────
// Zone forecast growth rates per zone (Bengaluru-specific projections)
const ZONE_GROWTH_RATES = {
  Z01:{ ev:0.18, load:0.06, solar:0.12 }, // Indiranagar
  Z02:{ ev:0.20, load:0.07, solar:0.14 }, // Koramangala
  Z03:{ ev:0.22, load:0.08, solar:0.15 }, // HSR Layout
  Z04:{ ev:0.12, load:0.05, solar:0.10 }, // Jayanagar
  Z05:{ ev:0.10, load:0.05, solar:0.08 }, // Rajajinagar
  Z06:{ ev:0.09, load:0.04, solar:0.09 }, // Malleswaram
  Z07:{ ev:0.38, load:0.14, solar:0.22 }, // Whitefield — IT corridor, highest EV
  Z08:{ ev:0.32, load:0.12, solar:0.20 }, // Electronic City — SEZ
  Z09:{ ev:0.24, load:0.09, solar:0.16 }, // Marathahalli
  Z10:{ ev:0.14, load:0.11, solar:0.08 }, // Yelahanka
  Z11:{ ev:0.16, load:0.10, solar:0.10 }, // Hebbal — airport corridor
  Z12:{ ev:0.08, load:0.09, solar:0.06 }, // Peenya — industrial
};

function _projectZone(z, months) {
  const gr = ZONE_GROWTH_RATES[z.zone_id] || { ev:0.12, load:0.07, solar:0.10 };
  const yrs = months / 12;
  const f = DEPLOY_FACTORS[z.zone_id] || { outage:0.5, comm:0.75, density:0.65 };
  const projPeak   = z.peak_mw * (1 + gr.load * yrs + gr.ev * yrs * 0.6);
  const atcProj    = Math.max(6.5, z.atc_pct - yrs * 1.8);  // smart meters cut AT&C
  const evPen      = Math.min(0.9, (z.ac_penetration || 0.3) + gr.ev * yrs);
  const solarPen   = Math.min(0.5, gr.solar * yrs);
  const dtStress   = Math.min(1, (projPeak / z.peak_mw - 1) * 1.5 + f.outage * 0.4);
  const healthBase = 100 - (z.atc_pct / 22) * 30 - f.outage * 22 - (z.type === 'rural_edge' ? 8 : z.type === 'semi_urban' ? 4 : 0) + f.comm * 12;
  const health     = Math.max(20, Math.min(98, healthBase - dtStress * 15 * yrs));
  const riskLevel  = projPeak > z.peak_mw * 1.30 ? 'Critical' : projPeak > z.peak_mw * 1.15 ? 'High' : projPeak > z.peak_mw * 1.05 ? 'Moderate' : 'Low';
  return { projPeak, atcProj, evPen, solarPen, dtStress, health, riskLevel };
}

function _zonePreventiveActions(z, proj) {
  const actions = [];
  if (proj.health < 60)          actions.push({ urgency:'Immediate', icon:'alert-triangle', text:`Inspect & upgrade DT units — health score ${proj.health.toFixed(0)}/100`, color:'#ef4444' });
  if (ZONE_GROWTH_RATES[z.zone_id]?.ev > 0.25) actions.push({ urgency:'Short-term', icon:'car', text:`Deploy EV-dedicated charging transformers · night ToD tariff`, color:'#f59e0b' });
  if (proj.projPeak > z.peak_mw * 1.20) actions.push({ urgency:'Short-term', icon:'zap', text:`Add alternate feeder capacity — projected ${((proj.projPeak/z.peak_mw-1)*100).toFixed(0)}% load growth`, color:'#f97316' });
  if (proj.solarPen > 0.18)      actions.push({ urgency:'Strategic', icon:'sun', text:`Install reverse-flow protection & voltage regulation for solar penetration`, color:'#22d3ee' });
  if (z.atc_pct > 16)            actions.push({ urgency:'Immediate', icon:'shield', text:`Priority smart meter deployment — AT&C ${z.atc_pct.toFixed(1)}% is ${(z.atc_pct-8.5).toFixed(1)}pp above benchmark`, color:'#ef4444' });
  if ((DEPLOY_FACTORS[z.zone_id]?.outage||0) > 0.65) actions.push({ urgency:'Short-term', icon:'cable', text:`Underground critical sections + fault passage indicators`, color:'#f59e0b' });
  if (!actions.length)           actions.push({ urgency:'Strategic', icon:'check-circle', text:`Zone stable — monitor seasonal load patterns`, color:'#10b981' });
  return actions.slice(0, 2);
}

function renderZoneForecastView() {
  const zones = STATE.data.zoneForecast || [];
  if (!zones.length) return;

  if (!STATE.selectedZone) {
    STATE.selectedZone = zones.reduce((a, b) => a.peak_mw > b.peak_mw ? a : b).zone_id;
  }
  const sel = zones.find(z => z.zone_id === STATE.selectedZone) || zones[0];

  renderZoneHourlyChart(sel);
  renderZonePeakChart(zones);
  renderZoneDriversChart(sel);
  renderZoneTable(zones);
  renderZoneFutureSection(zones);
  renderRevenuePanel(zones);
}

function renderZoneFutureSection(zones) {
  // Inject future intelligence section after zone-table if not already there
  let container = document.getElementById('zone-future-section');
  if (!container) {
    const tableSection = document.querySelector('#lview-zones .discom-table')?.closest('section');
    if (!tableSection) return;
    container = document.createElement('div');
    container.id = 'zone-future-section';
    tableSection.insertAdjacentElement('afterend', container);
  }

  STATE._zoneTimelineMonths = STATE._zoneTimelineMonths || 0;
  const months = STATE._zoneTimelineMonths;
  const projections = zones.map(z => ({ z, proj: _projectZone(z, months) }));
  const PC = { Critical:'#ef4444', High:'#f97316', Moderate:'#f59e0b', Low:'#10b981' };

  container.innerHTML = `
    <!-- Positioning strip -->
    <div class="zf-positioning-strip">
      <div class="zf-pos-icon"><i data-lucide="shield-check"></i></div>
      <div>
        <div class="zf-pos-title">Predictive Zone-Level Grid Reliability Intelligence</div>
        <div class="zf-pos-sub">Towards near-continuous reliable supply through predictive operations — uncertainty reduces, uptime improves</div>
      </div>
      <div class="zf-uptime-pills">
        <span class="zf-pill" style="background:rgba(16,185,129,0.15);color:#34d399;border-color:#34d39940">↓ Fewer Surprises</span>
        <span class="zf-pill" style="background:rgba(59,130,246,0.12);color:#60a5fa;border-color:#60a5fa40">↓ Peak Overload</span>
        <span class="zf-pill" style="background:rgba(168,85,247,0.12);color:#c084fc;border-color:#c084fc40">↑ Response Speed</span>
        <span class="zf-pill" style="background:rgba(245,158,11,0.12);color:#fbbf24;border-color:#fbbf2440">↑ Planned Maintenance</span>
      </div>
    </div>

    <!-- Future timeline section -->
    <section class="panel panel-full" style="margin-top:10px">
      <div class="panel-header" style="margin-bottom:12px">
        <span class="panel-title"><i data-lucide="clock-4"></i> Future Grid Stress — Timeline Projection</span>
        <span class="panel-sub">smart meter data → growth patterns → forward stress model</span>
      </div>
      <!-- Timeline slider -->
      <div class="zf-timeline-row">
        <span class="zf-tl-label">NOW</span>
        <input type="range" id="zf-timeline-slider" min="0" max="24" step="6" value="${months}" style="flex:1;accent-color:#3b82f6">
        <span class="zf-tl-label">2 YRS</span>
        <div class="zf-tl-badge" id="zf-tl-badge">${months === 0 ? 'Today — Current State' : months <= 6 ? `+${months} months` : months <= 12 ? '+1 year' : `+${months} months`}</div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:7.5pt;color:#475569;margin-bottom:10px;padding:0 4px">
        <span>Today</span><span>6 mo</span><span>12 mo</span><span>18 mo</span><span>2 yr</span>
      </div>
      <!-- Projected peak chart -->
      <div class="chart-wrap" style="height:190px"><canvas id="chart-zf-future-peak"></canvas></div>
    </section>

    <!-- DT Health Scores + Actions -->
    <section class="panel-row" style="margin-top:10px">
      <div class="panel" style="flex:1.3">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="activity"></i> Distribution Transformer Health Score</span>
          <span class="panel-sub">${months === 0 ? 'Current state' : `Projected at +${months} months`} · 90–100 Healthy · 60–90 Monitor · &lt;60 High Risk</span>
        </div>
        <div class="zf-health-grid" id="zf-health-grid">
          ${projections.map(({z, proj}) => {
            const h = proj.health;
            const hColor = h >= 80 ? '#10b981' : h >= 60 ? '#f59e0b' : '#ef4444';
            const hLabel = h >= 80 ? 'Healthy' : h >= 60 ? 'Monitor' : 'High Risk';
            const arc = Math.round((h / 100) * 220);
            return `<div class="zf-health-card" style="border-color:${hColor}22">
              <svg width="52" height="52" viewBox="0 0 52 52">
                <circle cx="26" cy="26" r="20" fill="none" stroke="#1e2d42" stroke-width="5"/>
                <circle cx="26" cy="26" r="20" fill="none" stroke="${hColor}" stroke-width="5"
                  stroke-dasharray="${arc} 220" stroke-dashoffset="55" stroke-linecap="round"/>
                <text x="26" y="30" text-anchor="middle" fill="${hColor}" font-size="10" font-weight="700" font-family="Inter">${h.toFixed(0)}</text>
              </svg>
              <div class="zf-health-name">${z.zone_name.replace(' Layout','').replace(' City','')}</div>
              <div class="zf-health-label" style="color:${hColor}">${hLabel}</div>
              <div class="zf-health-atc" style="color:${PC[proj.riskLevel]}">${proj.riskLevel}</div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="panel" style="flex:0.9">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="clipboard-check"></i> Preventive Action Recommendations</span>
          <span class="panel-sub">system-generated · ranked by urgency</span>
        </div>
        <div id="zf-actions-list" style="display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto">
          ${projections
            .flatMap(({z, proj}) => _zonePreventiveActions(z, proj).map(a => ({...a, zone:z.zone_name})))
            .sort((a,b) => a.urgency==='Immediate'?-1:b.urgency==='Immediate'?1:a.urgency==='Short-term'?-1:1)
            .slice(0, 10)
            .map(a => `<div class="zf-action-card" style="border-left-color:${a.color}">
              <div class="zf-action-top">
                <i data-lucide="${a.icon}" style="color:${a.color}"></i>
                <span class="zf-action-zone">${a.zone}</span>
                <span class="zf-action-urgency" style="color:${a.color}">${a.urgency}</span>
              </div>
              <div class="zf-action-text">${a.text}</div>
            </div>`).join('')}
        </div>
      </div>
    </section>

    <!-- Reliability improvement forecast -->
    <section class="panel panel-full" style="margin-top:10px">
      <div class="panel-header">
        <span class="panel-title"><i data-lucide="trending-up"></i> Reliability Improvement Forecast — With Predictive Operations</span>
        <span class="panel-sub">projected impact of smart meter data + preventive maintenance + demand shaping</span>
      </div>
      <div class="zf-reliability-grid">
        ${[
          { metric:'Peak DT Overloads/month', before:'28–34', predicted:`${Math.max(6, 34 - Math.round(months/24*22))}–${Math.max(10, 42 - Math.round(months/24*28))}`, icon:'zap' },
          { metric:'Avg Outage Duration (min)', before:'48', predicted:`${Math.max(18, 48 - Math.round(months/24*24))}`, icon:'clock' },
          { metric:'Unplanned Outages/month', before:'14', predicted:`${Math.max(4, 14 - Math.round(months/24*9))}`, icon:'alert-triangle' },
          { metric:'Peak Procurement Cost', before:'₹4.2L/day', predicted:`₹${(4.2 - months/24*1.4).toFixed(1)}L/day`, icon:'indian-rupee' },
          { metric:'AT&C Loss (avg)', before:`${(zones.reduce((s,z)=>s+z.atc_pct,0)/zones.length).toFixed(1)}%`, predicted:`${Math.max(8.5,(zones.reduce((s,z)=>s+z.atc_pct,0)/zones.length - months/12*1.8)).toFixed(1)}%`, icon:'trending-down' },
          { metric:'Voltage Instability Events', before:'High', predicted: months>=12?'Low':months>=6?'Moderate':'Reducing', icon:'activity' },
        ].map(r=>`<div class="zf-rel-card">
          <i data-lucide="${r.icon}" style="color:#60a5fa;width:16px;height:16px"></i>
          <div class="zf-rel-metric">${r.metric}</div>
          <div class="zf-rel-before">${r.before}</div>
          <div class="zf-rel-arrow">→</div>
          <div class="zf-rel-after">${r.predicted}</div>
        </div>`).join('')}
      </div>
    </section>`;

  refreshIcons();
  _renderZoneFuturePeakChart(projections, months);
  _bindZoneTimeline(zones);
}

function _renderZoneFuturePeakChart(projections, months) {
  const ctx = document.getElementById('chart-zf-future-peak');
  if (!ctx) return;
  if (charts.zfFuturePeak) charts.zfFuturePeak.destroy();
  const PC_A = { Critical:'rgba(239,68,68,0.82)', High:'rgba(249,115,22,0.80)', Moderate:'rgba(245,158,11,0.75)', Low:'rgba(16,185,129,0.72)' };
  const sorted = [...projections].sort((a,b) => b.proj.projPeak - a.proj.projPeak);
  charts.zfFuturePeak = new Chart(ctx, {
    type:'bar',
    data:{
      labels: sorted.map(({z})=>z.zone_name),
      datasets:[
        { label:'Baseline Peak (MW)', data:sorted.map(({z})=>parseFloat(z.peak_mw.toFixed(1))),
          backgroundColor:'rgba(148,163,184,0.25)', borderColor:'rgba(148,163,184,0.5)',
          borderWidth:1, borderRadius:3, barPercentage:0.8 },
        { label:`Projected Peak (${months===0?'Now':`+${months}mo`})`,
          data:sorted.map(({proj})=>parseFloat(proj.projPeak.toFixed(1))),
          backgroundColor:sorted.map(({proj})=>PC_A[proj.riskLevel]),
          borderRadius:3, barPercentage:0.8 },
      ],
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      layout:{padding:{left:4,right:8,top:4,bottom:0}},
      plugins:{
        legend:{labels:{color:'#94a3b8',font:{size:9},boxWidth:10}},
        tooltip:{callbacks:{label:c=>c.datasetIndex===1?`${c.raw} MW projected · ${sorted[c.dataIndex].proj.riskLevel}`:  `${c.raw} MW baseline`}},
      },
      scales:{
        x:{ticks:{color:'#94a3b8',font:{size:8},maxRotation:30},grid:{display:false}},
        y:{ticks:{color:'#8899aa',callback:v=>`${v}MW`,font:{size:8}},grid:{color:'#1e2d42'}},
      },
    },
  });
}

function _bindZoneTimeline(zones) {
  const slider = document.getElementById('zf-timeline-slider');
  if (!slider) return;
  slider.addEventListener('input', () => {
    STATE._zoneTimelineMonths = parseInt(slider.value);
    // Re-render just the future section without full re-render
    STATE._localZonesRendered = false;
    renderZoneForecastView();
  });
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
const _queueState = { search: '', severity: 'all', archetype: 'all' };

function renderInspectorQueue() {
  const evidence = STATE.data.evidence || [];
  const el = document.getElementById('inspector-queue');
  if (!el || !evidence.length) return;
  el.innerHTML = Array(6).fill(`<div style="height:80px;margin-bottom:8px" class="shimmer-block"></div>`).join('');
  setTimeout(_renderInspectorQueueFull, 320);
}

function _renderInspectorQueueFull() {
  const evidence = STATE.data.evidence || [];
  const el = document.getElementById('inspector-queue');
  if (!el || !evidence.length) return;

  const sevCount = { Critical: 0, High: 0, Moderate: 0 };
  const archCount = {};
  evidence.forEach(e => {
    sevCount[e.severity] = (sevCount[e.severity] || 0) + 1;
    archCount[e.theft_label] = (archCount[e.theft_label] || 0) + 1;
  });
  const totalLoss = evidence.reduce((s, e) => s + (e.est_revenue_loss_inr || 0), 0);
  const archetypes = Object.keys(archCount).sort();

  // Apply filter
  const filtered = evidence.filter(e => {
    if (_queueState.severity !== 'all' && e.severity !== _queueState.severity) return false;
    if (_queueState.archetype !== 'all' && e.theft_label !== _queueState.archetype) return false;
    if (_queueState.search) {
      const q = _queueState.search.toLowerCase();
      if (!e.meter_id.toLowerCase().includes(q) &&
          !e.zone_name.toLowerCase().includes(q) &&
          !e.feeder_id.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // ── Header (summary + search + filter chips) ─────────────────────────
  const headerHtml = `
    <div class="iq-header">
      <div class="iq-summary">
        <div class="iq-stat">
          <div class="iq-stat-num">${evidence.length}</div>
          <div class="iq-stat-label">Open cases</div>
        </div>
        <div class="iq-stat-sev">
          <span class="iq-pill iq-pill-critical"><span class="iq-pill-dot"></span>${sevCount.Critical || 0} Critical</span>
          <span class="iq-pill iq-pill-high"><span class="iq-pill-dot"></span>${sevCount.High || 0} High</span>
          <span class="iq-pill iq-pill-moderate"><span class="iq-pill-dot"></span>${sevCount.Moderate || 0} Moderate</span>
        </div>
        <div class="iq-stat-loss">
          <div class="iq-stat-num" style="color:#fbbf24">₹${(totalLoss / 1000).toFixed(1)}K</div>
          <div class="iq-stat-label">Monthly loss exposure</div>
        </div>
      </div>
      <div class="iq-controls">
        <div class="iq-search">
          <i data-lucide="search"></i>
          <input type="text" id="iq-search-input" placeholder="Search meter ID, zone, feeder…" value="${_queueState.search.replace(/"/g, '&quot;')}">
        </div>
        <div class="iq-chips">
          <span class="iq-chip ${_queueState.severity === 'all' ? 'active' : ''}" data-filter-sev="all">All severity</span>
          <span class="iq-chip ${_queueState.severity === 'Critical' ? 'active' : ''} iq-chip-critical" data-filter-sev="Critical">Critical</span>
          <span class="iq-chip ${_queueState.severity === 'High' ? 'active' : ''} iq-chip-high" data-filter-sev="High">High</span>
          <span class="iq-chip ${_queueState.severity === 'Moderate' ? 'active' : ''} iq-chip-moderate" data-filter-sev="Moderate">Moderate</span>
        </div>
        <div class="iq-chips">
          <span class="iq-chip ${_queueState.archetype === 'all' ? 'active' : ''}" data-filter-arch="all">All archetypes</span>
          ${archetypes.map(a => `<span class="iq-chip ${_queueState.archetype === a ? 'active' : ''}" data-filter-arch="${a}">${a} <small style="opacity:0.55">${archCount[a]}</small></span>`).join('')}
        </div>
      </div>
      <div class="iq-result-line">
        <span><b>${filtered.length}</b> of ${evidence.length} cases shown</span>
        ${filtered.length !== evidence.length ? '<a href="#" id="iq-clear-filters">Clear filters</a>' : ''}
      </div>
    </div>
  `;

  // ── Cards ────────────────────────────────────────────────────────────
  const archIcons = {
    'LT Bypass': 'cable',
    'Magnetic Tamper': 'magnet',
    'Neutral Bypass': 'unplug',
    'Billing Mismatch': 'receipt',
  };

  const cardsHtml = filtered.length === 0
    ? '<div class="iq-empty">No cases match the current filter.</div>'
    : filtered.map((e, i) => {
        const rank = evidence.findIndex(x => x.meter_id === e.meter_id) + 1;
        const archIcon = archIcons[e.theft_label] || 'alert-triangle';
        const sevLow = e.severity.toLowerCase();
        return `
          <article class="iq-card iq-card-${sevLow}" data-meter-id="${e.meter_id}">
            <div class="iq-card-rib"></div>
            <div class="iq-card-body">
              <div class="iq-card-row1">
                <span class="iq-rank">#${String(rank).padStart(2, '0')}</span>
                <span class="iq-id">${e.meter_id}</span>
                <span class="iq-sev iq-sev-${sevLow}">${e.severity}</span>
              </div>
              <div class="iq-card-row2">
                <span class="iq-zone"><i data-lucide="map-pin"></i>${e.zone_name}</span>
                <span class="iq-feeder">${e.feeder_id}</span>
                <span class="iq-cat">${e.category_label}</span>
              </div>
              <div class="iq-arch">
                <i data-lucide="${archIcon}"></i>
                <span class="iq-arch-name">${e.theft_label}</span>
              </div>
              <div class="iq-conf-row">
                <span class="iq-conf-label">Confidence</span>
                <div class="iq-conf-bar"><div class="iq-conf-fill" style="width:${e.confidence_pct}%"></div></div>
                <span class="iq-conf-val">${e.confidence_pct}%</span>
              </div>
              <div class="iq-card-row3">
                <div class="iq-loss">
                  <span class="iq-loss-label">Monthly loss</span>
                  <span class="iq-loss-val">₹${(e.est_revenue_loss_inr || 0).toLocaleString('en-IN')}</span>
                </div>
                <div class="iq-action">
                  <i data-lucide="briefcase"></i>
                  <span>${e.recommended_action}</span>
                </div>
              </div>
            </div>
            <div class="iq-card-tail">
              <span class="iq-open-label">OPEN EVIDENCE</span>
              <i data-lucide="arrow-right"></i>
            </div>
          </article>
        `;
      }).join('');

  el.innerHTML = headerHtml + `<div class="iq-grid">${cardsHtml}</div>`;

  // Wire interactions
  el.querySelectorAll('.iq-card').forEach(card => {
    card.addEventListener('click', () => openMeterEvidence(card.dataset.meterId));
  });
  el.querySelectorAll('[data-filter-sev]').forEach(chip => {
    chip.addEventListener('click', () => {
      _queueState.severity = chip.dataset.filterSev;
      renderInspectorQueue();
    });
  });
  el.querySelectorAll('[data-filter-arch]').forEach(chip => {
    chip.addEventListener('click', () => {
      _queueState.archetype = chip.dataset.filterArch;
      renderInspectorQueue();
    });
  });
  const searchInput = document.getElementById('iq-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      _queueState.search = e.target.value || '';
      // Debounce — re-render shortly after typing stops
      clearTimeout(_queueState._t);
      _queueState._t = setTimeout(() => renderInspectorQueue(), 120);
    });
    // Keep focus and caret position after re-render
    if (document.activeElement && document.activeElement.id === 'iq-search-input') {
      searchInput.focus();
      const len = searchInput.value.length;
      searchInput.setSelectionRange(len, len);
    }
  }
  const clearLink = document.getElementById('iq-clear-filters');
  if (clearLink) clearLink.addEventListener('click', (e) => {
    e.preventDefault();
    _queueState.search = ''; _queueState.severity = 'all'; _queueState.archetype = 'all';
    renderInspectorQueue();
  });

  refreshIcons();
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
// ── Digital Twin Engine — Event Library ──────────────────────────────────────
const TWIN_EVENTS = {
  diwali:   { id:'diwali',   name:'Diwali Evening',   icon:'sparkles',    badge:'Festival',  color:'#f59e0b',
               desc:'Residential +18% · burst at 21:00 · fireworks load',
               heatSnap:2, acSnap:10, festival:true,
               typeMulti:{ urban_core:1.18, semi_urban:1.22, rural_edge:1.12 },
               peakShift:1, conf:94,
               source:'Oct 24 2024 Diwali signature · 576 meters · 89,856 readings' },
  monsoon:  { id:'monsoon',  name:'Monsoon Day',      icon:'cloud-rain',  badge:'Weather',   color:'#3b82f6',
               desc:'AC off −18% · drainage pumps surge · storm at 15:00',
               heatSnap:0, acSnap:-20, festival:false,
               typeMulti:{ urban_core:0.90, semi_urban:0.93, rural_edge:0.97 },
               peakShift:0, conf:88,
               source:'Jul 18 2024 monsoon signature · 576 meters · hourly pattern matched' },
  heatwave: { id:'heatwave', name:'Heatwave +6°C',    icon:'thermometer', badge:'Extreme',   color:'#ef4444',
               desc:'AC saturation · DT loading 94% · Whitefield critical',
               heatSnap:6, acSnap:20, festival:false,
               typeMulti:{ urban_core:1.30, semi_urban:1.25, rural_edge:1.18 },
               peakShift:0, conf:91,
               source:'May 2024 pre-monsoon heatwave · 576 meters · stress validated against BESCOM logs' },
  ipl:      { id:'ipl',      name:'IPL Final Night',  icon:'trophy',      badge:'Sports',    color:'#8b5cf6',
               desc:'TV + AC · evening surge · peak at 20:00',
               heatSnap:0, acSnap:5,  festival:true,
               typeMulti:{ urban_core:1.12, semi_urban:1.08, rural_edge:1.04 },
               peakShift:2, conf:82,
               source:'IPL 2024 final · 576 meters · commercial-residential co-spike' },
  ev_surge: { id:'ev_surge', name:'EV Weekend Surge', icon:'car',         badge:'Future',    color:'#10b981',
               desc:'Post-weekend home charging · 19–23:00 · IT corridors',
               heatSnap:2, acSnap:10, festival:false,
               typeMulti:{ urban_core:1.09, semi_urban:1.06, rural_edge:1.02 },
               peakShift:0, conf:76,
               source:'Projected from 156 EV-connected meters in Whitefield & Marathahalli' },
  new_year: { id:'new_year', name:"New Year's Eve",   icon:'party-popper',badge:'Festival',  color:'#f97316',
               desc:'Dec 31 · midnight surge · late residential peak 23:30',
               heatSnap:0, acSnap:5,  festival:true,
               typeMulti:{ urban_core:1.20, semi_urban:1.15, rural_edge:1.08 },
               peakShift:3, conf:89,
               source:'Dec 31 2024 signature · 576 meters · peaks 2h later than normal festivals' },
};

function renderWhatIfView() {
  _withShimmer('lview-whatif', _twinShimmerHtml(), _renderDigitalTwinFull, 380);
}

function _twinShimmerHtml() {
  return `
    <div style="height:48px;margin-bottom:12px" class="shimmer-block"></div>
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px">
      ${Array(6).fill(`<div class="shimmer-block" style="height:90px;border-radius:10px"></div>`).join('')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
      <div class="shimmer-block" style="height:260px"></div>
      <div class="shimmer-block" style="height:260px"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
      ${Array(3).fill(`<div class="shimmer-block" style="height:160px"></div>`).join('')}
    </div>`;
}

const TWIN_INTERVENTIONS = {
  tod:     { id:'tod',     name:'ToD Pricing',        icon:'clock',           color:'#22d3ee', desc:'Shift 12–16% peak demand to off-peak via dynamic tariff',       peakRed:0.13, flagRed:0.40 },
  shedding:{ id:'shedding',name:'Load Shedding Alert',icon:'alert-triangle',  color:'#f59e0b', desc:'Cap critical zones at 90% DT capacity via advance notice',      peakRed:0.09, flagRed:0.25 },
  feeder:  { id:'feeder',  name:'Feeder Rerouting',   icon:'git-branch',      color:'#a78bfa', desc:'Redistribute load across backup feeders in stressed corridors', peakRed:0.07, flagRed:0.20 },
};

function _renderDigitalTwinFull() {
  const panel = document.getElementById('lview-whatif');
  if (!panel) return;

  STATE._twinActive       = STATE._twinActive || {};
  STATE._twinIntervention = STATE._twinIntervention || {};

  const totalMeters = (STATE.data.meters || []).length;
  const totalDays   = 89;
  const totalPts    = (totalMeters * totalDays * 96).toLocaleString('en-IN');

  panel.innerHTML = `
    <!-- Data pipeline narrative -->
    <div class="twin-pipeline">
      <div class="twin-pipe-step"><i data-lucide="cpu"></i><span>Smart Meters<br><b>${totalMeters}</b></span></div>
      <div class="twin-pipe-arrow">→</div>
      <div class="twin-pipe-step"><i data-lucide="database"></i><span>15-min Readings<br><b>${totalPts}</b></span></div>
      <div class="twin-pipe-arrow">→</div>
      <div class="twin-pipe-step active"><i data-lucide="box"></i><span>Grid Digital Twin<br><b>BESCOM 12-Zone</b></span></div>
      <div class="twin-pipe-arrow">→</div>
      <div class="twin-pipe-step"><i data-lucide="sparkles"></i><span>Event Simulation<br><b>compound scenarios</b></span></div>
      <div class="twin-pipe-arrow">→</div>
      <div class="twin-pipe-step"><i data-lucide="zap"></i><span>Decision Support<br><b>preemptive action</b></span></div>
      <div class="twin-data-status" style="margin-left:auto"><span class="twin-status-dot"></span> TWIN ACTIVE · calibrated today 00:00</div>
    </div>

    <!-- Event scenario library -->
    <div class="twin-event-library">
      <div class="twin-section-label"><i data-lucide="layers"></i> Event Scenario Library — toggle events · combine for compound scenarios</div>
      <div class="twin-event-grid" id="twin-event-grid">
        ${Object.values(TWIN_EVENTS).map(ev => `
          <div class="twin-event-card" data-event="${ev.id}" style="--ev-color:${ev.color}">
            <div class="twin-event-top">
              <span class="twin-event-badge" style="background:${ev.color}22;color:${ev.color};border-color:${ev.color}44">${ev.badge}</span>
              <span class="twin-event-conf">${ev.conf}%</span>
            </div>
            <div class="twin-event-icon"><i data-lucide="${ev.icon}"></i></div>
            <div class="twin-event-name">${ev.name}</div>
            <div class="twin-event-desc">${ev.desc}</div>
            <div class="twin-event-source">${ev.source}</div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Intervention testing -->
    <div class="twin-event-library" style="margin-top:6px">
      <div class="twin-section-label"><i data-lucide="shield-check"></i> Intervention Testing — apply a response strategy and see the delta</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px" id="twin-intervention-grid">
        ${Object.values(TWIN_INTERVENTIONS).map(iv => `
          <div class="twin-event-card twin-intervention-card" data-intervention="${iv.id}" style="--ev-color:${iv.color}">
            <div class="twin-event-top">
              <span class="twin-event-badge" style="background:${iv.color}22;color:${iv.color};border-color:${iv.color}44">INTERVENE</span>
              <span style="font-size:7pt;color:#10b981">↓ ${Math.round(iv.peakRed*100)}% peak</span>
            </div>
            <div class="twin-event-icon"><i data-lucide="${iv.icon}"></i></div>
            <div class="twin-event-name">${iv.name}</div>
            <div class="twin-event-desc">${iv.desc}</div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Compound + intervention status bar -->
    <div class="twin-compound-bar" id="twin-compound-bar" style="display:none">
      <i data-lucide="git-merge"></i>
      <span>Active: </span>
      <span id="twin-compound-label" style="font-weight:700;color:#f1f5f9"></span>
      <span id="twin-compound-conf" style="color:#94a3b8;margin-left:8px"></span>
      <button id="twin-clear-btn" style="margin-left:auto;background:rgba(239,68,68,0.12);color:#f87171;border:1px solid #f8717144;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:8.5pt">Clear all</button>
    </div>

    <!-- Main twin canvas -->
    <section class="panel-row" style="align-items:stretch">
      <div class="panel" style="flex:1.2">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="activity"></i> Grid Load — Baseline vs Event vs After Intervention</span>
          <span class="panel-sub" id="twin-curve-sub">No scenario active — showing historical baseline from meter data</span>
        </div>
        <div class="chart-wrap" style="height:245px"><canvas id="chart-twin-curve"></canvas></div>
      </div>
      <div class="panel" style="flex:0.9">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="grid-3x3"></i> Zone × Hour Stress Heatmap</span>
          <span class="panel-sub">green → red · intensity vs historical baseline</span>
        </div>
        <div style="position:relative;height:245px">
          <canvas id="twin-heatmap" style="width:100%;height:100%"></canvas>
        </div>
      </div>
    </section>

    <!-- Bottom row: hotspots + surge + reliability impact -->
    <section class="panel-row">
      <div class="panel" style="flex:0.9">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="flame"></i> Hotspot Zones</span>
          <span class="panel-sub">zones crossing critical threshold</span>
        </div>
        <div id="twin-hotspots" style="display:flex;flex-direction:column;gap:5px;padding:4px 0"></div>
      </div>
      <div class="panel" style="flex:0.9">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="siren"></i> Anomaly Surge</span>
          <span class="panel-sub">extra meters likely to flag</span>
        </div>
        <div class="chart-wrap" style="height:155px"><canvas id="chart-twin-surge"></canvas></div>
      </div>
      <div class="panel" style="flex:0.85">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="shield"></i> Reliability Impact Score</span>
          <span class="panel-sub">before / event / after intervention</span>
        </div>
        <div id="twin-reliability" class="twin-reliability-table">
          <div style="color:#64748b;font-size:8.5pt;padding:20px 0;text-align:center">Activate a scenario to see impact</div>
        </div>
      </div>
      <div class="panel" style="flex:1.1">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="bot"></i> Twin Intelligence Briefing</span>
          <span class="panel-sub" id="twin-brief-conf"></span>
        </div>
        <div id="twin-brief" class="twin-brief-box">
          <div style="color:#475569;font-size:8.5pt;line-height:1.6">
            <b style="color:#60a5fa">"Instead of reacting after failures occur, the digital twin lets BESCOM test future grid conditions before they happen."</b><br><br>
            Select one or more event scenarios above to project grid stress, identify hotspots, and test interventions.
          </div>
        </div>
      </div>
    </section>`;

  refreshIcons();
  _renderTwinBaseline();
  _bindTwinEvents();
}

function _renderTwinBaseline() {
  const zones = STATE.data.zoneForecast || [];
  const hrs = Array.from({length:24},(_,i)=>i);
  const baseline = hrs.map(h => zones.reduce((s,z) => {
    const hf=(z.hourly_forecast||[]).find(x=>x.hour===h);
    return s+(hf?hf.predicted_mw:0);
  }, 0));
  _drawTwinCurve(baseline, null, null);
  _drawHeatmap(zones, null);
  _renderHotspots(zones, null);
  _renderSurgeChart(0, []);
}

function _computeTwinScenario(activeEvents) {
  const scenarios = STATE.data.whatif || [];
  const zones = STATE.data.zoneForecast || [];
  if (!activeEvents.length) return null;

  // Combine active events into a single set of parameters
  const combined = activeEvents.reduce((acc, ev) => ({
    heatSnap: Math.max(acc.heatSnap, ev.heatSnap),
    acSnap:   Math.min(30, acc.acSnap + ev.acSnap),
    festival: acc.festival || ev.festival,
    typeMulti: {
      urban_core:  acc.typeMulti.urban_core  * ev.typeMulti.urban_core,
      semi_urban:  acc.typeMulti.semi_urban  * ev.typeMulti.semi_urban,
      rural_edge:  acc.typeMulti.rural_edge  * ev.typeMulti.rural_edge,
    },
    peakShift: Math.max(acc.peakShift, ev.peakShift),
    conf: Math.round((acc.conf + ev.conf) / 2),
  }), { heatSnap:0, acSnap:0, festival:false, typeMulti:{urban_core:1,semi_urban:1,rural_edge:1}, peakShift:0, conf:100 });

  // Snap to nearest precomputed scenario
  const hSnap = [0,2,4,6,8].reduce((p,c)=>Math.abs(c-combined.heatSnap)<Math.abs(p-combined.heatSnap)?c:p);
  const aRaw  = combined.acSnap / 100;
  const aSnap = [-0.2,-0.1,0,0.1,0.2,0.3].reduce((p,c)=>Math.abs(c-aRaw)<Math.abs(p-aRaw)?c:p);
  const key   = `h${hSnap}_a${Math.round(aSnap*100)}_f${combined.festival?1:0}`;
  const sc    = scenarios.find(s=>s.key===key) || scenarios.find(s=>s.festival===combined.festival) || scenarios[0];
  const base  = scenarios.find(s=>s.key==='h0_a0_f0') || scenarios[0];

  // Apply zone-type multipliers on top of precomputed scenario
  const projectedZones = sc.zones.map(z => {
    const zf = zones.find(zz=>zz.zone_id===z.zone_id);
    const multi = combined.typeMulti[zf?.type || 'urban_core'] || 1;
    const projPeak = parseFloat((z.peak_mw * multi).toFixed(2));
    const projRisk = projPeak > z.baseline_mw * 1.25 ? 'Critical' :
                     projPeak > z.baseline_mw * 1.10 ? 'High' :
                     projPeak > z.baseline_mw * 1.0  ? 'Moderate' : 'Low';
    return { ...z, peak_mw: projPeak, risk_level: projRisk, extra_flagged: Math.round((z.extra_flagged||0)*multi) };
  });

  return { sc, base, projectedZones, combined };
}

function _drawTwinCurve(baseline, projected, activeEvents, afterIntervention, interventions) {
  const ctx = document.getElementById('chart-twin-curve');
  if (!ctx) return;
  if (charts.twinCurve) charts.twinCurve.destroy();
  const hrs = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);
  const datasets = [
    { label:'Historical Baseline (meter avg)', data:baseline.map(v=>parseFloat(v.toFixed(1))),
      borderColor:'rgba(148,163,184,0.7)', backgroundColor:'rgba(148,163,184,0.08)',
      borderWidth:1.8, borderDash:[4,3], fill:true, tension:0.4, pointRadius:0 },
  ];
  if (projected) {
    const color = activeEvents.length===1 ? activeEvents[0].color : '#f59e0b';
    datasets.push({
      label:`Event: ${activeEvents.map(e=>e.name).join(' + ')}`,
      data: projected.map(v=>parseFloat(v.toFixed(1))),
      borderColor: color, backgroundColor: 'rgba(245,158,11,0.08)',
      borderWidth:2.5, fill:true, tension:0.4, pointRadius:0,
    });
  }
  if (afterIntervention) {
    datasets.push({
      label:`After ${interventions.map(i=>i.name).join(' + ')}`,
      data: afterIntervention.map(v=>parseFloat(v.toFixed(1))),
      borderColor:'#22d3ee', backgroundColor:'rgba(34,211,238,0.07)',
      borderDash:[6,3], borderWidth:2, fill:true, tension:0.4, pointRadius:0,
    });
  }
  charts.twinCurve = new Chart(ctx, {
    type:'line', data:{ labels:hrs, datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      layout:{padding:{left:4,right:8,top:6,bottom:0}},
      plugins:{ legend:{labels:{color:'#94a3b8',font:{size:9},boxWidth:10}} },
      scales:{
        x:{ticks:{color:'#8899aa',maxTicksLimit:12,font:{size:8}},grid:{color:'#1e2d42'}},
        y:{ticks:{color:'#8899aa',callback:v=>`${v|0}MW`,font:{size:8}},grid:{color:'#1e2d42'}},
      },
    },
  });
}

// Per-event, per-hour multiplier tables — makes heatmap change dramatically by event type
const HEATMAP_HOURLY = {
  diwali:   { 17:1.10, 18:1.22, 19:1.40, 20:1.45, 21:1.38, 22:1.20, 23:1.08 },
  monsoon:  { 0:0.88, 1:0.88, 2:0.88, 10:0.78, 11:0.75, 12:0.72, 13:0.75, 14:0.80, 15:1.12, 16:1.10, 17:0.90 },
  heatwave: { 10:1.15, 11:1.20, 12:1.28, 13:1.32, 14:1.35, 15:1.38, 16:1.40, 17:1.42, 18:1.45, 19:1.48, 20:1.50 },
  ipl:      { 19:1.18, 20:1.35, 21:1.30, 22:1.15 },
  ev_surge: { 18:1.08, 19:1.18, 20:1.25, 21:1.28, 22:1.22, 23:1.15 },
  new_year: { 20:1.15, 21:1.22, 22:1.35, 23:1.45 },
};

function _drawHeatmap(zones, projectedZones) {
  const canvas = document.getElementById('twin-heatmap');
  if (!canvas) return;

  // Resolve active events for hourly multipliers
  const activeEvents = Object.keys(STATE._twinActive || {})
    .filter(k => STATE._twinActive[k])
    .map(k => TWIN_EVENTS[k]).filter(Boolean);

  const LABEL_W = 86;
  // Force canvas pixel dimensions from layout
  const rect = canvas.getBoundingClientRect();
  canvas.width  = Math.round(rect.width)  || canvas.offsetWidth  || 420;
  canvas.height = Math.round(rect.height) || canvas.offsetHeight || 250;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const nH = 24;
  const nZ = zones.length;
  const cellW = (canvas.width - LABEL_W) / nH;
  const cellH = (canvas.height - 14) / nZ;  // leave 14px for hour labels

  // Peak reference: use projected if available, else baseline
  const refPeak = projectedZones
    ? Math.max(...projectedZones.map(z => z.peak_mw))
    : Math.max(...zones.map(z => z.peak_mw));

  // Zone-level multiplier from projectedZones (overall peak ratio)
  const zoneRatio = {};
  if (projectedZones) {
    projectedZones.forEach(pz => {
      zoneRatio[pz.zone_id] = pz.peak_mw / Math.max(pz.baseline_mw, 1);
    });
  }

  zones.forEach((z, zi) => {
    // Zone label
    ctx.fillStyle = '#94a3b8';
    const fontSize = Math.max(7, Math.min(9, Math.round(cellH * 0.38)));
    ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
    ctx.fillText(z.zone_name.substring(0, 11), 2, zi * cellH + cellH * 0.65);

    const baseZoneRatio = zoneRatio[z.zone_id] || 1;

    for (let h = 0; h < nH; h++) {
      const hf = (z.hourly_forecast || []).find(x => x.hour === h);
      const baseMw = hf ? hf.predicted_mw : 0;

      // Compute compound hourly multiplier from all active events
      let hourlyMult = baseZoneRatio;
      activeEvents.forEach(ev => {
        const mod = HEATMAP_HOURLY[ev.id];
        if (mod && mod[h] !== undefined) hourlyMult *= mod[h];
      });

      const projMw    = baseMw * hourlyMult;
      const intensity = Math.min(1, projMw / refPeak);

      // Steeper color ramp: green at <0.4, yellow at 0.6, red at >0.8
      let r, g, b;
      if (intensity < 0.4) {
        const t = intensity / 0.4;
        r = Math.round(t * 210); g = 185; b = 30;
      } else if (intensity < 0.7) {
        const t = (intensity - 0.4) / 0.3;
        r = 210; g = Math.round(185 * (1 - t * 0.5)); b = 20;
      } else {
        const t = (intensity - 0.7) / 0.3;
        r = 220; g = Math.round(92 * (1 - t)); b = 20;
      }
      const alpha = 0.18 + intensity * 0.78;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(LABEL_W + h * cellW + 0.5, zi * cellH + 0.5, cellW - 1, cellH - 1);

      // Highlight peak cell with border
      if (intensity > 0.85) {
        ctx.strokeStyle = 'rgba(239,68,68,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(LABEL_W + h * cellW + 0.5, zi * cellH + 0.5, cellW - 1, cellH - 1);
      }
    }
  });

  // Hour tick labels at bottom
  ctx.fillStyle = '#475569';
  ctx.font = '7px Inter, system-ui';
  [0, 3, 6, 9, 12, 15, 18, 21, 23].forEach(h => {
    ctx.fillText(`${h}h`, LABEL_W + h * cellW + 1, canvas.height - 2);
  });

  // Vertical marker at 18h (peak window start)
  if (activeEvents.length) {
    ctx.strokeStyle = 'rgba(239,68,68,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    const x18 = LABEL_W + 18 * cellW;
    ctx.beginPath(); ctx.moveTo(x18, 0); ctx.lineTo(x18, canvas.height - 14); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(239,68,68,0.6)';
    ctx.font = '7px Inter, system-ui';
    ctx.fillText('18h peak', x18 + 2, 9);
  }
}

function _renderHotspots(zones, projectedZones) {
  const el = document.getElementById('twin-hotspots');
  if (!el) return;
  const PC = { Critical:'#ef4444', High:'#f97316', Moderate:'#f59e0b', Low:'#10b981' };
  const source = projectedZones || zones.map(z=>({...z, risk_level: z.risk_level}));
  const sorted = [...source].sort((a,b)=>b.peak_mw-a.peak_mw);
  el.innerHTML = sorted.map(z => {
    const pct = projectedZones ? Math.round((z.peak_mw/(zones.find(zz=>zz.zone_id===z.zone_id)?.peak_mw||z.peak_mw)-1)*100) : 0;
    const delta = pct > 0 ? `<span style="color:#ef4444;font-weight:700">+${pct}%</span>` : pct < 0 ? `<span style="color:#10b981">-${Math.abs(pct)}%</span>` : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #0e1623">
      <span style="width:8px;height:8px;border-radius:50%;background:${PC[z.risk_level]||'#64748b'};flex-shrink:0"></span>
      <span style="flex:1;font-size:9pt;color:#cbd5e1;font-weight:600">${z.zone_name}</span>
      <span style="font-size:8.5pt;color:#94a3b8">${z.peak_mw.toFixed(1)} MW</span>
      ${delta}
      <span style="font-size:7.5pt;color:${PC[z.risk_level]||'#64748b'};font-weight:700">${z.risk_level}</span>
    </div>`;
  }).join('');
}

function _renderSurgeChart(totalExtra, zoneExtras) {
  const ctx = document.getElementById('chart-twin-surge');
  if (!ctx) return;
  if (charts.twinSurge) charts.twinSurge.destroy();
  if (!zoneExtras.length) {
    charts.twinSurge = new Chart(ctx, {
      type:'bar', data:{ labels:['No scenario active'], datasets:[{data:[0],backgroundColor:'rgba(100,116,139,0.3)',borderRadius:4}] },
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
        scales:{ x:{ticks:{color:'#8899aa',font:{size:9}}}, y:{ticks:{color:'#8899aa',font:{size:9}},grid:{color:'#1e2d42'}} } },
    });
    return;
  }
  const top8 = [...zoneExtras].sort((a,b)=>b.extra-a.extra).slice(0,8);
  charts.twinSurge = new Chart(ctx, {
    type:'bar',
    data:{
      labels: top8.map(z=>z.name),
      datasets:[{ label:'Extra flagged meters', data:top8.map(z=>z.extra),
        backgroundColor: top8.map(z=>z.extra>5?'rgba(239,68,68,0.80)':z.extra>2?'rgba(249,115,22,0.80)':'rgba(245,158,11,0.75)'),
        borderRadius:4 }],
    },
    options:{
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      layout:{padding:{left:4,right:8,top:4,bottom:0}},
      plugins:{ legend:{display:false}, tooltip:{callbacks:{label:c=>`+${c.raw} meters flagged`}} },
      scales:{ x:{ticks:{color:'#8899aa',font:{size:8}},grid:{color:'#1e2d42'}},
               y:{ticks:{color:'#cbd5e1',font:{size:8}},grid:{display:false}} },
    },
  });
}

function _updateTwinSimulation() {
  const active = Object.keys(STATE._twinActive||{}).filter(k=>STATE._twinActive[k]).map(k=>TWIN_EVENTS[k]).filter(Boolean);
  const activeInterventions = Object.keys(STATE._twinIntervention||{}).filter(k=>STATE._twinIntervention[k]).map(k=>TWIN_INTERVENTIONS[k]).filter(Boolean);

  const compoundBar = document.getElementById('twin-compound-bar');
  const compLabel   = document.getElementById('twin-compound-label');
  const compConf    = document.getElementById('twin-compound-conf');
  const curveSub    = document.getElementById('twin-curve-sub');
  const briefEl     = document.getElementById('twin-brief');
  const briefConf   = document.getElementById('twin-brief-conf');

  if (!active.length && !activeInterventions.length) {
    if (compoundBar) compoundBar.style.display = 'none';
    if (curveSub) curveSub.textContent = 'No scenario active — showing historical baseline from meter data';
    _renderTwinBaseline();
    const relEl = document.getElementById('twin-reliability');
    if (relEl) relEl.innerHTML = `<div style="color:#64748b;font-size:8.5pt;padding:20px 0;text-align:center">Activate a scenario to see impact</div>`;
    return;
  }

  if (compoundBar) compoundBar.style.display = 'flex';
  const allLabels = [...active.map(e=>e.name), ...activeInterventions.map(i=>`[${i.name}]`)];
  if (compLabel) compLabel.textContent = allLabels.join(' + ');

  if (!active.length) { _renderTwinBaseline(); return; }

  const sc = _computeTwinScenario(active);
  if (!sc) return;

  const { projectedZones, combined } = sc;
  const zones = STATE.data.zoneForecast || [];
  const hrs = Array.from({length:24},(_,i)=>i);

  const baseline = hrs.map(h => zones.reduce((s,z) => {
    const hf=(z.hourly_forecast||[]).find(x=>x.hour===h); return s+(hf?hf.predicted_mw:0);
  }, 0));
  const avgMulti = (combined.typeMulti.urban_core + combined.typeMulti.semi_urban + combined.typeMulti.rural_edge) / 3;
  const projCurve = hrs.map((_,i) => parseFloat((baseline[i] * avgMulti).toFixed(1)));

  // Intervention reduces the projected curve
  const totalPeakRed = activeInterventions.reduce((s,iv)=>s+iv.peakRed, 0);
  const afterCurve = activeInterventions.length
    ? projCurve.map((v,h) => h>=17&&h<=22 ? parseFloat((v*(1-totalPeakRed)).toFixed(1)) : parseFloat((v*0.98).toFixed(1)))
    : null;

  const peakBefore = Math.max(...baseline);
  const peakEvent  = Math.max(...projCurve);
  const peakAfterI = afterCurve ? Math.max(...afterCurve) : peakEvent;
  const peakDelta  = peakEvent - peakBefore;
  const peakSaved  = peakEvent - peakAfterI;

  const confAvg = Math.round(active.reduce((s,e)=>s+e.conf,0)/active.length);
  if (compConf) compConf.textContent = `${confAvg}% pattern confidence`;
  if (curveSub) curveSub.textContent = activeInterventions.length
    ? `Event peak: ${peakEvent.toFixed(1)} MW (+${peakDelta.toFixed(1)} MW) → After intervention: ${peakAfterI.toFixed(1)} MW (−${peakSaved.toFixed(1)} MW saved)`
    : `Projected peak: ${peakEvent.toFixed(1)} MW (+${peakDelta.toFixed(1)} MW · ${((peakDelta/peakBefore)*100).toFixed(1)}% above baseline)`;

  _drawTwinCurve(baseline, projCurve, active, afterCurve, activeInterventions);
  _drawHeatmap(zones, projectedZones);
  _renderHotspots(zones, projectedZones);

  const zoneExtras = projectedZones.map(z=>({ name:z.zone_name, extra:z.extra_flagged||0 }));
  const totalExtra = zoneExtras.reduce((s,z)=>s+z.extra,0);
  const totalFlagRed = activeInterventions.reduce((s,iv)=>s+iv.flagRed,0);
  const extraAfter  = activeInterventions.length ? Math.round(totalExtra*(1-totalFlagRed)) : totalExtra;
  _renderSurgeChart(totalExtra, zoneExtras);

  // Reliability impact score table
  const critBefore  = zones.filter(z=>z.risk_level==='Critical').length;
  const critEvent   = projectedZones.filter(z=>z.risk_level==='Critical').length;
  const critAfter   = activeInterventions.length ? Math.max(critBefore, Math.round(critEvent*(1-totalPeakRed*1.5))) : critEvent;
  const dtOverBefore = Math.round(critBefore*2.8);
  const dtOverEvent  = Math.round(critEvent*3.4);
  const dtOverAfter  = activeInterventions.length ? Math.round(dtOverEvent*(1-totalPeakRed)) : dtOverEvent;
  const relEl = document.getElementById('twin-reliability');
  if (relEl) {
    const rkColor = (a,b,c,better='low') => {
      const best = better==='low' ? Math.min(a,b,c) : Math.max(a,b,c);
      return v => v===best ? '#10b981' : v===Math.max(a,b,c)&&better==='low' ? '#ef4444' : '#f59e0b';
    };
    const cRisk = ['Low','Moderate','High','Critical'];
    const riskBefore = cRisk[Math.min(3,critBefore)];
    const riskEvent  = cRisk[Math.min(3,critEvent+1)];
    const riskAfter  = activeInterventions.length ? cRisk[Math.min(3,critAfter)] : riskEvent;
    const RC = (v) => v==='Critical'?'#ef4444':v==='High'?'#f97316':v==='Moderate'?'#f59e0b':'#10b981';
    relEl.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:8pt">
        <thead><tr style="color:#64748b;font-size:7.5pt;border-bottom:1px solid #1e2d42">
          <th style="padding:4px 6px;text-align:left">Metric</th>
          <th style="padding:4px 6px;text-align:center">Baseline</th>
          <th style="padding:4px 6px;text-align:center;color:#f59e0b">+ Event</th>
          ${activeInterventions.length?`<th style="padding:4px 6px;text-align:center;color:#22d3ee">+ Fix</th>`:''}
        </tr></thead>
        <tbody>
          <tr style="border-bottom:1px solid #0a1220"><td style="padding:4px 6px;color:#94a3b8">DT Overloads</td>
            <td style="text-align:center;color:#10b981">${dtOverBefore}</td>
            <td style="text-align:center;color:#ef4444">${dtOverEvent}</td>
            ${activeInterventions.length?`<td style="text-align:center;color:#22d3ee">${dtOverAfter}</td>`:''}
          </tr>
          <tr style="border-bottom:1px solid #0a1220"><td style="padding:4px 6px;color:#94a3b8">Critical Zones</td>
            <td style="text-align:center;color:#10b981">${critBefore}</td>
            <td style="text-align:center;color:#ef4444">${critEvent}</td>
            ${activeInterventions.length?`<td style="text-align:center;color:#22d3ee">${critAfter}</td>`:''}
          </tr>
          <tr style="border-bottom:1px solid #0a1220"><td style="padding:4px 6px;color:#94a3b8">Extra Flagged</td>
            <td style="text-align:center;color:#10b981">0</td>
            <td style="text-align:center;color:#ef4444">+${totalExtra}</td>
            ${activeInterventions.length?`<td style="text-align:center;color:#22d3ee">+${extraAfter}</td>`:''}
          </tr>
          <tr><td style="padding:4px 6px;color:#94a3b8">Outage Risk</td>
            <td style="text-align:center;color:${RC(riskBefore)};font-weight:700">${riskBefore}</td>
            <td style="text-align:center;color:${RC(riskEvent)};font-weight:700">${riskEvent}</td>
            ${activeInterventions.length?`<td style="text-align:center;color:${RC(riskAfter)};font-weight:700">${riskAfter}</td>`:''}
          </tr>
        </tbody>
      </table>`;
  }

  // AI brief
  const critZones = projectedZones.filter(z=>z.risk_level==='Critical').map(z=>z.zone_name);
  const highZones = projectedZones.filter(z=>z.risk_level==='High').map(z=>z.zone_name);
  const eventNames = active.map(e=>e.name).join(' + ');
  const sourceLine = active.map(e=>`<span style="color:#475569;font-size:7.5pt">↳ ${e.source}</span>`).join('<br>');
  const interventionLine = activeInterventions.length
    ? `<p style="margin-bottom:5px;color:#22d3ee"><i>Intervention applied: ${activeInterventions.map(i=>i.name).join(' + ')} — projected to reduce peak by ${(peakSaved).toFixed(1)} MW and cut flagged surge by ${Math.round(totalFlagRed*100)}%.</i></p>` : '';
  if (briefEl) briefEl.innerHTML = `
    <p style="color:#f1f5f9;margin-bottom:5px">Under <b>${eventNames}</b>, the twin projects <b>${peakEvent.toFixed(1)} MW peak</b> — <b style="color:#f59e0b">+${peakDelta.toFixed(1)} MW (+${((peakDelta/peakBefore)*100).toFixed(1)}%)</b> above baseline.</p>
    ${critZones.length?`<p style="margin-bottom:4px"><span style="color:#ef4444">▲ Critical:</span> <b>${critZones.join(', ')}</b> — DT loading >90%. Activate load shedding protocol.</p>`:''}
    ${highZones.length?`<p style="margin-bottom:4px"><span style="color:#f97316">▲ High:</span> <b>${highZones.join(', ')}</b> — inspection teams on standby.</p>`:''}
    <p style="margin-bottom:5px"><span style="color:#fbbf24">+${totalExtra} meters</span> projected to flag under demand surge.</p>
    ${interventionLine}
    <div style="border-top:1px solid #1e2d42;padding-top:5px;margin-top:5px">${sourceLine}</div>`;
  if (briefConf) briefConf.textContent = `${confAvg}% pattern confidence`;

  // Map update
  if (mlMap && STATE.localView === 'whatif') {
    const PC = { Critical:'#ef4444', High:'#f97316', Moderate:'#f59e0b', Low:'#10b981' };
    const expr = ['match', ['get', 'zone_id']];
    projectedZones.forEach(z=>{ expr.push(z.zone_id, PC[z.risk_level]||'#64748b'); });
    expr.push('#64748b');
    try { mlMap.setPaintProperty('zone-bounds-fill','fill-color',expr); mlMap.setPaintProperty('zone-bounds-fill','fill-opacity',0.40); } catch(e){}
  }
}

function _bindTwinEvents() {
  // Event scenario toggles
  document.querySelectorAll('.twin-event-card:not(.twin-intervention-card)').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.event;
      STATE._twinActive = STATE._twinActive || {};
      STATE._twinActive[id] = !STATE._twinActive[id];
      card.classList.toggle('twin-event-active', !!STATE._twinActive[id]);
      _updateTwinSimulation();
    });
  });
  // Intervention toggles
  document.querySelectorAll('.twin-intervention-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.intervention;
      STATE._twinIntervention = STATE._twinIntervention || {};
      STATE._twinIntervention[id] = !STATE._twinIntervention[id];
      card.classList.toggle('twin-event-active', !!STATE._twinIntervention[id]);
      _updateTwinSimulation();
    });
  });
  const clearBtn = document.getElementById('twin-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    STATE._twinActive = {}; STATE._twinIntervention = {};
    document.querySelectorAll('.twin-event-card').forEach(c=>c.classList.remove('twin-event-active'));
    _updateTwinSimulation();
  });
}

// Keep updateWhatIfScenario as a no-op stub (called from slider binds that no longer exist)
function updateWhatIfScenario() {}

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
  ['whatif-heat', 'whatif-ac', 'whatif-festival', 'whatif-ev', 'whatif-solar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateWhatIfScenario);
      el.addEventListener('change', updateWhatIfScenario);
    }
  });
  const resetBtn = document.getElementById('whatif-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    const h = document.getElementById('whatif-heat');     if (h) h.value = 0;
    const a = document.getElementById('whatif-ac');       if (a) a.value = 0;
    const f = document.getElementById('whatif-festival'); if (f) f.checked = false;
    const e = document.getElementById('whatif-ev');       if (e) e.value = 0;
    const s = document.getElementById('whatif-solar');    if (s) s.value = 0;
    updateWhatIfScenario();
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
      if (STATE.dashboardMode === 'local') {
        if (mlMap) mlMap.flyTo({ center: [BENGALURU_CENTER[1], BENGALURU_CENTER[0]], zoom: 11, pitch: 55, bearing: -12, duration: 600 });
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

  // Tactical overlay: map style filter (Tactical / B&W / NVG / Natural)
  document.querySelectorAll('.style-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const style = btn.dataset.style;
      document.body.setAttribute('data-mapstyle', style);
      try { localStorage.setItem('gridlytics_mapstyle', style); } catch (e) {}
    });
  });

  // Tactical overlay: scenes
  document.querySelectorAll('.scene-row').forEach(row => {
    row.addEventListener('click', () => {
      const scene = row.dataset.scene;
      if (scene === 'bengaluru') {
        STATE.selectedZone = null;
        if (mlMap) mlMap.flyTo({ center: [BENGALURU_CENTER[1], BENGALURU_CENTER[0]], zoom: 11, pitch: 55, bearing: -12, duration: 700 });
      } else if (scene === 'flagged') {
        STATE.layerOn = { critical: true, high: true, moderate: true, normal: false };
        document.querySelectorAll('input[data-layer]').forEach(i => {
          i.checked = STATE.layerOn[i.dataset.layer];
        });
      } else if (scene === 'rural') {
        if (mlMap) mlMap.flyTo({ center: [77.55, 13.07], zoom: 12, pitch: 55, bearing: -12, duration: 700 });
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
  refreshIcons();
  // Restore saved map style filter (default: tactical)
  let savedStyle = 'tactical';
  try { savedStyle = localStorage.getItem('gridlytics_mapstyle') || 'tactical'; } catch (e) {}
  document.body.setAttribute('data-mapstyle', savedStyle);
  document.querySelectorAll('.style-btn').forEach(b => b.classList.toggle('active', b.dataset.style === savedStyle));
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
        fitMapToBengaluru();   // Frames whatever we have; will refit when data lands
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

// ── Revenue Flow Sankey + Recovery Panel ──────────────────────────────────────
function renderRevenuePanel(zones) {
  // Aggregate AT&C for the 12 zones
  const avgAtc  = zones.reduce((s, z) => s + (z.atc_pct || 12), 0) / zones.length;
  const techLoss = 4.8;                            // technical (wire) loss %
  const commLoss = Math.max(0, avgAtc - techLoss); // commercial (theft+billing) loss %
  const collected = 100 - avgAtc;
  const billingGap = 1.8;                          // bills issued but not collected
  const paidRevenue = collected - billingGap;

  // Evidence-based monthly ₹ figures
  const evidence = STATE.data.evidence || [];
  const totalMonthlyLoss = evidence.reduce((s, e) => s + (e.est_revenue_loss_inr || e.monthly_loss_inr || 0), 0);
  const recoverable = Math.round(totalMonthlyLoss * 0.72);  // 72% recoverable within quarter
  const atcDrop = (commLoss * 0.45).toFixed(1);            // resolving flagged cases
  const payback  = Math.round(55 / Math.max(totalMonthlyLoss / 1e5, 0.1));  // inspection cost / monthly save

  // KPI strip
  const strip = document.getElementById('rev-kpi-strip');
  const fmt = v => v >= 1e7 ? `₹${(v/1e7).toFixed(1)}Cr` : v >= 1e5 ? `₹${(v/1e5).toFixed(1)}L` : `₹${(v/1e3).toFixed(0)}K`;
  if (strip) strip.innerHTML = `
    <div class="kpi-card kpi-red" style="padding:10px 12px">
      <div class="kpi-label" style="font-size:8pt">Monthly Loss</div>
      <div class="kpi-value" style="font-size:16pt">${fmt(totalMonthlyLoss)}</div>
      <div class="kpi-sub">across flagged meters</div>
    </div>
    <div class="kpi-card kpi-green" style="padding:10px 12px">
      <div class="kpi-label" style="font-size:8pt">Recoverable</div>
      <div class="kpi-value" style="font-size:16pt">${fmt(recoverable)}</div>
      <div class="kpi-sub">this quarter · 72% of loss</div>
    </div>
    <div class="kpi-card kpi-blue" style="padding:10px 12px">
      <div class="kpi-label" style="font-size:8pt">AT&C Drop</div>
      <div class="kpi-value" style="font-size:16pt">−${atcDrop}pp</div>
      <div class="kpi-sub">if Critical cases resolved</div>
    </div>
    <div class="kpi-card kpi-amber" style="padding:10px 12px">
      <div class="kpi-label" style="font-size:8pt">Payback</div>
      <div class="kpi-value" style="font-size:16pt">${payback} mo</div>
      <div class="kpi-sub">inspection cost ÷ monthly save</div>
    </div>`;

  // Revenue recovery bar (Critical/High/Moderate breakdown)
  const byTier = { Critical: 0, High: 0, Moderate: 0 };
  evidence.forEach(e => { const v = e.est_revenue_loss_inr || e.monthly_loss_inr || 0; if (byTier[e.severity] !== undefined) byTier[e.severity] += v; });
  const ctx2 = document.getElementById('chart-rev-recovery');
  if (ctx2) {
    if (charts.revRecovery) charts.revRecovery.destroy();
    charts.revRecovery = new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: ['Critical', 'High', 'Moderate'],
        datasets: [{ label: 'Monthly Loss (₹)', data: [byTier.Critical, byTier.High, byTier.Moderate],
          backgroundColor: ['rgba(239,68,68,0.85)','rgba(249,115,22,0.80)','rgba(245,158,11,0.75)'], borderRadius: 5 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { left: 4, right: 8, top: 4, bottom: 0 } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmt(c.raw) } } },
        scales: {
          x: { ticks: { color: '#94a3b8', font: { size: 9 } }, grid: { display: false } },
          y: { ticks: { color: '#8899aa', callback: v => fmt(v), font: { size: 9 } }, grid: { color: '#1e2d42' } },
        },
      },
    });
  }

  // Sankey: Energy → Losses → Revenue
  const ctx1 = document.getElementById('chart-sankey');
  if (!ctx1) return;
  if (charts.sankey) charts.sankey.destroy();

  const nodeColors = {
    'Energy\nGenerated': '#3b82f6',
    'Technical\nLoss':   '#64748b',
    'Commercial\nLoss':  '#ef4444',
    'Billing\nGap':      '#f97316',
    'Revenue\nCollected':'#10b981',
    'Energy\nBilled':    '#8b5cf6',
  };
  const getColor = (name) => nodeColors[name] || '#94a3b8';

  charts.sankey = new Chart(ctx1, {
    type: 'sankey',
    data: {
      datasets: [{
        data: [
          { from: 'Energy\nGenerated', to: 'Technical\nLoss',    flow: parseFloat(techLoss.toFixed(1)) },
          { from: 'Energy\nGenerated', to: 'Commercial\nLoss',   flow: parseFloat(commLoss.toFixed(1)) },
          { from: 'Energy\nGenerated', to: 'Energy\nBilled',     flow: parseFloat((100 - techLoss).toFixed(1)) },
          { from: 'Energy\nBilled',    to: 'Billing\nGap',       flow: parseFloat(billingGap.toFixed(1)) },
          { from: 'Energy\nBilled',    to: 'Revenue\nCollected', flow: parseFloat(paidRevenue.toFixed(1)) },
        ],
        colorFrom: (c) => getColor(c.dataset.data[c.dataIndex].from),
        colorTo:   (c) => getColor(c.dataset.data[c.dataIndex].to),
        colorMode: 'gradient',
        labels: {
          'Energy\nGenerated': 'Energy Generated',
          'Technical\nLoss':   `Technical Loss ${techLoss.toFixed(1)}%`,
          'Commercial\nLoss':  `Commercial Loss ${commLoss.toFixed(1)}%`,
          'Energy\nBilled':    `Billed ${(100-techLoss).toFixed(1)}%`,
          'Billing\nGap':      `Billing Gap ${billingGap}%`,
          'Revenue\nCollected':`Collected ${paidRevenue.toFixed(1)}%`,
        },
        color: '#cbd5e1',
        borderWidth: 0,
        nodeWidth: 14,
        nodePadding: 18,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { left: 6, right: 6, top: 8, bottom: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const d = c.dataset.data[c.dataIndex];
              return `${d.from.replace('\n',' ')} → ${d.to.replace('\n',' ')}: ${d.flow.toFixed(1)}%`;
            },
          },
        },
      },
    },
  });
}

// ── Shimmer skeleton helper ───────────────────────────────────────────────────
function _withShimmer(panelId, skeletonHtml, renderFn, delay) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.innerHTML = skeletonHtml;
  setTimeout(() => {
    if (document.getElementById(panelId)) renderFn();
  }, delay || 350);
}

function _deployShimmerHtml() {
  const kpi  = `<div class="kpi-card" style="height:72px"><div class="shimmer-block" style="height:14px;width:55%;margin-bottom:8px"></div><div class="shimmer-block" style="height:22px;width:40%"></div></div>`;
  const row  = `<tr><td colspan="6" style="padding:7px 8px"><div class="shimmer-block" style="height:13px;width:${60+Math.random()*30|0}%"></div></td></tr>`;
  return `
    <section class="kpi-strip local-kpi-strip">${kpi.repeat(4)}</section>
    <section class="panel panel-full" style="padding:14px 16px">
      <div class="shimmer-block" style="height:12px;width:220px;margin-bottom:10px"></div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px">
        ${Array(5).fill(`<div><div class="shimmer-block" style="height:10px;margin-bottom:6px"></div><div class="shimmer-block" style="height:6px"></div></div>`).join('')}
      </div>
    </section>
    <section class="panel-row">
      <div class="panel" style="flex:1.1">
        <div class="shimmer-block" style="height:12px;width:180px;margin-bottom:10px"></div>
        <div class="shimmer-block" style="height:310px"></div>
      </div>
      <div class="panel" style="flex:1">
        <div class="shimmer-block" style="height:12px;width:140px;margin-bottom:10px"></div>
        <div class="shimmer-block" style="height:240px;margin-bottom:8px"></div>
        <div class="shimmer-block" style="height:60px"></div>
      </div>
    </section>
    <section class="panel-row">
      <div class="panel" style="flex:1">
        <div class="shimmer-block" style="height:12px;width:160px;margin-bottom:10px"></div>
        <div class="shimmer-block" style="height:200px"></div>
      </div>
      <div class="panel" style="flex:1">
        <div class="shimmer-block" style="height:12px;width:160px;margin-bottom:10px"></div>
        <div class="shimmer-block" style="height:200px"></div>
      </div>
    </section>`;
}

function _todShimmerHtml() {
  const kpi = `<div class="kpi-card" style="height:72px"><div class="shimmer-block" style="height:12px;width:60%;margin-bottom:8px"></div><div class="shimmer-block" style="height:22px;width:40%"></div></div>`;
  const ctrl = Array(5).fill(`<div style="margin-bottom:10px"><div class="shimmer-block" style="height:10px;width:70%;margin-bottom:5px"></div><div class="shimmer-block" style="height:6px"></div></div>`).join('');
  return `
    <section class="kpi-strip local-kpi-strip">${kpi.repeat(4)}</section>
    <section class="panel-row" style="align-items:stretch">
      <div class="panel" style="flex:0 0 280px">
        <div class="shimmer-block" style="height:28px;margin-bottom:10px"></div>
        ${ctrl}
        <div class="shimmer-block" style="height:80px;margin-top:8px"></div>
      </div>
      <div class="panel" style="flex:1">
        <div class="shimmer-block" style="height:12px;width:200px;margin-bottom:10px"></div>
        <div class="shimmer-block" style="height:280px;margin-bottom:12px"></div>
        <div class="shimmer-block" style="height:130px"></div>
      </div>
    </section>
    <section class="panel-row">
      <div class="panel" style="flex:1.2"><div class="shimmer-block" style="height:200px"></div></div>
      <div class="panel" style="flex:0.9"><div class="shimmer-block" style="height:200px"></div></div>
    </section>`;
}

// ── ToD Pricing — Demand Shaping & Grid Balancing Simulation ─────────────────

// Base tariff ₹/kWh per hour (flat ₹6.5 is the reference)
const TOD_BASE_TARIFF = [3.5,3.5,3.5,3.5,3.5,3.5, 6.5,7.0,7.0,7.0, 6.5,6.5,6.5,6.5,6.5,6.5,6.5, 8.5,9.5,9.5,9.5,9.5, 7.0,6.5];
const TOD_FLAT = 6.5;

// Demand elasticity by consumer segment (price increase → demand reduction)
const TOD_ELASTICITY = { residential:-0.12, commercial:-0.20, industrial:-0.28, ev:-0.45 };
// System-wide share of each segment
const TOD_SHARE = { residential:0.50, commercial:0.28, industrial:0.17, ev:0.05 };
// Segment colors
const TOD_SEG_COLOR = { residential:'rgba(59,130,246,0.82)', commercial:'rgba(168,85,247,0.82)', industrial:'rgba(245,158,11,0.82)', ev:'rgba(16,185,129,0.85)' };

function computeToDScenario(settings) {
  const zones = STATE.data.zoneForecast || [];
  const hrs = Array.from({length:24}, (_,i) => i);

  // Aggregate system baseline (sum all zones)
  const baseline = hrs.map(h => zones.reduce((s,z) => {
    const hf = (z.hourly_forecast||[]).find(x=>x.hour===h);
    return s + (hf ? hf.predicted_mw : 0);
  }, 0));

  // Solar generation curve (normalised bell shape around noon, scaled to 20% of baseline peak)
  const peakBase = Math.max(...baseline);
  const solar = hrs.map(h => {
    if (h < 6 || h > 18) return 0;
    return parseFloat((Math.sin(Math.PI*(h-6)/12) * peakBase * 0.18 * settings.solarPenetration).toFixed(2));
  });

  // Effective tariff after scenario adjustments
  const tariff = TOD_BASE_TARIFF.map((t,h) => {
    if (h>=17 && h<=21) return parseFloat((t * settings.peakMultiplier).toFixed(2));
    if (h>=10 && h<=15) return parseFloat((t * (1 - settings.solarDiscount * 0.3)).toFixed(2));
    return t;
  });

  // Price delta from flat
  const priceDelta = tariff.map(t => (t - TOD_FLAT) / TOD_FLAT);

  // Weighted avg elasticity across all segments, scaled by response strength
  const weightedE = Object.keys(TOD_ELASTICITY).reduce((s,seg) =>
    s + TOD_SHARE[seg] * TOD_ELASTICITY[seg], 0) * settings.responseStrength;

  // Demand per segment (with ToD shift)
  const segments = {};
  Object.keys(TOD_SHARE).forEach(seg => {
    const e = TOD_ELASTICITY[seg] * settings.responseStrength;
    // EVs: also shift more based on EV adoption level
    const evBoost = seg === 'ev' ? (1 + settings.evAdoption * 0.8) : 1;
    segments[seg] = hrs.map((h, i) => {
      const segBase = baseline[i] * TOD_SHARE[seg];
      const shift = segBase * priceDelta[i] * e * evBoost;
      return Math.max(0, parseFloat((segBase + shift).toFixed(2)));
    });
  });

  // Total after-ToD curve = sum of segments
  const withTod = hrs.map(h => Object.values(segments).reduce((s,arr)=>s+arr[h],0));

  // KPIs
  const peakBefore = Math.max(...baseline);
  const peakAfter  = Math.max(...withTod);
  const peakRedPct = ((peakBefore-peakAfter)/peakBefore*100).toFixed(1);
  const procSaving  = parseFloat(((peakBefore-peakAfter)*0.85*365*1.5/1e7).toFixed(2)); // ₹Cr/yr at ₹1.5L/MW
  const dtStressRed = parseFloat((parseFloat(peakRedPct)*1.6).toFixed(1));
  const evShiftedMwh = parseFloat((baseline.reduce((s,v,h)=>h>=17&&h<=21?s+(v*TOD_SHARE.ev*(1-(-TOD_ELASTICITY.ev*settings.responseStrength*0.5))):s,0)*settings.evAdoption).toFixed(1));
  const energyBalance = parseFloat(((baseline.reduce((a,b)=>a+b,0)-withTod.reduce((a,b)=>a+b,0))/baseline.reduce((a,b)=>a+b,0)*100).toFixed(2));

  return { baseline, withTod, tariff, solar, segments, peakRedPct, procSaving, dtStressRed, evShiftedMwh, energyBalance };
}

function renderToDView() {
  if (!STATE.data.zoneForecast.length) return;
  _withShimmer('lview-tod', _todShimmerHtml(), _renderToDFull, 380);
}

function _renderToDFull() {
  STATE._todSettings = {
    peakMultiplier: 1.4,
    solarDiscount:  0.5,
    evAdoption:     0.25,
    responseStrength: 1.0,
    solarPenetration: 0.5,
  };

  const panel = document.getElementById('lview-tod');
  if (!panel) return;

  panel.innerHTML = `
    <!-- KPI strip -->
    <section class="kpi-strip local-kpi-strip" id="tod-kpi-strip">
      <div class="kpi-card kpi-green">
        <div class="kpi-label">Peak Demand Reduction</div>
        <div class="kpi-value" id="tod-kpi-peak">–</div>
        <div class="kpi-sub">evening peak shaved</div>
      </div>
      <div class="kpi-card kpi-blue">
        <div class="kpi-label">Procurement Savings</div>
        <div class="kpi-value" id="tod-kpi-proc">–</div>
        <div class="kpi-sub">₹Cr/yr · reduced peak purchase</div>
      </div>
      <div class="kpi-card kpi-amber">
        <div class="kpi-label">Transformer Stress ↓</div>
        <div class="kpi-value" id="tod-kpi-dt">–</div>
        <div class="kpi-sub">overload probability reduction</div>
      </div>
      <div class="kpi-card" style="border-color:#10b981">
        <div class="kpi-label">EV Load Shifted</div>
        <div class="kpi-value" id="tod-kpi-ev" style="color:#34d399">–</div>
        <div class="kpi-sub">MWh moved to off-peak</div>
      </div>
    </section>

    <!-- Main: controls left + load curve right -->
    <section class="panel-row" style="align-items:stretch">

      <!-- LEFT: Tariff + Scenario Controls -->
      <div class="panel" style="flex:0 0 280px;display:flex;flex-direction:column;gap:12px">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="sliders-horizontal"></i> Tariff Scenario</span>
          <span class="panel-sub">adjust — curves update live</span>
        </div>

        <!-- Tariff band visual -->
        <div id="tod-tariff-bands" style="display:flex;height:28px;border-radius:6px;overflow:hidden;gap:1px"></div>
        <div style="display:flex;justify-content:space-between;font-size:7.5pt;color:#64748b;margin-top:-8px">
          <span>12AM</span><span>6AM</span><span>12PM</span><span>6PM</span><span>12AM</span>
        </div>

        <!-- Tariff legend -->
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:8pt">
          <span style="color:#10b981">■ Off-peak ₹3.5</span>
          <span style="color:#f59e0b">■ Mid ₹6.5</span>
          <span style="color:#f97316">■ Morning ₹7</span>
          <span style="color:#ef4444">■ Peak ₹8.5+</span>
          <span style="color:#22d3ee">■ Solar ₹4–5.5</span>
        </div>

        <div style="border-top:1px solid #1e2d42;padding-top:10px;display:flex;flex-direction:column;gap:10px">

          <div class="tod-sc-item">
            <label class="tod-sc-label"><i data-lucide="trending-up"></i> Peak tariff multiplier <span class="tod-sc-val" id="tod-peak-val">×1.4</span></label>
            <input type="range" class="deploy-sc-range" id="tod-peak" min="100" max="200" step="10" value="140">
            <div class="deploy-sc-ticks"><span>×1.0</span><span>×1.5</span><span>×2.0</span></div>
          </div>

          <div class="tod-sc-item">
            <label class="tod-sc-label"><i data-lucide="sun"></i> Solar hour discount <span class="tod-sc-val" id="tod-solar-val">50%</span></label>
            <input type="range" class="deploy-sc-range" id="tod-solar" min="0" max="80" step="10" value="50">
            <div class="deploy-sc-ticks"><span>0%</span><span>40%</span><span>80%</span></div>
          </div>

          <div class="tod-sc-item">
            <label class="tod-sc-label"><i data-lucide="car"></i> EV adoption level <span class="tod-sc-val" id="tod-ev-val">25%</span></label>
            <input type="range" class="deploy-sc-range" id="tod-ev" min="0" max="60" step="5" value="25">
            <div class="deploy-sc-ticks"><span>0%</span><span>30%</span><span>60%</span></div>
          </div>

          <div class="tod-sc-item">
            <label class="tod-sc-label"><i data-lucide="users"></i> Consumer response <span class="tod-sc-val" id="tod-resp-val">100%</span></label>
            <input type="range" class="deploy-sc-range" id="tod-resp" min="20" max="150" step="10" value="100">
            <div class="deploy-sc-ticks"><span>Low</span><span>Med</span><span>High</span></div>
          </div>

          <div class="tod-sc-item">
            <label class="tod-sc-label"><i data-lucide="panel-top"></i> Solar penetration <span class="tod-sc-val" id="tod-sp-val">50%</span></label>
            <input type="range" class="deploy-sc-range" id="tod-sp" min="0" max="100" step="10" value="50">
            <div class="deploy-sc-ticks"><span>0%</span><span>50%</span><span>100%</span></div>
          </div>
        </div>

        <!-- Consumer bill impact -->
        <div style="border-top:1px solid #1e2d42;padding-top:10px;font-size:8.5pt">
          <div style="color:#64748b;font-size:7.5pt;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px">Consumer Bill Impact</div>
          <div id="tod-bill-table"></div>
        </div>
      </div>

      <!-- RIGHT: Main load curve -->
      <div class="panel" style="flex:1">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="activity"></i> Grid Load Profile — Before vs After ToD</span>
          <span class="panel-sub">system aggregate MW · live response to scenario controls</span>
        </div>
        <div class="chart-wrap" style="height:280px"><canvas id="chart-tod-curve"></canvas></div>
        <div style="margin-top:6px">
          <div class="panel-header" style="margin-top:8px">
            <span class="panel-title" style="font-size:9pt"><i data-lucide="sun"></i> Solar Generation Overlay</span>
            <span class="panel-sub">solar production vs demand curves</span>
          </div>
          <div class="chart-wrap" style="height:130px"><canvas id="chart-tod-solar"></canvas></div>
        </div>
      </div>
    </section>

    <!-- Bottom: segment stacked + procurement -->
    <section class="panel-row">
      <div class="panel" style="flex:1.2">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="layers"></i> Demand by Consumer Segment — After ToD</span>
          <span class="panel-sub">stacked MW · residential · commercial · industrial · EV</span>
        </div>
        <div class="chart-wrap" style="height:200px"><canvas id="chart-tod-segments"></canvas></div>
      </div>
      <div class="panel" style="flex:0.9">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="bar-chart-2"></i> Peak vs Off-Peak Procurement</span>
          <span class="panel-sub">₹L/day · expensive peak purchase reduction</span>
        </div>
        <div class="chart-wrap" style="height:200px"><canvas id="chart-tod-procurement"></canvas></div>
      </div>
    </section>`;

  refreshIcons();
  _renderTodTariffBands(STATE._todSettings);
  _updateToDScenario();
  _bindToDSliders();
}

function _renderTodTariffBands(settings) {
  const el = document.getElementById('tod-tariff-bands');
  if (!el) return;
  const tariff = TOD_BASE_TARIFF.map((t,h) => {
    if (h>=17&&h<=21) return t * settings.peakMultiplier;
    if (h>=10&&h<=15) return t * (1 - settings.solarDiscount * 0.3);
    return t;
  });
  const maxT = Math.max(...tariff);
  const getColor = (t, h) => {
    if (h>=10&&h<=15 && settings.solarDiscount>0.3) return '#22d3ee';
    if (t <= 4) return '#10b981';
    if (t <= 6.6) return '#f59e0b';
    if (t <= 7.5) return '#f97316';
    return '#ef4444';
  };
  el.innerHTML = tariff.map((t,h) =>
    `<div title="${String(h).padStart(2,'0')}:00 · ₹${t.toFixed(1)}/kWh" style="flex:1;background:${getColor(t,h)};opacity:${0.5+t/maxT*0.5}"></div>`
  ).join('');
}

function _updateToDScenario() {
  const s = STATE._todSettings;
  const sc = computeToDScenario(s);
  const hl = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);

  // KPIs
  const set = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
  set('tod-kpi-peak',  `${sc.peakRedPct}%`);
  set('tod-kpi-proc',  `₹${sc.procSaving} Cr`);
  set('tod-kpi-dt',    `${sc.dtStressRed}%`);
  set('tod-kpi-ev',    `${sc.evShiftedMwh} MWh`);

  // Bill impact table
  const billEl = document.getElementById('tod-bill-table');
  if (billEl) {
    const BILL = [
      { seg:'Residential', icon:'🏠', change: sc.energyBalance > 0 ? `-${(sc.energyBalance*0.4).toFixed(1)}%` : '±0%', color:'#10b981' },
      { seg:'Commercial',  icon:'🏢', change:`-${(parseFloat(sc.peakRedPct)*0.6).toFixed(1)}%`, color:'#3b82f6' },
      { seg:'Industrial',  icon:'🏭', change:`-${(parseFloat(sc.peakRedPct)*0.9).toFixed(1)}%`, color:'#f59e0b' },
      { seg:'EV Owner',    icon:'🚗', change:`-${(s.evAdoption*18).toFixed(0)}%`, color:'#10b981' },
    ];
    billEl.innerHTML = BILL.map(b=>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #0e1623">
        <span style="color:#94a3b8">${b.icon} ${b.seg}</span>
        <span style="color:${b.color};font-weight:700">${b.change}</span>
      </div>`
    ).join('');
  }

  // Main load curve
  const ctx1 = document.getElementById('chart-tod-curve');
  if (ctx1) {
    if (charts.todCurve) charts.todCurve.destroy();
    const tariffColors24 = sc.tariff.map(t => t>=8 ? 'rgba(239,68,68,0.18)' : t>=7 ? 'rgba(249,115,22,0.12)' : 'rgba(0,0,0,0)');
    charts.todCurve = new Chart(ctx1, {
      type: 'line',
      data: {
        labels: hl,
        datasets: [
          { label: 'Current Load (Flat Tariff)',
            data: sc.baseline.map(v=>parseFloat(v.toFixed(1))),
            borderColor:'#f97316', backgroundColor:'rgba(249,115,22,0.08)',
            borderWidth:2.5, fill:true, tension:0.4, pointRadius:0, order:2 },
          { label: 'With ToD Pricing',
            data: sc.withTod.map(v=>parseFloat(v.toFixed(1))),
            borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.12)',
            borderWidth:2.5, fill:true, tension:0.4, pointRadius:0, order:1 },
          { label: 'Tariff Zone',
            data: sc.tariff.map((t,h)=> h>=17&&h<=21 ? Math.max(...sc.baseline)*1.05 : null),
            backgroundColor:'rgba(239,68,68,0.08)', borderWidth:0,
            fill:true, pointRadius:0, type:'bar', barPercentage:1, categoryPercentage:1, order:3 },
        ],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        layout:{padding:{left:4,right:8,top:6,bottom:0}},
        plugins:{
          legend:{labels:{color:'#94a3b8',font:{size:10},boxWidth:12,filter:i=>i.datasetIndex<2}},
          tooltip:{callbacks:{label:c=>c.datasetIndex<2?`${c.dataset.label}: ${c.raw} MW`:null}},
        },
        scales:{
          x:{ticks:{color:'#8899aa',maxTicksLimit:12,font:{size:9}},grid:{color:'#1e2d42'}},
          y:{ticks:{color:'#8899aa',callback:v=>`${v.toFixed(0)} MW`,font:{size:9}},grid:{color:'#1e2d42'}},
        },
      },
    });
  }

  // Solar overlay
  const ctx2 = document.getElementById('chart-tod-solar');
  if (ctx2) {
    if (charts.todSolar) charts.todSolar.destroy();
    charts.todSolar = new Chart(ctx2, {
      type: 'line',
      data: {
        labels: hl,
        datasets: [
          { label:'Demand (After ToD)', data:sc.withTod.map(v=>parseFloat(v.toFixed(1))),
            borderColor:'#3b82f6', borderWidth:1.8, fill:false, tension:0.4, pointRadius:0 },
          { label:'Solar Generation', data:sc.solar,
            borderColor:'#fbbf24', backgroundColor:'rgba(251,191,36,0.18)',
            borderWidth:2, fill:true, tension:0.5, pointRadius:0 },
        ],
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        layout:{padding:{left:4,right:8,top:4,bottom:0}},
        plugins:{legend:{labels:{color:'#94a3b8',font:{size:9},boxWidth:10}}},
        scales:{
          x:{ticks:{color:'#8899aa',maxTicksLimit:12,font:{size:8}},grid:{color:'#1e2d42'}},
          y:{ticks:{color:'#8899aa',callback:v=>`${v.toFixed(0)}`,font:{size:8}},grid:{color:'#1e2d42'}},
        },
      },
    });
  }

  // Segment stacked
  const ctx3 = document.getElementById('chart-tod-segments');
  if (ctx3) {
    if (charts.todSegments) charts.todSegments.destroy();
    charts.todSegments = new Chart(ctx3, {
      type:'bar',
      data:{
        labels:hl,
        datasets: Object.entries(sc.segments).map(([seg,data])=>({
          label: seg.charAt(0).toUpperCase()+seg.slice(1),
          data: data.map(v=>parseFloat(v.toFixed(1))),
          backgroundColor: TOD_SEG_COLOR[seg],
          borderWidth:0,
          barPercentage:1, categoryPercentage:1,
        })),
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        layout:{padding:{left:4,right:8,top:4,bottom:0}},
        plugins:{
          legend:{labels:{color:'#94a3b8',font:{size:9},boxWidth:10}},
          tooltip:{callbacks:{label:c=>`${c.dataset.label}: ${c.raw} MW`}},
        },
        scales:{
          x:{stacked:true,ticks:{color:'#8899aa',maxTicksLimit:12,font:{size:8}},grid:{display:false}},
          y:{stacked:true,ticks:{color:'#8899aa',callback:v=>`${v}MW`,font:{size:8}},grid:{color:'#1e2d42'}},
        },
      },
    });
  }

  // Procurement cost comparison
  const ctx4 = document.getElementById('chart-tod-procurement');
  if (ctx4) {
    if (charts.todProc) charts.todProc.destroy();
    const peakHours = [17,18,19,20,21];
    const PEAK_COST = 15;   // ₹L/MWh peak procurement
    const OFF_COST  = 4.5;
    const procBefore = peakHours.map(h => parseFloat((sc.baseline[h]*PEAK_COST/100).toFixed(1)));
    const procAfter  = peakHours.map(h => parseFloat((sc.withTod[h]*PEAK_COST/100).toFixed(1)));
    charts.todProc = new Chart(ctx4, {
      type:'bar',
      data:{
        labels: peakHours.map(h=>`${h}:00`),
        datasets:[
          {label:'Before ToD', data:procBefore, backgroundColor:'rgba(239,68,68,0.75)', borderRadius:4},
          {label:'After ToD',  data:procAfter,  backgroundColor:'rgba(16,185,129,0.75)', borderRadius:4},
        ],
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        layout:{padding:{left:4,right:8,top:4,bottom:0}},
        plugins:{
          legend:{labels:{color:'#94a3b8',font:{size:9},boxWidth:10}},
          tooltip:{callbacks:{label:c=>`₹${c.raw}L procurement cost`}},
        },
        scales:{
          x:{ticks:{color:'#8899aa',font:{size:9}},grid:{display:false}},
          y:{ticks:{color:'#8899aa',callback:v=>`₹${v}L`,font:{size:8}},grid:{color:'#1e2d42'}},
        },
      },
    });
  }

  // Update map: zone stress reduction (greener = less stressed after ToD)
  if (mlMap && STATE.localView === 'tod') {
    const reductionPct = parseFloat(sc.peakRedPct);
    const expr = ['match', ['get', 'zone_id']];
    (STATE.data.zoneForecast || []).forEach((z,i) => {
      const zRed = reductionPct * (0.8 + (i%5)*0.08);
      const color = zRed > 12 ? '#10b981' : zRed > 8 ? '#22d3ee' : zRed > 5 ? '#f59e0b' : '#f97316';
      expr.push(z.zone_id, color);
    });
    expr.push('#64748b');
    try {
      mlMap.setPaintProperty('zone-bounds-fill', 'fill-color', expr);
      mlMap.setPaintProperty('zone-bounds-fill', 'fill-opacity', 0.40);
    } catch(e) {}
  }
}

function _bindToDSliders() {
  [
    ['tod-peak',  v => { STATE._todSettings.peakMultiplier = v/100; document.getElementById('tod-peak-val').textContent = `×${(v/100).toFixed(1)}`; }],
    ['tod-solar', v => { STATE._todSettings.solarDiscount   = v/100; document.getElementById('tod-solar-val').textContent = `${v}%`; }],
    ['tod-ev',    v => { STATE._todSettings.evAdoption      = v/100; document.getElementById('tod-ev-val').textContent = `${v}%`; }],
    ['tod-resp',  v => { STATE._todSettings.responseStrength= v/100; document.getElementById('tod-resp-val').textContent = `${v}%`; }],
    ['tod-sp',    v => { STATE._todSettings.solarPenetration= v/100; document.getElementById('tod-sp-val').textContent = `${v}%`; }],
  ].forEach(([id, fn]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      fn(parseInt(el.value));
      _renderTodTariffBands(STATE._todSettings);
      _updateToDScenario();
    });
  });
}

// ── Smart Meter Deployment Optimizer — AI Investment Prioritization ──────────

// Zone-specific synthetic factor data (deterministic, calibrated to real BESCOM geography)
const DEPLOY_FACTORS = {
  Z01:{ growth:0.70, outage:0.45, criticality:0.75, comm:0.85, density:0.82 }, // Indiranagar
  Z02:{ growth:0.72, outage:0.42, criticality:0.65, comm:0.88, density:0.78 }, // Koramangala
  Z03:{ growth:0.68, outage:0.40, criticality:0.60, comm:0.82, density:0.75 }, // HSR Layout
  Z04:{ growth:0.55, outage:0.50, criticality:0.55, comm:0.80, density:0.85 }, // Jayanagar
  Z05:{ growth:0.52, outage:0.55, criticality:0.50, comm:0.75, density:0.80 }, // Rajajinagar
  Z06:{ growth:0.50, outage:0.58, criticality:0.55, comm:0.72, density:0.88 }, // Malleswaram
  Z07:{ growth:0.88, outage:0.35, criticality:0.82, comm:0.90, density:0.60 }, // Whitefield
  Z08:{ growth:0.85, outage:0.38, criticality:0.85, comm:0.88, density:0.55 }, // Electronic City
  Z09:{ growth:0.75, outage:0.48, criticality:0.60, comm:0.80, density:0.65 }, // Marathahalli
  Z10:{ growth:0.60, outage:0.72, criticality:0.45, comm:0.60, density:0.45 }, // Yelahanka
  Z11:{ growth:0.65, outage:0.68, criticality:0.70, comm:0.65, density:0.50 }, // Hebbal
  Z12:{ growth:0.45, outage:0.78, criticality:0.65, comm:0.70, density:0.55 }, // Peenya
};

const DEPLOY_W_DEFAULT = { atc:0.25, theft:0.20, revenue:0.20, outage:0.15, growth:0.10, density:0.05, criticality:0.05 };

function computeDeployZones(weights) {
  const zones   = STATE.data.zoneForecast || [];
  const meters  = STATE.data.meters || [];
  const w = weights || DEPLOY_W_DEFAULT;
  const TARIFF = 7.5, METER_COST = 4500, AVG_KWH = 100;

  // Normalisation helpers
  const maxAtc    = Math.max(...zones.map(z => z.atc_pct));
  const maxPeak   = Math.max(...zones.map(z => z.peak_mw));

  return zones.map(z => {
    const f = DEPLOY_FACTORS[z.zone_id] || { growth:0.55, outage:0.50, criticality:0.55, comm:0.75, density:0.65 };

    // Factor scores (0–1)
    const atcScore      = Math.min(1, Math.max(0, (z.atc_pct - 8) / (maxAtc - 8)));
    const theftScore    = Math.min(1, (z.n_flagged / Math.max(z.n_meters, 1)) * 3.5);
    const revenueScore  = atcScore * 0.65 + (z.peak_mw / maxPeak) * 0.35;
    const outageScore   = f.outage;
    const growthScore   = f.growth;
    const densityScore  = f.density;
    const critScore     = f.criticality;

    const score = Math.min(1,
      w.atc        * atcScore +
      w.theft      * theftScore +
      w.revenue    * revenueScore +
      w.outage     * outageScore +
      w.growth     * growthScore +
      w.density    * densityScore +
      w.criticality* critScore
    );

    // Ease = communication quality × inverse of density (less dense = easier)
    const ease = Math.min(0.95, f.comm * 0.5 + (1 - f.density) * 0.35 + (z.type === 'rural_edge' ? 0.15 : z.type === 'semi_urban' ? 0.07 : 0));

    // Financials (realistic per-consumer)
    const consumers     = Math.round(z.n_meters * 18);
    const nUnmetered    = Math.round(consumers * 0.93);
    const lossPerCons   = (z.atc_pct / 100) * AVG_KWH * TARIFF;
    const monthlyLoss   = lossPerCons * nUnmetered;
    const payback       = (METER_COST * nUnmetered) / Math.max(monthlyLoss, 1);
    const annualROI     = (monthlyLoss * 12) / 1e5;  // ₹L/yr

    const priority = score >= 0.65 ? 'Critical' : score >= 0.48 ? 'High' : score >= 0.32 ? 'Medium' : 'Low';

    return {
      ...z, score, priority, ease,
      atcScore, theftScore, revenueScore, outageScore, growthScore, densityScore, critScore,
      consumers, nUnmetered, monthlyLoss, payback, annualROI, lossPerCons,
    };
  }).sort((a, b) => b.score - a.score);
}

function renderDeployView() {
  if (!STATE.data.zoneForecast.length) return;
  STATE._deployWeights = { ...DEPLOY_W_DEFAULT };
  STATE._deployBudget  = 200;
  _withShimmer('lview-deploy', _deployShimmerHtml(), _renderDeployFull, 350);
}

function _deployWhyReasons(z) {
  const reasons = [];
  if (z.atcScore > 0.65)      reasons.push(`High AT&C loss (${z.atc_pct.toFixed(1)}%) — significant unbilled energy`);
  if (z.theftScore > 0.5)     reasons.push(`Elevated theft risk — ${z.n_flagged} meters flagged (${(z.theftScore*100).toFixed(0)}% rate)`);
  if (z.growthScore > 0.75)   reasons.push(`High-growth zone (EV/solar corridor) — smart visibility critical early`);
  if (z.outageScore > 0.60)   reasons.push(`Frequent outages — real-time monitoring cuts restoration time`);
  if (z.critScore > 0.70)     reasons.push(`Critical infrastructure zone (hospitals / IT parks / metro)`);
  if (z.payback < 36)         reasons.push(`Fast payback: ${z.payback.toFixed(0)} months at RDSS ₹4,500/meter`);
  if (z.densityScore > 0.75)  reasons.push(`High consumer density — maximum meters per deployment team`);
  if (!reasons.length)        reasons.push(`Moderate across all factors — suitable for secondary rollout`);
  return reasons;
}

function _renderDeployFull() {
  const w  = STATE._deployWeights;
  const budget = STATE._deployBudget;
  const zoneData = computeDeployZones(w);
  const top = zoneData[0];
  const METER_COST_CR = 4500 * 18 * 48 / 1e7; // ₹Cr per zone
  const zonesAffordable = Math.min(12, Math.floor(budget / METER_COST_CR));
  const totalAnnual = zoneData.reduce((s, z) => s + z.annualROI, 0);
  const avgScore = (zoneData.reduce((s, z) => s + z.score, 0) / zoneData.length * 100).toFixed(0);

  const PC_SOLID = { Critical:'#ef4444', High:'#f97316', Medium:'#f59e0b', Low:'#10b981' };
  const PC_ALPHA = { Critical:'rgba(239,68,68,0.82)', High:'rgba(249,115,22,0.82)', Medium:'rgba(245,158,11,0.78)', Low:'rgba(16,185,129,0.72)' };

  const panel = document.getElementById('lview-deploy');
  if (!panel) return;
  panel.innerHTML = `
    <section class="kpi-strip local-kpi-strip">
      <div class="kpi-card kpi-red">
        <div class="kpi-label">Top Priority Zone</div>
        <div class="kpi-value" style="font-size:16pt">${top.zone_name}</div>
        <div class="kpi-sub">Score ${(top.score*100).toFixed(0)}/100 · Deploy immediately</div>
      </div>
      <div class="kpi-card kpi-amber">
        <div class="kpi-label">Zones in Budget</div>
        <div class="kpi-value">${zonesAffordable} <span style="font-size:12pt">/ 12</span></div>
        <div class="kpi-sub">₹${budget} Cr budget · ₹${METER_COST_CR.toFixed(1)} Cr/zone</div>
      </div>
      <div class="kpi-card kpi-green">
        <div class="kpi-label">Total Annual Recovery</div>
        <div class="kpi-value">₹${(totalAnnual/100).toFixed(1)} Cr</div>
        <div class="kpi-sub">all 12 zones · 100 kWh/consumer</div>
      </div>
      <div class="kpi-card kpi-blue">
        <div class="kpi-label">Avg Priority Score</div>
        <div class="kpi-value">${avgScore}<span style="font-size:12pt">/100</span></div>
        <div class="kpi-sub">composite of 7 factors</div>
      </div>
    </section>

    <!-- Scenario controls -->
    <section class="panel panel-full" style="padding:12px 16px">
      <div class="panel-header" style="margin-bottom:10px">
        <span class="panel-title"><i data-lucide="sliders-horizontal"></i> Investment Scenario Controls</span>
        <span class="panel-sub">adjust focus — rankings update live</span>
      </div>
      <div class="deploy-scenario-grid" id="deploy-scenario-grid">
        <div class="deploy-sc-item">
          <label class="deploy-sc-label"><i data-lucide="indian-rupee"></i> Budget (₹ Cr) <span class="deploy-sc-val" id="dsc-budget-val">₹${budget} Cr</span></label>
          <input type="range" class="deploy-sc-range" id="dsc-budget" min="50" max="500" step="50" value="${budget}">
          <div class="deploy-sc-ticks"><span>₹50Cr</span><span>₹200Cr</span><span>₹500Cr</span></div>
        </div>
        <div class="deploy-sc-item">
          <label class="deploy-sc-label"><i data-lucide="zap"></i> AT&C Focus <span class="deploy-sc-val" id="dsc-atc-val">${Math.round(w.atc*100)}%</span></label>
          <input type="range" class="deploy-sc-range" id="dsc-atc" min="0" max="50" step="5" value="${Math.round(w.atc*100)}">
        </div>
        <div class="deploy-sc-item">
          <label class="deploy-sc-label"><i data-lucide="siren"></i> Theft Priority <span class="deploy-sc-val" id="dsc-theft-val">${Math.round(w.theft*100)}%</span></label>
          <input type="range" class="deploy-sc-range" id="dsc-theft" min="0" max="50" step="5" value="${Math.round(w.theft*100)}">
        </div>
        <div class="deploy-sc-item">
          <label class="deploy-sc-label"><i data-lucide="car"></i> EV/Future Growth <span class="deploy-sc-val" id="dsc-growth-val">${Math.round(w.growth*100)}%</span></label>
          <input type="range" class="deploy-sc-range" id="dsc-growth" min="0" max="40" step="5" value="${Math.round(w.growth*100)}">
        </div>
        <div class="deploy-sc-item">
          <label class="deploy-sc-label"><i data-lucide="activity"></i> Outage Reliability <span class="deploy-sc-val" id="dsc-outage-val">${Math.round(w.outage*100)}%</span></label>
          <input type="range" class="deploy-sc-range" id="dsc-outage" min="0" max="40" step="5" value="${Math.round(w.outage*100)}">
        </div>
      </div>
    </section>

    <!-- Matrix + Table -->
    <section class="panel-row">
      <div class="panel" style="flex:1.1">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="target"></i> Priority Matrix — Impact vs Ease</span>
          <span class="panel-sub">4-quadrant · bubble = composite priority score · click zone for reasoning</span>
        </div>
        <div class="chart-wrap" style="height:310px;position:relative">
          <canvas id="chart-deploy-matrix"></canvas>
          <div style="position:absolute;top:14px;left:52%;font-size:8pt;color:#475569;pointer-events:none">Strategic Investment →</div>
          <div style="position:absolute;top:14px;left:8px;font-size:8pt;color:#ef444480;pointer-events:none">Quick Wins →</div>
        </div>
      </div>
      <div class="panel" style="flex:1">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="list-ordered"></i> Priority Ranking</span>
          <span class="panel-sub">click row to see AI reasoning</span>
        </div>
        <div id="deploy-table" style="overflow-y:auto;max-height:240px"></div>
        <div id="deploy-why" class="deploy-why-panel" style="display:none"></div>
      </div>
    </section>

    <!-- Factor breakdown -->
    <section class="panel-row">
      <div class="panel" style="flex:1">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="radar"></i> Factor Breakdown — <span id="deploy-radar-title">${top.zone_name}</span></span>
          <span class="panel-sub">7-factor composite score · click any zone row to compare</span>
        </div>
        <div class="chart-wrap" style="height:200px"><canvas id="chart-deploy-radar"></canvas></div>
      </div>
      <div class="panel" style="flex:1">
        <div class="panel-header">
          <span class="panel-title"><i data-lucide="clock"></i> Payback Period by Zone</span>
          <span class="panel-sub">shortest = highest ROI · threshold: 36 months</span>
        </div>
        <div class="chart-wrap" style="height:200px"><canvas id="chart-deploy-payback"></canvas></div>
      </div>
    </section>`;

  refreshIcons();
  _renderDeployCharts(zoneData, PC_SOLID, PC_ALPHA, top.zone_id);
  _renderDeployTable(zoneData, PC_SOLID, null);
  _updateDeployMap(zoneData, PC_SOLID);

  // Bind scenario sliders
  ['dsc-atc','dsc-theft','dsc-growth','dsc-outage','dsc-budget'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseInt(el.value);
      const valEl = document.getElementById(`${id}-val`);
      if (id === 'dsc-budget') {
        STATE._deployBudget = v;
        if (valEl) valEl.textContent = `₹${v} Cr`;
      } else {
        const key = id.replace('dsc-','');
        STATE._deployWeights[key] = v / 100;
        if (valEl) valEl.textContent = `${v}%`;
      }
      const newZones = computeDeployZones(STATE._deployWeights);
      _renderDeployCharts(newZones, PC_SOLID, PC_ALPHA, newZones[0].zone_id);
      _renderDeployTable(newZones, PC_SOLID, null);
      _updateDeployMap(newZones, PC_SOLID);
      const kAfford = Math.min(12, Math.floor(STATE._deployBudget / METER_COST_CR));
      const topEl = document.querySelector('#lview-deploy .kpi-card:nth-child(2) .kpi-value');
      if (topEl) topEl.innerHTML = `${kAfford} <span style="font-size:12pt">/ 12</span>`;
    });
  });
}

function _renderDeployCharts(zoneData, PC_SOLID, PC_ALPHA, selectedZoneId) {
  // 4-quadrant bubble matrix
  const ctx1 = document.getElementById('chart-deploy-matrix');
  if (ctx1) {
    if (charts.deployMatrix) charts.deployMatrix.destroy();
    const QUAD_COLORS = { Critical: PC_ALPHA.Critical, High: PC_ALPHA.High, Medium: PC_ALPHA.Medium, Low: PC_ALPHA.Low };
    charts.deployMatrix = new Chart(ctx1, {
      type: 'bubble',
      data: {
        datasets: [{
          label: 'Zones',
          data: zoneData.map(z => ({
            x: parseFloat(z.ease.toFixed(3)),
            y: parseFloat(z.score.toFixed(3)),
            r: Math.max(9, Math.min(24, z.score * 28)),
            zone: z.zone_name, zoneId: z.zone_id,
            priority: z.priority, score: z.score,
            atc: z.atc_pct, payback: z.payback,
          })),
          backgroundColor: zoneData.map(z => z.zone_id === selectedZoneId ? 'rgba(99,102,241,0.92)' : QUAD_COLORS[z.priority]),
          borderColor: zoneData.map(z => z.zone_id === selectedZoneId ? '#818cf8' : PC_SOLID[z.priority]),
          borderWidth: zoneData.map(z => z.zone_id === selectedZoneId ? 2.5 : 1.5),
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { left: 8, right: 12, top: 8, bottom: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => [`${c.raw.zone} · Score ${(c.raw.score*100).toFixed(0)}/100`, `AT&C: ${c.raw.atc.toFixed(1)}% · Payback: ${c.raw.payback.toFixed(0)} mo`, `Priority: ${c.raw.priority}`] } },
          annotation: {},
        },
        onClick: (e, els) => {
          if (!els.length) return;
          const z = zoneData[els[0].index];
          _renderDeployTable(zoneData, PC_SOLID, z.zone_id);
          _renderDeployRadar(z);
          const titleEl = document.getElementById('deploy-radar-title');
          if (titleEl) titleEl.textContent = z.zone_name;
        },
        scales: {
          x: { min: 0, max: 1.05, title: { display: true, text: 'Ease of Deployment →', color: '#64748b', font: { size: 10 } }, ticks: { color: '#8899aa', font: { size: 9 } }, grid: { color: '#1e2d42' },
            afterDraw: (axis) => {
              const { ctx, chartArea } = axis.chart;
              const midX = axis.getPixelForValue(0.5);
              ctx.save(); ctx.strokeStyle = 'rgba(100,116,139,0.3)'; ctx.setLineDash([4,4]);
              ctx.beginPath(); ctx.moveTo(midX, chartArea.top); ctx.lineTo(midX, chartArea.bottom); ctx.stroke();
              ctx.restore();
            }
          },
          y: { min: 0, max: 1.05, title: { display: true, text: 'Impact Score →', color: '#64748b', font: { size: 10 } }, ticks: { color: '#8899aa', callback: v => `${(v*100).toFixed(0)}`, font: { size: 9 } }, grid: { color: '#1e2d42' },
            afterDraw: (axis) => {
              const { ctx, chartArea } = axis.chart;
              const midY = axis.getPixelForValue(0.5);
              ctx.save(); ctx.strokeStyle = 'rgba(100,116,139,0.3)'; ctx.setLineDash([4,4]);
              ctx.beginPath(); ctx.moveTo(chartArea.left, midY); ctx.lineTo(chartArea.right, midY); ctx.stroke();
              ctx.restore();
            }
          },
        },
      },
    });
  }

  // Radar chart for selected zone
  const selZone = zoneData.find(z => z.zone_id === selectedZoneId) || zoneData[0];
  _renderDeployRadar(selZone);

  // Payback bar (horizontal)
  const sorted = [...zoneData].sort((a, b) => a.payback - b.payback);
  const ctx3 = document.getElementById('chart-deploy-payback');
  if (ctx3) {
    if (charts.deployPayback) charts.deployPayback.destroy();
    charts.deployPayback = new Chart(ctx3, {
      type: 'bar',
      data: {
        labels: sorted.map(z => z.zone_name),
        datasets: [
          { label: 'Payback', data: sorted.map(z => parseFloat(z.payback.toFixed(1))),
            backgroundColor: sorted.map(z => z.payback <= 36 ? PC_ALPHA[z.priority] : 'rgba(100,116,139,0.45)'),
            borderColor: sorted.map(z => z.payback <= 36 ? PC_SOLID[z.priority] : '#64748b'),
            borderWidth: 1, borderRadius: 3, barPercentage: 0.65 },
          { label: '36-month threshold', data: sorted.map(() => 36),
            type: 'line', borderColor: '#f97316', borderDash: [5,3], borderWidth: 1.5,
            pointRadius: 0, fill: false },
        ],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        layout: { padding: { left: 4, right: 8, top: 4, bottom: 0 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => c.datasetIndex === 0 ? `${c.raw} months payback` : '36-month break-even' } },
        },
        scales: {
          x: { ticks: { color: '#8899aa', font: { size: 9 } }, grid: { color: '#1e2d42' } },
          y: { ticks: { color: '#cbd5e1', font: { size: 9 } }, grid: { display: false } },
        },
      },
    });
  }
}

function _renderDeployRadar(z) {
  const ctx = document.getElementById('chart-deploy-radar');
  if (!ctx) return;
  if (charts.deployRadar) charts.deployRadar.destroy();
  charts.deployRadar = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: ['AT&C Loss', 'Theft Risk', 'Revenue', 'Outage Freq', 'Future Growth', 'Density', 'Criticality'],
      datasets: [{
        label: z.zone_name,
        data: [
          parseFloat((z.atcScore * 100).toFixed(1)),
          parseFloat((z.theftScore * 100).toFixed(1)),
          parseFloat((z.revenueScore * 100).toFixed(1)),
          parseFloat((z.outageScore * 100).toFixed(1)),
          parseFloat((z.growthScore * 100).toFixed(1)),
          parseFloat((z.densityScore * 100).toFixed(1)),
          parseFloat((z.critScore * 100).toFixed(1)),
        ],
        borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.18)',
        borderWidth: 2, pointBackgroundColor: '#3b82f6', pointRadius: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 4, bottom: 4 } },
      plugins: { legend: { display: false } },
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { display: false },
          pointLabels: { color: '#94a3b8', font: { size: 9 } },
          grid: { color: '#1e2d42' },
          angleLines: { color: '#1e2d42' },
        },
      },
    },
  });
}

function _renderDeployTable(zoneData, PC_SOLID, highlightId) {
  const tbody = document.getElementById('deploy-table');
  if (!tbody) return;
  tbody.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:8.5pt">
    <thead><tr style="color:#64748b;border-bottom:1px solid #1e2d42;font-size:7.5pt;text-transform:uppercase;letter-spacing:0.5px">
      <th style="padding:4px 8px">#</th>
      <th style="padding:4px 8px;text-align:left">Zone</th>
      <th style="padding:4px 8px;text-align:right">Score</th>
      <th style="padding:4px 8px;text-align:right">AT&C</th>
      <th style="padding:4px 8px;text-align:right">Payback</th>
      <th style="padding:4px 8px;text-align:center">Tier</th>
    </tr></thead><tbody>
    ${zoneData.map((z, i) => {
      const hl = z.zone_id === highlightId ? 'background:rgba(59,130,246,0.10);' : '';
      return `<tr class="deploy-row" data-zone-id="${z.zone_id}" style="border-bottom:1px solid #0a1220;cursor:pointer;${hl}">
        <td style="padding:5px 8px;color:#64748b">${i+1}</td>
        <td style="padding:5px 8px;font-weight:600;color:#e2e8f0">${z.zone_name}</td>
        <td style="padding:5px 8px;text-align:right">
          <div style="display:flex;align-items:center;gap:5px;justify-content:flex-end">
            <div style="width:40px;height:4px;background:#1e2d42;border-radius:2px">
              <div style="width:${Math.round(z.score*100)}%;height:4px;background:${PC_SOLID[z.priority]};border-radius:2px"></div>
            </div>
            <span style="color:${PC_SOLID[z.priority]};font-weight:700">${(z.score*100).toFixed(0)}</span>
          </div>
        </td>
        <td style="padding:5px 8px;text-align:right;color:#ef4444">${z.atc_pct.toFixed(1)}%</td>
        <td style="padding:5px 8px;text-align:right;color:#94a3b8">${z.payback.toFixed(0)} mo</td>
        <td style="padding:5px 8px;text-align:center"><span style="background:${PC_SOLID[z.priority]}22;color:${PC_SOLID[z.priority]};border:1px solid ${PC_SOLID[z.priority]}55;padding:1px 7px;border-radius:999px;font-size:7.5pt;font-weight:700">${z.priority}</span></td>
      </tr>`;
    }).join('')}
    </tbody></table>`;

  // Bind row clicks
  tbody.querySelectorAll('.deploy-row').forEach(row => {
    row.addEventListener('click', () => {
      const z = zoneData.find(zz => zz.zone_id === row.dataset.zoneId);
      if (!z) return;
      const PC_SOLID2 = { Critical:'#ef4444', High:'#f97316', Medium:'#f59e0b', Low:'#10b981' };
      _renderDeployTable(zoneData, PC_SOLID2, z.zone_id);
      _renderDeployRadar(z);
      const titleEl = document.getElementById('deploy-radar-title');
      if (titleEl) titleEl.textContent = z.zone_name;
      // Show "Why Recommended?" panel
      const whyEl = document.getElementById('deploy-why');
      if (whyEl) {
        const reasons = _deployWhyReasons(z);
        whyEl.style.display = 'block';
        whyEl.innerHTML = `<div class="deploy-why-title"><i data-lucide="brain-circuit"></i> Why <b>${z.zone_name}</b> is recommended</div>
          <ul class="deploy-why-list">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>
          <div class="deploy-why-footer">Annual Recovery Potential: <b>₹${z.annualROI.toFixed(1)}L</b> · Score: <b>${(z.score*100).toFixed(0)}/100</b></div>`;
        refreshIcons();
      }
    });
  });
}

function _updateDeployMap(zoneData, PC_SOLID) {
  if (!mlMap) return;

  // Inject priority + score_label into the zone-bounds GeoJSON source
  // so MapLibre label/line expressions can reference them directly
  const fc = STATE.data.zoneBounds;
  if (fc && fc.features && mlMap.getSource('zone-bounds')) {
    const byId = Object.fromEntries(zoneData.map(z => [z.zone_id, z]));
    const enriched = {
      type: 'FeatureCollection',
      features: fc.features.map(f => {
        const z = byId[f.properties.zone_id];
        return {
          ...f,
          properties: {
            ...f.properties,
            zone_name:     f.properties.zone_name || f.properties.zone_id,
            priority:      z ? z.priority : 'Low',
            score_label:   z ? `${(z.score * 100).toFixed(0)}/100` : '–',
            priority_color: z ? PC_SOLID[z.priority] : '#64748b',
          },
        };
      }),
    };
    try { mlMap.getSource('zone-bounds').setData(enriched); } catch(e) {}
  }

  // Fill — priority color at high opacity
  const fillExpr = ['match', ['get', 'zone_id']];
  zoneData.forEach(z => { fillExpr.push(z.zone_id, PC_SOLID[z.priority]); });
  fillExpr.push('#64748b');

  // Line — solid, thick, same priority color
  const lineExpr = ['match', ['get', 'zone_id']];
  zoneData.forEach(z => { lineExpr.push(z.zone_id, PC_SOLID[z.priority]); });
  lineExpr.push('#64748b');

  try {
    mlMap.setPaintProperty('zone-bounds-fill', 'fill-color', fillExpr);
    mlMap.setPaintProperty('zone-bounds-fill', 'fill-opacity', 0.38);

    mlMap.setPaintProperty('zone-bounds-line', 'line-color', lineExpr);
    mlMap.setPaintProperty('zone-bounds-line', 'line-width', 2.8);
    mlMap.setPaintProperty('zone-bounds-line', 'line-opacity', 1);
    mlMap.setLayoutProperty('zone-bounds-line', 'line-cap', 'round');
    try { mlMap.setPaintProperty('zone-bounds-line', 'line-dasharray', null); } catch(_) {}

    // Label: zone name + score on second line
    mlMap.setLayoutProperty('zone-bounds-label', 'text-field',
      ['concat', ['get', 'zone_name'], '\n', ['get', 'score_label']]);
    mlMap.setLayoutProperty('zone-bounds-label', 'text-size', 10);
    mlMap.setPaintProperty('zone-bounds-label', 'text-color', '#ffffff');
    mlMap.setPaintProperty('zone-bounds-label', 'text-halo-color', '#0a1220');
    mlMap.setPaintProperty('zone-bounds-label', 'text-halo-width', 1.8);
    mlMap.setPaintProperty('zone-bounds-label', 'text-opacity', 1);
  } catch(e) {}
}

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
