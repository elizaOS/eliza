#!/usr/bin/env python3
"""Capture host prerequisites for E1 formal/equivalence execution.

This is a pre-execution contract. It does not run formal tools and it does not
claim proof coverage. The report records whether the host can run the strict
SymbiYosys path, whether only fallback Yosys evidence is possible, and which
formal specs/scripts/source files are hash-pinned for replay.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/formal_verification_prerequisites"
SCHEMA = "eliza.ai_eda.formal_verification_prerequisites.v1"
CLAIM_BOUNDARY = "formal_verification_prerequisites_only_no_proof_or_release_claim"

REQUIRED_ARTIFACTS = (
    "scripts/run_formal.sh",
    "scripts/yosys_formal_top_structural.ys",
    "scripts/yosys_formal_npu_structural.ys",
    "scripts/yosys_formal_dma.ys",
    "verify/formal/e1_dbg_mmio_bridge.sby",
    "verify/formal/e1_npu.sby",
    "verify/formal/e1_dma.sby",
    "verify/formal/e1_soc_top.sby",
    "verify/formal/e1_dbg_mmio_bridge_formal.sv",
    "verify/formal/e1_npu_formal.sv",
    "verify/formal/e1_dma_formal.sv",
    "verify/formal/e1_soc_top_formal.sv",
    "verify/properties/dma_axil.sby",
    "verify/properties/dma_axil_bind.sv",
    "verify/properties/axi_lite.sv",
    "verify/rtl_gap_work_order.yaml",
)

OPTIONAL_TOOLS = (
    "sby",
    "yosys",
    "yosys-smtbmc",
    "z3",
    "boolector",
    "bitwuzla",
    "abc",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version_for(binary_path: str | None) -> str | None:
    if not binary_path:
        return None
    for flag in ("--version", "-V", "-v"):
        try:
            result = subprocess.run(
                [binary_path, flag],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except Exception:
            continue
        text = (result.stdout or result.stderr).strip()
        if text:
            return text.splitlines()[0][:240]
    return None


def tool_entry(name: str) -> dict[str, Any]:
    found = shutil.which(name)
    return {
        "tool": name,
        "status": "PRESENT" if found else "MISSING",
        "path": found,
        "version": version_for(found),
    }


def artifact_entry(path_text: str) -> dict[str, Any]:
    path = repo_path(path_text)
    return {
        "path": rel(path),
        "required": True,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    artifacts = {path: artifact_entry(path) for path in REQUIRED_ARTIFACTS}
    tools = {name: tool_entry(name) for name in OPTIONAL_TOOLS}
    blockers: list[str] = []

    missing_artifacts = [
        name for name, entry in artifacts.items() if entry["status"] != "PRESENT"
    ]
    if missing_artifacts:
        blockers.append(f"formal prerequisite artifacts missing: {', '.join(missing_artifacts)}")
    if tools["sby"]["status"] != "PRESENT":
        blockers.append("SymbiYosys is not available; strict formal execution is blocked")
    if tools["yosys"]["status"] != "PRESENT":
        blockers.append("Yosys is not available; fallback structural formal is blocked")
    if tools["z3"]["status"] != "PRESENT" and tools["boolector"]["status"] != "PRESENT" and tools["bitwuzla"]["status"] != "PRESENT":
        blockers.append("no SMT solver was detected for SymbiYosys/yosys-smtbmc replay")

    strict_ready = not blockers
    fallback_possible = tools["yosys"]["status"] == "PRESENT" and not missing_artifacts
    status = "READY_FOR_STRICT_FORMAL_HOST" if strict_ready else "BLOCKED_FORMAL_PREREQUISITES"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "formal_proof_claim_allowed": False,
        "status": status,
        "capabilities": {
            "strict_sby_ready": strict_ready,
            "yosys_fallback_possible": fallback_possible,
            "fallback_counts_as_deep_formal": False,
            "runs_formal": False,
            "runs_yosys": False,
            "mutates_source_tree": False,
        },
        "tools": tools,
        "artifacts": artifacts,
        "execution_templates": {
            "fallback_or_shallow": "make PYTHON=python3 formal",
            "strict": "make PYTHON=python3 formal-strict",
            "direct_strict": "REQUIRE_SBY=1 REQUIRE_DEEP_FORMAL=1 scripts/run_formal.sh",
        },
        "required_post_execution_evidence": [
            "build/reports/formal_manifest.json with source hashes",
            "verify/formal/<block>/status for every SBY block in strict mode",
            "verify/formal/<block>/logfile.txt for every SBY block in strict mode",
            "build/reports/e1_*_formal_yosys.log only as fallback evidence",
            "reviewer disposition before any generated assertion, RTL rewrite, or proof claim",
        ],
        "blockers": blockers,
        "next_required_gates": [
            "resolve every blocker before using formal evidence for readiness",
            "run formal-strict for deep formal evidence",
            "treat Yosys fallback as structural smoke only",
            "archive formal_manifest.json and status/log hashes",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "formal_verification_prerequisites.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.formal_verification_prerequisites "
        f"status={status} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
