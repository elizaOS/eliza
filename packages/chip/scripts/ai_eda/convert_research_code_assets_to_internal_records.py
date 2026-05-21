#!/usr/bin/env python3
"""Convert fetched AI-EDA research-code repos into text instruction records."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
LOCKFILE = ROOT / "external/SOURCES.lock.yaml"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/research_code_assets"
CLAIM_BOUNDARY = (
    "ai_eda_research_code_asset_text_sample_only_no_training_inference_or_release_claim"
)

ASSET_IDS = (
    "chipdiffusion",
    "chipformer",
    "core-placement",
    "maptune",
    "abc-rl",
    "abcrl",
    "rl4ls",
    "mcp4eda",
    "orfs-agent",
    "openroad-agent",
    "openroad-mcp",
    "open3dbench",
    "dreamplace",
)

ASSET_ROLES = {
    "chipdiffusion": "diffusion macro-placement policy and synthetic placement data generation",
    "chipformer": "offline decision-transformer macro-placement policy",
    "core-placement": "EA+RL B*-tree floorplanning search on MCNC/GSRC blocks",
    "maptune": "RL-guided technology-mapping library tuning",
    "abc-rl": "MCTS/GNN logic-synthesis recipe exploration over AIG circuits",
    "abcrl": "REINFORCE/GCN logic-synthesis recipe exploration over AIG/BLIF circuits",
    "rl4ls": "FPGA logic-synthesis recipe search with stable-baselines style RL",
    "mcp4eda": "MCP-mediated RTL-to-GDSII automation and backend-aware synthesis optimization",
    "orfs-agent": "agentic OpenROAD-flow-scripts parameter tuning and flow optimization",
    "openroad-agent": "OpenROAD command/log assistant training and tool-feedback data generation",
    "openroad-mcp": "interactive OpenROAD MCP tool access for audited agent sessions",
    "open3dbench": "OpenROAD-based 3D-IC backend implementation and PPA benchmark transfer",
    "dreamplace": "GPU-accelerated analytical placement baseline and macro-placement reference",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_lock_entries() -> dict[str, dict[str, Any]]:
    data = yaml.safe_load(LOCKFILE.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{LOCKFILE}: expected YAML mapping")
    entries: dict[str, dict[str, Any]] = {}
    for entry in data.get("entries", []):
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            entries[entry["id"]] = entry
    return entries


def payload_path(asset_id: str) -> Path:
    return ROOT / "external/repos" / asset_id / "payload"


def find_readme(payload: Path) -> Path | None:
    for name in ("README.md", "Readme.md", "readme.md", "README.rst", "README.txt", "README"):
        path = payload / name
        if path.is_file():
            return path
    return None


def source_record(path: Path, row_index: int) -> dict[str, Any]:
    return {"path": rel(path), "sha256": sha256_file(path), "row_index": row_index}


def read_text_excerpt(path: Path, limit: int = 4000) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[:limit]


def file_inventory(payload: Path) -> dict[str, Any]:
    files = [
        path for path in sorted(payload.rglob("*")) if path.is_file() and ".git" not in path.parts
    ]
    suffix_counts: Counter[str] = Counter(path.suffix.lower() or "<none>" for path in files)
    key_files = [
        rel(path)
        for path in files
        if path.name in {"README.md", "requirements.txt", "environment.yaml", "Makefile"}
        or path.suffix.lower() in {".bench", ".blif", ".aig", ".genlib", ".lib", ".block", ".nets"}
    ][:80]
    return {
        "file_count": len(files),
        "suffix_counts": dict(sorted(suffix_counts.items())),
        "key_files": key_files,
    }


def asset_record(
    asset_id: str, entry: dict[str, Any], payload: Path, readme: Path, out_dir: Path
) -> list[dict[str, Any]]:
    revision = entry.get("revision")
    revision_value = revision.get("value") if isinstance(revision, dict) else "UNKNOWN"
    inventory = file_inventory(payload)
    role = ASSET_ROLES[asset_id]
    records = [
        {
            "schema": "eda.text_instruction_sample.v1",
            "id": f"{asset_id}.research-readme.000000",
            "asset_id": asset_id,
            "source": source_record(readme, 0),
            "split": "train",
            "task_type": "ai_eda_research_asset_summary",
            "prompt": f"Summarize how {asset_id} can be used in the E1 AI-EDA optimization stack.",
            "response": {
                "kind": "structured_research_asset_summary",
                "content": {
                    "asset_id": asset_id,
                    "name": entry.get("name"),
                    "role": role,
                    "priority": entry.get("priority"),
                    "allowed_use": entry.get("allowed_use"),
                    "e1_lane": entry.get("e1_lane", []),
                    "source_url": entry.get("source_url"),
                    "readme_excerpt": read_text_excerpt(readme),
                    "required_boundary": "advisory until license review, deterministic E1 replay, and human review",
                },
            },
            "provenance": {
                "generated_by": "scripts/ai_eda/convert_research_code_assets_to_internal_records.py",
                "source_revision": str(revision_value),
            },
            "replay": {
                "deterministic_command": "python3 scripts/ai_eda/convert_research_code_assets_to_internal_records.py --run-id <run-id>",
                "expected_report": "build/ai_eda/research_code_assets/<run-id>/conversion_report.json",
            },
            "claim_boundary": CLAIM_BOUNDARY,
        },
        {
            "schema": "eda.text_instruction_sample.v1",
            "id": f"{asset_id}.research-inventory.000001",
            "asset_id": asset_id,
            "source": source_record(
                payload / ".pinned-commit" if (payload / ".pinned-commit").is_file() else readme, 1
            ),
            "split": "train",
            "task_type": "ai_eda_research_asset_inventory",
            "prompt": f"List the reproducibility inputs and blockers for using {asset_id}.",
            "response": {
                "kind": "structured_research_asset_inventory",
                "content": {
                    "asset_id": asset_id,
                    "payload": rel(payload),
                    "inventory": inventory,
                    "blocked_by": [
                        "license and provenance review before release use",
                        "dependency and CUDA environment pinning before remote execution",
                        "train/test contamination review before model-quality claims",
                        "deterministic E1 replay before accepting any optimization candidate",
                    ],
                },
            },
            "provenance": {
                "generated_by": "scripts/ai_eda/convert_research_code_assets_to_internal_records.py",
                "source_revision": str(revision_value),
            },
            "replay": {
                "deterministic_command": "python3 scripts/ai_eda/convert_research_code_assets_to_internal_records.py --run-id <run-id>",
                "expected_report": "build/ai_eda/research_code_assets/<run-id>/conversion_report.json",
            },
            "claim_boundary": CLAIM_BOUNDARY,
        },
    ]
    converted = []
    for record in records:
        path = out_dir / f"{record['id']}.json"
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        converted.append(
            {
                "id": record["id"],
                "asset_id": asset_id,
                "schema": record["schema"],
                "json": rel(path),
                "task_type": record["task_type"],
            }
        )
    return converted


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    entries = load_lock_entries()
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()
    converted: list[dict[str, Any]] = []
    blocked: list[dict[str, str]] = []
    for asset_id in ASSET_IDS:
        entry = entries.get(asset_id)
        payload = payload_path(asset_id)
        readme = find_readme(payload)
        if not entry:
            blocked.append({"asset_id": asset_id, "reason": "missing_lock_entry"})
            continue
        if not payload.is_dir():
            blocked.append({"asset_id": asset_id, "reason": "missing_payload"})
            continue
        if readme is None:
            blocked.append({"asset_id": asset_id, "reason": "missing_readme"})
            continue
        converted.extend(asset_record(asset_id, entry, payload, readme, out_dir))
    report = {
        "schema": "eliza.ai_eda.research_code_assets_conversion_report.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "asset_ids": list(ASSET_IDS),
        "converted_asset_count": len({item["asset_id"] for item in converted}),
        "converted_record_count": len(converted),
        "converted_records": converted,
        "blocked_assets": blocked,
        "policy": {
            "contains_model_weights": False,
            "executes_research_code": False,
            "trains_model": False,
            "runs_inference": False,
            "release_use_allowed": False,
            "e1_signoff_evidence": False,
            "deterministic_replay_required_for_optimization_claims": True,
        },
    }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.research_code_assets_conversion "
        f"assets={report['converted_asset_count']} records={len(converted)} blocked={len(blocked)} report={rel(report_path)}"
    )
    return 0 if not blocked else 2


if __name__ == "__main__":
    raise SystemExit(main())
