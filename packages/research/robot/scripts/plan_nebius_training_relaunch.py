#!/usr/bin/env python3
"""Assess whether a clean Nebius full-training relaunch is ready.

This does not create or destroy cloud resources. It combines the regenerated
launch bundle contract with the current run closeout/runtime state so a relaunch
cannot accidentally proceed with stale preflight evidence, unsafe cloud-init, or
an already-running production attempt that has not been intentionally handled.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from scripts.validate_end_to_end_full_training_preflight import validate_bundle


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


def plan_nebius_training_relaunch(
    *,
    run_root: Path,
    bundle_dir: Path,
    current_run_id: str | None = None,
    current_instance_id: str | None = None,
    allow_parallel: bool = False,
    allow_before_hard_cap: bool = False,
) -> dict[str, Any]:
    run_root = run_root.resolve()
    bundle_dir = bundle_dir.resolve()
    closeout = _load_json(run_root / "closeout_status.json")
    runtime = _load_json(run_root / "runtime_watch.json")
    cleanup = _load_json(run_root / "cleanup_plan.json")
    preflight = validate_bundle(bundle_dir)
    launch_hygiene = (
        preflight.get("launch_hygiene")
        if isinstance(preflight.get("launch_hygiene"), dict)
        else {}
    )
    closeout_state = closeout.get("state")
    active_running = closeout_state == "running"
    hard_cap_exceeded = runtime.get("hard_cap_exceeded") is True
    stale = runtime.get("stale") is True
    cleanup_allowed = cleanup.get("cleanup_allowed") is True
    blockers = {
        "preflight_bundle_not_ready": preflight.get("ok") is True,
        "launch_template_hygiene_not_ready": launch_hygiene.get("ok") is True,
        "current_run_already_complete": closeout.get("ok") is not True,
        "active_run_still_running_without_parallel_override": (
            not active_running or hard_cap_exceeded or allow_parallel
        ),
        "active_run_before_hard_cap_without_override": (
            not active_running or hard_cap_exceeded or allow_before_hard_cap
        ),
    }
    failed = [name for name, passed in blockers.items() if passed is not True]
    relaunch_ready = not failed
    if relaunch_ready:
        recommendation = "ready_to_launch_clean_run"
    elif active_running and not hard_cap_exceeded and not allow_parallel:
        recommendation = "do_not_launch_parallel_run"
    elif active_running and not hard_cap_exceeded and not allow_before_hard_cap:
        recommendation = "wait_for_hard_cap_or_use_explicit_override"
    else:
        recommendation = "fix_relaunch_blockers"
    report = {
        "schema": "robot-nebius-training-relaunch-plan-v1",
        "ok": relaunch_ready,
        "relaunch_ready": relaunch_ready,
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "run_root": str(run_root),
        "bundle_dir": str(bundle_dir),
        "current_run_id": current_run_id,
        "current_instance_id": current_instance_id,
        "allow_parallel": bool(allow_parallel),
        "allow_before_hard_cap": bool(allow_before_hard_cap),
        "recommendation": recommendation,
        "blockers": failed,
        "active_run": {
            "closeout_state": closeout_state,
            "closeout_ok": closeout.get("ok"),
            "stale": stale,
            "hard_cap_exceeded": hard_cap_exceeded,
            "elapsed_hours": runtime.get("elapsed_hours"),
            "hours_until_hard_cap": runtime.get("hours_until_hard_cap"),
            "cleanup_allowed": cleanup_allowed,
        },
        "preflight": {
            "ok": preflight.get("ok"),
            "checks": preflight.get("checks"),
            "launch_template": preflight.get("launch_template"),
            "launch_hygiene": {
                "ok": launch_hygiene.get("ok"),
                "checks": launch_hygiene.get("checks"),
                "secret_fields_embedded": launch_hygiene.get(
                    "secret_fields_embedded", []
                ),
            },
        },
        "next_actions": _next_actions(
            relaunch_ready=relaunch_ready,
            active_running=active_running,
            allow_parallel=allow_parallel,
            hard_cap_exceeded=hard_cap_exceeded,
            allow_before_hard_cap=allow_before_hard_cap,
            current_instance_id=current_instance_id,
            bundle_dir=bundle_dir,
        ),
    }
    _write_json(run_root / "relaunch_plan.json", report)
    write_markdown(report, run_root / "relaunch_plan.md")
    return report


def _next_actions(
    *,
    relaunch_ready: bool,
    active_running: bool,
    allow_parallel: bool,
    hard_cap_exceeded: bool,
    allow_before_hard_cap: bool,
    current_instance_id: str | None,
    bundle_dir: Path,
) -> list[str]:
    if relaunch_ready:
        actions = []
        if active_running and hard_cap_exceeded and current_instance_id:
            actions.append(
                f"Stop or replace hard-cap-exceeded active instance {current_instance_id} before creating the clean run."
            )
        actions.extend([
            f"Package and upload repo payload with {bundle_dir}/nebius_instance_launch_template.json.",
            "Inject object-storage credentials outside VM metadata on the host.",
            "Create a new Nebius H200 instance from the validated template.",
        ])
        return actions
    actions = []
    if active_running and not allow_parallel:
        actions.append(
            "Do not launch a parallel H200 run unless --allow-parallel is explicitly set."
        )
    if active_running and not hard_cap_exceeded and not allow_before_hard_cap:
        actions.append(
            "Continue polling until the active run completes or reaches the hard cap, or use --allow-before-hard-cap intentionally."
        )
    if current_instance_id and active_running:
        actions.append(
            f"Inspect active instance {current_instance_id} before stopping or replacing it."
        )
    actions.append("Fix any failed preflight or launch-hygiene checks before relaunch.")
    return actions


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Nebius Training Relaunch Plan",
        "",
        f"Relaunch ready: `{report.get('relaunch_ready')}`",
        f"Recommendation: `{report.get('recommendation')}`",
        f"Generated: `{report.get('generated_at')}`",
        f"Current run: `{report.get('current_run_id') or 'unknown'}`",
        f"Current instance: `{report.get('current_instance_id') or 'unknown'}`",
        "",
        "## Active Run",
        "",
    ]
    active = report.get("active_run") if isinstance(report.get("active_run"), dict) else {}
    for name in (
        "closeout_state",
        "closeout_ok",
        "stale",
        "hard_cap_exceeded",
        "elapsed_hours",
        "hours_until_hard_cap",
        "cleanup_allowed",
    ):
        lines.append(f"- {name}: `{active.get(name)}`")
    blockers = report.get("blockers") or []
    lines += ["", "## Blockers", ""]
    lines.extend(f"- `{blocker}`" for blocker in blockers) if blockers else lines.append("- none")
    lines += ["", "## Next Actions", ""]
    actions = report.get("next_actions") or []
    lines.extend(f"- {action}" for action in actions) if actions else lines.append("- none")
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
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "evidence"
        / "full_training_preflight",
    )
    parser.add_argument("--current-run-id")
    parser.add_argument("--current-instance-id")
    parser.add_argument("--allow-parallel", action="store_true")
    parser.add_argument("--allow-before-hard-cap", action="store_true")
    args = parser.parse_args(argv)
    report = plan_nebius_training_relaunch(
        run_root=args.run_root,
        bundle_dir=args.bundle_dir,
        current_run_id=args.current_run_id,
        current_instance_id=args.current_instance_id,
        allow_parallel=args.allow_parallel,
        allow_before_hard_cap=args.allow_before_hard_cap,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
