#!/usr/bin/env python3
"""Capture dry-run extraction, SPEF, and parasitic-analysis targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/extraction_parasitic_targets"
CLAIM_BOUNDARY = "extraction_parasitic_target_capture_only_no_spef_or_signoff_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "pd/openlane/config.sky130.json",
    "pd/openlane/config.gf180.json",
    "pd/openlane/config.ihp-sg13g2.json",
    "pd/openlane/run.sh",
    "pd/signoff/manifest.yaml",
    "docs/evidence/pd/multi-corner-sta-evidence.yaml",
    "docs/evidence/pd/multi-corner-sta-RUN_2026-05-19_05-08-54.json",
    "docs/evidence/pd/post-route-ppa-validator.yaml",
    "docs/evidence/power/pdn-signoff-gate.yaml",
    "docs/pd/signoff/openlane_release_run_monitor_2026-05-19.md",
    "docs/pd/signoff/si-pi/local-gap-report.md",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_pd_closure.py",
    "scripts/check_pd_signoff.py",
    "scripts/ai_eda/capture_timing_closure_targets.py",
    "scripts/ai_eda/capture_routing_congestion_targets.py",
    "scripts/ai_eda/capture_clock_tree_targets.py",
    "build/ai_eda/rag_index/source_manifest.json",
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


def latest_run_dir(metrics_path: Path | None) -> Path | None:
    if metrics_path is None:
        return None
    return metrics_path.parents[1]


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


def extraction_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    patterns = (
        "*openroad-rcx*/**/*.spef",
        "*openroad-rcx*/**/rcx.log",
        "*openroad-rcx*/or_metrics_out.json",
        "*magic-spiceextraction*/e1_*.spice",
        "*magic-spiceextraction*/magic-spiceextraction.log",
        "*magic-spiceextraction*/feedback.txt",
        "*magic-spiceextraction*/feedback.xml",
        "final/spef/**/*.spef",
        "final/spice/*.spice",
        "*openroad-stapostpnr*/**/*.sdf",
        "reports/signoff/sta.rpt",
        "reports/signoff/signoff-corners.yaml",
    )
    paths: list[Path] = []
    for pattern in patterns:
        paths.extend(sorted(run_dir.glob(pattern)))
    entries: list[dict[str, Any]] = []
    for path in paths[:36]:
        if not path.is_file():
            continue
        entries.append(
            {
                "path": rel(path),
                "sha256": sha256_file(path),
                "size_bytes": path.stat().st_size,
                "samples": report_sample(
                    path,
                    (
                        r"spef",
                        r"rcx",
                        r"cap",
                        r"res",
                        r"coupling",
                        r"extract",
                        r"warning",
                        r"error",
                        r"sdf",
                        r"delay",
                    ),
                ),
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
        "schema": "eliza.ai_eda.extraction_parasitic_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_SPEF_OR_EXTRACTION_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "openroad-openrcx",
            "openlane-timing-corners",
            "magic-extraction",
            "capbench",
        ],
        "policy": {
            "changes_layout": False,
            "changes_def": False,
            "changes_odb": False,
            "changes_gds": False,
            "changes_spef": False,
            "changes_sdf": False,
            "changes_spice": False,
            "changes_extraction_rules": False,
            "changes_pd_config": False,
            "runs_openroad": False,
            "runs_openlane": False,
            "runs_rcx": False,
            "runs_magic": False,
            "runs_sta": False,
            "runs_si_analysis": False,
            "runs_model": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "imports_external_dataset": False,
            "generates_spef": False,
            "generates_sdf": False,
            "generates_spice": False,
            "generates_rc_prediction": False,
            "generates_si_waiver": False,
            "generates_tcl": False,
            "generates_patch": False,
            "prediction_generated": False,
            "extraction_claim_allowed": False,
            "timing_claim_allowed": False,
            "si_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "extraction_artifacts": extraction_artifacts(run_dir),
        "optional_commands": [
            command_entry("openroad"),
            command_entry("openlane"),
            command_entry("magic"),
            command_entry("sta"),
        ],
        "candidate_actions": [
            {
                "id": "rcx-spef-artifact-capture",
                "status": "CAPTURED_NOT_EXTRACTED",
                "target": "hash OpenRCX SPEF, RCX logs, SDF, Magic extracted SPICE, signoff STA, and corner manifests for future parasitic-label datasets",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_extraction_parasitic_targets.py --run-id validation",
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/check_pd_closure.py",
                ],
            },
            {
                "id": "ml-capacitance-extraction-watch",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "future CapBench-style ML capacitance extraction may remain advisory only until local E1 extracted labels and held-out error reports exist",
                "acceptance_gates": [
                    "make docs-check",
                    "make no-hardware-action-check",
                    "make pd-signoff-manifest-check",
                    "make power-thermal-evidence-check",
                ],
            },
            {
                "id": "si-aware-timing-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future SI/crosstalk or SPEF-reduction suggestions require PrimeTime/OpenSTA-equivalent replay manifests and cannot waive multi-corner STA",
                "acceptance_gates": [
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "make manufacturing-artifacts-check",
                    "make real-world-gates-check",
                ],
            },
        ],
        "blocked_by": [
            "no held-out E1 parasitic extraction or coupling-capacitance label corpus",
            "no approved write-capable SPEF, SDF, SPICE, extraction-rule, or SI-waiver command schema",
            "no license-reviewed external capacitance-extraction dataset import or model checkpoint",
            "current report is advisory and cannot waive extraction, STA, SI, route, power, or signoff failures",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.extraction_parasitic.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
