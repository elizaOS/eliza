#!/usr/bin/env python3
"""Validate a completed OpenLane2 PD run of the single-tier E1X3D logic block.

This gate consumes the sky130 OpenLane2 run produced by
``pd/openlane/config.e1x3d-router.sky130.json`` (design ``e1x3d_router7``). A
completed ``e1x3d_tile`` run is also accepted when the hard SRAM macro path is
available. These runs are planar, single-tier physical-design proxies for the
E1X3D wafer-mesh logic tier: they are real RTL-to-GDS evidence on an open PDK,
but they are NOT the 3D stack signoff. Full 3D DRC/LVS, electrothermal, and
SI/PI signoff remain BLOCKED with no open-source path (commercial-only) and are
owned by ``e1x3d-signoff``.

The gate PASSes only when the latest completed accepted design run has clean
sky130 signoff metrics in ``final/metrics.json`` and emits the layout database
(GDS + DEF) and the gate-level netlist. It fails closed (BLOCKED) when no
completed accepted run exists yet, naming the proving command.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

REPORT = ROOT / "build/reports/e1x3d_pd_signoff.json"
RUNS_DIR = ROOT / "pd/openlane/runs"
# The open-PDK logic-tier signoff target is the standalone 3D fabric router
# (e1x3d_router7); e1x3d_tile is also accepted if a full-tile run is produced
# with a hard SRAM macro. The per-PE SRAM is a hard macro on the memory tier
# (see the tier-split manifest), so the logic-tier block is the router.
DESIGN_NAMES = {"e1x3d_router7", "e1x3d_tile"}
PRIMARY_DESIGN = "e1x3d_router7"
CONFIG_REL = "pd/openlane/config.e1x3d-router.sky130.json"
PROVING_COMMAND = (
    f"OPENLANE_CONFIG={CONFIG_REL} scripts/run_openlane.sh --config {CONFIG_REL} "
    "&& python3 scripts/check_e1x3d_pd_signoff.py"
)

# OpenLane2 metric keys that must be exactly 0 for a clean sky130 signoff.
# Key names are read from completed OpenLane2 runs (see scripts/check_pd_closure.py
# and the final/metrics.json emitted by RUN_* directories) and are not guessed.
DRC_ZERO_METRICS = {
    "magic__drc_error__count": "magic DRC violations",
    "magic__illegal_overlap__count": "magic illegal-overlap violations",
    "klayout__drc_error__count": "klayout DRC violations",
    "route__drc_errors": "detailed-route DRC violations",
}

LVS_ZERO_METRICS = {
    "design__lvs_error__count": "LVS errors",
    "design__lvs_unmatched_device__count": "LVS unmatched devices",
    "design__lvs_unmatched_net__count": "LVS unmatched nets",
    "design__lvs_unmatched_pin__count": "LVS unmatched pins",
    "design__lvs_device_difference__count": "LVS device differences",
    "design__lvs_net_difference__count": "LVS net differences",
    "design__lvs_property_fail__count": "LVS property failures",
}

# The repo's accepted antenna bound is zero: scripts/check_pd_closure.py lists
# all three antenna metrics in its zero-tolerance ZERO_METRICS set.
ANTENNA_ZERO_METRICS = {
    "antenna__violating__nets": "antenna violating nets",
    "antenna__violating__pins": "antenna violating pins",
    "route__antenna_violation__count": "route antenna violations",
}

# Violation counts that fail the run when nonzero; the run config sets
# QUIT_ON_TIMING_VIOLATIONS / QUIT_ON_SLEW_VIOLATIONS true.
TIMING_ZERO_METRICS = {
    "timing__setup_vio__count": "setup violation count",
    "timing__hold_vio__count": "hold violation count",
    "timing__setup_r2r_vio__count": "reg-to-reg setup violation count",
    "timing__hold_r2r_vio__count": "reg-to-reg hold violation count",
    "design__max_slew_violation__count": "max slew violations",
}

# WNS metrics: a passing run has non-negative worst negative slack (no failing path).
TIMING_WNS_METRICS = {
    "timing__setup__wns": "setup WNS",
    "timing__hold__wns": "hold WNS",
}

# Required final artifacts: layout database (GDS + DEF) and gate-level netlist.
REQUIRED_OUTPUTS = {
    "gds": ("final/gds", ".gds", "GDS layout"),
    "def": ("final/def", ".def", "DEF layout"),
    "gate_netlist": ("final/nl", ".nl.v", "gate-level netlist"),
}

CLAIM_BOUNDARY = (
    "E1X3D single-tier logic-tier sky130 OpenLane2 physical-design signoff only: validates "
    "magic+klayout+detailed-route DRC, LVS, antenna (repo accepted bound = 0), and "
    "setup/hold/slew timing closure plus GDS+DEF+gate-netlist emission for one accepted "
    "planar logic-tier slice of the wafer mesh. NOT the 3D stack signoff: 3D DRC/LVS, electrothermal, "
    "and SI/PI remain BLOCKED with no open-source path (owned by e1x3d-signoff)."
)

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "three_d_stack_signoff_claim_allowed": False,
    "electrothermal_signoff_claim_allowed": False,
    "si_pi_signoff_claim_allowed": False,
    "foundry_signoff_claim_allowed": False,
    "production_readiness_claim_allowed": False,
    "silicon_claim_allowed": False,
    "tapeout_claim_allowed": False,
}


def run_design_name(run_dir: Path) -> str | None:
    """Resolve the design name OpenLane2 recorded for a run from resolved.json."""
    resolved = run_dir / "resolved.json"
    if not resolved.is_file():
        return None
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    name = payload.get("DESIGN_NAME") if isinstance(payload, dict) else None
    return name if isinstance(name, str) else None


def latest_completed_tile_run() -> tuple[Path | None, list[Path]]:
    """Return the newest completed e1x3d_tile run and all matching run dirs.

    A run is "completed" when it has produced final/metrics.json. The matching
    list (regardless of completion) feeds the missing-dependency diagnostic.
    """
    matching: list[Path] = []
    completed: list[Path] = []
    if not RUNS_DIR.is_dir():
        return None, matching
    for run_dir in RUNS_DIR.iterdir():
        if not run_dir.is_dir():
            continue
        if run_design_name(run_dir) not in DESIGN_NAMES:
            continue
        matching.append(run_dir)
        if (run_dir / "final/metrics.json").is_file():
            completed.append(run_dir)
    matching.sort()
    if not completed:
        return None, matching
    return max(completed, key=lambda path: path.stat().st_mtime), matching


def load_metrics(run_dir: Path) -> tuple[dict[str, object], list[str]]:
    metrics_path = run_dir / "final/metrics.json"
    try:
        payload = json.loads(metrics_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {}, [f"{metrics_path.relative_to(ROOT)}: invalid JSON: {exc}"]
    if not isinstance(payload, dict):
        return {}, [f"{metrics_path.relative_to(ROOT)}: metrics payload must be a JSON object"]
    return payload, []


def numeric(metrics: dict[str, object], key: str, label: str, failures: list[str]) -> float | None:
    value = metrics.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        failures.append(f"missing numeric metric {key} ({label})")
        return None
    return float(value)


def check_zero(metrics: dict[str, object], spec: dict[str, str], failures: list[str]) -> None:
    for key, label in spec.items():
        value = numeric(metrics, key, label, failures)
        if value is not None and value != 0:
            failures.append(
                f"{label} must be 0 for E1X3D logic-tier PD signoff; got {value:g} ({key})"
            )


def check_wns(metrics: dict[str, object], failures: list[str]) -> None:
    for key, label in TIMING_WNS_METRICS.items():
        value = numeric(metrics, key, label, failures)
        if value is not None and value < 0:
            failures.append(
                f"{label} is negative (timing not met) for E1X3D logic-tier PD signoff; "
                f"got {value:g} ({key})"
            )


def check_outputs(run_dir: Path, failures: list[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    for name, (subdir, suffix, label) in REQUIRED_OUTPUTS.items():
        directory = run_dir / subdir
        matches = (
            sorted(path for path in directory.glob(f"*{suffix}") if path.is_file())
            if directory.is_dir()
            else []
        )
        if not matches:
            failures.append(f"missing {label} ({subdir}/*{suffix}) in completed e1x3d_tile run")
            continue
        found[name] = matches[0].relative_to(ROOT).as_posix()
    return found


def build_summary(
    metrics: dict[str, object], run_dir: Path | None, outputs: dict[str, str]
) -> dict[str, object]:
    def metric_value(key: str) -> float | None:
        value = metrics.get(key)
        return (
            float(value)
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            else None
        )

    summary: dict[str, object] = {
        "design_name": run_design_name(run_dir) if run_dir else None,
        "accepted_design_names": sorted(DESIGN_NAMES),
        "selected_run": run_dir.relative_to(ROOT).as_posix() if run_dir else None,
        "magic_drc_violations": metric_value("magic__drc_error__count"),
        "klayout_drc_violations": metric_value("klayout__drc_error__count"),
        "detailed_route_drc_violations": metric_value("route__drc_errors"),
        "lvs_errors": metric_value("design__lvs_error__count"),
        "lvs_unmatched_devices": metric_value("design__lvs_unmatched_device__count"),
        "lvs_unmatched_nets": metric_value("design__lvs_unmatched_net__count"),
        "antenna_violating_nets": metric_value("antenna__violating__nets"),
        "antenna_violating_pins": metric_value("antenna__violating__pins"),
        "route_antenna_violations": metric_value("route__antenna_violation__count"),
        "setup_wns": metric_value("timing__setup__wns"),
        "hold_wns": metric_value("timing__hold__wns"),
        "setup_violation_count": metric_value("timing__setup_vio__count"),
        "hold_violation_count": metric_value("timing__hold_vio__count"),
        "max_slew_violation_count": metric_value("design__max_slew_violation__count"),
        "accepted_antenna_bound": 0,
        "gds": outputs.get("gds"),
        "def": outputs.get("def"),
        "gate_netlist": outputs.get("gate_netlist"),
    }
    return summary


def main() -> int:
    run_dir, matching = latest_completed_tile_run()

    if run_dir is None:
        if matching:
            newest = max(matching, key=lambda path: path.stat().st_mtime)
            detail = (
                f"found {len(matching)} {'/'.join(sorted(DESIGN_NAMES))} run(s) but none "
                f"completed final/metrics.json (newest: {newest.relative_to(ROOT)})"
            )
        else:
            detail = (
                f"no OpenLane2 run with DESIGN_NAME in {sorted(DESIGN_NAMES)} exists under "
                f"{RUNS_DIR.relative_to(ROOT)}"
            )
        checks = [
            {
                "id": "e1x3d_tile_completed_pd_run_present",
                "status": "blocked",
                "detail": (
                    f"{detail}. Missing dependency: a completed OpenLane2 sky130 PD run "
                    f"of {PRIMARY_DESIGN}. Proving command: {PROVING_COMMAND}"
                ),
            }
        ]
        status = "BLOCKED"
        summary: dict[str, object] = {
            "design_name": PRIMARY_DESIGN,
            "accepted_design_names": sorted(DESIGN_NAMES),
            "selected_run": None,
            "matching_run_count": len(matching),
            "completed_run_count": 0,
            "missing_dependency": f"completed_openlane2_{PRIMARY_DESIGN}_run",
            "proving_command": PROVING_COMMAND,
            "check_count": len(checks),
            "failing_check_count": len(checks),
        }
        emit(status, checks, summary, run_dir=None)
        print(f"BLOCKED: E1X3D PD signoff; {detail}")
        print(f"  proving command: {PROVING_COMMAND}")
        return 2

    metrics, load_failures = load_metrics(run_dir)
    drc_failures: list[str] = list(load_failures)
    lvs_failures: list[str] = []
    antenna_failures: list[str] = []
    timing_failures: list[str] = []

    if metrics:
        check_zero(metrics, DRC_ZERO_METRICS, drc_failures)
        check_zero(metrics, LVS_ZERO_METRICS, lvs_failures)
        check_zero(metrics, ANTENNA_ZERO_METRICS, antenna_failures)
        check_zero(metrics, TIMING_ZERO_METRICS, timing_failures)
        check_wns(metrics, timing_failures)

    outputs: dict[str, str] = {}
    artifact_failures: list[str] = []
    check_outputs(run_dir, artifact_failures)
    if not artifact_failures:
        outputs = check_outputs(run_dir, [])

    checks = [
        {
            "id": "e1x3d_tile_completed_pd_run_present",
            "status": "pass",
            "detail": (
                f"completed E1X3D logic-tier run {run_dir.relative_to(ROOT)} "
                f"(design {run_design_name(run_dir)})"
            ),
        },
        {
            "id": "e1x3d_tile_drc_clean",
            "status": "pass" if not drc_failures else "fail",
            "detail": "; ".join(drc_failures) or "magic, klayout, and detailed-route DRC == 0",
        },
        {
            "id": "e1x3d_tile_lvs_clean",
            "status": "pass" if not lvs_failures else "fail",
            "detail": "; ".join(lvs_failures) or "LVS errors and unmatched devices/nets/pins == 0",
        },
        {
            "id": "e1x3d_tile_antenna_within_bound",
            "status": "pass" if not antenna_failures else "fail",
            "detail": "; ".join(antenna_failures) or "antenna violations within accepted bound (0)",
        },
        {
            "id": "e1x3d_tile_timing_met",
            "status": "pass" if not timing_failures else "fail",
            "detail": "; ".join(timing_failures)
            or "setup/hold WNS not failing and slew/timing violation counts == 0",
        },
        {
            "id": "e1x3d_tile_layout_and_netlist_present",
            "status": "pass" if not artifact_failures else "fail",
            "detail": "; ".join(artifact_failures)
            or f"GDS, DEF, and gate netlist present: {', '.join(sorted(outputs.values()))}",
        },
    ]
    failures = [check for check in checks if check["status"] != "pass"]
    status = "PASS" if not failures else "BLOCKED"
    summary = {
        **build_summary(metrics, run_dir, outputs),
        "proving_command": PROVING_COMMAND,
        "check_count": len(checks),
        "failing_check_count": len(failures),
    }
    emit(status, checks, summary, run_dir=run_dir)

    if failures:
        print(
            "BLOCKED: E1X3D logic-tier PD signoff failed: " + ", ".join(c["id"] for c in failures)
        )
        for check in failures:
            print(f"  - {check['id']}: {check['detail']}")
        return 2
    print(
        f"PASS: E1X3D logic-tier PD signoff; run {run_dir.relative_to(ROOT)}; "
        f"report {REPORT.relative_to(ROOT)}"
    )
    return 0


def emit(
    status: str, checks: list[dict[str, str]], summary: dict[str, object], run_dir: Path | None
) -> None:
    evidence_paths = [
        CONFIG_REL,
        "docs/arch/e1x3d-wafer-stack.md",
        "research/threed_ic_2026/03_implementation/e1x3d_design_decisions.md",
    ]
    if run_dir is not None:
        evidence_paths.insert(1, (run_dir / "final/metrics.json").relative_to(ROOT).as_posix())
        evidence_paths.insert(2, "pd/constraints/e1x3d_tile.sdc")
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x3d-pd-signoff",
        "status": status,
        **FALSE_CLAIM_FLAGS,
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "subsystem": "e1x3d",
        "claim_boundary": CLAIM_BOUNDARY,
        "evidence_paths": evidence_paths,
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
