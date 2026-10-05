"""Reporting helpers for orchestrator lifecycle benchmark."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from benchmarks.publication_contracts import (
    ORCHESTRATOR_LIFECYCLE_MEASUREMENT_SCOPE,
    ORCHESTRATOR_LIFECYCLE_SIDE_EFFECTS_EXECUTED,
    canonical_identifier_manifest_sha256,
    canonical_json_sha256,
)

from .contract import LIFECYCLE_SYSTEM_HINT
from .dataset import LifecycleDataset, base_scenario_id, scenario_corpus_sha256
from .types import LifecycleConfig, LifecycleMetrics, ScenarioResult


def save_report(
    *,
    config: LifecycleConfig,
    results: list[ScenarioResult],
    metrics: LifecycleMetrics,
    transcripts: dict[str, list[dict[str, object]]],
    mode: str,
) -> Path:
    output_dir = Path(config.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = output_dir / f"orchestrator-lifecycle-{timestamp}.json"
    scored = mode == "bridge" and config.strict
    metrics_payload: dict[str, object] = asdict(metrics)
    if not scored:
        # Diagnostic runs can exercise either bridge without claiming a
        # publishable result. Withholding the score makes that intent intrinsic
        # to the artifact instead of relying on a later registry rejection.
        metrics_payload["overall_score"] = None
    scenario_ids = [result.scenario_id for result in results]
    transcript_user_turns = sum(
        entry.get("actor") == "user"
        for transcript in transcripts.values()
        for entry in transcript
    )
    transcript_assistant_turns = sum(
        entry.get("actor") == "assistant"
        for transcript in transcripts.values()
        for entry in transcript
    )
    transcript_user_turn_manifest: list[dict[str, object]] = []
    for scenario_id in sorted(transcripts):
        user_turn_index = 0
        for entry in transcripts[scenario_id]:
            if entry.get("actor") != "user":
                continue
            transcript_user_turn_manifest.append(
                {
                    "scenario_id": scenario_id,
                    "turn_index": user_turn_index,
                    "message": entry.get("message"),
                }
            )
            user_turn_index += 1
    corpus = LifecycleDataset(config.scenario_dir).load()
    tasks_tool = json.loads(
        Path(__file__).with_name("tasks-tool.json").read_text(encoding="utf-8")
    )
    tool_contracts = [tasks_tool]
    tool_contract_names = [tasks_tool["function"]["name"]]
    payload = {
        "metadata": {
            "timestamp": datetime.now().isoformat(),
            "model": config.model,
            "provider": config.provider,
            "strict": config.strict,
            "max_scenarios": config.max_scenarios,
            "scenario_filter": config.scenario_filter,
            "mode": mode,
            "scored": scored,
        },
        "mode": mode,
        "scored": scored,
        "workload": {
            "measurement_scope": ORCHESTRATOR_LIFECYCLE_MEASUREMENT_SCOPE,
            "side_effects_executed": ORCHESTRATOR_LIFECYCLE_SIDE_EFFECTS_EXECUTED,
            "base_scenario_count": sum(
                scenario_id == base_scenario_id(scenario_id)
                for scenario_id in scenario_ids
            ),
            "edge_scenario_count": sum(
                scenario_id != base_scenario_id(scenario_id)
                for scenario_id in scenario_ids
            ),
            "scenario_count": len(scenario_ids),
            "scenario_id_manifest_count": len(set(scenario_ids)),
            "scenario_id_manifest_sha256": canonical_identifier_manifest_sha256(
                scenario_ids
            ),
            "transcript_scenario_count": len(transcripts),
            "user_turn_count": transcript_user_turns,
            "user_turn_manifest_sha256": canonical_json_sha256(
                transcript_user_turn_manifest
            ),
            "assistant_turn_count": transcript_assistant_turns,
            "corpus_scenario_count": len(corpus),
            "corpus_sha256": scenario_corpus_sha256(corpus),
            "tool_contract_count": len(tool_contracts),
            "tool_contract_names": tool_contract_names,
            "tool_contract_sha256": canonical_json_sha256(tool_contracts),
            "system_hint_sha256": hashlib.sha256(
                LIFECYCLE_SYSTEM_HINT.encode("utf-8")
            ).hexdigest(),
        },
        "scenarios": [asdict(result) for result in results],
        "metrics": metrics_payload,
        "transcripts": transcripts,
    }
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    return output_path
