#!/usr/bin/env python3
"""
BESCOM Synthetic Smart-Meter Data Generator
============================================
Generates realistic 15-min interval consumption data for 600 synthetic meters
across 12 Bengaluru zones. Injects 5% theft cases across 4 archetypes.

Real anchors:
- BESCOM AT&C loss FY24: 12.2% (CARE Ratings, Jul 2024)
- 4 zones / 9 circles / 32 divisions (BESCOM official)
- Peak hours 6PM-10PM (BESCOM advisory)
- Profile shapes informed by iREDS (IIT Bombay), iAWE (IIIT Delhi)
- Theft signatures: ASTESJ 2019, Bidgely

Outputs 5 JSON snapshots to /tmp/gridlytics-build/api/:
- meters, feeders, zone-forecasts, evidence-packets, whatif-scenarios
"""

import json
import math
import os
import random
from datetime import datetime, timedelta
from pathlib import Path

random.seed(42)  # reproducible

OUT_DIR = Path("/tmp/gridlytics-build/api")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ─── Bengaluru zones (real BESCOM division names + approx lat/lon) ────────────
ZONES = [
    {"id": "Z01", "name": "Indiranagar",     "lat": 12.9719, "lon": 77.6412, "type": "urban_core",   "atc_pct": 9.2,  "ac_pen": 0.42, "meters": 50},
    {"id": "Z02", "name": "Koramangala",     "lat": 12.9352, "lon": 77.6245, "type": "urban_core",   "atc_pct": 8.8,  "ac_pen": 0.45, "meters": 50},
    {"id": "Z03", "name": "HSR Layout",      "lat": 12.9116, "lon": 77.6473, "type": "urban_core",   "atc_pct": 8.5,  "ac_pen": 0.48, "meters": 50},
    {"id": "Z04", "name": "Jayanagar",       "lat": 12.9250, "lon": 77.5938, "type": "urban_mid",    "atc_pct": 10.5, "ac_pen": 0.30, "meters": 50},
    {"id": "Z05", "name": "Rajajinagar",     "lat": 12.9911, "lon": 77.5550, "type": "urban_mid",    "atc_pct": 11.2, "ac_pen": 0.26, "meters": 50},
    {"id": "Z06", "name": "Malleswaram",     "lat": 13.0035, "lon": 77.5709, "type": "urban_mid",    "atc_pct": 10.8, "ac_pen": 0.28, "meters": 50},
    {"id": "Z07", "name": "Whitefield",      "lat": 12.9698, "lon": 77.7500, "type": "tech_hub",     "atc_pct": 9.5,  "ac_pen": 0.55, "meters": 50},
    {"id": "Z08", "name": "Electronic City", "lat": 12.8452, "lon": 77.6602, "type": "tech_hub",     "atc_pct": 10.1, "ac_pen": 0.52, "meters": 50},
    {"id": "Z09", "name": "Marathahalli",    "lat": 12.9591, "lon": 77.6974, "type": "tech_hub",     "atc_pct": 11.0, "ac_pen": 0.48, "meters": 50},
    {"id": "Z10", "name": "Yelahanka",       "lat": 13.1007, "lon": 77.5963, "type": "peri_urban",   "atc_pct": 18.5, "ac_pen": 0.18, "meters": 50},
    {"id": "Z11", "name": "Hebbal",          "lat": 13.0358, "lon": 77.5970, "type": "peri_urban",   "atc_pct": 15.8, "ac_pen": 0.22, "meters": 50},
    {"id": "Z12", "name": "Peenya",          "lat": 13.0285, "lon": 77.5200, "type": "industrial",   "atc_pct": 21.4, "ac_pen": 0.15, "meters": 50},
]
TOTAL_METERS = sum(z["meters"] for z in ZONES)  # 600

