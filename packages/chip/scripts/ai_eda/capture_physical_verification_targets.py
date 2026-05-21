#!/usr/bin/env python3
"""Capture dry-run physical verification, DRC/LVS, and antenna targets for E1."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/physical_verification_targets"
CLAIM_BOUNDARY = "physical_verification_capture_only_no_drc_lvs_or_layout_claim"

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
    "docs/pd/e1_chip_top_antenna_metadata_2026-05-18.md",
    "docs/pd/signoff/klayout_drc_completion_blocker_RUN_2026-05-18_04-00-56.md",
    "docs/pd/signoff/openlane_repairantennas_blocker_RUN_2026-05-19_01-52-14.md",
    "docs/board/antenna-plan.md",
    "docs/evidence/pd/post-route-ppa-validator.yaml",
    "docs/evidence/pd/multi-corner-sta-evidence.yaml",
    "docs/evidence/pd/dft-evidence.yaml",
    "docs/evidence/pd/commercial-eda-gate.yaml",
    "scripts/check_pd_signoff.py",
    "scripts/check_pd_closure.py",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_antenna_metadata.py",
    "scripts/ai_eda/capture_routing_congestion_targets.py",
    "scripts/ai_eda/capture_extraction_parasitic_targets.py",
    "scripts/ai_eda/capture_dfm_yield_lithography_targets.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "klayout",
    "magic",
    "netgen",
    "openroad",
    "openlane",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


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


def latest_openlane_run_dir() -> Path | None:
    metrics = sorted(
        (ROOT / "pd/openlane/runs").glob("RUN_*/final/metrics.json"),
        key=lambda path: path.stat().st_mtime,
    )
    if not metrics:
        return None
    return metrics[-1].parents[1]


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


def physical_verification_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    patterns = (
        "*checkantennas*/**/*.log",
        "*checkantennas*/**/*.rpt",
        "*globalrouting*/antenna.rpt",
        "*detailedrouting*/*.drc",
        "*checker-trdrc*/**/*",
        "*magic-drc*/magic-drc.log",
        "*klayout-drc*/klayout-drc.log",
        "*klayout-drc*/xml_drc_report_to_json.log",
        "*checker-magicdrc*/**/*",
        "*checker-klayoutdrc*/**/*",
        "*netgen-lvs*/netgen-lvs.log",
        "*netgen-lvs*/lvs_script.lvs",
        "*checker-lvs*/**/*",
        "*klayout-xor*/klayout-xor.log",
        "*klayout-streamout*/klayout-streamout.log",
        "final/klayout_gds/**/*",
        "reports/signoff/*.rpt",
    )
    paths: list[Path] = []
    for pattern in patterns:
        paths.extend(sorted(run_dir.glob(pattern)))
    entries: list[dict[str, Any]] = []
    for path in paths[:48]:
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
                        r"drc",
                        r"lvs",
                        r"antenna",
                        r"violation",
                        r"error",
                        r"warning",
                        r"clean",
                        r"fail",
                        r"pass",
                        r"xor",
                        r"mismatch",
                    ),
                ),
            }
        )
    return entries


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_dir = latest_openlane_run_dir()
    report = {
        "schema": "eliza.ai_eda.physical_verification_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_DRC_LVS_OR_LAYOUT_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "autoeda-mcp",
            "klayout-drc",
            "magic-drc-lvs",
            "netgen-lvs",
            "openroad-antenna-check",
            "rule2drc",
            "drc-coder",
            "structural-eda-code-verification",
            "opendrc",
            "posteda-bench",
        ],
        "policy": {
            "changes_layout": False,
            "changes_gds": False,
            "changes_def": False,
            "changes_odb": False,
            "changes_netlist": False,
            "changes_pdk_rules": False,
            "changes_pd_config": False,
            "changes_constraints": False,
            "runs_klayout": False,
            "runs_magic": False,
            "runs_netgen": False,
            "runs_openroad": False,
            "runs_openlane": False,
            "runs_drc": False,
            "runs_lvs": False,
            "runs_xor": False,
            "runs_antenna_check": False,
            "runs_model": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "imports_foundry_data": False,
            "generates_drc_deck": False,
            "generates_drc_fix": False,
            "generates_lvs_waiver": False,
            "generates_antenna_fix": False,
            "generates_tcl": False,
            "generates_patch": False,
            "prediction_generated": False,
            "drc_claim_allowed": False,
            "lvs_claim_allowed": False,
            "antenna_claim_allowed": False,
            "physical_signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "physical_verification_artifacts": physical_verification_artifacts(run_dir),
        "optional_commands": [command_entry(command) for command in OPTIONAL_COMMANDS],
        "candidate_tasks": [
            {
                "id": "autoeda-mcp-physical-verification-service-watch",
                "status": "CAPTURED_NOT_STARTED",
                "target": "future AutoEDA/MCP-EDA physical-verification service calls remain blocked until pinned server revision, service allowlist, DRC/LVS deck provenance, request/response logs, tool stdout/stderr, artifact hashes, and signoff replay exist",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id validation",
                    "make no-hardware-action-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "drc-lvs-antenna-log-triage-watch",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "hash KLayout DRC, Magic DRC, Netgen LVS, XOR, antenna, and checker logs before any AI triage or waiver recommendation is accepted",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_physical_verification_targets.py --run-id validation",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/check_pd_closure.py",
                    "make antenna-metadata-check",
                ],
            },
            {
                "id": "generated-drc-deck-quarantine-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future Rule2DRC or DRC-Coder-style generated DRC scripts remain citation-only until decks are reviewed against process rules and run on pinned layouts",
                "acceptance_gates": [
                    "make docs-check",
                    "make no-hardware-action-check",
                    "make manufacturing-artifacts-check",
                    "make commercial-eda-gate",
                ],
            },
            {
                "id": "structural-eda-code-guardrail-watch",
                "status": "CAPTURED_NOT_VERIFIED",
                "target": "future generated physical-verification scripts must pass structural dependency checks for command scope, artifact prerequisites, rule decks, layouts, and reports before any tool invocation",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make no-hardware-action-check",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "drc-fix-and-waiver-quarantine-watch",
                "status": "CAPTURED_NOT_MODIFIED",
                "target": "future DRC/PPA repair, antenna fixes, LVS waivers, or layout patches may be proposed only after deterministic before/after DRC, LVS, extraction, STA, power, and review evidence",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_routing_congestion_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_extraction_parasitic_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_dfm_yield_lithography_targets.py --run-id validation",
                    "make power-thermal-evidence-check",
                    "make real-world-gates-check",
                ],
            },
        ],
        "blocked_by": [
            "no foundry-approved DRC/LVS/antenna signoff deck, waiver policy, or commercial-signoff correlation for E1",
            "no accepted AI-generated DRC deck, layout repair, antenna fix, or LVS waiver workflow with deterministic before/after artifacts",
            "no approved AutoEDA/MCP-EDA DRC/LVS service path with pinned revision, service allowlist, request/response logs, artifact hashes, sandbox policy, and replay evidence",
            "no approved structural dependency schema, command whitelist, generated-script quarantine, or OpenDRC correlation evidence for physical-verification code generation",
            "no release gate allowing AI physical-verification output to bypass KLayout, Magic, Netgen, OpenROAD/OpenLane, STA, extraction, power, manufacturing, and reviewer gates",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.physical_verification.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
