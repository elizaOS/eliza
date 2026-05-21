#!/usr/bin/env python3
"""Build a synth-feedback manifest from a post-route OpenLane/OpenROAD run.

Closes the backend->frontend half of the QoR loop: parse a routed run's
metrics.json plus, when present, the OpenROAD timing / congestion / antenna
reports, and distill the actionable signals a re-synthesis pass can act on:

  - critical paths        (worst setup endpoints / negative slack summary)
  - congestion hotspots   (global-route overflow / utilization signal)
  - high-fanout nets       (max-fanout / fanout-violation signal)
  - buffering signals     (max-slew / max-cap violation counts)

Emits eliza.pd_feedback.v1 to build/qor/pd_feedback.<node_id>.json. This file
is consumed by scripts/yosys_e1_soc_qor.ys (via FEEDBACK_JSON) to bias retiming
and buffering hooks.

Fail-closed: missing run dir / metrics.json -> non-zero with a structured error
naming the run that must be produced first.

Usage:
  scripts/build_pd_feedback.py --run-dir <openlane run dir> --node-id sky130 \
      [--out build/qor/pd_feedback.sky130.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

SCHEMA = "eliza.pd_feedback.v1"

# OpenLane metric keys we map into the feedback signal set.
SETUP_WNS = "timing__setup__ws"
SETUP_TNS = "timing__setup__tns"
HOLD_WNS = "timing__hold__ws"
HOLD_TNS = "timing__hold__tns"
MAX_SLEW = "design__max_slew_violation__count"
MAX_CAP = "design__max_cap_violation__count"
MAX_FANOUT = "design__max_fanout_violation__count"
DRC = "route__drc_errors"
WIRELENGTH = "route__wirelength"
UTIL = "design__instance__utilization"
ANTENNA = "antenna__violating__nets"


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def find_metrics(run_dir: Path) -> Path | None:
    direct = run_dir / "final" / "metrics.json"
    if direct.is_file():
        return direct
    candidates = sorted(run_dir.rglob("final/metrics.json"))
    return candidates[-1] if candidates else None


def _num(metrics: dict[str, Any], key: str) -> float | None:
    value = metrics.get(key)
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


# Worst-setup endpoint lines in OpenROAD STA reports look like:
#   "Endpoint: <pin>  slack -0.1234"  or a "report_checks" tail with
#   "<slack> <endpoint>" rows. We scrape negative-slack endpoints generically.
ENDPOINT_SLACK_RE = re.compile(
    r"(?:Endpoint:\s*)?(\S+)\s+slack\s+(-?\d+\.\d+)", re.IGNORECASE
)


def parse_timing_reports(run_dir: Path, limit: int = 10) -> list[dict[str, Any]]:
    paths = sorted(run_dir.rglob("*.rpt")) + sorted(run_dir.rglob("*sta*.log"))
    endpoints: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in paths:
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        for match in ENDPOINT_SLACK_RE.finditer(text):
            pin, slack = match.group(1), float(match.group(2))
            if slack >= 0 or pin in seen:
                continue
            seen.add(pin)
            endpoints.append({"endpoint": pin, "slack": slack, "report": path.name})
    endpoints.sort(key=lambda e: e["slack"])
    return endpoints[:limit]


def build_signals(metrics: dict[str, Any]) -> dict[str, Any]:
    setup_wns = _num(metrics, SETUP_WNS)
    setup_tns = _num(metrics, SETUP_TNS)
    hold_wns = _num(metrics, HOLD_WNS)
    util = _num(metrics, UTIL)
    max_slew = _num(metrics, MAX_SLEW)
    max_cap = _num(metrics, MAX_CAP)
    max_fanout = _num(metrics, MAX_FANOUT)

    setup_violated = setup_wns is not None and setup_wns < 0
    return {
        "critical_paths": {
            "setup_wns": setup_wns,
            "setup_tns": setup_tns,
            "hold_wns": hold_wns,
            "setup_violated": setup_violated,
            # Retiming is worthwhile only when setup is the binding constraint.
            "recommend_retiming": setup_violated,
        },
        "congestion": {
            "instance_utilization": util,
            # >0.70 utilization is the OpenLane congestion-risk heuristic.
            "hotspot_risk": util is not None and util > 0.70,
        },
        "high_fanout": {
            "max_fanout_violations": max_fanout,
            "recommend_max_fanout_split": (max_fanout or 0) > 0,
        },
        "buffering": {
            "max_slew_violations": max_slew,
            "max_cap_violations": max_cap,
            "recommend_buffering": ((max_slew or 0) + (max_cap or 0)) > 0,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--design", default="e1_chip_top")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    if not run_dir.is_absolute():
        run_dir = (ROOT / args.run_dir).resolve()
    if not run_dir.is_dir():
        return fail("run dir missing", run_dir=str(run_dir))

    metrics_path = find_metrics(run_dir)
    if metrics_path is None:
        return fail(
            "no final/metrics.json under run dir; run the PD flow to signoff first",
            run_dir=str(run_dir),
        )

    raw = json.loads(metrics_path.read_text())
    if not isinstance(raw, dict):
        return fail("metrics.json is not a JSON object", path=str(metrics_path))

    signals = build_signals(raw)
    critical_endpoints = parse_timing_reports(run_dir)

    feedback = {
        "schema": SCHEMA,
        "design": args.design,
        "node_id": args.node_id,
        "source_run_dir": rel(run_dir),
        "source_metrics": rel(metrics_path),
        "release_use_allowed": False,
        "claim_boundary": "synth_feedback_hint_only_not_signoff",
        "raw_metrics": {
            key: _num(raw, key)
            for key in (
                SETUP_WNS,
                SETUP_TNS,
                HOLD_WNS,
                HOLD_TNS,
                MAX_SLEW,
                MAX_CAP,
                MAX_FANOUT,
                DRC,
                WIRELENGTH,
                UTIL,
                ANTENNA,
            )
        },
        "signals": signals,
        "critical_endpoints": critical_endpoints,
    }

    out_path = (
        Path(args.out)
        if args.out
        else ROOT / "build" / "qor" / f"pd_feedback.{args.node_id}.json"
    )
    if not out_path.is_absolute():
        out_path = (ROOT / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(feedback, indent=2, sort_keys=True) + "\n")
    print(
        f"PASS: PD feedback written {rel(out_path)} "
        f"(retiming={signals['critical_paths']['recommend_retiming']}, "
        f"buffering={signals['buffering']['recommend_buffering']}, "
        f"endpoints={len(critical_endpoints)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