# Realistic neighborhood polygons (lat, lon vertices) approximated from
# OpenStreetMap admin / suburb extents and BBMP ward layouts. Each polygon
# follows the actual elongated/rectangular shape of the named area in Bengaluru.
ZONE_BOUNDARIES = {
    "Z01": [  # Indiranagar — bounded by Old Madras Rd (N), CMH Rd (E), 100 Ft Rd, Old Airport Rd (S)
        [12.9883, 77.6300], [12.9890, 77.6480], [12.9810, 77.6555],
        [12.9650, 77.6520], [12.9600, 77.6360], [12.9700, 77.6280]
    ],
    "Z02": [  # Koramangala — 1-8 blocks
        [12.9510, 77.6090], [12.9530, 77.6280], [12.9430, 77.6400],
        [12.9215, 77.6380], [12.9180, 77.6220], [12.9290, 77.6090]
    ],
    "Z03": [  # HSR Layout — sectors 1-7
        [12.9260, 77.6320], [12.9280, 77.6580], [12.9180, 77.6680],
        [12.8960, 77.6650], [12.8930, 77.6450], [12.9070, 77.6320]
    ],
    "Z04": [  # Jayanagar — blocks 1-9 + JP Nagar fringe
        [12.9430, 77.5790], [12.9450, 77.6020], [12.9320, 77.6120],
        [12.9080, 77.6080], [12.9060, 77.5880], [12.9220, 77.5760]
    ],
    "Z05": [  # Rajajinagar — blocks 1-6 + WOC Rd
        [13.0080, 77.5400], [13.0100, 77.5680], [12.9970, 77.5760],
        [12.9760, 77.5710], [12.9740, 77.5500], [12.9890, 77.5380]
    ],
    "Z06": [  # Malleswaram — 1st-18th cross + Sampige
        [13.0180, 77.5560], [13.0200, 77.5810], [13.0100, 77.5880],
        [12.9920, 77.5840], [12.9890, 77.5660], [13.0010, 77.5530]
    ],
    "Z07": [  # Whitefield — Hope Farm to ITPL + Sarjapur boundary
        [12.9920, 77.7250], [12.9960, 77.7670], [12.9810, 77.7800],
        [12.9510, 77.7720], [12.9460, 77.7440], [12.9650, 77.7240]
    ],
    "Z08": [  # Electronic City — phases 1-4 + Hosa Road
        [12.8650, 77.6380], [12.8680, 77.6740], [12.8530, 77.6850],
        [12.8260, 77.6790], [12.8220, 77.6500], [12.8390, 77.6360]
    ],
    "Z09": [  # Marathahalli — Outer Ring Rd to KR Puram fringe
        [12.9780, 77.6800], [12.9810, 77.7150], [12.9680, 77.7220],
        [12.9430, 77.7140], [12.9400, 77.6890], [12.9560, 77.6770]
    ],
    "Z10": [  # Yelahanka — old town + new town + Doddaballapur Rd
        [13.1230, 77.5750], [13.1290, 77.6180], [13.1100, 77.6310],
        [13.0780, 77.6230], [13.0750, 77.5870], [13.0950, 77.5710]
    ],
    "Z11": [  # Hebbal — Outer Ring Rd, Manyata, Kempapura
        [13.0560, 77.5750], [13.0600, 77.6190], [13.0470, 77.6300],
        [13.0190, 77.6230], [13.0140, 77.5860], [13.0320, 77.5710]
    ],
    "Z12": [  # Peenya — industrial belt + Yeshwanthpur fringe
        [13.0500, 77.4970], [13.0540, 77.5390], [13.0410, 77.5470],
        [13.0100, 77.5410], [13.0080, 77.5070], [13.0260, 77.4930]
    ],
}

# ─── Theft archetypes (ASTESJ 2019, Bidgely) ──────────────────────────────────
THEFT_ARCHETYPES = [
    {"id": "lt_bypass",        "label": "LT Bypass",        "prob": 0.40, "desc": "Direct hooking from LT line — feeder mass-balance gap"},
    {"id": "magnetic_tamper",  "label": "Magnetic Tamper",  "prob": 0.30, "desc": "Sudden flat-line / 30-80% drop with no lifestyle change"},
    {"id": "neutral_bypass",   "label": "Neutral Bypass",   "prob": 0.18, "desc": "Phase-vs-neutral current mismatch; reverse wiring"},
    {"id": "billing_mismatch", "label": "Billing Mismatch", "prob": 0.12, "desc": "Commercial usage on residential tariff (cat-mismatch)"},
]

