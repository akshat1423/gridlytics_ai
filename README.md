# Gridlytics

> **Smart Meter Intelligence & Loss Detection Platform for BESCOM**
> Submission for **Theme 8** of the Bharat Bricks / IIT Bombay hackathon.

Gridlytics turns smart-meter data into actionable, explainable, decision-support intelligence for grid operators and inspection teams. It works as a non-intrusive analytics layer over existing infrastructure — no modifications to deployed meters or grid systems required.

**Live demo:** [gridlytics-ai.vercel.app](https://gridlytics-ai.vercel.app)

---

## What it does

### Local Mode (BESCOM, Bengaluru) — primary view

A tactical, full-bleed satellite dashboard styled after Delhi Kavach, with four sub-views:

1. **Meter Anomalies** — 576 synthetic 15-min smart meters across 12 BESCOM zones. Severity-scaled circle markers (Critical/High/Moderate/Low), real Bengaluru zone polygons, hover/click drives a floating right detail panel with a 24h consumption chart, SHAP attribution, causal reasoning chain, and an LLM-generated inspector brief.
2. **Zone Forecast** — 24h hourly demand prediction per zone with confidence bands, peak-load risk ranking, driver attribution (temperature / weekday / AC penetration / festival), and a sortable zone risk table.
3. **Inspector Queue** — sticky header with severity pill counts, monthly loss exposure, search bar, and severity + archetype filter chips. Each case is a rich card (rank, meter ID, archetype with custom icon, confidence bar, loss, recommended action) that opens the evidence drawer on click.
4. **What-If** — counterfactual scenario simulator with sliders for heatwave (+0…+8 °C), AC penetration (−20…+30 %), and a festival/weekend toggle. Live-updating system stress score, baseline vs scenario peak-load grouped bars, projected extra flagged meters, risk distribution shift, and a zone-by-zone delta table — all driven by a pre-computed scenario grid for instant interpolation.

### India Mode — macro context

The original DISCOM-level dashboard with tampering risk, AT&C trends, smart-meter deployment progress, ML anomaly detection, MLflow registry, and Sarvam-powered Hindi insights. Toggled from the right corner of the header.

### Map style toggle

Tactical (default), B&W, NVG (green night vision), and Natural — applied as CSS filters over the Esri World Imagery satellite tiles.

---

## Stack

| Concern | Choice |
| --- | --- |
| **3D satellite map** (Local) | MapLibre GL JS v4 + Esri World Imagery tiles, pitch 55°, bearing −12° |
| **2D map** (India) | Leaflet 1.9 + CartoDB dark tiles + India state GeoJSON |
| **Charts** | Chart.js v4 |
| **Icons** | Lucide v0.460 (open-source SVG, no emojis) |
| **Data** | Pre-generated JSON snapshots served as static `/api/*` files |
| **Frontend** | Plain HTML / CSS / vanilla JS — no framework, no build step |
| **Hosting** | Vercel (static) |
| **Synthetic data generator** | Python 3 (`data/generate_bescom_meters.py`) |
| **Real anchors** | BESCOM AT&C 12.2 % (CARE Ratings 2024), 30 600 meters deployed Feb 2025 (RDSS), iREDS / iAWE residential profiles, ASTESJ theft archetypes |

The project deliberately avoids Databricks-specific dependencies — everything runs as plain Python + a static frontend.

---

## Run it locally

### Option 1: Just the static frontend (fastest)

No dependencies — Python's built-in HTTP server serves the entire app:

```bash
cd /path/to/gridlytics
python3 -m http.server 8080
```

Open <http://localhost:8080> in your browser. The app loads all data from the bundled `/api/*` JSON files; no backend needed.

### Option 2: Re-generate synthetic data

If you want to tweak the synthetic data (zone count, meter count, theft prevalence, etc.) before serving:

```bash
cd /path/to/gridlytics
python3 data/generate_bescom_meters.py
```

This rewrites the JSON files under `api/`:

- `meters` — 576 synthetic 15-min smart meters across 12 zones (~282 KB)
- `feeders` — 48 synthetic feeders with mass-balance gaps (~10 KB)
- `zone-forecasts` — 24h hourly demand forecast per zone (~26 KB)
- `evidence-packets` — full evidence (24h chart, SHAP, causal chain, AI brief) for every flagged meter (~495 KB)
- `whatif-scenarios` — 60 pre-computed counterfactual scenarios (~113 KB)
- `zone-boundaries` — GeoJSON polygons for the 12 Bengaluru zones (~3 KB)

Then start the server as in Option 1.

### Option 3: Deploy to Vercel

1. Push the project to a GitHub repo.
2. Go to <https://vercel.com/new> → **Import** the repo.
3. Settings: **Framework Preset = Other**, **Build Command = (leave empty)**, **Output Directory = `./`**.
4. Click **Deploy**. Live in ~30 s.

The included `vercel.json` already configures the JSON content-type headers, CORS, and a couple of route rewrites.

---

## Project structure

```
gridlytics/
├── index.html                 # Single-page entry, loads Leaflet + MapLibre + Chart.js + Lucide
├── app.js                     # All app logic (~3.5k lines, no framework)
├── style.css                  # Tactical UI styling, including all overlays
├── vercel.json                # Static deploy config (headers, rewrites)
├── package.json               # Marker only — no JS build, no node_modules
├── README.md                  # This file
├── api/                       # Pre-built JSON snapshots (the "backend")
│   ├── meters
│   ├── feeders
│   ├── zone-forecasts
│   ├── evidence-packets
│   ├── whatif-scenarios
│   ├── zone-boundaries
│   ├── intelligence           # India mode — DISCOM-level
│   ├── atc                    # India mode — AT&C trend
│   ├── arbitrage              # India mode
│   └── …
└── data/
    └── generate_bescom_meters.py   # Synthetic data generator (run once)
```

`app.js` is intentionally framework-free for portability and so judges can read it linearly. It is organised top-down:

1. Global state + helpers (formatters, API fetcher)
2. Leaflet `initMap` + India-mode rendering (markers, choropleth, drawer)
3. MapLibre `initMapLibre` + Local-mode rendering (sources, circle/fill/symbol layers, hover/click handlers)
4. Mode + sub-view switching (`switchDashboardMode`, `applyLocalSubView`, `switchLocalView`)
5. Right detail panel renderers (`updateDetailPanelForMeter`, `updateDetailPanelForZone`)
6. Sub-view renderers (`renderZoneForecastView`, `renderMeterAnomalyView`, `renderInspectorQueue`, `updateWhatIfScenario`)
7. Boot sequence (`boot`) — triggered on `DOMContentLoaded`

---

## Where the numbers come from

- **BESCOM AT&C loss FY24: 12.2 %** — CARE Ratings press release, July 2024.
- **30 600 smart meters deployed (Feb 2025), rollout under RDSS** — Ministry of Power coverage.
- **4 zones / 9 circles / 32 divisions / 147 sub-divisions / 534 section offices** — BESCOM official RTI Section 4(1)(A) page.
- **Peak hours 6 PM – 10 PM** — BESCOM advisory.
- **Residential 15-min profile shape** — adapted from iREDS (IIT Bombay) and iAWE (IIIT Delhi) public datasets.
- **Theft signatures (LT bypass / magnetic tamper / neutral bypass / billing-category mismatch)** — ASTESJ 2019, Bidgely whitepapers.
- **Per-meter consumption, theft injection, and confidence scores are synthetic** — clearly labelled as such throughout the UI; calibrated against the real anchors above.

No real BESCOM consumer data is included in the project — none is publicly available.

---

## Browser support

Tested on the latest Chrome, Safari, and Firefox. WebGL is required (MapLibre GL). Desktop only — the layout is intentionally not responsive for the demo.

---

## License

Hackathon submission — feel free to read and learn from the code. Not packaged for production use.

---

## Credits

- Map tiles: Esri World Imagery, Esri Boundaries & Places, CartoDB dark
- Icons: Lucide
- Charting: Chart.js
- 3D map: MapLibre GL JS
- 2D map: Leaflet
