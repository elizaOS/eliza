#!/usr/bin/env python3
"""Create a guarded cleanup plan for a completed Nebius robot training run."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def plan_nebius_training_cleanup(
    run_root: Path,
    *,
    instance_id: str,
    disk_id: str | None = None,
    upload_access_key_id: str | None = None,
    allow_before_complete: bool = False,
) -> dict[str, Any]:
    run_root = run_root.resolve()
    closeout = _load_json(run_root / "closeout_status.json")
    finalization = _load_json(run_root / "finalization_report.json")
    inventory = _load_json(run_root / "artifact_inventory.json")
    validation = _load_json(run_root / "validation_report.json")
    training_report = _load_json(run_root / "training_comparison_report.json")
    required_gates = {
        "closeout_status.ok is not true": closeout.get("ok") is True,
        "finalization_report.ok is not true": finalization.get("ok") is True,
        "artifact_inventory.ok is not true": inventory.get("ok") is True,
        "validation_report.ok is not true": validation.get("ok") is True,
        "training_comparison_report.ok is not true": training_report.get("ok")
        is True,
    }
    blockers = [
        label for label, passed in required_gates.items() if passed is not True
    ]
    complete = not blockers
    cleanup_allowed = complete or allow_before_complete
    commands = []
    if upload_access_key_id:
        commands.append(
            {
                "name": "delete_upload_access_key",
                "command": f"nebius iam v2 access-key delete {upload_access_key_id}",
                "destructive": True,
            }
        )
    commands.append(
        {
            "name": "stop_instance",
            "command": f"nebius compute instance stop {instance_id}",
            "destructive": False,
        }
    )
    commands.append(
        {
            "name": "delete_instance",
            "command": f"nebius compute instance delete {instance_id}",
            "destructive": True,
        }
    )
    if disk_id:
        commands.append(
            {
                "name": "confirm_disk_deleted_or_delete_if_unmanaged",
                "command": f"nebius compute disk delete {disk_id}",
                "destructive": True,
            }
        )
    report = {
        "schema": "robot-nebius-training-cleanup-plan-v1",
        "ok": cleanup_allowed,
        "cleanup_allowed": cleanup_allowed,
        "run_root": str(run_root),
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "instance_id": instance_id,
        "disk_id": disk_id,
        "upload_access_key_id": upload_access_key_id,
        "complete": complete,
        "override_used": allow_before_complete and not complete,
        "closeout_ok": closeout.get("ok"),
        "closeout_state": closeout.get("state"),
        "finalization_ok": finalization.get("ok"),
        "artifact_inventory_ok": inventory.get("ok"),
        "validation_ok": validation.get("ok"),
        "training_report_ok": training_report.get("ok"),
        "blockers": blockers,
        "commands": commands if cleanup_allowed else [],
        "held_commands_until_complete": [] if cleanup_allowed else commands,
    }
    _write_json(run_root / "cleanup_plan.json", report)
    write_markdown(report, run_root / "cleanup_plan.md")
    return report


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Nebius Training Cleanup Plan",
        "",
        f"Cleanup allowed: `{report.get('cleanup_allowed')}`",
        f"Complete: `{report.get('complete')}`",
        f"Override used: `{report.get('override_used')}`",
        f"Closeout state: `{report.get('closeout_state')}`",
        f"Closeout ok: `{report.get('closeout_ok')}`",
        f"Finalization ok: `{report.get('finalization_ok')}`",
        f"Artifact inventory ok: `{report.get('artifact_inventory_ok')}`",
        f"Validation ok: `{report.get('validation_ok')}`",
        f"Training report ok: `{report.get('training_report_ok')}`",
        "",
    ]
    blockers = report.get("blockers") or []
    if blockers:
        lines += ["## Blockers", ""]
        lines.extend(f"- {blocker}" for blocker in blockers)
        lines.append("")
    if report.get("override_used"):
        lines += [
            "## Override",
            "",
            "`--allow-before-complete` was used. Commands are emitted even though "
            "one or more completion gates are still failing.",
            "",
        ]
    commands = report.get("commands") or []
    held = report.get("held_commands_until_complete") or []
    lines += ["## Commands", ""]
    if commands:
        lines.extend(f"- `{item['command']}`" for item in commands)
    elif held:
        lines.append("Cleanup commands are held until closeout is complete:")
        lines.extend(f"- `{item['command']}`" for item in held)
    else:
        lines.append("- none")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "run_root",
        type=Path,
        nargs="?",
        default=Path(__file__).resolve().parents[1]
        / "evidence"
        / "nebius_full_training"
        / "synced_run",
    )
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--disk-id")
    parser.add_argument("--upload-access-key-id")
    parser.add_argument("--allow-before-complete", action="store_true")
    args = parser.parse_args(argv)
    report = plan_nebius_training_cleanup(
        args.run_root,
        instance_id=args.instance_id,
        disk_id=args.disk_id,
        upload_access_key_id=args.upload_access_key_id,
        allow_before_complete=args.allow_before_complete,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