CONSUMER_CATEGORIES = [
    {"id": "RES_LT", "label": "Residential LT", "prob": 0.65, "base_kwh": 0.35},
    {"id": "RES_HT", "label": "Residential HT", "prob": 0.10, "base_kwh": 0.80},
    {"id": "COM_LT", "label": "Commercial LT",  "prob": 0.18, "base_kwh": 1.20},
    {"id": "COM_HT", "label": "Commercial HT",  "prob": 0.05, "base_kwh": 3.50},
    {"id": "IND_HT", "label": "Industrial HT",  "prob": 0.02, "base_kwh": 8.00},
]

# ─── Helpers ──────────────────────────────────────────────────────────────────
def pick_weighted(items, key="prob"):
    r = random.random()
    cum = 0.0
    for it in items:
        cum += it[key]
        if r <= cum:
            return it
    return items[-1]

def daily_load_curve(hour, category, ac_pen, weekend=False):
    """Realistic 24h load shape (kW) for residential/commercial/industrial."""
    h = hour
    if category in ("RES_LT", "RES_HT"):
        # Residential: morning peak 7-9, dip midday, evening peak 18-22
        morning = math.exp(-((h - 8) ** 2) / 4) * 1.2
        evening = math.exp(-((h - 20) ** 2) / 6) * 2.5
        base = 0.25
        ac_load = ac_pen * (math.exp(-((h - 14) ** 2) / 25) * 0.8 + math.exp(-((h - 22) ** 2) / 8) * 1.5)
        load = base + morning + evening + ac_load
        if weekend:
            load *= 0.92
    elif category in ("COM_LT", "COM_HT"):
        # Commercial: 9-6 working hours, low at night
        if 9 <= h <= 18:
            load = 1.5 + math.sin((h - 9) / 9 * math.pi) * 1.0 + ac_pen * 1.2
        else:
            load = 0.3
        if weekend:
            load *= 0.45
    else:  # Industrial: 24/7 baseload + shifts
        load = 4.0 + math.sin(h / 24 * 2 * math.pi) * 0.8
        if weekend:
            load *= 0.75
    return max(0.05, load)

def inject_theft(curves, archetype, meter_id):
    """Mutate a 24h curve based on theft type. Returns mutation flag."""
    if archetype == "lt_bypass":
        # Drops 40-70% across the board
        factor = random.uniform(0.30, 0.60)
        return [c * factor for c in curves]
    elif archetype == "magnetic_tamper":
        # Sharp flat-line during peak hours
        return [min(c, 0.4) if 18 <= i < 23 else c for i, c in enumerate(curves)]
    elif archetype == "neutral_bypass":
        # Random 35-50% reduction
        factor = random.uniform(0.50, 0.65)
        return [c * factor for c in curves]
    elif archetype == "billing_mismatch":
        # Commercial usage pattern but on residential tariff (much higher)
        return [c * random.uniform(2.5, 4.0) for c in curves]
    return curves

