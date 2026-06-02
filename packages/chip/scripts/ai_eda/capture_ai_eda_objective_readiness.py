#!/usr/bin/env python3
"""Capture objective-level readiness for the AI-EDA chip optimization stack.

This audit maps the broad AI-chip optimization objective to concrete evidence
artifacts. It is intentionally strict: a validated handoff, model run, or
manifest is recorded as progress, but full completion remains blocked until
CUDA training, AlphaChip-or-successor reproduction, and deterministic E1
OpenLane/OpenROAD replay/signoff evidence are all present.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/objective_readiness"
DEFAULT_RESEARCH_DOC = (
    ROOT
    / "research/alpha_chip_macro_placement/08_full_stack_ai_chip_optimization_plan_2026-05-20.md"
)
SCHEMA = "eliza.ai_eda.objective_readiness.v1"
CLAIM_BOUNDARY = "objective_readiness_audit_only_no_completion_or_release_claim"


def false_claim_flags(status: str) -> dict[str, bool]:
    flags = {"release_use_allowed": False}
    if status != "COMPLETE_READY":
        flags["completion_claim_allowed"] = False
    return flags


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


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


def artifact(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path),
    }


def requirement(
    req_id: str,
    title: str,
    status: str,
    evidence: list[Path],
    detail: str,
    blockers: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": req_id,
        "title": title,
        "status": status,
        "detail": detail,
        "evidence": [artifact(path) for path in evidence],
        "blockers": blockers or [],
    }


def present(path: Path) -> bool:
    return path.is_file()


def capability(readiness: dict[str, Any] | None, name: str) -> bool:
    return bool(readiness and readiness.get("capabilities", {}).get(name) is True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument(
        "--readiness-run-id",
        default=None,
        help="CUDA readiness audit run id; defaults to --run-id.",
    )
    parser.add_argument(
        "--evidence-bundle-run-id",
        default=None,
        help="CUDA evidence bundle run id; defaults to --readiness-run-id.",
    )
    parser.add_argument(
        "--training-handoff-run-id",
        default=None,
        help="Training/inference/replay handoff evidence run id; defaults to '<run-id>-training-handoff'.",
    )
    parser.add_argument(
        "--training-corpus-run-id",
        default=None,
        help="Training corpus manifest run id; defaults to --training-handoff-run-id.",
    )
    parser.add_argument(
        "--research-run-id",
        default=None,
        help="Current-research target capture run id; defaults to --readiness-run-id.",
    )
    parser.add_argument(
        "--replay-prerequisites-run-id",
        default=None,
        help="OpenLane/OpenROAD replay prerequisite run id; defaults to --training-handoff-run-id.",
    )
    parser.add_argument(
        "--replay-preflight-run-id",
        default=None,
        help="E1 replay preflight run id; defaults to --readiness-run-id.",
    )
    parser.add_argument(
        "--replay-handoff-run-id",
        default=None,
        help="OpenLane replay handoff package run id; defaults to --replay-preflight-run-id.",
    )
    parser.add_argument(
        "--replay-execution-run-id",
        default=None,
        help="E1 replay execution evidence run id; defaults to --replay-preflight-run-id.",
    )
    parser.add_argument(
        "--replay-comparison-run-id",
        default=None,
        help="E1 replay comparison evidence run id; defaults to --replay-execution-run-id.",
    )
    parser.add_argument(
        "--alphachip-run-id",
        default=None,
        help="AlphaChip checkpoint blocker run id; defaults to --readiness-run-id.",
    )
    parser.add_argument(
        "--alphachip-successor-run-id",
        default=None,
        help="AlphaChip successor/fallback plan run id; defaults to --readiness-run-id.",
    )
    parser.add_argument(
        "--alphachip-successor-reproduction-run-id",
        default=None,
        help="AlphaChip successor reproduction evidence run id; defaults to --readiness-run-id.",
    )
    parser.add_argument(
        "--full-training-matrix-run-id",
        default=None,
        help="Full CUDA training/evaluation matrix run id; defaults to --readiness-run-id.",
    )
    parser.add_argument("--research-doc", type=Path, default=DEFAULT_RESEARCH_DOC)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    readiness_run_id = args.readiness_run_id or args.run_id
    evidence_bundle_run_id = args.evidence_bundle_run_id or readiness_run_id
    training_handoff_run_id = args.training_handoff_run_id or f"{args.run_id}-training-handoff"
    training_corpus_run_id = args.training_corpus_run_id or training_handoff_run_id
    research_run_id = args.research_run_id or readiness_run_id
    replay_prerequisites_run_id = args.replay_prerequisites_run_id or training_handoff_run_id
    replay_preflight_run_id = args.replay_preflight_run_id or readiness_run_id
    replay_handoff_run_id = args.replay_handoff_run_id or replay_preflight_run_id
    replay_execution_run_id = args.replay_execution_run_id or replay_preflight_run_id
    replay_comparison_run_id = args.replay_comparison_run_id or replay_execution_run_id
    alphachip_run_id = args.alphachip_run_id or readiness_run_id
    alphachip_successor_run_id = args.alphachip_successor_run_id or readiness_run_id
    alphachip_successor_reproduction_run_id = (
        args.alphachip_successor_reproduction_run_id or readiness_run_id
    )
    full_training_matrix_run_id = args.full_training_matrix_run_id or readiness_run_id

    readiness_path = (
        ROOT / f"build/ai_eda/cuda_readiness_audit/{readiness_run_id}/cuda_readiness_audit.json"
    )
    evidence_bundle_path = (
        ROOT
        / f"build/ai_eda/cuda_evidence_bundles/{evidence_bundle_run_id}/cuda_evidence_bundle.json"
    )
    research_watchlist_path = (
        ROOT / f"build/ai_eda/current_research_watchlist/{research_run_id}/targets_report.json"
    )
    training_corpus_path = (
        ROOT
        / f"build/ai_eda/training_corpus_manifest/{training_corpus_run_id}/training_corpus_manifest.json"
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
    replay_prerequisites_path = (
        ROOT
        / f"build/ai_eda/openlane_replay_prerequisites/{replay_prerequisites_run_id}/openlane_replay_prerequisites.json"
    )
    replay_preflight_path = (
        ROOT
        / f"build/ai_eda/macro_placement_replay_preflight/{replay_preflight_run_id}/replay_preflight_report.json"
    )
    replay_handoff_path = (
        ROOT
        / f"build/ai_eda/openlane_replay_handoff/{replay_handoff_run_id}/openlane_replay_handoff.json"
    )
    replay_execution_path = (
        ROOT
        / f"build/ai_eda/openlane_replay_execution/{replay_execution_run_id}/openlane_replay_execution.json"
    )
    replay_comparison_path = (
        ROOT
        / f"build/ai_eda/openlane_replay_comparison/{replay_comparison_run_id}/openlane_replay_comparison.json"
    )
    alphachip_path = (
        ROOT
        / f"build/ai_eda/alphachip_checkpoint_blocker/{alphachip_run_id}/alphachip_checkpoint_blocker_audit.json"
    )
    alphachip_successor_path = (
        ROOT
        / f"build/ai_eda/alphachip_successor_plan/{alphachip_successor_run_id}/alphachip_successor_plan.json"
    )
    alphachip_successor_reproduction_path = (
        ROOT
        / f"build/ai_eda/alphachip_successor_reproduction/{alphachip_successor_reproduction_run_id}/alphachip_successor_reproduction.json"
    )
    full_training_matrix_path = (
        ROOT
        / f"build/ai_eda/cuda_full_training_matrix/{full_training_matrix_run_id}/cuda_full_training_matrix.json"
    )

    readiness = load_json(readiness_path)
    bundle = load_json(evidence_bundle_path)
    research_doc_text = (
        args.research_doc.read_text(encoding="utf-8") if args.research_doc.is_file() else ""
    )
    training = load_json(torch_training_path)
    inference = load_json(torch_inference_path)
    replay_queue = load_json(replay_queue_path)
    replay_prerequisites = load_json(replay_prerequisites_path)
    replay_handoff = load_json(replay_handoff_path)
    replay_execution = load_json(replay_execution_path)
    replay_comparison = load_json(replay_comparison_path)
    alphachip = load_json(alphachip_path)
    alphachip_successor = load_json(alphachip_successor_path)
    alphachip_successor_reproduction = load_json(alphachip_successor_reproduction_path)
    full_training_matrix = load_json(full_training_matrix_path)

    requirements: list[dict[str, Any]] = []
    requirements.append(
        requirement(
            "research_doc",
            "Detailed current research plan and TODO backlog",
            "PROVEN"
            if len(research_doc_text) > 50_000 and "TODO" in research_doc_text
            else "INCOMPLETE",
            [args.research_doc],
            "Research document must be substantial and carry implementation TODOs.",
            []
            if len(research_doc_text) > 50_000 and "TODO" in research_doc_text
            else ["research doc is missing, short, or lacks TODO markers"],
        )
    )
    requirements.append(
        requirement(
            "current_research_watchlist",
            "Latest/current AI-EDA research watchlist captured",
            "PROVEN"
            if capability(readiness, "current_research_watchlist_captured")
            or present(research_watchlist_path)
            else "INCOMPLETE",
            [research_watchlist_path, readiness_path],
            "Current research watchlist must be captured as a machine-readable target report.",
            []
            if capability(readiness, "current_research_watchlist_captured")
            or present(research_watchlist_path)
            else ["current research watchlist evidence is missing"],
        )
    )
    requirements.append(
        requirement(
            "training_data_handoff",
            "Training data and external benchmark intake prepared for CUDA host",
            "PROVEN"
            if present(training_corpus_path) and capability(readiness, "payload_handoff_ready")
            else "INCOMPLETE",
            [training_corpus_path, readiness_path, evidence_bundle_path],
            "Training corpus manifest and CUDA payload/evidence bundle must be present.",
            []
            if present(training_corpus_path) and capability(readiness, "payload_handoff_ready")
            else ["training corpus manifest or CUDA payload readiness is missing"],
        )
    )
    torch_ok = (
        capability(readiness, "torch_training_validated")
        and capability(readiness, "torch_inference_validated")
        and training is not None
        and inference is not None
    )
    requirements.append(
        requirement(
            "own_model_training_and_inference",
            "Own macro-placement model trained and inference run validated",
            "PROVEN" if torch_ok else "INCOMPLETE",
            [torch_training_path, torch_inference_path, readiness_path],
            "Torch training and inference artifacts must both validate with non-empty samples/candidates.",
            []
            if torch_ok
            else ["torch training or inference validation is missing for the selected handoff run"],
        )
    )
    cuda_ok = (
        capability(readiness, "payload_handoff_ready")
        and capability(readiness, "run_plan_dry_run_validated")
        and capability(readiness, "run_plan_safety_matrix_validated")
        and bundle is not None
    )
    requirements.append(
        requirement(
            "cuda_machine_ready_handoff",
            "Reproducible CUDA machine handoff package is validated",
            "PROVEN" if cuda_ok else "INCOMPLETE",
            [readiness_path, evidence_bundle_path],
            "Payload, dry-run executor, safety matrix, and evidence bundle must all validate.",
            [] if cuda_ok else ["CUDA payload/run-plan/evidence bundle validation is incomplete"],
        )
    )
    large_cuda_ok = capability(readiness, "large_cuda_training_ready")
    full_training_matrix_ok = capability(readiness, "full_training_matrix_validated") or (
        full_training_matrix is not None
        and full_training_matrix.get("schema") == "eliza.ai_eda.cuda_full_training_matrix.v1"
    )
    requirements.append(
        requirement(
            "large_cuda_training",
            "Large CUDA training is ready or completed on a CUDA host",
            "PROVEN" if large_cuda_ok else "BLOCKED",
            [readiness_path, full_training_matrix_path],
            "Mac/MPS smoke work is not enough for the requested large CUDA training objective; the full matrix must also be unblocked and executed on CUDA.",
            []
            if large_cuda_ok
            else [
                "cuda.available=false or large_training_ready=false in readiness evidence"
                + (
                    "; full CUDA training matrix is present but blocked pending CUDA/full-dataset execution"
                    if full_training_matrix_ok
                    else "; full CUDA training matrix evidence is missing"
                )
            ],
        )
    )
    alphachip_ok = capability(readiness, "alphachip_checkpoint_available") or (
        alphachip is not None and alphachip.get("status") == "PASS_AVAILABLE"
    )
    alphachip_successor_validated = capability(readiness, "alphachip_successor_plan_validated") or (
        alphachip_successor is not None
        and alphachip_successor.get("schema") == "eliza.ai_eda.alphachip_successor_plan.v1"
    )
    alphachip_successor_reproduced = capability(readiness, "alphachip_successor_reproduced") or (
        alphachip_successor_reproduction is not None
        and alphachip_successor_reproduction.get("schema")
        == "eliza.ai_eda.alphachip_successor_reproduction.v1"
        and alphachip_successor_reproduction.get("status") == "SUCCESSOR_REPRODUCTION_READY"
    )
    alphachip_requirement_status = (
        "PROVEN"
        if alphachip_ok or alphachip_successor_reproduced
        else "INCOMPLETE"
        if alphachip_successor_validated
        else "BLOCKED"
    )
    requirements.append(
        requirement(
            "alphachip_or_successor_reproduction",
            "AlphaChip or successor model path is reproducible with checkpoint/source evidence",
            alphachip_requirement_status,
            [
                alphachip_path,
                alphachip_successor_path,
                alphachip_successor_reproduction_path,
                readiness_path,
            ],
            "Public AlphaChip checkpoint/binary access or an equivalent reproducible successor must be available.",
            []
            if alphachip_ok or alphachip_successor_reproduced
            else [
                "successor fallback plan is validated but AlphaChip checkpoint/binary access and CUDA-scale successor reproduction remain unproven"
            ]
            if alphachip_successor_validated
            else ["AlphaChip checkpoint/binary access remains blocked or unavailable"],
        )
    )
    replay_queue_ok = capability(readiness, "full_replay_plan_validated") and capability(
        readiness, "replay_queue_validated"
    )
    replay_handoff_ok = (
        replay_handoff is not None
        and replay_handoff.get("schema") == "eliza.ai_eda.openlane_replay_handoff.v1"
        and replay_handoff.get("status") == "HANDOFF_READY_FOR_PD_HOST"
        and replay_handoff.get("ready_candidate_count", 0) >= 1
    )
    requirements.append(
        requirement(
            "candidate_replay_queue",
            "Ranked candidates are packaged for deterministic replay",
            "PROVEN"
            if replay_queue_ok and replay_queue is not None and replay_handoff_ok
            else "INCOMPLETE",
            [full_replay_path, replay_queue_path, replay_handoff_path, readiness_path],
            "Full replay plan, replay queue, and PD-host handoff package must validate before any PD execution.",
            []
            if replay_queue_ok and replay_queue is not None and replay_handoff_ok
            else ["full replay plan, replay queue, or replay handoff package is missing"],
        )
    )
    prereq_ready = capability(readiness, "openlane_replay_host_ready") or (
        replay_prerequisites is not None
        and replay_prerequisites.get("status") == "READY_FOR_REPLAY_PREREQUISITES"
    )
    requirements.append(
        requirement(
            "openlane_openroad_replay_prerequisites",
            "OpenLane/OpenROAD replay host prerequisites are satisfied",
            "PROVEN" if prereq_ready else "BLOCKED",
            [replay_prerequisites_path, readiness_path],
            "Replay host must have tools, PDK, fresh run tree, and a ready queue item.",
            []
            if prereq_ready
            else ["OpenLane/OpenROAD/PDK/replay queue prerequisites are blocked"],
        )
    )
    replay_ready = capability(readiness, "e1_openlane_replay_ready") and (
        capability(readiness, "openlane_replay_execution_validated")
        or (
            replay_execution is not None
            and replay_execution.get("status") == "EXECUTED_REPLAY_EVIDENCE_READY"
        )
    )
    comparison_ready = capability(readiness, "openlane_replay_comparison_validated") or (
        replay_comparison is not None
        and replay_comparison.get("status") == "COMPARISON_READY"
        and replay_comparison.get("optimization_claim_allowed") is True
    )
    requirements.append(
        requirement(
            "meaningful_e1_optimization_demo",
            "Meaningful E1 optimization demonstrated through deterministic replay/signoff evidence",
            "PROVEN" if replay_ready and comparison_ready else "BLOCKED",
            [replay_preflight_path, replay_execution_path, replay_comparison_path, readiness_path],
            "A candidate must run through deterministic E1 OpenLane/OpenROAD replay and beat a replayed baseline before optimization claims.",
            []
            if replay_ready and comparison_ready
            else [
                "deterministic E1 replay/signoff evidence is not ready, not executed, or not compared against a baseline"
            ],
        )
    )
    requirements.append(
        requirement(
            "verification_analysis_optimization_lanes",
            "Verification, physical-design, and optimization target lanes are captured",
            "PROVEN"
            if present(research_watchlist_path)
            and cuda_ok
            and capability(readiness, "formal_prerequisites_validated")
            and (
                capability(readiness, "strict_formal_host_ready")
                or capability(readiness, "formal_yosys_fallback_possible")
            )
            and capability(readiness, "formal_execution_evidence_validated")
            and (
                capability(readiness, "strict_formal_execution_ready")
                or capability(readiness, "formal_fallback_execution_captured")
            )
            else "INCOMPLETE",
            [research_watchlist_path, readiness_path],
            "Formal/verification/analysis/optimization lanes must be represented in target captures, CUDA run plan, formal prerequisites, and captured formal execution evidence.",
            []
            if present(research_watchlist_path)
            and cuda_ok
            and capability(readiness, "formal_prerequisites_validated")
            and (
                capability(readiness, "strict_formal_host_ready")
                or capability(readiness, "formal_yosys_fallback_possible")
            )
            and capability(readiness, "formal_execution_evidence_validated")
            and (
                capability(readiness, "strict_formal_execution_ready")
                or capability(readiness, "formal_fallback_execution_captured")
            )
            else [
                "target captures, CUDA run-plan coverage, formal prerequisites, or formal execution evidence is incomplete"
            ],
        )
    )

    blockers = [
        {"requirement_id": req["id"], "blocker": blocker}
        for req in requirements
        for blocker in req["blockers"]
    ]
    proven_count = sum(1 for req in requirements if req["status"] == "PROVEN")
    status = "COMPLETE_READY" if proven_count == len(requirements) else "INCOMPLETE_WITH_BLOCKERS"
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "release_use_allowed": False,
        "completion_claim_allowed": status == "COMPLETE_READY",
        "false_claim_flags": false_claim_flags(status),
        "status": status,
        "evidence_run_ids": {
            "readiness": readiness_run_id,
            "evidence_bundle": evidence_bundle_run_id,
            "training_handoff": training_handoff_run_id,
            "training_corpus": training_corpus_run_id,
            "research": research_run_id,
            "replay_prerequisites": replay_prerequisites_run_id,
            "replay_preflight": replay_preflight_run_id,
            "replay_handoff": replay_handoff_run_id,
            "replay_execution": replay_execution_run_id,
            "replay_comparison": replay_comparison_run_id,
            "alphachip": alphachip_run_id,
            "alphachip_successor": alphachip_successor_run_id,
            "alphachip_successor_reproduction": alphachip_successor_reproduction_run_id,
            "full_training_matrix": full_training_matrix_run_id,
        },
        "summary": {
            "requirement_count": len(requirements),
            "proven_count": proven_count,
            "blocked_or_incomplete_count": len(requirements) - proven_count,
            "blocker_count": len(blockers),
        },
        "requirements": requirements,
        "blockers": blockers,
        "next_required_actions": [
            "run the validated CUDA handoff on a real CUDA host and recapture readiness there",
            "complete the full CUDA training matrix over reviewed full-dataset conversion modes",
            "resolve AlphaChip checkpoint access or land a documented from-scratch successor training route",
            "install SymbiYosys and archive strict formal proof evidence before claiming deep formal coverage",
            "provide OpenLane/OpenROAD/PDK prerequisites with a ready replay queue item",
            "execute deterministic baseline and candidate E1 replay, archive metrics/logs/DEF/GDS, and compare them",
        ],
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "objective_readiness.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.objective_readiness "
        f"status={status} proven={proven_count}/{len(requirements)} blockers={len(blockers)} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
