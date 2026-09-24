"""Verifies that published subscription results traversed each named agent runtime.

The benchmark adapters write one provenance object per model turn. This module
reduces those records to a small, non-secret summary and applies a fail-closed
contract before a Claude-subscription result can enter ``latest/``.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from benchmarks.publication_contracts import (
    ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_COUNT,
    ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_COUNT,
    ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
    canonical_identifier_manifest_sha256,
    canonical_json_sha256,
)


EXPECTED_NATIVE_RUNTIME: dict[str, dict[str, str]] = {
    "eliza": {
        "agent_runtime": "eliza",
        "native_runtime_class": "@elizaos/core.AgentRuntime",
        "native_runtime_api": "messageService.handleMessage",
        "transport": "eliza_benchmark_http",
    },
    "hermes": {
        "agent_runtime": "hermes",
        "native_runtime_class": "run_agent.AIAgent",
        "native_runtime_api": "run_conversation",
        "transport": "subprocess_loopback_openai_compatible",
    },
    "openclaw": {
        "agent_runtime": "openclaw",
        "native_runtime_class": "openclaw.agent.embedded",
        "native_runtime_api": "openclaw agent --local --json",
        "transport": "openclaw_embedded_runtime",
    },
}

ELIZA_NATIVE_RUNTIME_ROUTES: dict[str, frozenset[str]] = {
    "messageService.handleMessage": frozenset({"native_action_capture"}),
    "useModel": frozenset({"runtime_model_native_tools", "runtime_model_text"}),
}
ELIZA_LIFECYCLE_BENCHMARK_ID = "orchestrator_lifecycle"
ELIZA_LIFECYCLE_TOOL_BRIDGE = "lifecycle_capture_only"
ELIZA_LIFECYCLE_HINT_ATTESTATION_FIELDS = frozenset(
    {
        "schema_version",
        "system_hint_sha256",
        "model_boundary_call_count",
        "model_boundary_attested_call_count",
        "model_boundary_hint_occurrence_count",
        "exact_once_per_model_call",
        "model_type_call_counts",
    }
)
ELIZA_LIFECYCLE_MODEL_TYPES = frozenset(
    {"ACTION_PLANNER", "RESPONSE_HANDLER"}
)


def _normalized_benchmark_id(value: object) -> str | None:
    cleaned = _clean_string(value)
    return cleaned.lower().replace("-", "_") if cleaned is not None else None


def _clean_string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _is_git_sha(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value)
    )


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _eliza_lifecycle_hint_attestation_is_valid(
    value: object,
    *,
    usage_call_count: object,
) -> bool:
    if not isinstance(value, Mapping):
        return False
    model_call_count = value.get("model_boundary_call_count")
    attested_call_count = value.get("model_boundary_attested_call_count")
    occurrence_count = value.get("model_boundary_hint_occurrence_count")
    model_type_counts = value.get("model_type_call_counts")
    if (
        set(value) != ELIZA_LIFECYCLE_HINT_ATTESTATION_FIELDS
        or not _positive_int(value.get("schema_version"))
        or value.get("schema_version") != 1
        or value.get("system_hint_sha256")
        != ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256
        or not _positive_int(model_call_count)
        or attested_call_count != model_call_count
        or occurrence_count != model_call_count
        or value.get("exact_once_per_model_call") is not True
        or not isinstance(model_type_counts, Mapping)
        or not model_type_counts
        or usage_call_count != model_call_count
    ):
        return False
    if any(
        not isinstance(model_type, str)
        or not model_type.strip()
        or not _positive_int(count)
        for model_type, count in model_type_counts.items()
    ):
        return False
    return sum(model_type_counts.values()) == model_call_count


def _runtime_provenance(record: Mapping[str, Any]) -> Mapping[str, Any] | None:
    explicit = record.get("runtime_provenance")
    if isinstance(explicit, Mapping):
        return explicit

    # Direct adapter telemetry nests proof under normalized response params,
    # while orchestrator telemetry promotes it to the common top-level field.
    params = record.get("params")
    if not isinstance(params, Mapping):
        return None
    meta = params.get("_meta")
    if not isinstance(meta, Mapping):
        return None
    openclaw = meta.get("openclaw_adapter")
    return openclaw if isinstance(openclaw, Mapping) else None


def _tool_call_names(record: Mapping[str, Any]) -> list[str] | None:
    raw_calls = record.get("tool_calls")
    if raw_calls is None:
        params = record.get("params")
        raw_calls = params.get("tool_calls") if isinstance(params, Mapping) else []
    if not isinstance(raw_calls, list):
        return None
    names: list[str] = []
    for call in raw_calls:
        if not isinstance(call, Mapping):
            return None
        function = call.get("function")
        name = _clean_string(call.get("name")) or _clean_string(
            function.get("name") if isinstance(function, Mapping) else None
        )
        if name is None:
            return None
        names.append(name)
    return names


def _lifecycle_result_names(record: Mapping[str, Any]) -> list[str] | None:
    params = record.get("params")
    if not isinstance(params, Mapping) or "lifecycle_results" not in params:
        return None
    raw_results = params.get("lifecycle_results")
    if not isinstance(raw_results, list):
        return None
    names: list[str] = []
    for result in raw_results:
        if not isinstance(result, Mapping):
            return None
        name = _clean_string(result.get("name"))
        if name is None:
            return None
        names.append(name)
    return names


def _lifecycle_model_call_count(
    provenance: Mapping[str, Any],
) -> tuple[int | None, str | None, dict[str, int]]:
    runtime = provenance.get("agent_runtime")
    if runtime == "eliza":
        attestation = provenance.get("lifecycle_system_hint_attestation")
        if not isinstance(attestation, Mapping):
            return None, None, {}
        count = attestation.get("model_boundary_call_count")
        raw_type_counts = attestation.get("model_type_call_counts")
        type_counts = (
            {
                str(model_type): int(value)
                for model_type, value in raw_type_counts.items()
                if isinstance(model_type, str) and _positive_int(value)
            }
            if isinstance(raw_type_counts, Mapping)
            else {}
        )
        return (
            int(count) if _positive_int(count) else None,
            "eliza_model_boundary_attestation",
            type_counts,
        )
    if runtime == "hermes":
        count = provenance.get("native_api_calls")
        return (
            int(count) if _positive_int(count) else None,
            "hermes_native_api_calls",
            {},
        )
    if runtime == "openclaw":
        count = provenance.get("native_session_assistant_model_call_count")
        return (
            int(count) if _positive_int(count) else None,
            "openclaw_native_session_assistant_model_call_count",
            {},
        )
    return None, None, {}


def _eliza_lifecycle_model_grammar_valid(
    model_call_count: int,
    model_type_counts: Mapping[str, int],
) -> bool:
    response_calls = model_type_counts.get("RESPONSE_HANDLER", 0)
    planner_calls = model_type_counts.get("ACTION_PLANNER", 0)
    return (
        set(model_type_counts).issubset(ELIZA_LIFECYCLE_MODEL_TYPES)
        and sum(model_type_counts.values()) == model_call_count
        and (
            (response_calls == 1 and planner_calls == 0)
            or (response_calls == 2 and planner_calls >= 1)
        )
    )


def summarize_runtime_provenance(telemetry_path: Path) -> dict[str, Any]:
    """Return a compact summary of provenance carried by telemetry JSONL."""

    dimensions = {
        "benchmark_ids": set(),
        "harnesses": set(),
        "providers": set(),
        "models": set(),
        "agent_runtimes": set(),
        "native_runtime_classes": set(),
        "native_runtime_apis": set(),
        "transports": set(),
        "path_labels": set(),
        "tool_bridges": set(),
        "benchmark_workspace_paths": set(),
        "native_process_cwds": set(),
    }
    telemetry_records = 0
    provenance_records = 0
    publishable_values: list[bool] = []
    direct_model_bypass_values: list[object] = []
    stand_in_values: list[object] = []
    release_evidence_values: list[object] = []
    eliza_lifecycle_hint_attestation_values: list[bool] = []
    eliza_lifecycle_hint_attestation_sha256s: set[str] = set()
    eliza_lifecycle_hint_model_call_total = 0
    eliza_lifecycle_hint_attested_call_total = 0
    eliza_lifecycle_hint_occurrence_total = 0
    eliza_lifecycle_hint_model_type_call_counts: dict[str, int] = {}
    openclaw_session_evidence_values: list[bool] = []
    openclaw_session_sha256_values: list[bool] = []
    openclaw_session_sha256s: set[str] = set()
    openclaw_session_terminal_reason_records = 0
    openclaw_session_terminal_reasons: set[str] = set()
    openclaw_trajectory_evidence_values: list[bool] = []
    openclaw_trajectory_sha256_values: list[bool] = []
    openclaw_trajectory_sha256s: set[str] = set()
    openclaw_full_usage_values: list[bool] = []
    openclaw_usage_sha256_values: list[bool] = []
    openclaw_identity_attestation_values: list[bool] = []
    openclaw_thinking_attestation_values: list[bool] = []
    openclaw_workspace_git_sha_values: list[bool] = []
    openclaw_runtime_workspace_isolated_values: list[bool] = []
    benchmark_workspace_path_records = 0
    native_process_cwd_records = 0
    invalid_native_route_records = 0
    invalid_json_lines = 0
    task_ids: set[str] = set()
    task_id_records = 0
    missing_task_id_records = 0
    lifecycle_turn_manifest: list[dict[str, Any]] = []
    lifecycle_turn_manifest_values: list[bool] = []
    lifecycle_task_turn_counts: dict[str, int] = {}
    lifecycle_closed_task_ids: set[str] = set()
    lifecycle_current_task_id: str | None = None
    lifecycle_task_groups_contiguous = True

    try:
        lines = telemetry_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        # error-policy:J3 a missing telemetry artifact produces the explicit
        # zero-record provenance summary rejected by publication.
        lines = []

    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            # error-policy:J3 malformed telemetry increments the explicit
            # invalid_json_lines signal instead of becoming a valid turn.
            invalid_json_lines += 1
            continue
        if not isinstance(record, Mapping):
            continue
        telemetry_records += 1
        task_id = _clean_string(record.get("task_id"))
        if task_id is None:
            missing_task_id_records += 1
        else:
            task_id_records += 1
            task_ids.add(task_id)
        for source_key, dimension in (
            ("benchmark", "benchmark_ids"),
            ("harness", "harnesses"),
            ("provider", "providers"),
            ("model", "models"),
        ):
            value = _clean_string(record.get(source_key))
            if value is not None:
                dimensions[dimension].add(value)

        provenance = _runtime_provenance(record)
        if provenance is None:
            continue
        provenance_records += 1
        for source_key, dimension in (
            ("agent_runtime", "agent_runtimes"),
            ("native_runtime_class", "native_runtime_classes"),
            ("native_runtime_api", "native_runtime_apis"),
            ("transport", "transports"),
            ("path_label", "path_labels"),
            ("tool_bridge", "tool_bridges"),
            ("benchmark_workspace_path", "benchmark_workspace_paths"),
            ("native_process_cwd", "native_process_cwds"),
        ):
            value = _clean_string(provenance.get(source_key))
            if value is not None:
                dimensions[dimension].add(value)
                if source_key == "benchmark_workspace_path":
                    benchmark_workspace_path_records += 1
                elif source_key == "native_process_cwd":
                    native_process_cwd_records += 1
        publishable_values.append(provenance.get("publishable_native") is True)
        direct_model_bypass_values.append(provenance.get("direct_model_bypass"))
        stand_in_values.append(provenance.get("stand_in"))
        release_evidence_values.append(provenance.get("release_evidence"))

        if (
            _normalized_benchmark_id(record.get("benchmark"))
            == ELIZA_LIFECYCLE_BENCHMARK_ID
        ):
            if task_id is not None:
                if (
                    lifecycle_current_task_id is not None
                    and task_id != lifecycle_current_task_id
                ):
                    lifecycle_closed_task_ids.add(lifecycle_current_task_id)
                    if task_id in lifecycle_closed_task_ids:
                        lifecycle_task_groups_contiguous = False
                lifecycle_current_task_id = task_id
                task_turn_index = lifecycle_task_turn_counts.get(task_id, 0)
                lifecycle_task_turn_counts[task_id] = task_turn_index + 1
                task_id_sha256 = hashlib.sha256(task_id.encode("utf-8")).hexdigest()
            else:
                task_turn_index = -1
                task_id_sha256 = None
            model_call_count, count_source, model_type_counts = (
                _lifecycle_model_call_count(provenance)
            )
            tool_call_names = _tool_call_names(record)
            lifecycle_result_names = _lifecycle_result_names(record)
            runtime = provenance.get("agent_runtime")
            if runtime == "eliza" and lifecycle_result_names is None:
                lifecycle_result_names = (
                    list(tool_call_names) if tool_call_names is not None else None
                )
            entry_valid = (
                task_id_sha256 is not None
                and model_call_count is not None
                and count_source is not None
                and tool_call_names is not None
                and lifecycle_result_names is not None
                and tool_call_names == lifecycle_result_names
                and all(name == "TASKS" for name in tool_call_names)
            )
            if runtime == "eliza" and model_call_count is not None:
                entry_valid = entry_valid and _eliza_lifecycle_model_grammar_valid(
                    model_call_count,
                    model_type_counts,
                )
            lifecycle_turn_manifest.append(
                {
                    "ordinal": len(lifecycle_turn_manifest),
                    "task_id_sha256": task_id_sha256,
                    "task_turn_index": task_turn_index,
                    "model_boundary_call_count": model_call_count,
                    "model_call_count_source": count_source,
                    "model_type_call_counts": dict(sorted(model_type_counts.items())),
                    "tool_call_names": tool_call_names,
                    "lifecycle_result_names": lifecycle_result_names,
                }
            )
            lifecycle_turn_manifest_values.append(entry_valid)

        if provenance.get("agent_runtime") == "openclaw":
            openclaw_session_evidence_values.append(
                provenance.get("native_session_evidence") == "succeeded"
            )
            session_sha256 = provenance.get("native_session_sha256")
            openclaw_session_sha256_values.append(_is_sha256(session_sha256))
            if isinstance(session_sha256, str) and _is_sha256(session_sha256):
                openclaw_session_sha256s.add(session_sha256)
            terminal_reason = _clean_string(
                provenance.get("native_session_terminal_stop_reason")
            )
            if terminal_reason is not None:
                openclaw_session_terminal_reason_records += 1
                openclaw_session_terminal_reasons.add(terminal_reason)
            openclaw_trajectory_evidence_values.append(
                provenance.get("native_trajectory_evidence") == "succeeded"
            )
            trajectory_sha256 = provenance.get("native_trajectory_sha256")
            openclaw_trajectory_sha256_values.append(_is_sha256(trajectory_sha256))
            if isinstance(trajectory_sha256, str) and _is_sha256(trajectory_sha256):
                openclaw_trajectory_sha256s.add(trajectory_sha256)
            openclaw_full_usage_values.append(
                provenance.get("native_usage_scope") == "full_native_turn_aggregate"
                and isinstance(
                    provenance.get("native_session_assistant_model_call_count"), int
                )
                and not isinstance(
                    provenance.get("native_session_assistant_model_call_count"), bool
                )
                and provenance["native_session_assistant_model_call_count"] > 0
            )
            openclaw_usage_sha256_values.append(
                _is_sha256(provenance.get("native_usage_sha256"))
            )
            openclaw_identity_attestation_values.append(
                provenance.get("native_runtime_identity_attested") is True
            )
            openclaw_thinking_attestation_values.append(
                provenance.get("thinking_level_attested") is True
            )
            openclaw_workspace_git_sha_values.append(
                _is_git_sha(provenance.get("benchmark_workspace_git_sha"))
                if provenance.get("benchmark_workspace_path") is not None
                else True
            )
            openclaw_runtime_workspace_isolated_values.append(
                provenance.get("runtime_workspace_isolated") is True
            )

        if provenance.get("agent_runtime") == "eliza":
            native_runtime_api = _clean_string(provenance.get("native_runtime_api"))
            tool_bridge = _clean_string(provenance.get("tool_bridge"))
            allowed_bridges = ELIZA_NATIVE_RUNTIME_ROUTES.get(native_runtime_api or "")
            lifecycle_capture = (
                native_runtime_api == "messageService.handleMessage"
                and tool_bridge == ELIZA_LIFECYCLE_TOOL_BRIDGE
                and _normalized_benchmark_id(record.get("benchmark"))
                == ELIZA_LIFECYCLE_BENCHMARK_ID
            )
            if allowed_bridges is None or (
                tool_bridge not in allowed_bridges and not lifecycle_capture
            ):
                invalid_native_route_records += 1
            attestation = provenance.get("lifecycle_system_hint_attestation")
            if isinstance(attestation, Mapping):
                usage = record.get("usage")
                usage_call_count = (
                    usage.get("callCount") if isinstance(usage, Mapping) else None
                )
                eliza_lifecycle_hint_attestation_values.append(
                    _eliza_lifecycle_hint_attestation_is_valid(
                        attestation,
                        usage_call_count=usage_call_count,
                    )
                )
                system_hint_sha256 = attestation.get("system_hint_sha256")
                if _is_sha256(system_hint_sha256):
                    eliza_lifecycle_hint_attestation_sha256s.add(system_hint_sha256)
                model_call_count = attestation.get("model_boundary_call_count")
                attested_call_count = attestation.get(
                    "model_boundary_attested_call_count"
                )
                occurrence_count = attestation.get(
                    "model_boundary_hint_occurrence_count"
                )
                if _positive_int(model_call_count):
                    eliza_lifecycle_hint_model_call_total += model_call_count
                if _positive_int(attested_call_count):
                    eliza_lifecycle_hint_attested_call_total += attested_call_count
                if _positive_int(occurrence_count):
                    eliza_lifecycle_hint_occurrence_total += occurrence_count
                model_type_counts = attestation.get("model_type_call_counts")
                if isinstance(model_type_counts, Mapping):
                    for model_type, count in model_type_counts.items():
                        if isinstance(model_type, str) and _positive_int(count):
                            eliza_lifecycle_hint_model_type_call_counts[model_type] = (
                                eliza_lifecycle_hint_model_type_call_counts.get(
                                    model_type, 0
                                )
                                + count
                            )

    return {
        "schema_version": 1,
        "telemetry_file": telemetry_path.name,
        "telemetry_records": telemetry_records,
        "provenance_records": provenance_records,
        "invalid_json_lines": invalid_json_lines,
        "invalid_native_route_records": invalid_native_route_records,
        "task_id_records": task_id_records,
        "missing_task_id_records": missing_task_id_records,
        "task_id_manifest_count": len(task_ids),
        "task_id_manifest_sha256": (
            canonical_identifier_manifest_sha256(task_ids) if task_ids else None
        ),
        "lifecycle_gateway_turn_manifest": lifecycle_turn_manifest,
        "lifecycle_gateway_turn_manifest_count": len(lifecycle_turn_manifest),
        "lifecycle_gateway_turn_manifest_sha256": (
            canonical_json_sha256(lifecycle_turn_manifest)
            if lifecycle_turn_manifest
            else None
        ),
        "lifecycle_gateway_turn_manifest_all_valid": bool(
            lifecycle_turn_manifest_values
        )
        and all(lifecycle_turn_manifest_values),
        "lifecycle_gateway_expected_request_count_total": sum(
            int(entry["model_boundary_call_count"])
            for entry in lifecycle_turn_manifest
            if _positive_int(entry.get("model_boundary_call_count"))
        ),
        "lifecycle_task_groups_contiguous": lifecycle_task_groups_contiguous,
        "benchmark_workspace_path_records": benchmark_workspace_path_records,
        "native_process_cwd_records": native_process_cwd_records,
        **{key: sorted(values) for key, values in dimensions.items()},
        "publishable_native_all": bool(publishable_values) and all(publishable_values),
        "direct_model_bypass_all_false": bool(direct_model_bypass_values)
        and all(value is False for value in direct_model_bypass_values),
        "stand_in_all_false": bool(stand_in_values)
        and all(value is False for value in stand_in_values),
        "release_evidence_all": bool(release_evidence_values)
        and all(value is True for value in release_evidence_values),
        "eliza_lifecycle_system_hint_attestation_records": len(
            eliza_lifecycle_hint_attestation_values
        ),
        "eliza_lifecycle_system_hint_attestation_all_valid": bool(
            eliza_lifecycle_hint_attestation_values
        )
        and all(eliza_lifecycle_hint_attestation_values),
        "eliza_lifecycle_system_hint_sha256s": sorted(
            eliza_lifecycle_hint_attestation_sha256s
        ),
        "eliza_lifecycle_system_hint_model_boundary_call_count_total": (
            eliza_lifecycle_hint_model_call_total
        ),
        "eliza_lifecycle_system_hint_model_boundary_attested_call_count_total": (
            eliza_lifecycle_hint_attested_call_total
        ),
        "eliza_lifecycle_system_hint_occurrence_count_total": (
            eliza_lifecycle_hint_occurrence_total
        ),
        "eliza_lifecycle_system_hint_model_type_call_counts": dict(
            sorted(eliza_lifecycle_hint_model_type_call_counts.items())
        ),
        "openclaw_native_session_records": len(openclaw_session_evidence_values),
        "openclaw_native_session_evidence_all_succeeded": bool(
            openclaw_session_evidence_values
        )
        and all(openclaw_session_evidence_values),
        "openclaw_native_session_sha256_all_valid": bool(openclaw_session_sha256_values)
        and all(openclaw_session_sha256_values),
        "openclaw_native_session_sha256_manifest_count": len(openclaw_session_sha256s),
        "openclaw_native_session_terminal_reason_records": (
            openclaw_session_terminal_reason_records
        ),
        "openclaw_native_session_terminal_reasons": sorted(
            openclaw_session_terminal_reasons
        ),
        "openclaw_native_trajectory_evidence_all_succeeded": bool(
            openclaw_trajectory_evidence_values
        )
        and all(openclaw_trajectory_evidence_values),
        "openclaw_native_trajectory_sha256_all_valid": bool(
            openclaw_trajectory_sha256_values
        )
        and all(openclaw_trajectory_sha256_values),
        "openclaw_native_trajectory_sha256_manifest_count": len(
            openclaw_trajectory_sha256s
        ),
        "openclaw_full_native_usage_all_attested": bool(openclaw_full_usage_values)
        and all(openclaw_full_usage_values),
        "openclaw_native_usage_sha256_all_valid": bool(openclaw_usage_sha256_values)
        and all(openclaw_usage_sha256_values),
        "openclaw_runtime_identity_all_attested": bool(
            openclaw_identity_attestation_values
        )
        and all(openclaw_identity_attestation_values),
        "openclaw_thinking_level_all_attested": bool(
            openclaw_thinking_attestation_values
        )
        and all(openclaw_thinking_attestation_values),
        "openclaw_benchmark_workspace_git_sha_all_valid": bool(
            openclaw_workspace_git_sha_values
        )
        and all(openclaw_workspace_git_sha_values),
        "openclaw_runtime_workspace_isolated_all_true": bool(
            openclaw_runtime_workspace_isolated_values
        )
        and all(openclaw_runtime_workspace_isolated_values),
    }


def native_runtime_quarantine_reason(
    *,
    agent: str,
    provider: str,
    model: str,
    provenance: Mapping[str, Any] | None,
    benchmark_id: str | None = None,
    expected_lifecycle_turn_count: int = ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_COUNT,
    expected_lifecycle_scenario_count: int = ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_COUNT,
) -> str | None:
    """Return the first fail-closed publication reason for subscription rows.

    Production callers keep the pinned full-workload defaults. A deliberately
    smaller lifecycle evidence boundary, such as the tri-harness live canary,
    must state its exact expected counts instead of weakening or bypassing the
    same provenance checks.
    """

    if expected_lifecycle_turn_count <= 0 or expected_lifecycle_scenario_count <= 0:
        raise ValueError("expected lifecycle provenance counts must be positive")

    if provider.strip().lower() != "claude-subscription":
        return None
    harness = agent.strip().lower()
    expected = EXPECTED_NATIVE_RUNTIME.get(harness)
    if expected is None:
        return "subscription_unknown_harness"
    if not isinstance(provenance, Mapping):
        return "subscription_missing_runtime_provenance"
    telemetry_records = provenance.get("telemetry_records")
    provenance_records = provenance.get("provenance_records")
    if not isinstance(telemetry_records, int) or telemetry_records <= 0:
        return "subscription_missing_telemetry"
    if provenance_records != telemetry_records:
        return "subscription_incomplete_runtime_provenance"
    if provenance.get("invalid_json_lines") not in (0, None):
        return "subscription_invalid_telemetry"
    if provenance.get("publishable_native_all") is not True:
        return "subscription_non_native_transport"
    if provenance.get("stub_embedding_enabled") is True:
        return "subscription_stub_embedding_enabled"
    if provenance.get("harnesses") != [harness]:
        return "subscription_harness_provenance_mismatch"
    if provenance.get("providers") != ["claude-subscription"]:
        return "subscription_provider_provenance_mismatch"
    normalized_model = model.strip().split("/", 1)[-1]
    observed_models = provenance.get("models")
    if observed_models not in ([model.strip()], [normalized_model]):
        return "subscription_model_provenance_mismatch"
    for field, expected_value in expected.items():
        if field == "native_runtime_api":
            continue
        plural = {
            "agent_runtime": "agent_runtimes",
            "native_runtime_class": "native_runtime_classes",
            "transport": "transports",
        }[field]
        if provenance.get(plural) != [expected_value]:
            return f"subscription_{field}_mismatch"

    expected_benchmark_id = _normalized_benchmark_id(benchmark_id)
    observed_benchmark_ids = {
        normalized
        for value in provenance.get("benchmark_ids", [])
        if (normalized := _normalized_benchmark_id(value)) is not None
    }
    observed_native_runtime_apis = provenance.get("native_runtime_apis")
    if harness == "eliza":
        if (
            not isinstance(observed_native_runtime_apis, list)
            or not observed_native_runtime_apis
            or any(
                api not in ELIZA_NATIVE_RUNTIME_ROUTES
                for api in observed_native_runtime_apis
            )
        ):
            return "subscription_native_runtime_api_mismatch"
        if provenance.get("invalid_native_route_records") != 0:
            return "subscription_native_runtime_route_mismatch"
        if provenance.get("direct_model_bypass_all_false") is not True:
            return "subscription_direct_model_bypass"
        if provenance.get("stand_in_all_false") is not True:
            return "subscription_runtime_stand_in"
        if provenance.get("release_evidence_all") is not True:
            return "subscription_runtime_not_release_evidence"
        observed_bridges = provenance.get("tool_bridges")
        if expected_benchmark_id == ELIZA_LIFECYCLE_BENCHMARK_ID:
            if observed_bridges != [ELIZA_LIFECYCLE_TOOL_BRIDGE]:
                return "subscription_native_runtime_route_mismatch"
            if observed_benchmark_ids != {ELIZA_LIFECYCLE_BENCHMARK_ID}:
                return "subscription_native_runtime_route_mismatch"
            if (
                provenance.get(
                    "eliza_lifecycle_system_hint_attestation_records"
                )
                != telemetry_records
                or provenance.get(
                    "eliza_lifecycle_system_hint_attestation_all_valid"
                )
                is not True
                or provenance.get("eliza_lifecycle_system_hint_sha256s")
                != [ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256]
                or provenance.get(
                    "eliza_lifecycle_system_hint_model_boundary_call_count_total"
                )
                != provenance.get(
                    "eliza_lifecycle_system_hint_model_boundary_attested_call_count_total"
                )
                or provenance.get(
                    "eliza_lifecycle_system_hint_model_boundary_call_count_total"
                )
                != provenance.get(
                    "eliza_lifecycle_system_hint_occurrence_count_total"
                )
            ):
                return "subscription_lifecycle_system_hint_attestation_mismatch"
        elif (
            isinstance(observed_bridges, list)
            and ELIZA_LIFECYCLE_TOOL_BRIDGE in observed_bridges
        ):
            return "subscription_native_runtime_route_mismatch"
    elif observed_native_runtime_apis != [expected["native_runtime_api"]]:
        return "subscription_native_runtime_api_mismatch"
    if harness == "openclaw" and (
        provenance.get("openclaw_native_session_records") != provenance_records
        or provenance.get("openclaw_native_session_evidence_all_succeeded") is not True
        or provenance.get("openclaw_native_session_sha256_all_valid") is not True
        or provenance.get("openclaw_native_session_terminal_reason_records")
        != provenance_records
        or not isinstance(
            provenance.get("openclaw_native_session_terminal_reasons"), list
        )
        or not provenance.get("openclaw_native_session_terminal_reasons")
        or any(
            reason not in {"stop", "length", "toolUse"}
            for reason in provenance["openclaw_native_session_terminal_reasons"]
        )
        or provenance.get("openclaw_native_trajectory_evidence_all_succeeded")
        is not True
        or provenance.get("openclaw_native_trajectory_sha256_all_valid") is not True
        or provenance.get("openclaw_full_native_usage_all_attested") is not True
        or provenance.get("openclaw_native_usage_sha256_all_valid") is not True
        or provenance.get("openclaw_runtime_identity_all_attested") is not True
        or provenance.get("openclaw_thinking_level_all_attested") is not True
    ):
        return "subscription_native_session_evidence_mismatch"
    if (
        harness == "openclaw"
        and expected_benchmark_id == ELIZA_LIFECYCLE_BENCHMARK_ID
        and (
            provenance.get("openclaw_native_session_terminal_reasons") != ["stop"]
            or provenance.get("openclaw_native_session_sha256_manifest_count")
            != telemetry_records
            or provenance.get("openclaw_native_trajectory_sha256_manifest_count")
            != telemetry_records
        )
    ):
        return "subscription_native_session_evidence_mismatch"
    if expected_benchmark_id == ELIZA_LIFECYCLE_BENCHMARK_ID and harness in {
        "hermes",
        "openclaw",
    }:
        workspace_paths = provenance.get("benchmark_workspace_paths")
        if (
            provenance.get("benchmark_workspace_path_records") != telemetry_records
            or not isinstance(workspace_paths, list)
            or len(workspace_paths) != 1
        ):
            return "subscription_lifecycle_workspace_provenance_mismatch"
        if harness == "hermes" and (
            provenance.get("native_process_cwd_records") != telemetry_records
            or provenance.get("native_process_cwds") != workspace_paths
        ):
            return "subscription_lifecycle_workspace_provenance_mismatch"
        if harness == "openclaw" and (
            provenance.get("openclaw_runtime_workspace_isolated_all_true") is not True
            or provenance.get("openclaw_benchmark_workspace_git_sha_all_valid")
            is not True
        ):
            return "subscription_lifecycle_workspace_provenance_mismatch"
    if expected_benchmark_id == ELIZA_LIFECYCLE_BENCHMARK_ID and (
        observed_benchmark_ids != {ELIZA_LIFECYCLE_BENCHMARK_ID}
        or telemetry_records != expected_lifecycle_turn_count
        or provenance.get("task_id_records") != expected_lifecycle_turn_count
        or provenance.get("missing_task_id_records") != 0
        or provenance.get("task_id_manifest_count") != expected_lifecycle_scenario_count
        or provenance.get("lifecycle_gateway_turn_manifest_count")
        != expected_lifecycle_turn_count
        or provenance.get("lifecycle_gateway_turn_manifest_all_valid") is not True
        or provenance.get("lifecycle_task_groups_contiguous") is not True
        or not _positive_int(
            provenance.get("lifecycle_gateway_expected_request_count_total")
        )
    ):
        return "subscription_lifecycle_workload_provenance_mismatch"
    return None