# ─── Generate meters ──────────────────────────────────────────────────────────
def generate_meters():
    meters = []
    feeder_counter = 0
    feeders_meta = {}  # feeder_id -> aggregate

    for zone in ZONES:
        # 4-5 feeders per zone (~10 meters each)
        n_feeders = 4 if zone["meters"] <= 50 else 5
        meters_per_feeder = zone["meters"] // n_feeders

        for f in range(n_feeders):
            feeder_counter += 1
            feeder_id = f"FDR-{zone['id']}-{f+1:02d}"
            feeders_meta[feeder_id] = {
                "feeder_id": feeder_id,
                "zone_id": zone["id"],
                "zone_name": zone["name"],
                "lat": zone["lat"] + random.uniform(-0.015, 0.015),
                "lon": zone["lon"] + random.uniform(-0.015, 0.015),
                "total_meters": 0,
                "declared_kwh": 0.0,
                "sum_meter_kwh": 0.0,
                "loss_pct": 0.0,
                "theft_score": 0,
            }

            for m in range(meters_per_feeder):
                meter_id = f"BSC-{zone['id']}-{f+1:02d}-{m+1:03d}"
                category = pick_weighted(CONSUMER_CATEGORIES)

                # 5% theft probability, weighted higher in peri-urban / industrial zones
                theft_boost = 1.0 if zone["type"] in ("urban_core", "tech_hub") else 2.5
                is_theft = random.random() < (0.05 * theft_boost)
                archetype = pick_weighted(THEFT_ARCHETYPES) if is_theft else None

                # Compute 24h average kWh
                hourly = [daily_load_curve(h, category["id"], zone["ac_pen"]) for h in range(24)]
                if archetype:
                    hourly = inject_theft(hourly, archetype["id"], meter_id)
                avg_kw = sum(hourly) / 24
                last_24h_kwh = avg_kw * 24

                # Anomaly score (0-100): higher = more suspicious
                if archetype:
                    anomaly_score = random.randint(72, 98)
                    severity = "Critical" if anomaly_score > 88 else "High" if anomaly_score > 80 else "Moderate"
                else:
                    anomaly_score = random.randint(2, 35)
                    severity = "Low"

                meter = {
                    "meter_id": meter_id,
                    "feeder_id": feeder_id,
                    "zone_id": zone["id"],
                    "zone_name": zone["name"],
                    "lat": zone["lat"] + random.uniform(-0.018, 0.018),
                    "lon": zone["lon"] + random.uniform(-0.018, 0.018),
                    "category": category["id"],
                    "category_label": category["label"],
                    "is_theft": bool(archetype),
                    "theft_archetype": archetype["id"] if archetype else None,
                    "theft_label": archetype["label"] if archetype else None,
                    "anomaly_score": anomaly_score,
                    "severity": severity,
                    "last_24h_kwh": round(last_24h_kwh, 2),
                    "avg_load_kw": round(avg_kw, 3),
                    "peer_cohort": f"COH-{category['id']}-{zone['type']}",
                    "monthly_kwh": round(last_24h_kwh * 30, 1),
                    "tariff_category": category["label"],
                    "tampering_label": severity,
                    "tampering_index": anomaly_score,
                    "est_revenue_loss_inr": round(last_24h_kwh * 30 * 7.5 * (1.0 if archetype else 0.0), 0),
                }
                meters.append(meter)

                # Aggregate to feeder
                feeders_meta[feeder_id]["total_meters"] += 1
                feeders_meta[feeder_id]["sum_meter_kwh"] += last_24h_kwh

    # Compute feeder mass-balance: declared = sum × (1 + true_loss%)
    # Inject mass-balance gap for feeders with theft meters
    for fid, fdr in feeders_meta.items():
        zone_atc = next(z["atc_pct"] for z in ZONES if z["id"] == fdr["zone_id"])
        zone_meters_in_feeder = [m for m in meters if m["feeder_id"] == fid]
        n_theft = sum(1 for m in zone_meters_in_feeder if m["is_theft"])
        # Declared kWh = sum + technical losses (8.5%) + non-technical (theft) shortfall
        ntl_pct = (zone_atc - 8.5) / 100
        declared = fdr["sum_meter_kwh"] / max(0.01, 1.0 - 0.085)  # tech loss adjustment
        declared *= (1 + ntl_pct + (n_theft * 0.015))  # theft adds gap
        fdr["declared_kwh"] = round(declared, 1)
        fdr["sum_meter_kwh"] = round(fdr["sum_meter_kwh"], 1)
        fdr["loss_pct"] = round((declared - fdr["sum_meter_kwh"]) / declared * 100, 2)
        fdr["theft_score"] = min(100, int(n_theft * 22 + ntl_pct * 100))

    feeders = list(feeders_meta.values())
    return meters, feeders

