#!/usr/bin/env python3
"""Capture a machine-readable CUDA handoff readiness audit."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cuda_readiness_audit"
CLAIM_BOUNDARY = "cuda_readiness_audit_only_no_training_inference_signoff_or_release_claim"
RUN_PLAN_EXECUTION_SCHEMA = "eliza.ai_eda.cuda_run_plan_execution.v1"
RUN_PLAN_SAFETY_MATRIX_SCHEMA = "eliza.ai_eda.cuda_run_plan_safety_matrix.v1"
REPLAY_QUEUE_SCHEMA = "eliza.ai_eda.macro_placement_replay_queue.v1"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must contain a JSON object")
    return data


def artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
    }


def has_command(plan: dict[str, Any] | None, needle: str) -> bool:
    if not plan:
        return False
    commands = plan.get("required_remote_commands")
    return isinstance(commands, list) and any(
        isinstance(command, str) and needle in command for command in commands
    )


def has_output(plan: dict[str, Any] | None, expected: str) -> bool:
    if not plan:
        return False
    outputs = plan.get("expected_outputs")
    return isinstance(outputs, list) and expected in outputs


def run_plan_execution_ready(report: dict[str, Any] | None, run_id: str) -> tuple[bool, str]:
    if report is None:
        return False, "missing execution report"
    if report.get("schema") != RUN_PLAN_EXECUTION_SCHEMA:
        return False, "schema mismatch"
    if report.get("mode") != "dry-run":
        return False, f"mode={report.get('mode')}"
    if report.get("failures") != 0 or report.get("blocked") != 0:
        return False, f"failures={report.get('failures')} blocked={report.get('blocked')}"
    if not isinstance(report.get("commands"), list) or not report["commands"]:
        return False, "no commands recorded"
    if int(report.get("selected_command_count", 0)) <= 0:
        return False, "no selected commands recorded"
    outputs = report.get("expected_outputs")
    expected_execution_output = (
        f"build/ai_eda/cuda_run_plan_execution/{run_id}/cuda_run_plan_execution.json"
    )
    if not isinstance(outputs, list) or expected_execution_output not in outputs:
        return False, "dry-run manifest does not carry expanded execution output"
    return True, "validated dry-run execution manifest"


def run_plan_safety_matrix_ready(report: dict[str, Any] | None) -> tuple[bool, str]:
    if report is None:
        return False, "missing safety matrix report"
    if report.get("schema") != RUN_PLAN_SAFETY_MATRIX_SCHEMA:
        return False, "schema mismatch"
    if report.get("failures") not in ([], None):
        return False, f"failures={report.get('failures')}"
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        return False, "no safety checks recorded"
    failed = [
        check for check in checks if isinstance(check, dict) and check.get("status") != "PASS"
    ]
    if failed:
        return False, f"failed_checks={len(failed)}"
    risky = report.get("risky_stages")
    if not isinstance(risky, dict) or not risky:
        return False, "risky stages not recorded"
    return True, "validated stage-selection and risky-stage blocking matrix"


def replay_queue_ready(report: dict[str, Any] | None) -> tuple[bool, str]:
    if report is None:
        return False, "missing replay queue report"
    if report.get("schema") != REPLAY_QUEUE_SCHEMA:
        return False, "schema mismatch"
    if report.get("release_use_allowed") is not False:
        return False, "release_use_allowed must be false"
    queue = report.get("queue")
    if not isinstance(queue, list) or not queue:
        return False, "queue is empty"
    if report.get("queue_count") != len(queue):
        return False, "queue_count mismatch"
    if report.get("missing_from_replay") not in ([], None):
        return False, "queue has candidates missing from replay plan"
    if not isinstance(report.get("blocked_count"), int) or not isinstance(
        report.get("ready_count"), int
    ):
        return False, "ready/blocked counts missing"
    return True, "validated deterministic replay queue"


def blocker(
    blocker_id: str, severity: str, detail: str, evidence: str | None = None
) -> dict[str, str]:
    item = {"id": blocker_id, "severity": severity, "detail": detail}
    if evidence:
        item["evidence"] = evidence
    return item


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument(
        "--preflight-run-id",
        default=None,
        help="Run id for CUDA preflight evidence; defaults to --run-id.",
    )
    parser.add_argument(
        "--payload-run-id",
        default=None,
        help="Run id for CUDA payload and embedded run-plan evidence; defaults to --run-id.",
    )
    parser.add_argument(
        "--run-plan-execution-run-id",
        default=None,
        help="Run id for dry-run execution evidence; defaults to --payload-run-id.",
    )
    parser.add_argument(
        "--run-plan-safety-run-id",
        default=None,
        help="Run id for run-plan safety-matrix evidence; defaults to --payload-run-id.",
    )
    parser.add_argument(
        "--alphachip-run-id",
        default=None,
        help="Run id for AlphaChip checkpoint blocker evidence; defaults to --run-id.",
    )
    parser.add_argument(
        "--watchlist-run-id",
        default=None,
        help="Run id for current-research watchlist evidence; defaults to --run-id.",
    )
    parser.add_argument(
        "--replay-preflight-run-id",
        default=None,
        help="Run id for E1 replay-preflight evidence; defaults to --run-id.",
    )
    parser.add_argument(
        "--setup-run-id",
        default=None,
        help="Run id for the setup-check bootstrap evidence; defaults to --run-id.",
    )
    parser.add_argument(
        "--training-handoff-run-id",
        default=None,
        help="Run id for the training-handoff bootstrap evidence; defaults to '<run-id>-training-handoff'.",
    )
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_id = args.run_id
    preflight_run_id = args.preflight_run_id or run_id
    payload_run_id = args.payload_run_id or run_id
    run_plan_execution_run_id = args.run_plan_execution_run_id or payload_run_id
    run_plan_safety_run_id = args.run_plan_safety_run_id or payload_run_id
    alphachip_run_id = args.alphachip_run_id or run_id
    watchlist_run_id = args.watchlist_run_id or run_id
    replay_preflight_run_id = args.replay_preflight_run_id or run_id
    setup_run_id = args.setup_run_id or run_id
    training_handoff_run_id = args.training_handoff_run_id or f"{run_id}-training-handoff"
    preflight_path = (
        ROOT
        / f"build/ai_eda/cuda_training_preflight/{preflight_run_id}/cuda_training_preflight.json"
    )
    payload_report_path = (
        ROOT
        / f"build/ai_eda/cuda_training_payloads/{payload_run_id}/cuda_training_payload_report.json"
    )
    run_plan_path = (
        ROOT / f"build/ai_eda/cuda_training_payloads/{payload_run_id}/cuda_training_run_plan.json"
    )
    run_plan_execution_path = (
        ROOT
        / f"build/ai_eda/cuda_run_plan_execution/{run_plan_execution_run_id}/cuda_run_plan_execution.json"
    )
    run_plan_safety_matrix_path = (
        ROOT
        / f"build/ai_eda/cuda_run_plan_safety_matrix/{run_plan_safety_run_id}/cuda_run_plan_safety_matrix.json"
    )
    alphachip_path = (
        ROOT
        / f"build/ai_eda/alphachip_checkpoint_blocker/{alphachip_run_id}/alphachip_checkpoint_blocker_audit.json"
    )
    watchlist_path = (
        ROOT / f"build/ai_eda/current_research_watchlist/{watchlist_run_id}/targets_report.json"
    )
    replay_path = (
        ROOT
        / f"build/ai_eda/macro_placement_replay_preflight/{replay_preflight_run_id}/replay_preflight_report.json"
    )
    setup_bootstrap_path = ROOT / f"build/ai_eda/bootstrap/{setup_run_id}/bootstrap_report.json"
    training_handoff_bootstrap_path = (
        ROOT / f"build/ai_eda/bootstrap/{training_handoff_run_id}/bootstrap_report.json"
    )
    torch_training_path = (
        ROOT
        / f"build/ai_eda/macro_placement_torch_regressor/{training_handoff_run_id}/torch_training_run.json"
    )
    torch_inference_path = (
        ROOT
        / f"build/ai_eda/macro_placement_torch_inference/{training_handoff_run_id}/torch_inference_run.json"
    )
    full_replay_path = (
        ROOT
        / f"build/ai_eda/macro_placement_full_replay/{training_handoff_run_id}/replay_plan.json"
    )
    replay_queue_path = (
        ROOT
        / f"build/ai_eda/macro_placement_replay_queue/{training_handoff_run_id}/replay_queue.json"
    )
    training_handoff_payload_path = (
        ROOT
        / f"build/ai_eda/cuda_training_payloads/{training_handoff_run_id}/cuda_training_payload_report.json"
    )

    preflight = load_json(preflight_path)
    payload_report = load_json(payload_report_path)
    run_plan = load_json(run_plan_path)
    run_plan_execution = load_json(run_plan_execution_path)
    run_plan_safety_matrix = load_json(run_plan_safety_matrix_path)
    alphachip = load_json(alphachip_path)
    watchlist = load_json(watchlist_path)
    replay = load_json(replay_path)
    setup_bootstrap = load_json(setup_bootstrap_path)
    training_handoff_bootstrap = load_json(training_handoff_bootstrap_path)
    torch_training = load_json(torch_training_path)
    torch_inference = load_json(torch_inference_path)
    full_replay = load_json(full_replay_path)
    replay_queue = load_json(replay_queue_path)
    training_handoff_payload = load_json(training_handoff_payload_path)

    blockers: list[dict[str, str]] = []
    if preflight is None:
        blockers.append(
            blocker(
                "missing_cuda_preflight",
                "hard",
                "CUDA preflight report is missing",
                rel(preflight_path),
            )
        )
    elif not preflight.get("cuda", {}).get("large_training_ready"):
        cuda = preflight.get("cuda", {})
        blockers.append(
            blocker(
                "cuda_large_training_not_ready",
                "hard",
                "Host is not ready for large CUDA training according to preflight",
                f"cuda.available={cuda.get('available')} large_training_ready={cuda.get('large_training_ready')}",
            )
        )

    if payload_report is None or run_plan is None:
        blockers.append(
            blocker(
                "missing_cuda_payload",
                "hard",
                "CUDA payload report or run plan is missing",
                rel(payload_report_path),
            )
        )
        payload_ready = False
    else:
        payload_path = ROOT / str(payload_report.get("payload", ""))
        payload_ready = payload_path.is_file() and bool(
            payload_report.get("included_file_count", 0)
        )
        if not payload_ready:
            blockers.append(
                blocker(
                    "payload_tarball_missing",
                    "hard",
                    "CUDA payload tarball is missing or empty",
                    rel(payload_path),
                )
            )
        if not has_command(run_plan, "ai-eda-all-target-captures"):
            blockers.append(
                blocker(
                    "run_plan_missing_target_capture_gate",
                    "hard",
                    "Run plan lacks all-target capture gate",
                )
            )
        if not has_command(run_plan, "ai-eda-cuda-readiness-audit"):
            blockers.append(
                blocker(
                    "run_plan_missing_readiness_audit",
                    "hard",
                    "Run plan lacks readiness audit gate",
                )
            )
        if not has_output(
            run_plan, "build/ai_eda/cuda_readiness_audit/<run-id>/cuda_readiness_audit.json"
        ):
            blockers.append(
                blocker(
                    "run_plan_missing_readiness_output",
                    "hard",
                    "Run plan lacks readiness audit expected output",
                )
            )
        if not has_command(run_plan, "execute_cuda_run_plan.py"):
            blockers.append(
                blocker(
                    "run_plan_missing_dry_run_executor",
                    "hard",
                    "Run plan lacks its dry-run executor command",
                )
            )
        if not has_command(run_plan, "check_cuda_run_plan_execution.py"):
            blockers.append(
                blocker(
                    "run_plan_missing_dry_run_checker",
                    "hard",
                    "Run plan lacks its dry-run checker command",
                )
            )
        if not has_command(run_plan, "check_cuda_run_plan_safety_matrix.py"):
            blockers.append(
                blocker(
                    "run_plan_missing_safety_matrix_checker",
                    "hard",
                    "Run plan lacks its safety-matrix checker command",
                )
            )
        if not has_output(
            run_plan, "build/ai_eda/cuda_run_plan_execution/<run-id>/cuda_run_plan_execution.json"
        ):
            blockers.append(
                blocker(
                    "run_plan_missing_dry_run_output",
                    "hard",
                    "Run plan lacks dry-run execution expected output",
                )
            )
        if not has_output(
            run_plan,
            "build/ai_eda/cuda_run_plan_safety_matrix/<run-id>/cuda_run_plan_safety_matrix.json",
        ):
            blockers.append(
                blocker(
                    "run_plan_missing_safety_matrix_output",
                    "hard",
                    "Run plan lacks safety-matrix expected output",
                )
            )
        if not has_command(run_plan, "select_macro_placement_replay_queue.py"):
            blockers.append(
                blocker(
                    "run_plan_missing_replay_queue_builder",
                    "hard",
                    "Run plan lacks macro-placement replay queue builder",
                )
            )
        if not has_command(run_plan, "check_macro_placement_replay_queue.py"):
            blockers.append(
                blocker(
                    "run_plan_missing_replay_queue_checker",
                    "hard",
                    "Run plan lacks macro-placement replay queue checker",
                )
            )
        if not has_output(
            run_plan, "build/ai_eda/macro_placement_replay_queue/<run-id>/replay_queue.json"
        ):
            blockers.append(
                blocker(
                    "run_plan_missing_replay_queue_output",
                    "hard",
                    "Run plan lacks macro-placement replay queue expected output",
                )
            )

    run_plan_dry_run_validated, run_plan_dry_run_detail = run_plan_execution_ready(
        run_plan_execution, run_plan_execution_run_id
    )
    if not run_plan_dry_run_validated:
        blockers.append(
            blocker(
                "run_plan_dry_run_not_validated",
                "hard",
                "CUDA run plan has not been expanded and validated in dry-run mode",
                f"{rel(run_plan_execution_path)}: {run_plan_dry_run_detail}",
            )
        )

    run_plan_safety_matrix_validated, run_plan_safety_matrix_detail = run_plan_safety_matrix_ready(
        run_plan_safety_matrix
    )
    if not run_plan_safety_matrix_validated:
        blockers.append(
            blocker(
                "run_plan_safety_matrix_not_validated",
                "hard",
                "CUDA run plan stage selection and risky-stage blocking matrix is not validated",
                f"{rel(run_plan_safety_matrix_path)}: {run_plan_safety_matrix_detail}",
            )
        )

    if alphachip is None:
        blockers.append(
            blocker(
                "missing_alphachip_checkpoint_audit",
                "hard",
                "AlphaChip checkpoint audit is missing",
                rel(alphachip_path),
            )
        )
        alphachip_available = False
    else:
        alphachip_available = alphachip.get("status") == "PASS_AVAILABLE"
        if not alphachip_available:
            blockers.append(
                blocker(
                    "alphachip_checkpoint_blocked",
                    "hard",
                    "Public AlphaChip checkpoint/binary access is not available for reproduction",
                    str(alphachip.get("status")),
                )
            )

    if watchlist is None:
        blockers.append(
            blocker(
                "missing_current_research_watchlist_report",
                "hard",
                "Current-research watchlist report is missing",
                rel(watchlist_path),
            )
        )

    setup_complete = bool(
        setup_bootstrap
        and setup_bootstrap.get("status") == "PASS"
        and setup_bootstrap.get("complete") is True
    )
    if not setup_complete:
        blockers.append(
            blocker(
                "setup_check_bootstrap_not_complete",
                "hard",
                "setup-check bootstrap report is missing or not complete for the configured setup evidence run id",
                rel(setup_bootstrap_path),
            )
        )

    training_handoff_complete = bool(
        training_handoff_bootstrap
        and training_handoff_bootstrap.get("status") == "PASS"
        and training_handoff_bootstrap.get("complete") is True
    )
    torch_training_complete = bool(
        torch_training
        and torch_training.get("schema")
        == "eliza.ai_eda.macro_placement_torch_regressor_training_run.v1"
        and torch_training.get("train_sample_count", 0) > 0
        and isinstance(torch_training.get("model"), str)
    )
    torch_inference_complete = bool(
        torch_inference
        and torch_inference.get("schema") == "eliza.ai_eda.macro_placement_torch_inference_run.v1"
        and torch_inference.get("candidate_count", 0) > 0
    )
    full_replay_complete = bool(
        full_replay
        and full_replay.get("schema") == "eliza.ai_eda.macro_placement_replay_plan.v1"
        and full_replay.get("candidate_count", 0) > 0
    )
    replay_queue_validated, replay_queue_detail = replay_queue_ready(replay_queue)
    training_handoff_payload_ready = bool(
        training_handoff_payload and training_handoff_payload.get("included_file_count", 0) > 0
    )
    if not training_handoff_complete:
        severity = (
            "soft"
            if torch_training_complete
            and torch_inference_complete
            and full_replay_complete
            and training_handoff_payload_ready
            else "hard"
        )
        blockers.append(
            blocker(
                "training_handoff_bootstrap_not_complete",
                severity,
                "training-handoff bootstrap report is missing or not complete for the configured handoff evidence run id",
                rel(training_handoff_bootstrap_path),
            )
        )
    if not torch_training_complete:
        blockers.append(
            blocker(
                "torch_training_not_validated",
                "hard",
                "Torch macro-placement training report is missing or not PASS",
                rel(torch_training_path),
            )
        )
    if not torch_inference_complete:
        blockers.append(
            blocker(
                "torch_inference_not_validated",
                "hard",
                "Torch macro-placement inference report is missing or not PASS",
                rel(torch_inference_path),
            )
        )
    if not full_replay_complete:
        blockers.append(
            blocker(
                "full_replay_plan_not_validated",
                "hard",
                "Full macro-placement replay plan is missing or empty",
                rel(full_replay_path),
            )
        )
    if not replay_queue_validated:
        blockers.append(
            blocker(
                "replay_queue_not_validated",
                "hard",
                "Macro-placement replay queue is missing or not validated for the configured handoff evidence run id",
                f"{rel(replay_queue_path)}: {replay_queue_detail}",
            )
        )
    if not training_handoff_payload_ready:
        blockers.append(
            blocker(
                "training_handoff_payload_not_validated",
                "hard",
                "Training-handoff payload report is missing or empty",
                rel(training_handoff_payload_path),
            )
        )

    replay_ready = False
    if replay is None:
        blockers.append(
            blocker(
                "missing_e1_replay_preflight",
                "hard",
                "E1 macro-placement replay preflight report is missing",
                rel(replay_path),
            )
        )
    else:
        replay_ready = str(replay.get("status", "")).startswith("READY") or str(
            replay.get("status", "")
        ).startswith("EXECUTED")
        if not replay_ready:
            blockers.append(
                blocker(
                    "e1_openlane_replay_blocked",
                    "hard",
                    "E1 OpenLane/OpenROAD replay is not ready or not executed",
                    str(replay.get("status")),
                )
            )

    large_cuda_ready = bool(preflight and preflight.get("cuda", {}).get("large_training_ready"))
    hard_blockers = [item for item in blockers if item["severity"] == "hard"]
    report = {
        "schema": "eliza.ai_eda.cuda_readiness_audit.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": run_id,
        "evidence_run_ids": {
            "preflight": preflight_run_id,
            "payload": payload_run_id,
            "run_plan_execution": run_plan_execution_run_id,
            "run_plan_safety_matrix": run_plan_safety_run_id,
            "alphachip_checkpoint": alphachip_run_id,
            "current_research_watchlist": watchlist_run_id,
            "replay_preflight": replay_preflight_run_id,
            "setup_check": setup_run_id,
            "training_handoff": training_handoff_run_id,
        },
        "status": "READY_FOR_CUDA_EXECUTION"
        if not hard_blockers
        else "PASS_WITH_BLOCKERS_RECORDED",
        "claim_boundary": CLAIM_BOUNDARY,
        "policy": {
            "runs_training": False,
            "runs_inference": False,
            "runs_openlane": False,
            "downloads_assets": False,
            "downloads_model_weights": False,
            "release_use_allowed": False,
            "signoff_claim_allowed": False,
            "optimization_claim_allowed": False,
        },
        "capabilities": {
            "payload_handoff_ready": payload_ready,
            "run_plan_dry_run_validated": run_plan_dry_run_validated,
            "run_plan_safety_matrix_validated": run_plan_safety_matrix_validated,
            "large_cuda_training_ready": large_cuda_ready,
            "alphachip_checkpoint_available": alphachip_available,
            "current_research_watchlist_captured": watchlist is not None,
            "e1_openlane_replay_ready": replay_ready,
            "setup_check_bootstrap_complete": setup_complete,
            "training_handoff_bootstrap_complete": training_handoff_complete,
            "torch_training_validated": torch_training_complete,
            "torch_inference_validated": torch_inference_complete,
            "full_replay_plan_validated": full_replay_complete,
            "replay_queue_validated": replay_queue_validated,
            "training_handoff_payload_ready": training_handoff_payload_ready,
        },
        "input_artifacts": [
            artifact(preflight_path),
            artifact(payload_report_path),
            artifact(run_plan_path),
            artifact(run_plan_execution_path),
            artifact(run_plan_safety_matrix_path),
            artifact(alphachip_path),
            artifact(watchlist_path),
            artifact(replay_path),
            artifact(setup_bootstrap_path),
            artifact(training_handoff_bootstrap_path),
            artifact(torch_training_path),
            artifact(torch_inference_path),
            artifact(full_replay_path),
            artifact(replay_queue_path),
            artifact(training_handoff_payload_path),
        ],
        "blockers": blockers,
        "next_required_actions": [
            "run the embedded cuda_training_run_plan.json through execute_cuda_run_plan.py in dry-run mode on the CUDA host",
            "validate stage selection and risky-stage blocking with check_cuda_run_plan_safety_matrix.py on the CUDA host",
            "run this audit on the CUDA host after executing the selected stages from the embedded cuda_training_run_plan.json",
            "finish or explicitly record setup-check/training-handoff bootstrap reports for the CUDA host",
            "run deterministic E1 OpenLane/OpenROAD replay before accepting any candidate optimization",
            "resolve AlphaChip checkpoint/binary access or continue with from-scratch/non-AlphaChip training only",
        ],
    }
    out_dir = args.out_root / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "cuda_readiness_audit.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.cuda_readiness_audit "
        f"status={report['status']} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
