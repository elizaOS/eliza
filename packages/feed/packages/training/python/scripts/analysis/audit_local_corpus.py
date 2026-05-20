#!/usr/bin/env python3
"""
Audit a local Babylon trust corpus.

This script recursively scans a local export root, dedupes trajectories by
trajectory id, and produces a quality report suitable for deciding whether the
corpus is ready for larger GRPO/SFT runs.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
from collections import Counter
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.data_bridge.reader import (
    IGNORED_EXPORT_FILES,
    JsonTrajectoryReader,
    count_usable_action_steps,
    count_valid_llm_steps,
    discover_local_export_files,
)

HF_EXPORT_SCRIPT = Path(__file__).resolve().parent / "hf" / "trajectories_to_hf_dataset.py"

TRUST_RELEVANT_ACTIONS = {
    "DM",
    "MESSAGE",
    "CHAT",
    "REPLY_CHAT",
    "COMMENT",
    "REPLY_COMMENT",
    "FOLLOW",
    "LIKE",
}

TRADE_ACTIONS = {"TRADE"}
SOCIAL_ACTIONS = {
    "COMMENT",
    "REPLY_COMMENT",
    "POST",
    "REPOST",
    "LIKE",
    "FOLLOW",
    "UNFOLLOW",
    "DM",
    "REPLY_CHAT",
    "MESSAGE",
    "CHAT",
    "GROUP_MESSAGE",
}
GROUP_CHAT_ACTIONS = {"GROUP_MESSAGE", "CHAT"}
EXPECTED_MODEL_SIZES = {"0.5b", "1.5b", "3b", "7b", "14b", "30b"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit a local Babylon trust corpus")
    parser.add_argument("--source-dir", required=True, help="Local export root")
    parser.add_argument(
        "--output",
        default="corpus_audit.json",
        help="Where to write the JSON report",
    )
    return parser.parse_args()


def iter_payloads(file_path: Path) -> Iterator[dict[str, Any]]:
    if file_path.suffix == ".jsonl":
        with file_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                payload = json.loads(stripped)
                trajectory = payload.get("trajectory", payload)
                if isinstance(trajectory, dict):
                    yield trajectory
        return

    with file_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    trajectory = payload.get("trajectory", payload)
    if isinstance(trajectory, dict):
        yield trajectory


def normalize_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    metadata = payload.get("metadata")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            metadata = {}
    metadata_json = payload.get("metadataJson")
    if not metadata and isinstance(metadata_json, str):
        try:
            metadata = json.loads(metadata_json)
        except json.JSONDecodeError:
            metadata = {}
    return metadata if isinstance(metadata, dict) else {}


def load_steps(payload: dict[str, Any]) -> list[dict[str, Any]]:
    steps = payload.get("steps")
    if isinstance(steps, list):
        return [step for step in steps if isinstance(step, dict)]

    steps_json = payload.get("stepsJson")
    if isinstance(steps_json, str):
        try:
            parsed = json.loads(steps_json)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list):
            return [step for step in parsed if isinstance(step, dict)]
    return []


def load_reward_judgments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    reward_judgments = payload.get("rewardJudgments")
    if isinstance(reward_judgments, list):
        return [judgment for judgment in reward_judgments if isinstance(judgment, dict)]

    reward_judgments_json = payload.get("rewardJudgmentsJson")
    if isinstance(reward_judgments_json, str):
        try:
            parsed = json.loads(reward_judgments_json)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list):
            return [judgment for judgment in parsed if isinstance(judgment, dict)]
    return []


def summarize_float(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "min": None, "max": None, "mean": None, "median": None}
    return {
        "count": len(values),
        "min": round(min(values), 4),
        "max": round(max(values), 4),
        "mean": round(statistics.fmean(values), 4),
        "median": round(float(statistics.median(values)), 4),
    }


def bucket_distribution(
    values: list[int], *, buckets: list[tuple[str, int, int | None]]
) -> dict[str, int]:
    counts: dict[str, int] = {label: 0 for label, _, _ in buckets}
    for value in values:
        for label, lower, upper in buckets:
            if value < lower:
                continue
            if upper is not None and value > upper:
                continue
            counts[label] += 1
            break
    return counts


def classify_failed_action(message: str) -> str:
    lowered = message.lower()
    if "rate limit" in lowered:
        return "rate_limited"
    if "already made a top-level comment" in lowered:
        return "duplicate_comment_target"
    if "already liked" in lowered or "already reposted" in lowered:
        return "duplicate_social_target"
    if "not in the current context" in lowered or "not currently available" in lowered:
        return "stale_or_unknown_target"
    if "missing required parameters" in lowered or "no content provided" in lowered:
        return "missing_parameters"
    if "invalid because" in lowered:
        return "validation_rejection"
    return "other"


def load_registered_agent_provenance(
    source_dir: Path,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], list[str]]:
    by_agent_id: dict[str, dict[str, Any]] = {}
    by_instance_id: dict[str, dict[str, Any]] = {}
    loaded_files: list[str] = []

    for manifest_path in source_dir.rglob("manifest.json"):
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        source_manifest = payload.get("sourceManifest")
        if not isinstance(source_manifest, str) or not source_manifest.strip():
            continue

        registered_agents_path = (
            Path(source_manifest).expanduser().resolve().parent / "registered-agents.json"
        )
        if not registered_agents_path.is_file():
            continue

        loaded_files.append(str(registered_agents_path))
        try:
            registered_payload = json.loads(registered_agents_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        agents = registered_payload.get("agents", [])
        if not isinstance(agents, list):
            continue

        for agent in agents:
            if not isinstance(agent, dict):
                continue
            record = {
                "instanceId": agent.get("instanceId"),
                "agentId": agent.get("agentId"),
                "username": agent.get("username"),
                "modelSize": agent.get("modelSize"),
                "trainingProfile": agent.get("trainingProfile"),
                "initialGroupChatTarget": agent.get("initialGroupChatTarget"),
                "initialGroupChatCount": agent.get("initialGroupChatCount"),
                "initialGroupChatIds": agent.get("initialGroupChatIds"),
            }
            agent_id = record.get("agentId")
            instance_id = record.get("instanceId")
            if isinstance(agent_id, str) and agent_id:
                by_agent_id[agent_id] = record
            if isinstance(instance_id, str) and instance_id:
                by_instance_id[instance_id] = record

    return by_agent_id, by_instance_id, sorted(set(loaded_files))


def summarize_numeric(values: list[int]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "min": None, "max": None, "mean": None, "median": None}
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "mean": round(statistics.fmean(values), 3),
        "median": statistics.median(values),
    }


def load_hf_export_module():
    spec = importlib.util.spec_from_file_location("trajectories_to_hf_dataset", HF_EXPORT_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load HF export script at {HF_EXPORT_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    args = parse_args()
    source_dir = Path(args.source_dir).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    if not source_dir.is_dir():
        raise FileNotFoundError(f"Source directory not found: {source_dir}")

    raw_id_counts: Counter[str] = Counter()
    file_counts: Counter[str] = Counter()
    for file_path in discover_local_export_files(source_dir):
        if file_path.name in IGNORED_EXPORT_FILES:
            continue
        file_counts[file_path.suffix] += 1
        for payload in iter_payloads(file_path):
            trajectory_id = payload.get("trajectoryId") or payload.get("trajectory_id")
            if trajectory_id:
                raw_id_counts[str(trajectory_id)] += 1

    reader = JsonTrajectoryReader(str(source_dir))
    unique_payloads: list[dict[str, Any]] = []
    for window_id in sorted(reader.get_window_ids()):
        unique_payloads.extend(reader.get_trajectories_by_window(window_id))

    batch_counts: Counter[str] = Counter()
    model_size_counts: Counter[str] = Counter()
    training_profile_counts: Counter[str] = Counter()
    team_counts: Counter[str] = Counter()
    scenario_profile_counts: Counter[str] = Counter()
    action_counts: Counter[str] = Counter()
    failed_action_counts: Counter[str] = Counter()
    failed_action_reason_counts: Counter[str] = Counter()
    interaction_channel_counts: Counter[str] = Counter()
    usable_action_steps: list[int] = []
    episode_lengths: list[int] = []
    valid_llm_step_counts: list[int] = []
    social_action_steps_per_trajectory: list[int] = []
    trade_action_steps_per_trajectory: list[int] = []
    initial_group_chat_counts: list[int] = []
    initial_group_chat_targets: list[int] = []
    missing_batch_ids = 0
    missing_experiment_run_ids = 0
    missing_scenario_profiles = 0
    missing_model_sizes = 0
    missing_training_profiles = 0
    missing_team_labels = 0
    missing_alignment_labels = 0
    missing_trust_labels = 0
    trajectories_requiring_trust_labels = 0
    trajectories_with_social_actions = 0
    trajectories_with_trade_actions = 0
    trajectories_with_both_social_and_trade_actions = 0
    trajectories_with_group_chat_actions = 0
    trajectories_with_failed_actions = 0
    trajectories_with_interaction_labels = 0
    trajectories_with_group_chat_seed_metadata = 0
    trajectories_with_nonzero_initial_group_chats = 0
    trajectories_with_reward_judgments = 0
    low_signal_trajectories = 0
    zero_usable_action_trajectories = 0

    provenance_by_agent_id, provenance_by_instance_id, provenance_sources = (
        load_registered_agent_provenance(source_dir)
    )

    for payload in unique_payloads:
        metadata = normalize_metadata(payload)
        agent_id = payload.get("agentId") or payload.get("agent_id")
        instance_id = metadata.get("agentInstanceId")
        if not isinstance(instance_id, str):
            instance_id = None
        supplemental_provenance = None
        if isinstance(agent_id, str) and agent_id in provenance_by_agent_id:
            supplemental_provenance = provenance_by_agent_id[agent_id]
        elif instance_id and instance_id in provenance_by_instance_id:
            supplemental_provenance = provenance_by_instance_id[instance_id]
        if supplemental_provenance:
            metadata = {
                **supplemental_provenance,
                **metadata,
            }

        batch_id = (
            payload.get("batchId")
            or metadata.get("batchId")
            or metadata.get("experimentRunId")
            or "missing"
        )
        if batch_id == "missing":
            missing_batch_ids += 1
        else:
            batch_counts[str(batch_id)] += 1

        experiment_run_id = metadata.get("experimentRunId")
        if not experiment_run_id:
            missing_experiment_run_ids += 1

        model_size = metadata.get("modelSize") or "unknown"
        training_profile = metadata.get("trainingProfile") or "unknown"
        team = metadata.get("team") or "unknown"
        scenario_profile = metadata.get("scenarioProfile") or "unknown"
        alignment = metadata.get("alignment") or "unknown"
        model_size_counts[str(model_size)] += 1
        training_profile_counts[str(training_profile)] += 1
        team_counts[str(team)] += 1
        scenario_profile_counts[str(scenario_profile)] += 1
        if model_size == "unknown":
            missing_model_sizes += 1
        if training_profile == "unknown":
            missing_training_profiles += 1
        if team == "unknown":
            missing_team_labels += 1
        if alignment == "unknown":
            missing_alignment_labels += 1
        if scenario_profile == "unknown":
            missing_scenario_profiles += 1

        steps = load_steps(payload)
        reward_judgments = load_reward_judgments(payload)
        if reward_judgments:
            trajectories_with_reward_judgments += 1

        usable_steps = count_usable_action_steps(steps)
        usable_action_steps.append(usable_steps)
        episode_lengths.append(len(steps))
        valid_llm_step_counts.append(count_valid_llm_steps(steps))
        if usable_steps == 0:
            zero_usable_action_trajectories += 1
        if usable_steps <= 1:
            low_signal_trajectories += 1
        requires_trust_labels = bool(metadata.get("redTeamNpcIds"))
        social_steps = 0
        trade_steps = 0
        group_chat_steps = 0
        failed_steps = 0
        interaction_labels = metadata.get("interactionLabels", [])
        trajectory_has_group_chat_label = False
        if isinstance(interaction_labels, list) and interaction_labels:
            trajectories_with_interaction_labels += 1
            for label in interaction_labels:
                if not isinstance(label, dict):
                    continue
                channel = label.get("channel")
                if isinstance(channel, str) and channel:
                    interaction_channel_counts[channel] += 1
                    if channel == "group-chat":
                        trajectory_has_group_chat_label = True

        for step in steps:
            if not isinstance(step, dict):
                continue
            action = step.get("action") or {}
            if not isinstance(action, dict):
                continue
            action_type = (
                action.get("actionType")
                or action.get("action_type")
                or action.get("type")
                or action.get("action")
                or "unknown"
            )
            normalized_action_type = str(action_type).strip().upper() or "UNKNOWN"
            action_counts[normalized_action_type] += 1
            if normalized_action_type in SOCIAL_ACTIONS:
                social_steps += 1
            if normalized_action_type in TRADE_ACTIONS:
                trade_steps += 1
            if normalized_action_type in GROUP_CHAT_ACTIONS:
                group_chat_steps += 1
            if normalized_action_type in TRUST_RELEVANT_ACTIONS:
                requires_trust_labels = True
            if action.get("success") is False:
                failed_steps += 1
                failed_action_counts[normalized_action_type] += 1
                failure_message = " ".join(
                    str(part)
                    for part in [
                        action.get("error"),
                        action.get("summary"),
                        (action.get("result") or {}).get("error")
                        if isinstance(action.get("result"), dict)
                        else None,
                    ]
                    if part
                )
                failed_action_reason_counts[classify_failed_action(failure_message)] += 1

        if requires_trust_labels:
            trajectories_requiring_trust_labels += 1
        if requires_trust_labels and not (metadata.get("interactionLabels") or reward_judgments):
            missing_trust_labels += 1

        social_action_steps_per_trajectory.append(social_steps)
        trade_action_steps_per_trajectory.append(trade_steps)
        if social_steps > 0:
            trajectories_with_social_actions += 1
        if trade_steps > 0:
            trajectories_with_trade_actions += 1
        if social_steps > 0 and trade_steps > 0:
            trajectories_with_both_social_and_trade_actions += 1
        if group_chat_steps > 0 or trajectory_has_group_chat_label:
            trajectories_with_group_chat_actions += 1
        if failed_steps > 0:
            trajectories_with_failed_actions += 1

        initial_group_chat_count = metadata.get("initialGroupChatCount")
        initial_group_chat_target = metadata.get("initialGroupChatTarget")
        if isinstance(initial_group_chat_count, (int, float)):
            normalized_group_chat_count = int(initial_group_chat_count)
            initial_group_chat_counts.append(normalized_group_chat_count)
            trajectories_with_group_chat_seed_metadata += 1
            if normalized_group_chat_count > 0:
                trajectories_with_nonzero_initial_group_chats += 1
        if isinstance(initial_group_chat_target, (int, float)):
            initial_group_chat_targets.append(int(initial_group_chat_target))

    duplicate_trajectory_ids = {
        trajectory_id: count for trajectory_id, count in raw_id_counts.items() if count > 1
    }

    hf_export = load_hf_export_module()
    export_config = hf_export.ExportConfig(source_dir=str(source_dir))
    export_trajectories = hf_export.fetch_trajectories_from_local_export(export_config)
    valid_training_trajectory_count = len(export_trajectories)
    decision_group_counts: Counter[str] = Counter()
    decision_example_count = 0
    for traj in export_trajectories:
        for example in hf_export.build_decision_examples(traj):
            decision_example_count += 1
            decision_group_counts[example["group_key"]] += 1

    eligible_group_sizes = sorted(
        (count for count in decision_group_counts.values() if count >= 2),
        reverse=True,
    )
    decision_singletons = sum(1 for count in decision_group_counts.values() if count == 1)
    decision_context_buckets = bucket_distribution(
        list(decision_group_counts.values()),
        buckets=[
            ("1", 1, 1),
            ("2", 2, 2),
            ("3", 3, 3),
            ("4_5", 4, 5),
            ("6_10", 6, 10),
            ("11_plus", 11, None),
        ],
    )

    failed_action_total = sum(failed_action_counts.values())
    action_total = sum(action_counts.values())
    full_model_coverage = EXPECTED_MODEL_SIZES.issubset(
        {key for key, value in model_size_counts.items() if value > 0}
    )
    singleton_ratio = (
        decision_singletons / max(len(decision_group_counts), 1) if decision_group_counts else 1.0
    )
    social_trade_mix_rate = trajectories_with_both_social_and_trade_actions / max(
        len(unique_payloads), 1
    )
    failed_action_rate = failed_action_total / max(action_total, 1)
    group_seed_coverage_rate = trajectories_with_group_chat_seed_metadata / max(
        len(unique_payloads), 1
    )
    group_exposure_rate = trajectories_with_nonzero_initial_group_chats / max(
        len(unique_payloads), 1
    )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_dir": str(source_dir),
        "provenance_sources": provenance_sources,
        "files_scanned": sum(file_counts.values()),
        "file_type_counts": dict(file_counts),
        "raw_trajectory_count": sum(raw_id_counts.values()),
        "unique_trajectory_count": len(unique_payloads),
        "valid_training_trajectory_count": valid_training_trajectory_count,
        "trajectory_filter_drop_count": len(unique_payloads) - valid_training_trajectory_count,
        "trajectory_filter_drop_rate_percent": round(
            (
                (len(unique_payloads) - valid_training_trajectory_count)
                / max(len(unique_payloads), 1)
            )
            * 100,
            3,
        ),
        "duplicate_trajectory_id_count": len(duplicate_trajectory_ids),
        "duplicate_trajectory_ids": duplicate_trajectory_ids,
        "batch_count": len(batch_counts),
        "batch_counts": dict(batch_counts.most_common()),
        "model_size_counts": dict(model_size_counts.most_common()),
        "training_profile_counts": dict(training_profile_counts.most_common()),
        "team_counts": dict(team_counts.most_common()),
        "scenario_profile_counts": dict(scenario_profile_counts.most_common(20)),
        "action_counts": dict(action_counts.most_common()),
        "failed_action_counts": dict(failed_action_counts.most_common()),
        "failed_action_reason_counts": dict(failed_action_reason_counts.most_common()),
        "interaction_channel_counts": dict(interaction_channel_counts.most_common()),
        "episode_lengths": summarize_numeric(episode_lengths),
        "usable_action_steps": summarize_numeric(usable_action_steps),
        "valid_llm_steps": summarize_numeric(valid_llm_step_counts),
        "social_action_steps_per_trajectory": summarize_numeric(social_action_steps_per_trajectory),
        "trade_action_steps_per_trajectory": summarize_numeric(trade_action_steps_per_trajectory),
        "initial_group_chat_targets": summarize_numeric(initial_group_chat_targets),
        "initial_group_chat_counts": summarize_numeric(initial_group_chat_counts),
        "initial_group_chat_distribution": bucket_distribution(
            initial_group_chat_counts,
            buckets=[
                ("0", 0, 0),
                ("1_2", 1, 2),
                ("3_4", 3, 4),
                ("5_6", 5, 6),
                ("7_plus", 7, None),
            ],
        ),
        "coverage": {
            "trajectories_with_social_actions": trajectories_with_social_actions,
            "trajectories_with_trade_actions": trajectories_with_trade_actions,
            "trajectories_with_both_social_and_trade_actions": trajectories_with_both_social_and_trade_actions,
            "trajectories_with_group_chat_actions": trajectories_with_group_chat_actions,
            "trajectories_with_failed_actions": trajectories_with_failed_actions,
            "trajectories_with_interaction_labels": trajectories_with_interaction_labels,
            "trajectories_with_reward_judgments": trajectories_with_reward_judgments,
            "trajectories_with_group_chat_seed_metadata": trajectories_with_group_chat_seed_metadata,
            "trajectories_with_nonzero_initial_group_chats": trajectories_with_nonzero_initial_group_chats,
            "zero_usable_action_trajectories": zero_usable_action_trajectories,
            "low_signal_trajectories": low_signal_trajectories,
        },
        "decision_level": {
            "decision_example_count": decision_example_count,
            "unique_decision_context_count": len(decision_group_counts),
            "singleton_decision_context_count": decision_singletons,
            "decision_context_size_buckets": decision_context_buckets,
            "eligible_ranking_group_count": len(eligible_group_sizes),
            "eligible_ranking_row_count": sum(eligible_group_sizes),
            "largest_eligible_group_size": eligible_group_sizes[0] if eligible_group_sizes else 0,
            "median_eligible_group_size": statistics.median(eligible_group_sizes)
            if eligible_group_sizes
            else 0,
        },
        "provenance_gaps": {
            "missing_batch_ids": missing_batch_ids,
            "missing_experiment_run_ids": missing_experiment_run_ids,
            "missing_scenario_profiles": missing_scenario_profiles,
            "missing_model_sizes": missing_model_sizes,
            "missing_training_profiles": missing_training_profiles,
            "missing_team_labels": missing_team_labels,
            "missing_alignment_labels": missing_alignment_labels,
        },
        "trajectories_requiring_trust_labels": trajectories_requiring_trust_labels,
        "missing_trust_labels": missing_trust_labels,
        "readiness": {
            "has_multiple_batches": len(batch_counts) >= 2,
            "has_exact_provenance": missing_batch_ids == 0 and missing_experiment_run_ids == 0,
            "has_enough_unique_trajectories_for_smoke": valid_training_trajectory_count >= 100,
            "has_enough_unique_trajectories_for_medium_run": valid_training_trajectory_count
            >= 1000,
            "has_full_model_coverage": full_model_coverage,
            "has_group_chat_seed_metadata": group_seed_coverage_rate >= 0.95,
            "has_nontrivial_group_chat_exposure": group_exposure_rate >= 0.50,
            "has_social_trade_mix": social_trade_mix_rate >= 0.20,
            "has_context_recurrence": len(eligible_group_sizes) >= 100 and singleton_ratio <= 0.70,
            "has_low_failed_action_rate": failed_action_rate <= 0.10,
            "has_complete_trust_labels": missing_trust_labels == 0,
            "duplicate_rate_percent": round(
                (len(duplicate_trajectory_ids) / max(len(raw_id_counts), 1)) * 100,
                3,
            ),
            "singleton_context_rate_percent": round(singleton_ratio * 100, 3),
            "failed_action_rate_percent": round(failed_action_rate * 100, 3),
            "social_trade_mix_rate_percent": round(social_trade_mix_rate * 100, 3),
            "group_chat_seed_coverage_percent": round(group_seed_coverage_rate * 100, 3),
            "group_chat_exposure_percent": round(group_exposure_rate * 100, 3),
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