# ─── Zone-level demand forecast ───────────────────────────────────────────────
def generate_zone_forecasts(meters):
    """24h hourly forecast per zone with confidence bands and driver attribution."""
    zones_out = []
    for zone in ZONES:
        zone_meters = [m for m in meters if m["zone_id"] == zone["id"]]
        # Aggregate avg load × meters → MW
        total_load_kw = sum(m["avg_load_kw"] for m in zone_meters)

        hourly = []
        for h in range(24):
            base = sum(daily_load_curve(h, m["category"], zone["ac_pen"])
                       for m in zone_meters)
            # Convert to MW with realistic upscaling (each meter represents ~500 households)
            mw = base * 500 / 1000
            hourly.append({
                "hour": h,
                "predicted_mw": round(mw, 2),
                "confidence_low": round(mw * 0.88, 2),
                "confidence_high": round(mw * 1.12, 2),
            })

        peak = max(hourly, key=lambda x: x["predicted_mw"])
        peak_mw = peak["predicted_mw"]

        # Risk classification
        if peak_mw > 4.0:
            risk = "Critical"
        elif peak_mw > 3.0:
            risk = "High"
        elif peak_mw > 2.0:
            risk = "Moderate"
        else:
            risk = "Low"

        # Driver attribution (synthetic but realistic)
        drivers = {
            "temperature": round(0.50 + zone["ac_pen"] * 0.4, 2),
            "weekday_pattern": round(0.20 - zone["ac_pen"] * 0.05, 2),
            "ac_penetration": round(zone["ac_pen"] * 0.6, 2),
            "festival_boost": 0.05,
        }
        # Normalize
        s = sum(drivers.values())
        drivers = {k: round(v / s, 3) for k, v in drivers.items()}

        zones_out.append({
            "zone_id": zone["id"],
            "zone_name": zone["name"],
            "lat": zone["lat"],
            "lon": zone["lon"],
            "type": zone["type"],
            "peak_mw": peak_mw,
            "peak_hour": peak["hour"],
            "avg_mw": round(sum(h["predicted_mw"] for h in hourly) / 24, 2),
            "risk_level": risk,
            "atc_pct": zone["atc_pct"],
            "ac_penetration": zone["ac_pen"],
            "drivers": drivers,
            "hourly_forecast": hourly,
            "n_meters": len(zone_meters),
            "n_flagged": sum(1 for m in zone_meters if m["is_theft"]),
        })
    return zones_out

