#!/usr/bin/env python3
"""Capture host prerequisites for deterministic OpenLane/OpenROAD replay.

This is a contract manifest only. It records whether a host has the pinned
inputs, tools, PDK hooks, isolated run-tree policy, and queued candidates needed
before any macro-placement replay may execute.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/openlane_replay_prerequisites"
DEFAULT_QUEUE_ROOT = ROOT / "build/ai_eda/macro_placement_replay_queue"
DEFAULT_RUN_TREE_ROOT = ROOT / "build/ai_eda/openlane_replay_runs"
DEFAULT_OPENLANE_CONFIGS = (
    ROOT / "pd/openlane/config.sky130.json",
    ROOT / "pd/openlane/config.gf180.json",
    ROOT / "pd/openlane/config.ihp-sg13g2.json",
    ROOT / "pd/asap7/config.asap7.yaml",
)
SCHEMA = "eliza.ai_eda.openlane_replay_prerequisites.v1"
CLAIM_BOUNDARY = "openlane_replay_prerequisites_only_no_openlane_execution_or_release_claim"


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


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def version_for(binary_path: str | None) -> str | None:
    if not binary_path:
        return None
    for args in (["--version"], ["-version"], ["-v"]):
        try:
            result = subprocess.run(
                [binary_path, *args],
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


def tool(binary: str) -> dict[str, Any]:
    found = shutil.which(binary)
    return {
        "binary": binary,
        "path": found,
        "available": found is not None,
        "version": version_for(found),
    }


def config_item(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "present": path.is_file(),
        "sha256": sha256_file(path),
    }


def pdk_status() -> dict[str, Any]:
    pdk_root_value = os.environ.get("PDK_ROOT")
    pdk_root = Path(pdk_root_value) if pdk_root_value else None
    return {
        "PDK_ROOT": pdk_root_value,
        "PDK_ROOT_present": bool(pdk_root and pdk_root.exists()),
        "OPENLANE_ROOT": os.environ.get("OPENLANE_ROOT"),
        "PDK": os.environ.get("PDK"),
        "STD_CELL_LIBRARY": os.environ.get("STD_CELL_LIBRARY"),
    }


def queue_summary(queue_path: Path) -> tuple[dict[str, Any], list[str]]:
    queue = load_json(queue_path)
    if queue is None:
        return {
            "path": rel(queue_path),
            "present": False,
            "sha256": None,
            "queue_count": 0,
            "ready_count": 0,
            "blocked_count": 0,
        }, ["macro-placement replay queue is missing"]
    return {
        "path": rel(queue_path),
        "present": True,
        "sha256": sha256_file(queue_path),
        "schema": queue.get("schema"),
        "queue_count": queue.get("queue_count"),
        "ready_count": queue.get("ready_count"),
        "blocked_count": queue.get("blocked_count"),
        "release_use_allowed": queue.get("release_use_allowed"),
    }, []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--queue", type=Path)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-tree-root", type=Path, default=DEFAULT_RUN_TREE_ROOT)
    parser.add_argument("--openlane-bin", default="openlane")
    parser.add_argument("--openroad-bin", default="openroad")
    parser.add_argument("--yosys-bin", default="yosys")
    parser.add_argument("--config", action="append", type=Path, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    queue_path = args.queue or DEFAULT_QUEUE_ROOT / args.run_id / "replay_queue.json"
    configs = args.config or list(DEFAULT_OPENLANE_CONFIGS)
    tools = {
        "openlane": tool(args.openlane_bin),
        "openroad": tool(args.openroad_bin),
        "yosys": tool(args.yosys_bin),
    }
    queue, blockers = queue_summary(repo_path(str(queue_path)))
    config_status = [config_item(repo_path(str(path))) for path in configs]
    pdk = pdk_status()
    run_tree = repo_path(str(args.run_tree_root)) / args.run_id

    if queue.get("schema") not in (None, "eliza.ai_eda.macro_placement_replay_queue.v1"):
        blockers.append("macro-placement replay queue schema mismatch")
    if queue.get("release_use_allowed") not in (None, False):
        blockers.append("macro-placement replay queue must forbid release use")
    if int(queue.get("ready_count") or 0) < 1:
        blockers.append("no replay-queue candidates are ready for deterministic execution")
    for name in ("openlane", "openroad"):
        if not tools[name]["available"]:
            blockers.append(f"{name} executable is not available on PATH")
    if not pdk["PDK_ROOT"]:
        blockers.append("PDK_ROOT is not set")
    elif not pdk["PDK_ROOT_present"]:
        blockers.append("PDK_ROOT does not exist")
    missing_configs = [item["path"] for item in config_status if not item["present"]]
    if missing_configs:
        blockers.append(f"OpenLane config files are missing: {', '.join(missing_configs)}")
    if run_tree.exists():
        blockers.append("isolated replay run tree already exists; choose a fresh run id")

    status = "READY_FOR_REPLAY_PREREQUISITES" if not blockers else "BLOCKED_PREREQUISITES"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "status": status,
        "policy": {
            "runs_openlane": False,
            "runs_openroad": False,
            "mutates_source_tree": False,
            "downloads_assets": False,
            "release_use_allowed": False,
            "signoff_claim_allowed": False,
            "optimization_claim_allowed": False,
        },
        "source_replay_queue": queue,
        "tools": tools,
        "pdk_environment": pdk,
        "openlane_configs": config_status,
        "run_tree": {
            "path": rel(run_tree),
            "must_be_fresh": True,
            "exists": run_tree.exists(),
        },
        "deterministic_execution_template": [
            "python3 scripts/ai_eda/check_macro_placement_replay_queue.py --report "
            f"{queue['path']}",
            "python3 scripts/ai_eda/replay_macro_placement_on_e1.py --run-id "
            f"{args.run_id} --plan build/ai_eda/macro_placement_replay/{args.run_id}/replay_plan.json --execute",
            f"python3 scripts/ai_eda/parse_openlane_metrics_to_flow_run.py --run-id {args.run_id}",
        ],
        "required_post_execution_artifacts": [
            "openlane stdout/stderr logs",
            "OpenROAD logs and command transcript",
            "final metrics.json",
            "final DEF",
            "final GDS",
            "DRC/LVS/antenna reports when the selected PDK flow emits them",
            "replay manifest with SHA256 for candidate, placement case, config, DEF/GDS, and reports",
        ],
        "blockers": blockers,
        "next_required_gates": [
            "resolve every BLOCKED_PREREQUISITES item before passing --execute to replay",
            "run only inside a fresh isolated run tree",
            "archive OpenLane/OpenROAD logs, reports, DEF/GDS, and manifest hashes",
            "compare replayed metrics against baseline before any optimization claim",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "openlane_replay_prerequisites.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.openlane_replay_prerequisites "
        f"status={status} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
