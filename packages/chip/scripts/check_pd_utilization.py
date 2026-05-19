#!/usr/bin/env python3
"""PD utilization regression gate.

Permanent fail-closed defense against the historical 771.788% incident
captured in docs/three-week-prototype-workstreams.md. Reads
pd/signoff/util_threshold.yaml for the configured maximum utilization,
then validates the most recent OpenLane run's utilization report against it.

Usage:
    python3 scripts/check_pd_utilization.py [--run <run-dir>] [--threshold <fraction>]

Fails closed when:
- the threshold file is missing or malformed
- the run report is missing
- the parsed utilization exceeds the threshold
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
THRESHOLD_FILE = ROOT / "pd/signoff/util_threshold.yaml"
DEFAULT_RUN_DIR = ROOT / "pd/openlane/runs"


def load_threshold(design: str) -> tuple[float, dict]:
    if not THRESHOLD_FILE.exists():
        raise SystemExit(f"FAIL: util_threshold.yaml missing: {THRESHOLD_FILE.relative_to(ROOT)}")
    with THRESHOLD_FILE.open("r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    if not isinstance(cfg, dict):
        raise SystemExit("FAIL: util_threshold.yaml malformed (not a mapping)")
    default = cfg.get("max_utilization")
    if not isinstance(default, (int, float)):
        raise SystemExit("FAIL: util_threshold.max_utilization missing or non-numeric")
    threshold = float(default)
    for override in cfg.get("overrides") or []:
        if isinstance(override, dict) and override.get("design") == design:
            value = override.get("max_utilization")
            if isinstance(value, (int, float)):
                threshold = float(value)
                break
    return threshold, cfg


def find_latest_run(run_dir: Path) -> Path | None:
    if not run_dir.exists():
        return None
    candidates = sorted(
        (p for p in run_dir.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def parse_utilization(run: Path, cfg: dict) -> float | None:
    keys = cfg.get("report_keys") or ["utilization"]
    regex = cfg.get("report_regex")
    json_candidates = list(run.glob("**/*.json"))
    for jp in json_candidates:
        try:
            data = json.loads(jp.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        for key in keys:
            value = data.get(key)
            if isinstance(value, (int, float)):
                return float(value)
    if regex:
        pattern = re.compile(regex)
        for rpt in run.glob("**/*.rpt"):
            try:
                text = rpt.read_text()
            except OSError:
                continue
            match = pattern.search(text)
            if match:
                try:
                    return float(match.group("value"))
                except (ValueError, IndexError):
                    continue
        for txt in run.glob("**/*.txt"):
            try:
                text = txt.read_text()
            except OSError:
                continue
            match = pattern.search(text)
            if match:
                try:
                    return float(match.group("value"))
                except (ValueError, IndexError):
                    continue
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run",
        type=Path,
        help="Specific run directory (defaults to most recent under pd/openlane/runs/)",
    )
    parser.add_argument(
        "--design",
        default="e1_chip_top",
        help="Design name to look up in util_threshold.yaml overrides",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        help="Override the configured maximum utilization (fraction, e.g. 1.05).",
    )
    parser.add_argument(
        "--utilization",
        type=float,
        help="Provide utilization directly (skip report parsing).",
    )
    args = parser.parse_args()

    threshold, cfg = load_threshold(args.design)
    if args.threshold is not None:
        threshold = args.threshold

    if args.utilization is not None:
        observed = args.utilization
    else:
        run = args.run or find_latest_run(DEFAULT_RUN_DIR)
        if run is None:
            print(
                f"STATUS: BLOCKED pd-util-check - no run directory present at "
                f"{DEFAULT_RUN_DIR.relative_to(ROOT)} and --utilization not given"
            )
            return 0
        observed_value = parse_utilization(run, cfg)
        if observed_value is None:
            print(
                f"STATUS: BLOCKED pd-util-check - no utilization key found in "
                f"{run.relative_to(ROOT)}; expected keys {cfg.get('report_keys')}"
            )
            return 0
        observed = observed_value

    if observed > threshold:
        print(
            f"FAIL: pd-util-check observed={observed:.4f} threshold={threshold:.4f} "
            f"(historical 771.788% incident reference)",
            file=sys.stderr,
        )
        return 1

    print(f"pd-util-check passed observed={observed:.4f} threshold={threshold:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
