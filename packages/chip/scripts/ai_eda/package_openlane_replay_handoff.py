#!/usr/bin/env python3
"""Package ready macro-placement replay candidates for a PD host.

The package is intentionally evidence-only: it archives the selected replay
queue entries, candidate manifests, placement cases, generated macro placement
overrides, and the exact capture commands a host must run after OpenLane
execution. It does not execute OpenLane/OpenROAD and does not permit an
optimization claim by itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/openlane_replay_handoff"
SCHEMA = "eliza.ai_eda.openlane_replay_handoff.v1"
CLAIM_BOUNDARY = "openlane_replay_handoff_only_no_openlane_execution_or_release_claim"


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


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def artifact(path: Path, kind: str, required: bool = True) -> dict[str, Any]:
    return {
        "kind": kind,
        "path": rel(path),
        "required": required,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size if path.is_file() else None,
    }


def add_artifact(
    artifacts: dict[str, dict[str, Any]], label: str, path_value: str | None, kind: str
) -> None:
    if not path_value:
        artifacts[label] = {
            "kind": kind,
            "path": None,
            "required": True,
            "status": "MISSING",
            "sha256": None,
            "size_bytes": None,
        }
        return
    artifacts[label] = artifact(repo_path(path_value), kind)


def capture_command(
    run_id: str,
    candidate_id: str,
    queue_path: Path,
    preflight_path: Path,
    handoff_path: Path,
) -> str:
    return (
        "python3 scripts/ai_eda/capture_openlane_replay_execution.py "
        f"--run-id {run_id} "
        f"--candidate-id {candidate_id} "
        "--metrics <openlane-run>/final/metrics.json "
        "--openlane-log <openlane-run>/openlane.log "
        "--openroad-log <openlane-run>/openroad.log "
        "--def-file <openlane-run>/final/def/*.def "
        "--gds-file <openlane-run>/final/gds/*.gds "
        f"--replay-queue {rel(queue_path)} "
        f"--replay-preflight {rel(preflight_path)} "
        f"--replay-handoff {rel(handoff_path)}"
    )


def baseline_capture_command(run_id: str) -> str:
    return (
        "python3 scripts/ai_eda/capture_openlane_replay_execution.py "
        f"--run-id {run_id}-baseline "
        "--replay-role baseline "
        "--candidate-id e1-openlane-baseline "
        "--metrics <baseline-openlane-run>/final/metrics.json "
        "--openlane-log <baseline-openlane-run>/openlane.log "
        "--openroad-log <baseline-openlane-run>/openroad.log "
        "--def-file <baseline-openlane-run>/final/def/*.def "
        "--gds-file <baseline-openlane-run>/final/gds/*.gds"
    )


def write_text_artifact(path: Path, content: str, executable: bool = False) -> None:
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def render_runbook(
    handoff_run_id: str,
    source_run_id: str,
    candidates: list[dict[str, Any]],
    replay_queue_path: Path,
    replay_preflight_path: Path,
    handoff_path: Path,
    openlane_config: Path,
) -> str:
    lines = [
        "# OpenLane Replay Handoff Runbook",
        "",
        "This package is handoff evidence only. It does not prove an E1 optimization",
        "until a PD host runs OpenLane/OpenROAD, captures execution evidence, and",
        "compares the candidate against a baseline with no signoff regressions.",
        "",
        f"- Handoff run id: `{handoff_run_id}`",
        f"- Source run id: `{source_run_id}`",
        f"- Replay queue: `{rel(replay_queue_path)}`",
        f"- Replay preflight: `{rel(replay_preflight_path)}`",
        f"- Handoff manifest: `{rel(handoff_path)}`",
        "",
        "## Host prerequisites",
        "",
        "1. `openlane` and `openroad` are on `PATH`.",
        "2. `PDK_ROOT` points at the target PDK.",
        "3. The checkout path is clean or intentionally quarantined for replay.",
        "4. Baseline and candidate OpenLane runs are executed in distinct directories.",
        "",
        "## Candidate replay",
        "",
    ]
    for candidate in candidates:
        macro_cfg = str(candidate.get("macro_placement_cfg") or "")
        command = str(candidate.get("openlane_replay_command") or "")
        lines.extend(
            [
                f"### Candidate {candidate.get('handoff_rank')}: `{candidate.get('candidate_id')}`",
                "",
                f"- Macro placement cfg: `{macro_cfg}`",
                f"- OpenLane command template: `{command}`",
                "- Replace `<openlane-run>` in the capture command with the actual run directory.",
                "",
                "```sh",
                f"export MACRO_PLACEMENT_CFG={shell_quote(macro_cfg)}",
                command,
                str(candidate.get("capture_execution_command")),
                "```",
                "",
            ]
        )
    lines.extend(
        [
            "## Comparison closeout",
            "",
            "Capture the baseline replay execution with `--replay-role baseline`; the baseline",
            "does not need to appear in the candidate handoff package:",
            "",
            "```sh",
            baseline_capture_command(handoff_run_id),
            f"python3 scripts/ai_eda/check_openlane_replay_execution.py --report build/ai_eda/openlane_replay_execution/{handoff_run_id}-baseline/openlane_replay_execution.json",
            "```",
            "",
            "After baseline and candidate execution reports validate, run:",
            "",
            "```sh",
            "python3 scripts/ai_eda/capture_openlane_replay_comparison.py "
            f"--run-id {handoff_run_id} "
            f"--baseline-execution build/ai_eda/openlane_replay_execution/{handoff_run_id}-baseline/openlane_replay_execution.json "
            f"--candidate-execution build/ai_eda/openlane_replay_execution/{handoff_run_id}/openlane_replay_execution.json",
            f"python3 scripts/ai_eda/check_openlane_replay_comparison.py --report build/ai_eda/openlane_replay_comparison/{handoff_run_id}/openlane_replay_comparison.json",
            "```",
            "",
            "Only a validated comparison with `optimization_claim_allowed=true` can feed",
            "the objective-readiness gate as E1 optimization evidence.",
            "",
            f"OpenLane config packaged for reference: `{rel(openlane_config)}`",
            "",
        ]
    )
    return "\n".join(lines)


def render_command_script(
    candidates: list[dict[str, Any]],
    handoff_run_id: str,
    replay_queue_path: Path,
    replay_preflight_path: Path,
) -> str:
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        "# Fill these in with PD-host run directories before executing.",
        "BASELINE_RUN_DIR=${BASELINE_RUN_DIR:-}",
        "CANDIDATE_EXECUTION_JSON=${CANDIDATE_EXECUTION_JSON:-build/ai_eda/openlane_replay_execution/"
        f"{handoff_run_id}/openlane_replay_execution.json}}",
        "",
        'if [ -n "$BASELINE_RUN_DIR" ]; then',
        "  python3 scripts/ai_eda/capture_openlane_replay_execution.py "
        f"--run-id {handoff_run_id}-baseline "
        "--replay-role baseline "
        "--candidate-id e1-openlane-baseline "
        '--metrics "$BASELINE_RUN_DIR/final/metrics.json" '
        '--openlane-log "$BASELINE_RUN_DIR/openlane.log" '
        '--openroad-log "$BASELINE_RUN_DIR/openroad.log" '
        '--def-file "$BASELINE_RUN_DIR/final/def/"*.def '
        '--gds-file "$BASELINE_RUN_DIR/final/gds/"*.gds',
        f"  python3 scripts/ai_eda/check_openlane_replay_execution.py --report build/ai_eda/openlane_replay_execution/{handoff_run_id}-baseline/openlane_replay_execution.json",
        "fi",
        "",
    ]
    for candidate in candidates:
        macro_cfg = str(candidate.get("macro_placement_cfg") or "")
        command = str(candidate.get("openlane_replay_command") or "")
        lines.extend(
            [
                f"# Candidate {candidate.get('handoff_rank')}: {candidate.get('candidate_id')}",
                f"export MACRO_PLACEMENT_CFG={shell_quote(macro_cfg)}",
                f"echo {shell_quote('Run OpenLane candidate: ' + str(candidate.get('candidate_id')))}",
                f"echo {shell_quote(command)}",
                f"echo {shell_quote(str(candidate.get('capture_execution_command')))}",
                "",
            ]
        )
    lines.extend(
        [
            f"BASELINE_EXECUTION_JSON=${{BASELINE_EXECUTION_JSON:-build/ai_eda/openlane_replay_execution/{handoff_run_id}-baseline/openlane_replay_execution.json}}",
            'if [ -n "$CANDIDATE_EXECUTION_JSON" ]; then',
            "  python3 scripts/ai_eda/capture_openlane_replay_comparison.py "
            f"--run-id {handoff_run_id} "
            '--baseline-execution "$BASELINE_EXECUTION_JSON" '
            '--candidate-execution "$CANDIDATE_EXECUTION_JSON"',
            f"  python3 scripts/ai_eda/check_openlane_replay_comparison.py --report build/ai_eda/openlane_replay_comparison/{handoff_run_id}/openlane_replay_comparison.json",
            "fi",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--handoff-run-id", default=None)
    parser.add_argument("--replay-plan", type=Path)
    parser.add_argument("--replay-queue", type=Path)
    parser.add_argument("--replay-preflight", type=Path)
    parser.add_argument(
        "--openlane-config", type=Path, default=ROOT / "pd/openlane/config.sky130.json"
    )
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    handoff_run_id = args.handoff_run_id or args.run_id
    replay_plan_path = args.replay_plan or (
        ROOT / f"build/ai_eda/macro_placement_full_replay/{args.run_id}/replay_plan.json"
    )
    replay_queue_path = args.replay_queue or (
        ROOT / f"build/ai_eda/macro_placement_replay_queue/{args.run_id}/replay_queue.json"
    )
    replay_preflight_path = args.replay_preflight or (
        ROOT
        / f"build/ai_eda/macro_placement_replay_preflight/{args.run_id}/replay_preflight_report.json"
    )
    out_dir = args.out_root / handoff_run_id
    out_dir.mkdir(parents=True, exist_ok=True)

    replay_plan = load_json(repo_path(str(replay_plan_path)))
    replay_queue = load_json(repo_path(str(replay_queue_path)))
    preflight = load_json(repo_path(str(replay_preflight_path)))
    plan_list = [
        item
        for item in replay_plan.get("plans", [])
        if isinstance(item, dict) and isinstance(item.get("candidate_id"), str)
    ]
    plans = {item["candidate_id"]: item for item in plan_list}
    ready_queue = [
        item
        for item in replay_queue.get("queue", [])
        if isinstance(item, dict) and item.get("ready_for_execution") is True
    ]
    ready_queue_by_id = {str(item["candidate_id"]): item for item in ready_queue}
    selected_ids: list[str] = []
    queue_rank: dict[str, int] = {}
    for item in ready_queue:
        candidate_id = str(item["candidate_id"])
        if candidate_id not in selected_ids:
            selected_ids.append(candidate_id)
            queue_rank[candidate_id] = int(item.get("rank", len(queue_rank) + 1))
    for plan in plan_list:
        if len(selected_ids) >= args.limit:
            break
        if plan.get("status") != "READY_FOR_DETERMINISTIC_REPLAY":
            continue
        candidate_id = str(plan["candidate_id"])
        if candidate_id not in selected_ids:
            selected_ids.append(candidate_id)

    blockers: list[str] = []
    if not selected_ids:
        blockers.append("replay plan has no ready candidates")
    if preflight.get("status") not in {"READY_TO_EXECUTE", "BLOCKED_REPLAY_EXECUTION"}:
        blockers.append(f"unexpected replay preflight status: {preflight.get('status')}")

    package_items: dict[str, dict[str, Any]] = {
        "replay_plan": artifact(repo_path(str(replay_plan_path)), "replay_plan"),
        "replay_queue": artifact(repo_path(str(replay_queue_path)), "replay_queue"),
        "replay_preflight": artifact(repo_path(str(replay_preflight_path)), "replay_preflight"),
        "openlane_config": artifact(repo_path(str(args.openlane_config)), "openlane_config"),
    }
    manifest_path = out_dir / "openlane_replay_handoff.json"
    tar_path = out_dir / "openlane_replay_handoff.tar.gz"
    candidates: list[dict[str, Any]] = []
    for index, candidate_id in enumerate(selected_ids, start=1):
        plan = plans.get(candidate_id, {})
        queue_item = ready_queue_by_id.get(candidate_id, {})
        deterministic = (
            queue_item.get("deterministic_replay", {})
            if isinstance(queue_item.get("deterministic_replay"), dict)
            else {}
        )
        prefix = f"candidate_{index}"
        add_artifact(package_items, f"{prefix}_manifest", plan.get("candidate_path"), "candidate")
        add_artifact(
            package_items,
            f"{prefix}_placement_case",
            plan.get("placement_case_path"),
            "placement_case",
        )
        artifacts = plan.get("artifacts", {}) if isinstance(plan.get("artifacts"), dict) else {}
        add_artifact(
            package_items,
            f"{prefix}_macro_cfg",
            artifacts.get("macro_placement_cfg"),
            "macro_placement_cfg",
        )
        add_artifact(
            package_items,
            f"{prefix}_overrides",
            artifacts.get("placement_overrides"),
            "placement_overrides",
        )
        add_artifact(
            package_items, f"{prefix}_tool_action", plan.get("tool_action_manifest"), "tool_action"
        )
        candidates.append(
            {
                "queue_rank": queue_rank.get(candidate_id),
                "handoff_rank": index,
                "candidate_id": candidate_id,
                "placement_case_id": plan.get("placement_case_id"),
                "design_bundle_id": plan.get("design_bundle_id"),
                "macro_placement_cfg": artifacts.get("macro_placement_cfg"),
                "openlane_replay_command": deterministic.get(
                    "placement_case_replay_command",
                    "openlane --config pd/openlane/config.sky130.json",
                ),
                "capture_execution_command": capture_command(
                    handoff_run_id,
                    candidate_id,
                    repo_path(str(replay_queue_path)),
                    repo_path(str(replay_preflight_path)),
                    manifest_path,
                ),
            }
        )

    runbook_path = out_dir / "pd_host_replay_runbook.md"
    commands_path = out_dir / "pd_host_replay_commands.sh"
    write_text_artifact(
        runbook_path,
        render_runbook(
            handoff_run_id,
            args.run_id,
            candidates,
            repo_path(str(replay_queue_path)),
            repo_path(str(replay_preflight_path)),
            manifest_path,
            repo_path(str(args.openlane_config)),
        ),
    )
    write_text_artifact(
        commands_path,
        render_command_script(
            candidates,
            handoff_run_id,
            repo_path(str(replay_queue_path)),
            repo_path(str(replay_preflight_path)),
        ),
        executable=True,
    )
    package_items["pd_host_runbook"] = artifact(runbook_path, "pd_host_runbook")
    package_items["pd_host_command_script"] = artifact(commands_path, "pd_host_command_script")

    missing = [
        f"{label}: {entry.get('path')}"
        for label, entry in package_items.items()
        if entry.get("required") and entry.get("status") != "PRESENT"
    ]
    blockers.extend(f"required handoff artifact missing: {item}" for item in missing)
    status = "HANDOFF_READY_FOR_PD_HOST" if not blockers else "BLOCKED_HANDOFF"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": handoff_run_id,
        "source_run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "optimization_claim_allowed": False,
        "status": status,
        "ready_candidate_count": len(selected_ids),
        "queue_ready_candidate_count": len(ready_queue),
        "pd_host_runbook": rel(runbook_path),
        "pd_host_command_script": rel(commands_path),
        "baseline_openlane_command": "openlane --config pd/openlane/config.sky130.json",
        "baseline_capture_execution_command": baseline_capture_command(handoff_run_id),
        "package_path": rel(tar_path),
        "package_sha256": None,
        "artifacts": package_items,
        "ready_candidates": candidates,
        "pd_host_prerequisites": [
            "openlane executable on PATH",
            "openroad executable on PATH",
            "PDK_ROOT set for the target PDK",
            "isolated OpenLane run directory",
        ],
        "comparison_command": (
            "python3 scripts/ai_eda/capture_openlane_replay_comparison.py "
            f"--run-id {handoff_run_id} "
            "--baseline-execution <baseline-openlane-replay-execution.json> "
            "--candidate-execution <candidate-openlane-replay-execution.json>"
        ),
        "blockers": blockers,
    }
    manifest_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(manifest_path, arcname=rel(manifest_path))
        for entry in package_items.values():
            if entry.get("status") == "PRESENT" and isinstance(entry.get("path"), str):
                tar.add(repo_path(entry["path"]), arcname=entry["path"])
    report["package_sha256"] = sha256_file(tar_path)
    manifest_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.openlane_replay_handoff "
        f"status={status} ready={len(selected_ids)} blockers={len(blockers)} {rel(manifest_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
