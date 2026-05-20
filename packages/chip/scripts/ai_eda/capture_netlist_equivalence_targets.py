#!/usr/bin/env python3
"""Capture dry-run netlist equivalence and LEC targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/netlist_equivalence_targets"
CLAIM_BOUNDARY = "netlist_equivalence_target_capture_only_no_lec_or_equivalence_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "Makefile",
    "scripts/run_yosys.sh",
    "scripts/run_formal.sh",
    "scripts/yosys_e1_soc.ys",
    "scripts/yosys_formal_top.ys",
    "scripts/yosys_formal_npu.ys",
    "scripts/yosys_formal_dma.ys",
    "scripts/check_ai_eda_source_inventory.py",
    "scripts/ai_eda/capture_logic_synthesis_targets.py",
    "scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py",
    "scripts/ai_eda/build_local_eda_rag_index.py",
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "rtl/memory/e1_weight_buffer_sram.sv",
    "build/reports/e1_soc_yosys.log",
    "build/netlist/e1_chip_synth.v",
    "build/synth/e1_chip_top.json",
    "build/synth/e1_chip_top.v",
    "pd/openlane/config.sky130.json",
    "pd/signoff/manifest.yaml",
    "docs/evidence/pd/multi-corner-sta-evidence.yaml",
    "docs/evidence/pd/dft-evidence.yaml",
    "docs/evidence/scale/verification-maturity-matrix.yaml",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "eqy",
    "yosys",
    "yosys-smtbmc",
    "sby",
    "abc",
    "circt-lec",
    "z3",
    "boolector",
    "bitwuzla",
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


def report_sample(path: Path, patterns: tuple[str, ...], limit: int = 10) -> list[str]:
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


def openlane_netlist_artifacts(run_dir: Path | None) -> list[dict[str, Any]]:
    if run_dir is None:
        return []
    patterns = (
        "final/verilog/**/*.v",
        "final/sdc/**/*.sdc",
        "reports/signoff/*.rpt",
        "*yosys*/**/*.v",
        "*openroad*/**/*.v",
        "*openroad*/**/*.sdc",
    )
    paths: list[Path] = []
    for pattern in patterns:
        paths.extend(sorted(run_dir.glob(pattern)))
    entries: list[dict[str, Any]] = []
    for path in paths[:32]:
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
                        r"module",
                        r"endmodule",
                        r"assign",
                        r"clock",
                        r"reset",
                        r"warning",
                        r"error",
                        r"equiv",
                        r"lec",
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
    run_dir = latest_openlane_run_dir()
    report = {
        "schema": "eliza.ai_eda.netlist_equivalence_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_LEC_OR_EQUIVALENCE_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "yosys-eqy",
            "yosys-equivalence",
            "symbiyosys-sby",
            "yosys-smtbmc",
            "bitwuzla-smt",
            "boolector-smt",
            "z3-smt",
            "circt-lec",
            "abc",
            "datapath-cec-hybrid-sweeping",
            "dynamicsat-sat-tuning",
            "logic-optimization-csat",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_netlist": False,
            "changes_synthesis_script": False,
            "changes_formal_script": False,
            "changes_constraints": False,
            "changes_pd_config": False,
            "runs_yosys": False,
            "runs_eqy": False,
            "runs_abc": False,
            "runs_circt_lec": False,
            "runs_formal": False,
            "runs_openlane": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "generates_miter": False,
            "generates_equivalence_script": False,
            "generates_proof": False,
            "generates_waiver": False,
            "generates_patch": False,
            "prediction_generated": False,
            "equivalence_claim_allowed": False,
            "timing_claim_allowed": False,
            "qor_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "latest_openlane_run": rel(run_dir) if run_dir else None,
        "openlane_netlist_artifacts": openlane_netlist_artifacts(run_dir),
        "optional_commands": [command_entry(command) for command in OPTIONAL_COMMANDS],
        "candidate_tasks": [
            {
                "id": "rtl-to-synth-netlist-equivalence-watch",
                "status": "CAPTURED_NOT_PROVEN",
                "target": "future RTL-to-synth netlist equivalence must hash RTL, Yosys scripts, formal scripts, generated netlists, solver versions, and result logs before any synthesis or AI optimization claim",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_logic_synthesis_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation",
                    "make synth",
                    "make formal",
                    "make rtl-check",
                    "make cocotb-contract",
                ],
            },
            {
                "id": "smtbmc-proof-replay-watch",
                "status": "CAPTURED_NOT_PROVEN",
                "target": "future SymbiYosys/yosys-smtbmc proof replay must capture exact SBY/SMT inputs, solver revisions, command options, bounds, assumptions, witnesses, counterexamples, logs, and reviewer disposition before accepting generated RTL, assertion, or netlist changes",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id validation",
                    "make formal",
                    "make rtl-check",
                    "make cocotb-contract",
                ],
            },
            {
                "id": "post-pd-netlist-consistency-watch",
                "status": "CAPTURED_NOT_COMPARED",
                "target": "future post-PD netlist comparisons must hash synthesized, floorplan, placement, CTS, routed, and final signoff netlists with matching constraints and OpenLane manifests",
                "acceptance_gates": [
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/check_pd_closure.py",
                    "make power-thermal-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "ai-netlist-or-rtl-rewrite-lec-quarantine",
                "status": "CAPTURED_NOT_ACCEPTED",
                "target": "future AI-generated RTL, netlist, synthesis recipe, or optimization patch remains outside source until before/after equivalence, simulation, synthesis, STA, power, and review gates pass",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
                    "make docs-check",
                    "make platform-contract-check",
                    "make no-hardware-action-check",
                    "make formal",
                    "make synth",
                ],
            },
            {
                "id": "sat-solver-preprocessing-and-tuning-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future DynamicSAT-style solver tuning or logic-optimization CSAT preprocessing must pin miter/CNF/SMT inputs, preprocessing outputs, solver options, baseline logs, tuned logs, witness or counterexample replay, and reviewer disposition before any formal, LEC, or ATPG runtime claim",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id validation",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no dedicated E1 EQY, Yosys equiv_*, CIRCT LEC, or ABC CEC harness is accepted for RTL-to-netlist or post-PD netlist comparisons",
            "no pinned equivalence specification for black boxes, memories, resets, x-propagation, unmapped cells, clocking assumptions, and hierarchy matching",
            "no accepted SymbiYosys/yosys-smtbmc proof replay policy with solver revisions, SMT input hashes, bound/depth settings, witnesses, counterexamples, and cross-solver triage",
            "no approved DynamicSAT or logic-optimization CSAT workflow with solver-patch provenance, SAT instance hashes, preprocessing-output hashes, baseline/tuned logs, witness replay, and timeout policy",
            "no release policy allowing AI-generated netlists, miters, equivalence scripts, waivers, or proof logs to bypass RTL, formal, cocotb, synthesis, STA/OpenLane, power, and review gates",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.netlist_equivalence.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