# ─── Evidence packets (top 20 flagged meters) ─────────────────────────────────
def generate_evidence_packets(meters):
    """Generate inspector-ready evidence packets for ALL flagged meters
    (Critical + High + Moderate) so every dot in the map has the same rich detail."""
    flagged = sorted([m for m in meters if m["is_theft"]],
                     key=lambda x: -x["anomaly_score"])

    packets = []
    for m in flagged:
        # Reconstruct 7-day 15-min time-series (672 points)
        # Show baseline + observed for chart rendering
        baseline_24h = [daily_load_curve(h, m["category"], 0.3) for h in range(24)]
        observed_24h = inject_theft(baseline_24h.copy(), m["theft_archetype"], m["meter_id"])

        # 7-day series (peer baseline shape × 7 + observed × 7) at 15-min = 96 points/day
        peer_15min, observed_15min = [], []
        for day in range(7):
            for h in range(24):
                for q in range(4):  # 4 × 15-min per hour
                    interp = q / 4.0
                    h_next = (h + 1) % 24
                    p = baseline_24h[h] * (1 - interp) + baseline_24h[h_next] * interp
                    o = observed_24h[h] * (1 - interp) + observed_24h[h_next] * interp
                    # Add small noise
                    peer_15min.append(round(p * random.uniform(0.92, 1.08), 3))
                    observed_15min.append(round(o * random.uniform(0.92, 1.08), 3))

        # SHAP-style feature attribution
        shap_features = []
        if m["theft_archetype"] == "lt_bypass":
            shap_features = [
                {"feature": "Feeder mass-balance gap", "impact": 0.42},
                {"feature": "Consumption vs peer cohort", "impact": 0.31},
                {"feature": "Day/night ratio", "impact": -0.08},
                {"feature": "Weather correlation", "impact": -0.19},
            ]
        elif m["theft_archetype"] == "magnetic_tamper":
            shap_features = [
                {"feature": "Peak-hour flatlining", "impact": 0.38},
                {"feature": "Sudden load drop event", "impact": 0.35},
                {"feature": "Tamper-event flag count", "impact": 0.18},
                {"feature": "Historical baseline deviation", "impact": -0.09},
            ]
        elif m["theft_archetype"] == "neutral_bypass":
            shap_features = [
                {"feature": "Phase-neutral imbalance", "impact": 0.44},
                {"feature": "Reverse-wiring indicator", "impact": 0.28},
                {"feature": "Power factor anomaly", "impact": 0.22},
                {"feature": "Peer cohort deviation", "impact": -0.06},
            ]
        else:  # billing_mismatch
            shap_features = [
                {"feature": "Tariff category mismatch", "impact": 0.46},
                {"feature": "Weekday usage profile", "impact": 0.27},
                {"feature": "Load factor vs sanctioned", "impact": 0.21},
                {"feature": "Peer cohort deviation", "impact": -0.06},
            ]

        # Causal reasoning chain
        causal_chain = []
        if m["theft_archetype"] == "lt_bypass":
            causal_chain = [
                f"Feeder {m['feeder_id']} shows 12.3% mass-balance gap (declared vs metered)",
                "No concurrent power outage, no maintenance event in window",
                f"Meter consumption is 47% below peer cohort {m['peer_cohort']} for same category",
                "Pattern persisted across 14 of last 21 days — not vacation/seasonal",
                "Conclusion: high probability of LT-line bypass connection",
            ]
        elif m["theft_archetype"] == "magnetic_tamper":
            causal_chain = [
                f"Sharp consumption flatline detected during 6PM-10PM peak window",
                "Magnetic tamper event flag triggered 3 times in last 30 days",
                "Drop of 65% during peak with no proportional drop off-peak",
                "Inconsistent with appliance failure (would affect off-peak too)",
                "Conclusion: strong indication of magnetic meter tampering",
            ]
        elif m["theft_archetype"] == "neutral_bypass":
            causal_chain = [
                "Phase-neutral current imbalance >18% (threshold 5%)",
                "Power factor recorded at 0.62 — abnormal for residential load",
                f"Consumption 38% below peer cohort {m['peer_cohort']}",
                "Reverse-wiring smart-meter event flag raised twice this month",
                "Conclusion: probable neutral bypass / reverse wiring tampering",
            ]
        else:
            causal_chain = [
                f"Tariff category recorded as {m['category_label']}",
                f"Load profile matches commercial pattern (9AM-6PM heavy use)",
                f"Monthly kWh ({m['monthly_kwh']:.0f}) exceeds residential bracket by 3.2x",
                "Power factor and load factor consistent with commercial premise",
                "Conclusion: residential tariff applied to commercial-pattern usage",
            ]

        # LLM-generated brief (pre-rendered locally for demo)
        brief_templates = {
            "lt_bypass": (
                f"Meter {m['meter_id']} in {m['zone_name']} (consumer cat: {m['category_label']}) "
                f"shows clear LT-bypass signatures. Feeder mass-balance gap of 12.3% combined with "
                f"47% consumption shortfall versus peer cohort suggests direct hooking. "
                f"Estimated revenue loss: ₹{int(m['est_revenue_loss_inr']):,}/month. "
                f"Recommend immediate field inspection of LT line near premise."
            ),
            "magnetic_tamper": (
                f"Meter {m['meter_id']} in {m['zone_name']} exhibits classic magnetic-tampering "
                f"profile: sharp peak-hour flatlining with normal off-peak consumption. "
                f"Tamper-event flag triggered 3x in last 30 days. "
                f"Estimated monthly revenue loss: ₹{int(m['est_revenue_loss_inr']):,}. "
                f"Recommend physical seal verification and meter replacement."
            ),
            "neutral_bypass": (
                f"Meter {m['meter_id']} in {m['zone_name']} shows phase-neutral current imbalance "
                f"of 18% with abnormal power factor (0.62). Consistent with reverse-wiring tampering. "
                f"Estimated monthly revenue loss: ₹{int(m['est_revenue_loss_inr']):,}. "
                f"Recommend wiring inspection and power-quality logger deployment."
            ),
            "billing_mismatch": (
                f"Meter {m['meter_id']} in {m['zone_name']} is billed as residential but exhibits "
                f"commercial load patterns (9AM-6PM heavy use, monthly kWh 3.2x residential bracket). "
                f"Estimated monthly revenue gap: ₹{int(m['est_revenue_loss_inr']):,}. "
                f"Recommend tariff-category audit and consumer site visit."
            ),
        }

        # Recommended action
        action_map = {
            "lt_bypass": "Field inspection — LT line trace",
            "magnetic_tamper": "Meter replacement + seal verification",
            "neutral_bypass": "Wiring inspection + PQ logger",
            "billing_mismatch": "Tariff category re-audit",
        }

        packets.append({
            "meter_id": m["meter_id"],
            "zone_name": m["zone_name"],
            "feeder_id": m["feeder_id"],
            "category_label": m["category_label"],
            "anomaly_score": m["anomaly_score"],
            "severity": m["severity"],
            "theft_archetype": m["theft_archetype"],
            "theft_label": m["theft_label"],
            "est_revenue_loss_inr": m["est_revenue_loss_inr"],
            "lat": m["lat"],
            "lon": m["lon"],
            "shap_features": shap_features,
            "causal_chain": causal_chain,
            "llm_brief": brief_templates[m["theft_archetype"]],
            "recommended_action": action_map[m["theft_archetype"]],
            "confidence_pct": round(min(99, m["anomaly_score"] + random.randint(0, 5)), 1),
            "peer_baseline_kw_15min": peer_15min,
            "observed_kw_15min": observed_15min,
        })

    return packets

