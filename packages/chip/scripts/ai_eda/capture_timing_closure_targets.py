#!/usr/bin/env python3
"""Capture dry-run timing-closure and ECO automation targets for E1."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/timing_closure_targets"
CLAIM_BOUNDARY = "timing_closure_target_capture_only_no_constraint_or_eco_change"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "pd/constraints/e1_soc.sdc",
    "pd/constraints/e1_pd_smoke.sdc",
    "pd/constraints/e1_soc_gf180.sdc",
    "pd/openlane/config.sky130.json",
    "pd/openlane/config.gf180.json",
    "pd/signoff/manifest.yaml",
    "docs/evidence/pd/multi-corner-sta-evidence.yaml",
    "docs/evidence/pd/multi-corner-sta-RUN_2026-05-19_05-08-54.json",
    "docs/evidence/pd/post-route-ppa-validator.yaml",
    "docs/evidence/pd/dft-evidence.yaml",
    "docs/evidence/power/pdn-signoff-gate.yaml",
    "docs/pd/high-fanout-routing-pressure-2026-05-18.json",
    "docs/pd/signoff/openlane_release_run_monitor_2026-05-19.md",
    "docs/pd/signoff/openlane_repairantennas_blocker_RUN_2026-05-19_01-52-14.md",
    "docs/pd/signoff/si-pi/local-gap-report.md",
    "scripts/run_yosys.sh",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_pd_closure.py",
    "scripts/check_pd_signoff.py",
    "scripts/report_high_fanout_nets.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

TIMING_METRIC_KEYS = (
    "timing__setup__wns",
    "timing__setup__tns",
    "timing__setup_vio__count",
    "timing__setup_r2r__ws",
    "timing__setup_r2r_vio__count",
    "timing__hold__wns",
    "timing__hold__tns",
    "timing__hold_vio__count",
    "timing__hold_r2r__ws",
    "timing__hold_r2r_vio__count",
    "design__max_slew_violation__count",
    "design__max_cap_violation__count",
    "design__max_fanout_violation__count",
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact_entry(path_text: str) -> dict[str, Any]:
    path = ROOT / path_text
    return {
        "path": path_text,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def command_entry(command: str) -> dict[str, str | None]:
    resolved = shutil.which(command)
    return {
        "command": command,
        "status": "PRESENT" if resolved else "MISSING",
        "path": resolved,
    }


def latest_metrics_path() -> Path | None:
    metrics = sorted(
        (ROOT / "pd/openlane/runs").glob("RUN_*/final/metrics.json"),
        key=lambda path: path.stat().st_mtime,
    )
    return metrics[-1] if metrics else None


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def timing_metrics(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    metrics = load_json(path)
    return {key: metrics.get(key) for key in TIMING_METRIC_KEYS if key in metrics}


def report_sample(path: Path, patterns: tuple[str, ...], limit: int = 12) -> list[str]:
    if not path.is_file():
        return []
    compiled = [re.compile(pattern, re.IGNORECASE) for pattern in patterns]
    samples: list[str] = []
    for line in path.read_text(errors="replace").splitlines():
        if any(pattern.search(line) for pattern in compiled):
            samples.append(line.strip())
            if len(samples) >= limit:
                break
    return samples


def latest_run_dir(metrics_path: Path | None) -> Path | None:
    if metrics_path is None:
        return None
    return metrics_path.parents[1]


def timing_report_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    candidates = [
        run_dir / "final/metrics.json",
        *sorted(run_dir.glob("*openroad-sta*/wns.max.rpt")),
        *sorted(run_dir.glob("*openroad-sta*/wns.min.rpt")),
        *sorted(run_dir.glob("*openroad-resizertiming*/openroad-resizertiming*.log")),
    ]
    entries: list[dict[str, Any]] = []
    for path in candidates[:12]:
        if not path.is_file():
            continue
        entries.append(
            {
                "path": rel(path),
                "sha256": sha256_file(path),
                "samples": report_sample(path, (r"wns", r"tns", r"slack", r"violation")),
            }
        )
    return entries


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    metrics_path = latest_metrics_path()
    run_dir = latest_run_dir(metrics_path)
    report = {
        "schema": "eliza.ai_eda.timing_closure_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_ECO_OR_CONSTRAINT_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "timingpredict",
            "e2eslack",
            "timingllm",
            "fluxeda",
            "astrotune",
            "openroad-resizer",
            "openphysyn",
            "learning-driven-gate-sizing",
            "fusionsizer",
            "iccad-2024-gate-sizing-benchmark",
            "ir-aware-eco-rl",
            "open-llm-eco",
            "iscript-pd-tcl",
        ],
        "policy": {
            "changes_constraints": False,
            "changes_rtl": False,
            "changes_netlist": False,
            "changes_pd_config": False,
            "runs_openroad": False,
            "runs_sta": False,
            "runs_synthesis": False,
            "runs_external_optimizer": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "applies_eco": False,
            "applies_gate_sizing": False,
            "applies_buffer_insertion": False,
            "applies_pin_swapping": False,
            "applies_gate_cloning": False,
            "generates_tcl": False,
            "generates_constraints": False,
            "generates_netlist_patch": False,
            "prediction_generated": False,
            "timing_claim_allowed": False,
            "power_integrity_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "timing_metrics": timing_metrics(metrics_path),
        "timing_report_artifacts": timing_report_artifacts(run_dir),
        "optional_commands": [
            command_entry("openroad"),
            command_entry("sta"),
            command_entry("yosys"),
        ],
        "candidate_actions": [
            {
                "id": "pre-route-slack-prediction-dataset",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "build local timing-label rows from SDC, netlist, DEF/ODB, and STA reports",
                "acceptance_gates": [
                    "python3 scripts/check_pd_closure.py",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "constraint-review-suggestions",
                "status": "CAPTURED_NOT_APPLIED",
                "target": "review SDC completeness and IO-delay assumptions",
                "acceptance_gates": [
                    "make docs-check",
                    "python3 scripts/check_pd_closure.py",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "openroad-resizer-eco-search",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future advisory sweep over repair_design, repair_timing, gate sizing, buffer insertion, pin swapping, and gate cloning knobs",
                "acceptance_gates": [
                    "make openlane-run-preflight-check",
                    "python3 scripts/check_pd_closure.py",
                    "make pd-signoff-manifest-check",
                    "make synth",
                ],
            },
            {
                "id": "ml-gate-sizing-buffer-insertion-watch",
                "status": "CAPTURED_NOT_APPLIED",
                "target": "future ML/RL/differentiable gate sizing and buffer insertion must remain advisory until before/after STA, power, area, DRC, antenna, and routability evidence exists",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_timing_closure_targets.py --run-id validation",
                    "make power-thermal-evidence-check",
                    "make pd-signoff-manifest-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "ast-assisted-cross-stage-parameter-tuning-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future AstroTune-style RTL/AST-assisted retrieval and stage-aware parameter pruning for synthesis, placement, routing, and timing knobs must remain advisory until repeated E1 OpenLane labels exist",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_timing_closure_targets.py --run-id validation",
                    "python3 scripts/check_pd_closure.py",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "timing-tcl-generation-quarantine-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future iScript-style timing-analysis or physical-design Tcl remains advisory until script provenance, command schemas, generated-script quarantine, replay logs, and before/after STA/signoff evidence exist",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id validation",
                    "make no-hardware-action-check",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/check_pd_closure.py",
                ],
            },
            {
                "id": "metal-only-and-post-route-eco-watch",
                "status": "CAPTURED_NOT_MODIFIED",
                "target": "future post-route or metal-only ECO suggestions require localized changed-object manifests and cannot bypass DRC/LVS/antenna/STA/signoff gates",
                "acceptance_gates": [
                    "make pd-signoff-manifest-check",
                    "make manufacturing-artifacts-check",
                    "make real-world-gates-check",
                ],
            },
        ],
        "blocked_by": [
            "no timing predictor trained or calibrated on E1 runs",
            "no version-pinned external timing dataset or model",
            "no approved write-capable ECO command schema",
            "no before/after E1 ECO corpus with gate-sizing, buffer-insertion, pin-swapping, gate-cloning, route, DRC, antenna, STA, and power labels",
            "no AST-derived E1 design retrieval corpus or stage-aware OpenLane parameter replay manifest",
            "no approved iScript-style Tcl command schema, generated-script quarantine, syntax/semantic review, commercial-tool data-handling review, or deterministic replay manifest",
            "no license-reviewed external gate-sizing or ECO optimizer with pinned revisions, seeds, and replay manifests",
            "current report is advisory and cannot waive STA or signoff failures",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    report["policy"]["false_claim_flags"] = dict(sorted(report["policy"].items()))
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.timing_closure.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
