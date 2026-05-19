#!/usr/bin/env python3
"""Eliza E1 power + thermal projection model.

Projects per-block burst and sustained power for the modeled SoC operating
point under the vapor-chamber transient + steady-state thermal envelopes
declared in ``docs/spec-db/process-14a-effects.yaml``. Emits JSON to
``build/reports/power_thermal_projection.json``.

This is a planning model. Every number it emits is a projection from
existing spec inputs, never a measured-silicon claim. Each row carries
``provenance: simulator_or_spec`` and a ``confidence`` field
(``low``/``medium``/``high``).

CLI:
  python3 scripts/power_thermal_model.py --report   # write JSON report
  python3 scripts/power_thermal_model.py --check    # exit non-zero if over envelope
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
OPERATING_POINT = ROOT / "docs/architecture-optimization/soc-optimized-operating-point.yaml"
PROCESS_SPEC = ROOT / "docs/spec-db/process-14a-effects.yaml"
REPORT_PATH = ROOT / "build/reports/power_thermal_projection.json"
SCHEMA = "eliza.power_thermal_projection.v1"
CLAIM_BOUNDARY = "power_thermal_projection_simulator_or_spec_inputs_only_no_measured_silicon_claim"

# Block-level burst + sustained power budget. Aligned with
# docs/board/thermal-stack.md and docs/architecture-optimization/soc-optimized-operating-point.yaml.
DEFAULT_BLOCKS: tuple[tuple[str, float, float, str], ...] = (
    # (block, burst_w, sustained_w, confidence)
    ("cpu_ap_cluster", 2.5, 1.4, "medium"),
    ("npu", 3.0, 1.2, "medium"),
    ("lpddr_phy_and_dram", 0.8, 0.5, "medium"),
    ("display_and_dsi", 0.4, 0.4, "medium"),
    ("wifi_bt", 1.2, 0.3, "low"),
    ("misc_pmic_audio", 0.5, 0.2, "low"),
)

# Skin-temperature limit per IEC 60950-1 / IEC 62368-1.
SKIN_TEMP_LIMIT_C = 45.0


@dataclass(frozen=True)
class ThermalEnvelope:
    transient_window_s_low: float
    transient_window_s_high: float
    transient_w_low: float
    transient_w_high: float
    steady_state_w_low: float
    steady_state_w_high: float
    skin_temp_limit_c: float


def _load_thermal_envelope(path: Path) -> ThermalEnvelope:
    with path.open(encoding="utf-8") as fh:
        spec = yaml.safe_load(fh)
    phases = (spec or {}).get("thermal_capture_phases", {}).get("phases", [])
    transient = next((p for p in phases if (p or {}).get("id") == "vapor_chamber_transient"), None)
    steady = next((p for p in phases if (p or {}).get("id") == "vapor_chamber_steady_state"), None)
    if not transient or not steady:
        raise SystemExit(
            f"FAIL: thermal_capture_phases missing transient/steady-state entries in {path.relative_to(ROOT)}"
        )
    tw = transient.get("duration_s_range") or [10, 30]
    tp = transient.get("absorbed_power_w_range") or [4.0, 8.0]
    sp = steady.get("sustained_power_w_range") or [4.0, 6.0]
    skin = (spec.get("thermal_capture_phases", {}) or {}).get("skin_temperature_limit", {}).get(
        "limit_c"
    ) or SKIN_TEMP_LIMIT_C
    return ThermalEnvelope(
        transient_window_s_low=float(tw[0]),
        transient_window_s_high=float(tw[1]),
        transient_w_low=float(tp[0]),
        transient_w_high=float(tp[1]),
        steady_state_w_low=float(sp[0]),
        steady_state_w_high=float(sp[1]),
        skin_temp_limit_c=float(skin),
    )


def project(
    blocks: tuple[tuple[str, float, float, str], ...] = DEFAULT_BLOCKS,
) -> dict[str, object]:
    """Build the projection report (no I/O)."""
    envelope = _load_thermal_envelope(PROCESS_SPEC)
    block_rows = []
    burst_total = 0.0
    sustained_total = 0.0
    for name, burst, sustained, confidence in blocks:
        block_rows.append(
            {
                "block": name,
                "burst_w": burst,
                "sustained_w": sustained,
                "confidence": confidence,
                "provenance": "simulator_or_spec",
            }
        )
        burst_total += burst
        sustained_total += sustained

    transient_fit = envelope.transient_w_low <= burst_total <= envelope.transient_w_high
    transient_over = burst_total > envelope.transient_w_high
    steady_fit = sustained_total <= envelope.steady_state_w_high
    release_blocker = transient_over or not steady_fit

    return {
        "schema": SCHEMA,
        "as_of": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "claim_boundary": CLAIM_BOUNDARY,
        "provenance": "simulator_or_spec",
        "blocks": block_rows,
        "totals": {
            "burst_w": round(burst_total, 3),
            "sustained_w": round(sustained_total, 3),
        },
        "envelope": {
            "transient_window_s_low": envelope.transient_window_s_low,
            "transient_window_s_high": envelope.transient_window_s_high,
            "transient_w_low": envelope.transient_w_low,
            "transient_w_high": envelope.transient_w_high,
            "steady_state_w_low": envelope.steady_state_w_low,
            "steady_state_w_high": envelope.steady_state_w_high,
            "skin_temp_limit_c": envelope.skin_temp_limit_c,
        },
        "fit": {
            "transient_fit": transient_fit,
            "transient_over_envelope": transient_over,
            "steady_state_fit": steady_fit,
        },
        "release_blocker": release_blocker,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="write JSON report")
    parser.add_argument("--check", action="store_true", help="fail if envelope exceeded")
    parser.add_argument("--report-path", type=Path, default=REPORT_PATH)
    args = parser.parse_args()

    report = project()

    if args.report or not args.check:
        args.report_path.parent.mkdir(parents=True, exist_ok=True)
        args.report_path.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        try:
            rel = args.report_path.relative_to(ROOT)
        except ValueError:
            rel = args.report_path
        print(
            f"power_thermal_projection: burst={report['totals']['burst_w']} W "
            f"sustained={report['totals']['sustained_w']} W -> {rel}"
        )

    if args.check:
        if report["release_blocker"]:
            print(
                f"FAIL: power_thermal_projection release_blocker=True "
                f"(burst={report['totals']['burst_w']} W "
                f"sustained={report['totals']['sustained_w']} W "
                f"envelope_transient_max={report['envelope']['transient_w_high']} "
                f"envelope_steady_max={report['envelope']['steady_state_w_high']})",
                file=sys.stderr,
            )
            return 1
        print(
            f"power_thermal_projection ok: burst={report['totals']['burst_w']} W "
            f"sustained={report['totals']['sustained_w']} W within envelope"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
