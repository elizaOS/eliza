#!/usr/bin/env python3
"""Validate typed AI-EDA tool-action manifests before write-capable agents."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFESTS = (ROOT / "docs/spec-db/ai-eda/examples/e1-tool-action.example.yaml",)
CLAIM_BOUNDARY = "tool_action_validation_only_no_tool_execution_source_change_or_release_claim"

ALLOWED_ACTION_TYPES = {
    "analysis",
    "metrics_parse",
    "pd_replay",
    "synthesis_replay",
    "verification_replay",
    "training_smoke",
    "asset_fetch_dry_run",
}
ALLOWED_TOOLS = {
    "python_script",
    "make_target",
    "yosys",
    "openroad",
    "openlane",
    "klayout",
    "magic",
    "netgen",
    "qemu",
    "renode",
}
ALLOWED_ARGV0 = {
    "python3",
    "python",
    "make",
    "yosys",
    "openroad",
    "openlane",
    "klayout",
    "magic",
    "netgen",
    "qemu-system-riscv64",
    "renode",
}
ALLOWED_WRITE_PREFIXES = (
    "build/ai_eda/",
    "build/reports/",
    "build/netlist/",
    "build/openlane/",
    "external/repos/",
    "external/datasets/",
    "external/models/",
)
FORBIDDEN_ARG_TOKENS = {";", "&&", "||", "|", ">", ">>", "<", "$(", "`"}


def load_manifest(path: Path) -> dict[str, Any]:
    if path.suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected mapping")
    return data


def is_allowed_write_path(path: str) -> bool:
    clean = path.removeprefix("./")
    return any(clean.startswith(prefix) for prefix in ALLOWED_WRITE_PREFIXES)


def validate_manifest(path: Path, manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    record_id = manifest.get("id", str(path))
    if manifest.get("schema") != "eda.tool_action.v1":
        errors.append(f"{record_id}: schema must be eda.tool_action.v1")
    if manifest.get("action_type") not in ALLOWED_ACTION_TYPES:
        errors.append(f"{record_id}: unsupported action_type {manifest.get('action_type')!r}")
    if manifest.get("tool") not in ALLOWED_TOOLS:
        errors.append(f"{record_id}: unsupported tool {manifest.get('tool')!r}")
    if manifest.get("mode") not in {"dry_run", "proposed", "execute_requested", "executed"}:
        errors.append(f"{record_id}: unsupported mode {manifest.get('mode')!r}")

    claim_boundary = manifest.get("claim_boundary")
    if not isinstance(claim_boundary, str) or "release_claim" not in claim_boundary:
        errors.append(f"{record_id}: claim_boundary must explicitly forbid release claims")
    if not isinstance(claim_boundary, str) or "source_change" not in claim_boundary:
        errors.append(f"{record_id}: claim_boundary must explicitly forbid source changes")

    command = manifest.get("command")
    if not isinstance(command, dict):
        errors.append(f"{record_id}: command must be a mapping")
        argv: list[Any] = []
    else:
        argv = command.get("argv", [])
        cwd = command.get("cwd")
        if not isinstance(cwd, str) or cwd not in {"packages/chip", "."}:
            errors.append(f"{record_id}: command.cwd must be packages/chip or .")
        if not isinstance(argv, list) or not argv:
            errors.append(f"{record_id}: command.argv must be a non-empty list")
            argv = []
        elif str(argv[0]) not in ALLOWED_ARGV0:
            errors.append(f"{record_id}: command argv[0] is not allowlisted: {argv[0]!r}")
    for index, arg in enumerate(argv):
        if not isinstance(arg, str):
            errors.append(f"{record_id}: command.argv[{index}] must be a string")
            continue
        if any(token in arg for token in FORBIDDEN_ARG_TOKENS):
            errors.append(f"{record_id}: command.argv[{index}] contains shell metacharacters")

    read_scope = manifest.get("read_scope")
    if not isinstance(read_scope, list):
        errors.append(f"{record_id}: read_scope must be a list")
    write_scope = manifest.get("write_scope")
    if not isinstance(write_scope, list):
        errors.append(f"{record_id}: write_scope must be a list")
    else:
        for item in write_scope:
            if not isinstance(item, str):
                errors.append(f"{record_id}: write_scope entries must be strings")
            elif not is_allowed_write_path(item):
                errors.append(f"{record_id}: write_scope outside quarantine/build path: {item}")

    for field in ("input_artifacts", "generated_artifacts"):
        value = manifest.get(field)
        if not isinstance(value, list):
            errors.append(f"{record_id}: {field} must be a list")

    approval = manifest.get("approval")
    if not isinstance(approval, dict):
        errors.append(f"{record_id}: approval must be a mapping")
    else:
        approval_required = approval.get("required")
        approval_status = approval.get("status")
        if not isinstance(approval_required, bool):
            errors.append(f"{record_id}: approval.required must be boolean")
        if not isinstance(approval_status, str) or not approval_status:
            errors.append(f"{record_id}: approval.status must be non-empty")
        if (
            manifest.get("mode") in {"execute_requested", "executed"}
            and approval_status != "approved"
        ):
            errors.append(f"{record_id}: execute modes require approval.status=approved")

    execution = manifest.get("execution")
    if not isinstance(execution, dict):
        errors.append(f"{record_id}: execution must be a mapping")
    else:
        dry_run_only = execution.get("dry_run_only")
        if not isinstance(dry_run_only, bool):
            errors.append(f"{record_id}: execution.dry_run_only must be boolean")
        if manifest.get("mode") in {"dry_run", "proposed"} and dry_run_only is not True:
            errors.append(f"{record_id}: dry_run/proposed actions must set dry_run_only=true")
        for field in ("archived_stdout", "archived_stderr"):
            value = execution.get(field)
            if not isinstance(value, str) or not value.startswith("build/ai_eda/"):
                errors.append(f"{record_id}: execution.{field} must be under build/ai_eda/")

    status = manifest.get("status")
    if not isinstance(status, dict):
        errors.append(f"{record_id}: status must be a mapping")
    else:
        if not isinstance(status.get("result"), str) or not status.get("result"):
            errors.append(f"{record_id}: status.result must be non-empty")
        if not isinstance(status.get("blockers"), list):
            errors.append(f"{record_id}: status.blockers must be a list")

    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", action="append", type=Path, default=[])
    parser.add_argument("--manifests-dir", action="append", type=Path, default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifests = list(args.manifest or DEFAULT_MANIFESTS)
    for directory in args.manifests_dir:
        if not directory.exists():
            print(f"STATUS: FAIL ai_eda.tool_action_manifests missing_dir {directory}")
            return 1
        manifests.extend(sorted(directory.glob("*.json")))
        manifests.extend(sorted(directory.glob("*.yaml")))
    if not manifests:
        print("STATUS: FAIL ai_eda.tool_action_manifests no_manifests")
        return 1

    errors: list[str] = []
    for path in manifests:
        if not path.exists():
            errors.append(f"{path}: missing manifest")
            continue
        try:
            errors.extend(validate_manifest(path, load_manifest(path)))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{path}: {exc}")

    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.tool_action_manifests {error}")
        return 1
    print(
        "STATUS: PASS ai_eda.tool_action_manifests "
        f"count={len(manifests)} claim_boundary={CLAIM_BOUNDARY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
