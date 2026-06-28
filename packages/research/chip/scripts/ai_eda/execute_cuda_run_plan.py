#!/usr/bin/env python3
"""Dry-run or execute a CUDA AI-EDA run plan.

Default mode is dry-run. It expands the run-id placeholders, classifies stages,
and writes an execution manifest without fetching assets, training, inference,
or EDA execution. Execute mode is intentionally stage-scoped so a reviewed CUDA
host can run one slice at a time without recursively invoking this run-plan
driver or accidentally starting all downloads/training/replay commands.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = ROOT / "build/ai_eda/cuda_training_payloads/validation/cuda_training_run_plan.json"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cuda_run_plan_execution"
CLAIM_BOUNDARY = "cuda_run_plan_execution_manifest_no_unreviewed_training_inference_or_eda_claim"
ORCHESTRATION_SCRIPTS = {
    "scripts/ai_eda/execute_cuda_run_plan.py",
    "scripts/ai_eda/check_cuda_run_plan_execution.py",
}
RISKY_STAGE_ALLOW_FLAGS = {
    "asset_intake": "allow_downloads",
    "training": "allow_training",
    "inference": "allow_inference",
    "replay": "allow_replay",
    "alphachip": "allow_alphachip",
}

STAGE_RULES: tuple[tuple[str, str], ...] = (
    ("bootstrap", "bootstrap_ai_eda_stack.py"),
    ("preflight", "preflight_"),
    ("preflight", "check_backend_preflight.py"),
    ("audit", "ai-eda-cuda-readiness-audit"),
    ("audit", "capture_cuda_readiness_audit.py"),
    ("audit", "check_cuda_readiness_audit.py"),
    ("asset_intake", "fetch_external_asset.py"),
    ("asset_intake", "check_external_"),
    ("rag", "build_local_eda_rag_index.py"),
    ("rag", "check_local_eda_rag_index.py"),
    ("conversion", "convert_"),
    ("conversion", "materialize_"),
    ("conversion", "parse_openlane_metrics_to_flow_run.py"),
    ("conversion", "check_internal_dataset_schemas.py"),
    ("conversion", "check_"),
    ("corpus_manifest", "build_training_corpus_manifest.py"),
    ("corpus_manifest", "check_training_corpus_manifest.py"),
    ("training", "train_"),
    ("training", "run_logic_synthesis_policy_baseline.py"),
    ("inference", "infer_"),
    ("candidate_eval", "evaluate_macro_placement_candidates.py"),
    ("replay", "plan_macro_placement_replay.py"),
    ("replay", "replay_macro_placement_on_e1.py"),
    ("target_capture", "capture_"),
    ("target_capture", "ai-eda-all-target-captures"),
    ("alphachip", "scripts/alphachip/"),
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} root must be a mapping")
    return data


def expand(value: str, run_id: str) -> str:
    return value.replace("<cuda-host>", run_id).replace("<run-id>", run_id)


def classify(command: str) -> str:
    for stage, needle in STAGE_RULES:
        if needle in command:
            return stage
    return "misc"


def is_template(command: str) -> bool:
    return "<asset-id>" in command


def command_script(command: str) -> str | None:
    parts = shlex.split(command)
    if not parts:
        return None
    if parts[0].startswith("python") and len(parts) > 1 and parts[1].endswith(".py"):
        return parts[1]
    if parts[0].startswith("scripts/"):
        return parts[0]
    return None


def execute_command(command: str, timeout_s: int) -> dict[str, Any]:
    started = datetime.now(UTC).replace(microsecond=0).isoformat()
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            shell=True,
            check=False,
            text=True,
            capture_output=True,
            timeout=timeout_s,
        )
        return {
            "started_at_utc": started,
            "returncode": result.returncode,
            "stdout_tail": result.stdout[-4000:],
            "stderr_tail": result.stderr[-4000:],
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "started_at_utc": started,
            "returncode": None,
            "timeout_s": timeout_s,
            "stdout_tail": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
            "stderr_tail": (exc.stderr or "")[-4000:] if isinstance(exc.stderr, str) else "",
            "timed_out": True,
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--stage", action="append", default=[])
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-downloads", action="store_true")
    parser.add_argument("--allow-training", action="store_true")
    parser.add_argument("--allow-inference", action="store_true")
    parser.add_argument("--allow-replay", action="store_true")
    parser.add_argument("--allow-alphachip", action="store_true")
    parser.add_argument("--timeout-s", type=int, default=3600)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.execute and not args.stage:
        raise SystemExit(
            "--execute requires at least one --stage so the CUDA runbook is reviewed in bounded slices"
        )
    plan = load_json(args.plan)
    commands = plan.get("required_remote_commands")
    outputs = plan.get("expected_outputs")
    if not isinstance(commands, list) or not all(isinstance(command, str) for command in commands):
        raise SystemExit("run plan required_remote_commands must be a list of strings")
    if not isinstance(outputs, list) or not all(isinstance(output, str) for output in outputs):
        raise SystemExit("run plan expected_outputs must be a list of strings")

    selected_stages = set(args.stage)
    manifest_commands: list[dict[str, Any]] = []
    failures = 0
    blocked = 0
    executed = 0
    for index, command in enumerate(commands):
        stage = classify(command)
        template = is_template(command)
        selected = not selected_stages or stage in selected_stages
        expanded = expand(command, args.run_id)
        script = command_script(command)
        orchestration = script in ORCHESTRATION_SCRIPTS
        item: dict[str, Any] = {
            "index": index,
            "stage": stage,
            "selected": selected,
            "template": template,
            "orchestration_command": orchestration,
            "original": command,
            "expanded": expanded,
            "script": script,
            "status": "DRY_RUN_SELECTED" if selected and not template else "SKIPPED",
        }
        if template:
            item["status"] = "SKIPPED_TEMPLATE_COMMAND"
        if orchestration and selected:
            item["status"] = "SKIPPED_ORCHESTRATION_COMMAND"
            item["skip_reason"] = (
                "run-plan orchestration commands are not executed from inside the run plan"
            )
        allow_flag = RISKY_STAGE_ALLOW_FLAGS.get(stage)
        if (
            args.execute
            and selected
            and not template
            and not orchestration
            and allow_flag
            and not getattr(args, allow_flag)
        ):
            item["status"] = "BLOCKED_REQUIRES_EXPLICIT_ALLOW"
            item["blocked_reason"] = f"stage {stage!r} requires --{allow_flag.replace('_', '-')}"
            blocked += 1
        if (
            args.execute
            and selected
            and not template
            and not orchestration
            and item["status"] != "BLOCKED_REQUIRES_EXPLICIT_ALLOW"
        ):
            item["status"] = "EXECUTED"
            execution = execute_command(expanded, args.timeout_s)
            item["execution"] = execution
            executed += 1
            if execution.get("returncode") != 0:
                failures += 1
                item["status"] = "FAILED"
        manifest_commands.append(item)

    expanded_outputs = [expand(output, args.run_id) for output in outputs]
    stage_counts: dict[str, int] = {}
    selected_counts: dict[str, int] = {}
    for item in manifest_commands:
        stage = str(item["stage"])
        stage_counts[stage] = stage_counts.get(stage, 0) + 1
        if item["selected"] and not item["template"] and not item.get("orchestration_command"):
            selected_counts[stage] = selected_counts.get(stage, 0) + 1
    executed_stage_counts: dict[str, int] = {}
    for item in manifest_commands:
        if item["status"] == "EXECUTED":
            stage = str(item["stage"])
            executed_stage_counts[stage] = executed_stage_counts.get(stage, 0) + 1

    report = {
        "schema": "eliza.ai_eda.cuda_run_plan_execution.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "execute" if args.execute else "dry-run",
        "run_id": args.run_id,
        "plan": rel(args.plan),
        "plan_schema": plan.get("schema"),
        "claim_boundary": CLAIM_BOUNDARY,
        "claim_allowed": False,
        "release_claim_allowed": False,
        "training_claim_allowed": False,
        "inference_claim_allowed": False,
        "eda_signoff_claim_allowed": False,
        "openlane_execution_claim_allowed": False,
        "policy": {
            "dry_run_default": True,
            "runs_commands": executed > 0,
            "runs_training": executed_stage_counts.get("training", 0) > 0,
            "runs_inference": executed_stage_counts.get("inference", 0) > 0,
            "runs_openlane": False,
            "downloads_assets": executed_stage_counts.get("asset_intake", 0) > 0,
            "release_use_allowed": False,
        },
        "execution_safety": {
            "execute_requires_stage_selection": True,
            "selected_stages": sorted(selected_stages),
            "allow_downloads": bool(args.allow_downloads),
            "allow_training": bool(args.allow_training),
            "allow_inference": bool(args.allow_inference),
            "allow_replay": bool(args.allow_replay),
            "allow_alphachip": bool(args.allow_alphachip),
            "orchestration_commands_skipped": sum(
                1 for item in manifest_commands if item.get("orchestration_command")
            ),
            "blocked_command_count": blocked,
        },
        "command_count": len(manifest_commands),
        "template_command_count": sum(1 for item in manifest_commands if item["template"]),
        "selected_command_count": sum(
            1
            for item in manifest_commands
            if item["selected"] and not item["template"] and not item.get("orchestration_command")
        ),
        "executed_command_count": executed,
        "stage_counts": dict(sorted(stage_counts.items())),
        "selected_stage_counts": dict(sorted(selected_counts.items())),
        "executed_stage_counts": dict(sorted(executed_stage_counts.items())),
        "commands": manifest_commands,
        "expected_outputs": expanded_outputs,
        "failures": failures,
        "blocked": blocked,
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "cuda_run_plan_execution.json"
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    status = "PASS" if failures == 0 and blocked == 0 else "FAIL"
    print(
        f"STATUS: {status} ai_eda.cuda_run_plan_execution "
        f"mode={report['mode']} commands={report['command_count']} selected={report['selected_command_count']} "
        f"report={rel(out_path)}"
    )
    return 0 if failures == 0 and blocked == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
