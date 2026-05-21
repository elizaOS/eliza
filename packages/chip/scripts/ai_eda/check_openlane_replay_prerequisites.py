#!/usr/bin/env python3
"""Validate OpenLane/OpenROAD replay prerequisite manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT
    / "build/ai_eda/openlane_replay_prerequisites/validation/openlane_replay_prerequisites.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.openlane_replay_prerequisites.v1"
EXPECTED_CLAIM_BOUNDARY = (
    "openlane_replay_prerequisites_only_no_openlane_execution_or_release_claim"
)
FORBIDDEN_TRUE_POLICY = {
    "runs_openlane",
    "runs_openroad",
    "mutates_source_tree",
    "downloads_assets",
    "release_use_allowed",
    "signoff_claim_allowed",
    "optimization_claim_allowed",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("status") not in {
        "READY_FOR_REPLAY_PREREQUISITES",
        "BLOCKED_PREREQUISITES",
    }:
        errors.append(f"unsupported status {report.get('status')!r}")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for key in FORBIDDEN_TRUE_POLICY:
            if policy.get(key) is not False:
                errors.append(f"policy.{key} must be false")

    queue = report.get("source_replay_queue")
    if not isinstance(queue, dict):
        errors.append("source_replay_queue must be a mapping")
    else:
        queue_path = queue.get("path")
        if not isinstance(queue_path, str) or not queue_path:
            errors.append("source_replay_queue.path must be present")
        elif queue.get("present") is True:
            path = repo_path(queue_path)
            if not path.is_file():
                errors.append("source_replay_queue path is missing on disk")
            elif queue.get("sha256") != sha256_file(path):
                errors.append("source_replay_queue sha256 is stale")
        if queue.get("release_use_allowed") not in (None, False):
            errors.append("source_replay_queue.release_use_allowed must be false")
        for field in ("queue_count", "ready_count", "blocked_count"):
            if queue.get(field) is not None and not isinstance(queue.get(field), int):
                errors.append(f"source_replay_queue.{field} must be integer when present")

    tools = report.get("tools")
    if not isinstance(tools, dict):
        errors.append("tools must be a mapping")
    else:
        for name in ("openlane", "openroad"):
            item = tools.get(name)
            if not isinstance(item, dict):
                errors.append(f"tools.{name} must be a mapping")
            elif not isinstance(item.get("available"), bool):
                errors.append(f"tools.{name}.available must be boolean")

    pdk = report.get("pdk_environment")
    if not isinstance(pdk, dict):
        errors.append("pdk_environment must be a mapping")
    elif not isinstance(pdk.get("PDK_ROOT_present"), bool):
        errors.append("pdk_environment.PDK_ROOT_present must be boolean")

    configs = report.get("openlane_configs")
    if not isinstance(configs, list) or not configs:
        errors.append("openlane_configs must be a non-empty list")
    else:
        for index, item in enumerate(configs):
            if not isinstance(item, dict):
                errors.append(f"openlane_configs[{index}] must be a mapping")
                continue
            if not isinstance(item.get("path"), str) or not item["path"]:
                errors.append(f"openlane_configs[{index}].path must be present")
            if not isinstance(item.get("present"), bool):
                errors.append(f"openlane_configs[{index}].present must be boolean")
            if item.get("present") is True:
                path = repo_path(item["path"])
                if not path.is_file():
                    errors.append(f"openlane_configs[{index}] path missing on disk")
                elif item.get("sha256") != sha256_file(path):
                    errors.append(f"openlane_configs[{index}] sha256 is stale")

    run_tree = report.get("run_tree")
    if not isinstance(run_tree, dict):
        errors.append("run_tree must be a mapping")
    else:
        if run_tree.get("must_be_fresh") is not True:
            errors.append("run_tree.must_be_fresh must be true")
        if not isinstance(run_tree.get("exists"), bool):
            errors.append("run_tree.exists must be boolean")

    post = report.get("required_post_execution_artifacts")
    if not isinstance(post, list) or not all(isinstance(item, str) for item in post):
        errors.append("required_post_execution_artifacts must be a string list")
    else:
        joined = " ".join(post).lower()
        for token in ("metrics", "def", "gds", "logs", "sha256"):
            if token not in joined:
                errors.append(f"required_post_execution_artifacts must mention {token}")

    commands = report.get("deterministic_execution_template")
    if not isinstance(commands, list) or not any(
        isinstance(command, str) and "--execute" in command for command in commands
    ):
        errors.append("deterministic_execution_template must include explicit --execute command")

    blockers = report.get("blockers")
    if report.get("status") == "BLOCKED_PREREQUISITES" and not blockers:
        errors.append("blocked prerequisite report must list blockers")
    if report.get("status") == "READY_FOR_REPLAY_PREREQUISITES" and blockers:
        errors.append("ready prerequisite report must not list blockers")
    gates = report.get("next_required_gates")
    if not isinstance(gates, list) or len(gates) < 3:
        errors.append("next_required_gates must list replay follow-up gates")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(
            f"STATUS: FAIL ai_eda.openlane_replay_prerequisites missing_report {rel(args.report)}"
        )
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.openlane_replay_prerequisites {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.openlane_replay_prerequisites {error}")
        return 1
    status = "PASS_BLOCKED" if report["status"] == "BLOCKED_PREREQUISITES" else "PASS"
    print(
        "STATUS: "
        f"{status} ai_eda.openlane_replay_prerequisites "
        f"status={report['status']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
