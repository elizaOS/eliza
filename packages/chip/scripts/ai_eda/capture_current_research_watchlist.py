#!/usr/bin/env python3
"""Capture a dry-run report for the current AI-EDA research watchlist."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WATCHLIST = (
    ROOT
    / "research/alpha_chip_macro_placement/01_sources/ai_eda_current_research_watchlist_2026.yaml"
)
INVENTORY = ROOT / "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/current_research_watchlist"
CLAIM_BOUNDARY = "current_research_watchlist_capture_only_no_import_training_inference_or_e1_claim"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "training_claim_allowed": False,
    "inference_claim_allowed": False,
    "e1_optimization_claim_allowed": False,
    "e1_signoff_claim_allowed": False,
    "ppa_signoff_claim_allowed": False,
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} root must be a mapping")
    return data


def artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--watchlist", type=Path, default=DEFAULT_WATCHLIST)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    watchlist = load_yaml(args.watchlist)
    inventory = load_yaml(INVENTORY)
    inventory_ids = {
        entry.get("id")
        for entry in inventory.get("entries", [])
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }
    entries = watchlist.get("entries")
    if not isinstance(entries, list) or not entries:
        raise SystemExit("watchlist entries must be a non-empty list")

    missing_inventory_ids = sorted(
        entry["id"]
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("id"), str)
        and entry["id"] not in inventory_ids
    )
    candidate_tasks = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise SystemExit("watchlist entry must be a mapping")
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            raise SystemExit("watchlist entry missing id")
        candidate_tasks.append(
            {
                "id": f"{entry_id}-intake",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": entry.get("e1_action", ""),
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make ai-eda-source-inventory-check",
                    "make ai-eda-all-target-captures",
                    "make docs-check",
                ],
                "source_url": entry.get("source_url"),
                "required_evidence": entry.get("required_evidence"),
                "priority": entry.get("priority"),
                "lane": entry.get("lane"),
                "public_code_status": entry.get("public_code_status"),
            }
        )

    report = {
        "schema": "eliza.ai_eda.current_research_watchlist.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_CURRENT_RESEARCH_NO_IMPORT",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "source_ids": [task["id"].removesuffix("-intake") for task in candidate_tasks],
        "policy": {
            "changes_rtl": False,
            "changes_source": False,
            "changes_constraints": False,
            "changes_pd_config": False,
            "changes_layout": False,
            "changes_training_data": False,
            "generates_embeddings": False,
            "generates_layout": False,
            "runs_inference": False,
            "runs_llm": False,
            "runs_ml_model": False,
            "runs_synthesis": False,
            "runs_place_and_route": False,
            "runs_signoff": False,
            "trains_model": False,
            "finetunes_model": False,
            "downloads_external_assets": False,
            "downloads_model_weights": False,
            "calls_external_api": False,
            "imports_external_corpus": False,
            "prediction_generated": False,
            "release_use_allowed": False,
            "design_decision_claim_allowed": False,
        },
        "input_artifacts": [artifact(args.watchlist), artifact(INVENTORY)],
        "optional_backends": {
            "commands": [
                {"command": "openroad", "status": "MISSING", "path": None},
                {"command": "openlane", "status": "MISSING", "path": None},
                {"command": "python3", "status": "PRESENT", "path": "python3"},
            ],
            "python_modules": [
                {"module": "yaml", "status": "PRESENT"},
                {"module": "torch", "status": "MISSING"},
            ],
        },
        "candidate_tasks": candidate_tasks,
        "blocked_by": [
            "watchlist methods are metadata-only until code/data licenses and revisions are reviewed",
            "no current-research method output is accepted without deterministic E1 OpenLane/OpenROAD replay",
            "no model, hosted VLM, or coding-agent execution is approved from this capture",
            "no placement, routing, timing, signoff, or release claim is made by this watchlist",
        ],
        "missing_inventory_ids": missing_inventory_ids,
    }

    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "targets_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if missing_inventory_ids:
        print(
            "STATUS: FAIL ai_eda.current_research_watchlist "
            f"missing_inventory_ids={','.join(missing_inventory_ids)} {rel(report_path)}"
        )
        return 1
    print(
        "STATUS: PASS ai_eda.current_research_watchlist "
        f"entries={len(entries)} claim_boundary={CLAIM_BOUNDARY} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