# ─── What-If counterfactual scenarios ─────────────────────────────────────────
def generate_whatif_scenarios(zone_forecasts):
    """Pre-computed scenario grid for instant slider interpolation in frontend."""
    scenarios = []
    # Heatwave deltas: 0, 2, 4, 6, 8 °C
    # AC penetration deltas: -0.2, -0.1, 0, 0.1, 0.2, 0.3
    # Festival flag: True/False
    for heat_delta in [0, 2, 4, 6, 8]:
        for ac_delta in [-0.2, -0.1, 0, 0.1, 0.2, 0.3]:
            for festival in [False, True]:
                scenario_zones = []
                for zf in zone_forecasts:
                    # Heatwave amplifies AC load
                    heat_factor = 1.0 + (heat_delta / 8.0) * 0.35
                    # AC penetration shift
                    ac_factor = 1.0 + (ac_delta * 0.6)
                    # Festival adds 12-18% load
                    fest_factor = 1.15 if festival else 1.0

                    baseline_peak = zf["peak_mw"]
                    new_peak_mw = round(baseline_peak * heat_factor * ac_factor * fest_factor, 2)
                    delta_mw = round(new_peak_mw - baseline_peak, 2)

                    # Risk thresholds — calibrated against typical zone peaks (1.5-5 MW range)
                    if new_peak_mw > 4.5:
                        risk = "Critical"
                    elif new_peak_mw > 3.2:
                        risk = "High"
                    elif new_peak_mw > 2.0:
                        risk = "Moderate"
                    else:
                        risk = "Low"

                    # Project additional flagged meters from heat-stress + AC overrun signatures.
                    # Calibrated to give 0–8 extra flags per zone depending on conditions.
                    stress_score = (heat_delta / 8.0) * 0.6 + max(0, ac_delta) * 1.2 + (0.25 if festival else 0)
                    base = zf["n_meters"] * 0.08 * stress_score
                    extra_flagged = int(round(base + (random.random() * 1.5 if base > 0.5 else 0)))

                    scenario_zones.append({
                        "zone_id": zf["zone_id"],
                        "zone_name": zf["zone_name"],
                        "lat": zf["lat"],
                        "lon": zf["lon"],
                        "peak_mw": new_peak_mw,
                        "baseline_mw": baseline_peak,
                        "delta_mw": delta_mw,
                        "risk_level": risk,
                        "baseline_risk": zf["risk_level"],
                        "extra_flagged": extra_flagged,
                    })

                # Generate narrative
                peak_zone = max(scenario_zones, key=lambda z: z["peak_mw"])
                total_extra = sum(z["extra_flagged"] for z in scenario_zones)

                if heat_delta == 0 and ac_delta == 0 and not festival:
                    narrative = "Baseline scenario: no change from current forecast."
                else:
                    parts = []
                    if heat_delta > 0:
                        parts.append(f"a heatwave of +{heat_delta}°C")
                    if ac_delta != 0:
                        parts.append(f"AC penetration {'+' if ac_delta > 0 else ''}{int(ac_delta*100)}%")
                    if festival:
                        parts.append("festival load")
                    cond = " and ".join(parts) if parts else "no major changes"
                    narrative = (
                        f"Under {cond}, {peak_zone['zone_name']} crosses {peak_zone['peak_mw']} MW peak load. "
                        f"{total_extra} additional meters projected to show patterns consistent with bypass theft "
                        f"(likely AC-on-tariff-mismatch and capacity-overrun signatures)."
                    )

                scenarios.append({
                    "key": f"h{heat_delta}_a{int(ac_delta*100)}_f{int(festival)}",
                    "heat_delta": heat_delta,
                    "ac_delta": ac_delta,
                    "festival": festival,
                    "zones": scenario_zones,
                    "peak_zone": peak_zone["zone_name"],
                    "peak_mw": peak_zone["peak_mw"],
                    "total_extra_flagged": total_extra,
                    "narrative": narrative,
                })
    return scenarios

# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    print(f"📊 Generating BESCOM synthetic data for {TOTAL_METERS} meters across {len(ZONES)} zones...")

    print("  → Generating meters + feeders...")
    meters, feeders = generate_meters()
    print(f"     {len(meters)} meters, {len(feeders)} feeders, {sum(1 for m in meters if m['is_theft'])} flagged")

    print("  → Generating zone-level forecasts...")
    zone_forecasts = generate_zone_forecasts(meters)
    print(f"     {len(zone_forecasts)} zones with 24h forecasts")

    print("  → Generating evidence packets (top 20)...")
    evidence_packets = generate_evidence_packets(meters)
    print(f"     {len(evidence_packets)} packets with SHAP + causal chains + LLM briefs")

    print("  → Generating what-if scenario grid...")
    whatif = generate_whatif_scenarios(zone_forecasts)
    print(f"     {len(whatif)} pre-computed scenarios")

    # Build a GeoJSON-style boundaries file (one Feature per zone)
    boundaries_geojson = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "zone_id": z["id"],
                    "zone_name": z["name"],
                    "type": z["type"],
                    "atc_pct": z["atc_pct"],
                    "ac_penetration": z["ac_pen"],
                    "n_meters": z["meters"],
                },
                "geometry": {
                    "type": "Polygon",
                    # GeoJSON uses [lon, lat] order, and polygon is closed (first == last)
                    "coordinates": [[
                        [v[1], v[0]] for v in ZONE_BOUNDARIES[z["id"]]
                    ] + [[ZONE_BOUNDARIES[z["id"]][0][1], ZONE_BOUNDARIES[z["id"]][0][0]]]]
                }
            }
            for z in ZONES if z["id"] in ZONE_BOUNDARIES
        ]
    }

    # Write JSON files
    print(f"\n💾 Writing to {OUT_DIR}/")
    files = {
        "meters": meters,
        "feeders": feeders,
        "zone-forecasts": zone_forecasts,
        "evidence-packets": evidence_packets,
        "whatif-scenarios": whatif,
        "zone-boundaries": boundaries_geojson,
    }
    for name, data in files.items():
        path = OUT_DIR / name
        with open(path, "w") as f:
            json.dump(data, f, separators=(",", ":"))  # compact
        size_kb = path.stat().st_size / 1024
        n = len(data["features"]) if isinstance(data, dict) and "features" in data else len(data)
        print(f"   ✓ {name} ({size_kb:.1f} KB, {n} records)")

    # Summary stats
    print("\n📈 Summary:")
    print(f"   Total meters: {len(meters)}")
    print(f"   Flagged for theft: {sum(1 for m in meters if m['is_theft'])} ({sum(1 for m in meters if m['is_theft'])/len(meters)*100:.1f}%)")
    print(f"   Estimated annual revenue loss: ₹{sum(m['est_revenue_loss_inr'] for m in meters)*12/100000:.1f} lakh")
    print(f"   By archetype:")
    for at in THEFT_ARCHETYPES:
        n = sum(1 for m in meters if m["theft_archetype"] == at["id"])
        print(f"     {at['label']}: {n}")

    print("\n✅ Done!")

if __name__ == "__main__":
    main()
