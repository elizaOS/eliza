#!/usr/bin/env python3
"""thermal-summary.py — summarize thermal-timeline.tsv for the #11734 README."""

import csv
import sys
from datetime import datetime

path = sys.argv[1] if len(sys.argv) > 1 else (
    "/home/shaw/eliza-worktrees/bench-11734/.github/issue-evidence/"
    "11734-pixel6a-adb-rows/raw/thermal-timeline.tsv"
)
rows = list(csv.DictReader(open(path), delimiter="\t"))
zones = [
    "battery_c", "virtual_skin_c", "skin_therm1_c", "skin_therm2_c",
    "neutral_c", "quiet_c", "disp_c", "charger_skin_c", "tpu_c", "cellular_c",
]
n = len(rows)
t0, t1 = int(rows[0]["epoch"]), int(rows[-1]["epoch"])
print(f"samples={n}  span={t1 - t0}s ({(t1 - t0) / 60:.1f} min)  "
      f"{rows[0]['time']} -> {rows[-1]['time']}  cadence~{(t1 - t0) / max(n - 1, 1):.1f}s")
statuses = sorted({r["thermal_status"] for r in rows})
print(f"thermal_status values seen: {statuses}")
print(f"{'zone':<16} {'start':>7} {'min':>7} {'max':>7} {'end':>7} {'peak at':>9}")
for z in zones:
    vals = [(float(r[z]), r["time"]) for r in rows if r[z] not in ("", "NA")]
    if not vals:
        continue
    vmin = min(v[0] for v in vals)
    vmax, tmax = max(vals, key=lambda v: v[0])
    print(f"{z:<16} {vals[0][0]:>7.1f} {vmin:>7.1f} {vmax:>7.1f} {vals[-1][0]:>7.1f} {tmax:>9}")
for c in ["cool_cpu0", "cool_cpu1", "cool_cpu2", "cool_gpu", "cool_tpu"]:
    nz = [(r[c], r["time"]) for r in rows if r[c] not in ("", "0", "NA")]
    if nz:
        levels = sorted({v for v, _ in nz})
        print(f"{c}: nonzero in {len(nz)}/{n} samples, levels={levels}, "
              f"first {nz[0][1]}, last {nz[-1][1]}")
    else:
        print(f"{c}: 0 for all samples")
lvl = [int(r["batt_level"]) for r in rows if r["batt_level"] not in ("", "NA")]
print(f"battery level: {lvl[0]}% -> {lvl[-1]}% (USB powered; charging — no discharge measurement possible)")
