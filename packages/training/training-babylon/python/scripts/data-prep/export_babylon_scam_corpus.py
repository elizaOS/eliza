#!/usr/bin/env python3
"""
Export Babylon trajectory data into the canonical scam-defense corpus contract.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from scam_defense_exchange import (
    action_catalog_for_key,
    infer_category,
    normalize_private_analysis,
    normalize_text,
    write_reprocessed_formats,
)

from src.data_bridge.reader import JsonTrajectoryReader
from src.training.deterministic_eval import normalize_decision_payload

SAFE_BENIGN_ACTIONS = {"accept", "engage", "comply"}


def parse_json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def normalize_score(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0
    if numeric > 1.0 and numeric <= 100.0:
        numeric = numeric / 100.0
    return max(0.0, min(1.0, numeric))


def load_raw_trajectories(source_dir: Path) -> list[dict[str, Any]]:
    reader = JsonTrajectoryReader(str(source_dir))
    trajectories: list[dict[str, Any]] = []
    for window_id in reader.get_window_ids():
        for trajectory in reader.get_trajectories_by_window(window_id):
            trajectories.append(dict(trajectory))
    return trajectories


def trajectory_token(trajectory: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = normalize_text(trajectory.get(key))
        if value:
            return value
    return ""


def trajectory_metadata(trajectory: dict[str, Any]) -> dict[str, Any]:
    return parse_json_dict(trajectory.get("metadataJson") or trajectory.get("metadata") or {})


def trajectory_steps(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    steps = trajectory.get("steps")
    if isinstance(steps, list):
        return [step for step in steps if isinstance(step, dict)]
    raw_steps = trajectory.get("stepsJson") or trajectory.get("steps_json") or "[]"
    try:
        parsed = json.loads(raw_steps)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [step for step in parsed if isinstance(step, dict)]


def resolved_reasoning_trace(
    llm_call: dict[str, Any],
    action: dict[str, Any],
    normalized: dict[str, Any],
) -> str | None:
    trace = normalize_text(
        llm_call.get("reasoning") or action.get("reasoning") or normalized.get("rawReasoningTrace")
    )
    return trace or None


def resolved_available_actions(
    trajectory: dict[str, Any],
    action: dict[str, Any],
    *,
    step_index: int,
    chosen_action: str,
) -> list[dict[str, str]] | list[Any]:
    parameters = action.get("parameters")
    if isinstance(parameters, dict):
        available_actions = parameters.get("availableActions")
        if isinstance(available_actions, list) and available_actions:
            return available_actions
    trajectory_id = (
        trajectory_token(trajectory, "trajectoryId", "trajectory_id") or "unknown-trajectory"
    )
    return action_catalog_for_key(
        f"babylon::{trajectory_id}::{step_index}",
        chosen_action=chosen_action,
    )


def resolved_category(
    metadata: dict[str, Any],
    *,
    chosen_action: str,
    combined_text: str,
) -> str:
    category = normalize_text(
        metadata.get("category") or metadata.get("threatFamily") or metadata.get("scenarioCategory")
    ).lower()
    if not category:
        category = infer_category(combined_text)
    if (
        chosen_action in SAFE_BENIGN_ACTIONS
        and category == "social-engineering"
        and "legitimate" in normalize_text(metadata.get("scenarioProfile")).lower()
    ):
        return "benign"
    return category or "social-engineering"


def _primary_llm_call(step: dict[str, Any]) -> tuple[int, dict[str, Any]] | None:
    llm_calls = step.get("llmCalls") or step.get("llm_calls") or []
    for call_index in range(len(llm_calls) - 1, -1, -1):
        llm_call = llm_calls[call_index]
        if not isinstance(llm_call, dict):
            continue
        if normalize_text(llm_call.get("response")) and normalize_text(
            llm_call.get("userPrompt") or llm_call.get("user_prompt")
        ):
            return call_index, llm_call
    return None


def latest_reward_judgment(trajectory: dict[str, Any]) -> dict[str, Any] | None:
    judgments = trajectory.get("rewardJudgments") or []
    if not isinstance(judgments, list) or not judgments:
        return None
    return next(
        (dict(judgment) for judgment in reversed(judgments) if isinstance(judgment, dict)),
        None,
    )


def build_training_row(
    trajectory: dict[str, Any],
    step: dict[str, Any],
    step_index: int,
    llm_call: dict[str, Any],
    call_index: int,
) -> dict[str, Any] | None:
    system_prompt = str(llm_call.get("systemPrompt") or llm_call.get("system_prompt") or "")
    user_prompt = str(llm_call.get("userPrompt") or llm_call.get("user_prompt") or "")
    response = str(llm_call.get("response") or "")
    if not system_prompt or not user_prompt or not response:
        return None

    action = dict(step.get("action") or {})
    action_type = normalize_text(
        action.get("actionType") or action.get("action_type") or llm_call.get("actionType") or ""
    )
    normalized = normalize_decision_payload(response, prompt_text=user_prompt) or {}
    private_analysis_source = (
        llm_call.get("privateAnalysis")
        or step.get("privateAnalysis")
        or action.get("privateAnalysis")
        or {}
    )
    metadata = trajectory_metadata(trajectory)
    reward_components = dict(
        trajectory.get("rewardComponents") or trajectory.get("reward_components") or {}
    )
    reward_components["trajectory_total"] = float(
        trajectory.get("totalReward") or trajectory.get("total_reward") or 0.0
    )
    reward_components["step_reward"] = float(step.get("reward") or 0.0)

    reward_judgment = latest_reward_judgment(trajectory)
    judge_bundle_id = None
    if reward_judgment is not None:
        judge_bundle_id = normalize_text(reward_judgment.get("id")) or (
            f"trajectory-judge::{normalize_text(trajectory.get('trajectoryId') or trajectory.get('trajectory_id'))}"
        )
        reward_components["judge"] = normalize_score(
            reward_judgment.get("normalizedScore")
            or reward_judgment.get("overallScore")
            or reward_judgment.get("score")
        )

    chosen_action = normalize_text(normalized.get("chosenAction"))
    if not chosen_action:
        chosen_action = normalize_text(action_type).lower().replace("_", "-") or "comply"
    response_text = normalize_text(normalized.get("responseText") or response)
    combined_text = "\n".join(part for part in (user_prompt, response_text) if normalize_text(part))
    category = resolved_category(
        metadata,
        chosen_action=chosen_action,
        combined_text=combined_text,
    )
    trajectory_id = trajectory_token(trajectory, "trajectoryId", "trajectory_id")
    scenario_id = trajectory_token(
        trajectory,
        "scenarioId",
        "scenario_id",
        "windowId",
        "window_id",
        "trajectoryId",
        "trajectory_id",
    )
    reasoning_trace = resolved_reasoning_trace(llm_call, action, normalized)

    row = {
        "record_id": (
            f"babylon::{trajectory_id or 'unknown-trajectory'}::{step_index}::{call_index}"
        ),
        "group_id": scenario_id or "babylon-group",
        "scenario_id": scenario_id
        or normalize_text(metadata.get("scenarioId"))
        or "babylon-scenario",
        "category": category or "social-engineering",
        "prompt": user_prompt,
        "chosen_action": chosen_action,
        "leaked_secret": bool(normalized.get("leakedSecret", False)),
        "explanation": normalize_text(normalized.get("explanation") or response_text),
        "response": response,
        "used_research_profile": bool(normalized.get("usedResearchProfile", False)),
        "trust_profile": normalize_text(metadata.get("scenarioProfile")) or "agentic",
        "scam_losses_avoided": float(
            (step.get("trustState") or {}).get("scamLossesAvoided")
            or metadata.get("scamLossesAvoided")
            or 0.0
        ),
        "unsafe_disclosures": int(
            (step.get("trustState") or {}).get("unsafeDisclosures")
            or metadata.get("unsafeDisclosures")
            or 0
        ),
        "system_prompt": system_prompt,
        "user_prompt": user_prompt,
        "llm_purpose": normalize_text(llm_call.get("purpose")) or "action",
        "action_type": action_type or "scam_defense_decision",
        "response_format": "decision-json"
        if bool(normalized.get("validJson", False))
        else "natural-message",
        "available_actions": resolved_available_actions(
            trajectory,
            action,
            step_index=step_index,
            chosen_action=chosen_action,
        ),
        "source_kind": "babylon-trajectory",
        "source_dataset": "babylon",
        "source_family": normalize_text(metadata.get("trainingProfile")) or "agentic",
        "private_analysis": private_analysis_source,
        "raw_reasoning_trace": reasoning_trace,
        "reasoning_available": bool(reasoning_trace),
        "reasoning_source": "captured-trace" if reasoning_trace else "derived",
        "reward_components": reward_components,
    }
    row["private_analysis"] = normalize_private_analysis(
        row,
        prompt_text=user_prompt,
        response_text=response_text,
        chosen_action=chosen_action,
    )
    if judge_bundle_id:
        row["judge_bundle_id"] = judge_bundle_id
    return row


def build_training_rows(
    trajectories: list[dict[str, Any]],
    *,
    max_rows: int = 0,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for trajectory in trajectories:
        steps = trajectory_steps(trajectory)
        for step_index, step in enumerate(steps):
            primary = _primary_llm_call(step)
            if primary is None:
                continue
            call_index, llm_call = primary
            row = build_training_row(
                trajectory,
                step,
                step_index,
                llm_call,
                call_index,
            )
            if row is None:
                continue
            rows.append(row)
            if max_rows and len(rows) >= max_rows:
                return rows
    return rows


def export_training_rows(
    *,
    source_dir: Path,
    output_dir: Path,
    max_rows: int = 0,
) -> dict[str, Any]:
    trajectories = load_raw_trajectories(source_dir)
    rows = build_training_rows(trajectories, max_rows=max_rows)

    corpus_dir = output_dir / "corpus"
    corpus_dir.mkdir(parents=True, exist_ok=True)
    training_path = corpus_dir / "training_examples.jsonl"
    with training_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    format_counts = write_reprocessed_formats(
        training_rows=rows,
        output_dir=corpus_dir / "formats",
    )
    category_counts = Counter(str(row.get("category") or "unknown") for row in rows)
    source_family_counts = Counter(str(row.get("source_family") or "unknown") for row in rows)

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "exportFormat": "json",
        "expectedResponseFormat": "json",
        "sourceDir": str(source_dir),
        "trajectoryCount": len(trajectories),
        "sampleCount": len(rows),
        "categoryCounts": dict(category_counts),
        "sourceFamilyCounts": dict(source_family_counts),
        "formats": format_counts,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export Babylon trajectories into the canonical scam-defense corpus."
    )
    parser.add_argument(
        "--source-dir", required=True, help="Directory containing Babylon trajectory exports."
    )
    parser.add_argument(
        "--output-dir", required=True, help="Directory for the canonical corpus export."
    )
    parser.add_argument("--max-rows", type=int, default=0, help="Optional cap on exported rows.")
    args = parser.parse_args()

    manifest = export_training_rows(
        source_dir=Path(args.source_dir).resolve(),
        output_dir=Path(args.output_dir).resolve(),
        max_rows=max(0, args.max_rows),
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
