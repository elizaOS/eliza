"""Streams gateway audit evidence into bounded subscription publication proof.

Gateway deliveries may outnumber logical model calls because native runtimes
own tool loops and the durable gateway can replay a journaled response. The
reducer validates the append-only chain in one binary pass, counts only unique
successful logical completions against runtime telemetry, and retains ordered
per-request evidence only for the lifecycle benchmark whose exact graph needs
it. General campaign summaries remain bounded regardless of request count.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


EXPECTED_TRANSPORT = "claude-agent-sdk"
EXPECTED_CREDENTIAL_SOURCE = "claude-code-managed"
EXPECTED_SDK_API_KEY_SOURCE = "none"
EXPECTED_SDK_VERSION = "0.3.200"
EXPECTED_TOOL_EXECUTION = "capture-only"
EXPECTED_SERIALIZER = "openai-full-history-v1"
ALLOWED_RESPONSE_MODES = frozenset({"json", "sse"})
ALLOWED_REASONING_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
EXPECTED_COHORT_HARNESSES = frozenset({"eliza", "hermes", "openclaw"})
HASH_FIELDS = (
    "prompt_sha256",
    "system_prompt_sha256",
    "tool_schema_sha256",
    "request_sha256",
)
_ZERO_SHA256 = "0" * 64
_AUDIT_READ_CHUNK_BYTES = 64 * 1024
_MAX_AUDIT_LINE_BYTES = 8 * 1024 * 1024
# Real audit records nest at most a handful of levels; anything deeper is a
# pathological payload. json.loads only raises RecursionError below some
# interpreter-specific C recursion limit (~10k on CPython >= 3.12.1), so the
# scanner enforces its own deterministic depth cap instead of relying on it.
_MAX_AUDIT_JSON_DEPTH = 64
_MAX_DIMENSION_VALUES = 8
_DURABLE_AUDIT_FIELDS = frozenset(
    {
        "audit_event",
        "audit_sequence",
        "previous_record_sha256",
        "record_sha256",
        "logical_namespace_sha256",
        "logical_key_sha256",
        "logical_ordinal",
        "delivery_attempt",
        "execution_origin",
        "credential_epoch_hmac_sha256",
        "credential_tier_hmac_sha256",
        "credential_capability_hmac_sha256",
    }
)
_EXECUTION_ORIGINS = frozenset({"original", "replay"})
_AUDIT_STATUSES = frozenset({"succeeded", "failed", "paused"})
_AUDIT_EVENTS = frozenset(
    {"logical_completion", "replay_delivery", "failure", "pause_control"}
)
_PAUSE_REASONS = frozenset(
    {"rate_limit", "rate_limit_unknown", "storage_reserve"}
)

LIFECYCLE_BENCHMARK_ID = "orchestrator_lifecycle"
LIFECYCLE_FULL_CONTENT_CONTRACT_ID = "orchestrator_lifecycle_full_v1"
LIFECYCLE_CONTROL_MARKERS = (
    '"expected_behaviors"',
    '"forbidden_behaviors"',
    '"required_capabilities"',
    '"scenario_id"',
    '"checks_passed"',
    '"checks_total"',
    '"violations"',
)
LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256 = (
    "5e61574cc504c156aefc47cde293a031d1a2301daa10b1664bf3902c42c05535"
)
LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256 = (
    "b918bab7e164ced9452d284df592d186bb2bd56bb5c0ad3f7eeba429b7516e24"
)
LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256 = (
    "6ff34050a5d679aa226163556a57165758e0441cf71173f7e8af1d2095b5f2a5"
)
LIFECYCLE_RESPONSE_TOOL = "HANDLE_RESPONSE"
LIFECYCLE_TASKS_TOOL = "TASKS"
_CONTENT_ATTESTATION_KEYS = frozenset(
    {
        "schema_version",
        "contract_id",
        "contract_sha256",
        "system_hint_sha256",
        "system_hint_instruction_occurrences",
        "system_hint_user_occurrences",
        "system_hint_generated_occurrences",
        "public_user_matches",
        "public_user_instruction_matches",
        "public_user_generated_matches",
        "forbidden_ingress_match_counts",
        "forbidden_ingress_match_total",
        "forbidden_generated_match_counts",
        "forbidden_generated_match_total",
        "observed_instruction_match_counts",
        "observed_user_match_counts",
        "observed_ingress_match_counts",
        "observed_generated_match_counts",
        "message_content_manifest",
    }
)
_CONTENT_MANIFEST_KEYS = frozenset({"index", "role", "sha256"})
_CHAT_ROLES = frozenset({"system", "developer", "user", "assistant", "tool"})
_SAFE_CONTRACT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SAFE_CATEGORY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def build_lifecycle_gateway_content_contract(
    workspace_root: Path,
    *,
    public_user_turns: Sequence[str] | None = None,
    contract_id: str = LIFECYCLE_FULL_CONTENT_CONTRACT_ID,
) -> dict[str, object]:
    """Build the reviewed model-input contract without retaining run content."""

    from benchmarks.orchestrator_lifecycle.contract import LIFECYCLE_SYSTEM_HINT
    from benchmarks.orchestrator_lifecycle.dataset import (
        LifecycleDataset,
        scenario_corpus_sha256,
    )
    from benchmarks.orchestrator_lifecycle.types import BehaviorTag
    from benchmarks.publication_contracts import (
        ORCHESTRATOR_LIFECYCLE_FULL_CORPUS_SHA256,
        ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_COUNT,
        ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_ID_MANIFEST_SHA256,
        ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_COUNT,
        ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_MANIFEST_SHA256,
        ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
        canonical_identifier_manifest_sha256,
        canonical_json_sha256,
    )

    scenario_dir = workspace_root / "benchmarks" / LIFECYCLE_BENCHMARK_ID / "scenarios"
    dataset = LifecycleDataset(str(scenario_dir))
    validation = dataset.validate_scenarios()
    if validation.get("valid") is not True:
        raise RuntimeError("Lifecycle content contract source corpus is invalid")
    execution_scenarios = dataset.load()
    scenarios = sorted(execution_scenarios, key=lambda scenario: scenario.scenario_id)
    scenario_ids = [scenario.scenario_id for scenario in scenarios]
    full_turn_manifest = [
        {
            "scenario_id": scenario.scenario_id,
            "turn_index": turn_index,
            "message": turn.message,
        }
        for scenario in scenarios
        for turn_index, turn in enumerate(
            candidate for candidate in scenario.turns if candidate.actor == "user"
        )
    ]
    if (
        len(scenarios) != ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_COUNT
        or len(full_turn_manifest) != ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_COUNT
        or scenario_corpus_sha256(scenarios)
        != ORCHESTRATOR_LIFECYCLE_FULL_CORPUS_SHA256
        or canonical_identifier_manifest_sha256(scenario_ids)
        != ORCHESTRATOR_LIFECYCLE_FULL_SCENARIO_ID_MANIFEST_SHA256
        or canonical_json_sha256(full_turn_manifest)
        != ORCHESTRATOR_LIFECYCLE_FULL_USER_TURN_MANIFEST_SHA256
        or hashlib.sha256(LIFECYCLE_SYSTEM_HINT.encode("utf-8")).hexdigest()
        != ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256
    ):
        raise RuntimeError("Lifecycle content contract no longer matches its pins")

    execution_turns = [
        turn.message
        for scenario in execution_scenarios
        for turn in scenario.turns
        if turn.actor == "user"
    ]
    turns = (
        execution_turns
        if public_user_turns is None
        else list(public_user_turns)
    )
    if not turns or any(not isinstance(turn, str) or not turn for turn in turns):
        raise ValueError("Lifecycle content contract requires non-empty public turns")
    if len(set(turns)) != len(turns):
        raise ValueError("Lifecycle content contract public turns must be unique")

    forbidden = {
        "scenario_ids": scenario_ids,
        "scoring_behavior_labels": sorted(tag.value for tag in BehaviorTag),
        "benchmark_control_keys": list(LIFECYCLE_CONTROL_MARKERS),
    }
    leaked_markers = sorted(
        marker
        for markers in forbidden.values()
        for marker in markers
        if any(marker in turn for turn in turns)
    )
    if leaked_markers:
        raise RuntimeError(
            "Lifecycle public turns overlap hidden-control markers: "
            + ", ".join(leaked_markers)
        )

    package_root = workspace_root.resolve()
    repository_root = package_root.parent.resolve()
    return {
        "schema_version": 1,
        "contract_id": contract_id,
        "system_hint": LIFECYCLE_SYSTEM_HINT,
        "public_user_turns": turns,
        "forbidden_text_by_category": forbidden,
        # Framework-native system scaffolds may identify cwd. Preserve the
        # count for review without pretending every runtime has one shape.
        "observed_text_by_category": {
            "workspace_paths": [str(repository_root), str(package_root)],
        },
    }


def gateway_content_contract_sha256(contract: Mapping[str, object]) -> str:
    """Match the gateway stable-JSON hash over a validated startup contract."""

    canonical = json.dumps(
        dict(contract),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def lifecycle_tasks_gateway_schema_sha256() -> str:
    """Derive the gateway TASKS hash from the canonical scored tool contract."""

    from benchmarks.orchestrator_lifecycle.contract import LIFECYCLE_TASKS_TOOLS

    source = LIFECYCLE_TASKS_TOOLS[0]
    function = source.get("function")
    if not isinstance(function, Mapping):
        raise RuntimeError("Lifecycle TASKS contract has no function schema")
    normalized = [
        {
            "type": "function",
            "function": {
                "name": function.get("name"),
                "description": function.get("description"),
                "parameters": function.get("parameters"),
            },
        }
    ]
    digest = _canonical_json_sha256(normalized)
    if digest != LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256:
        raise RuntimeError("Lifecycle TASKS gateway schema no longer matches its pin")
    return digest


class _LifecycleGatewayValidationFailure(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def evaluate_lifecycle_gateway_execution(
    *,
    harness: str,
    records: Sequence[Mapping[str, Any]],
    runtime_turn_manifest: Sequence[Mapping[str, Any]],
    content_contract: Mapping[str, object],
    expected_reasoning_effort: str,
) -> dict[str, Any]:
    """Validate one exact native lifecycle call graph from content-free proof."""

    normalized_harness = harness.strip().lower()
    contract_id = content_contract.get("contract_id")
    system_hint = content_contract.get("system_hint")
    contract_sha256 = gateway_content_contract_sha256(content_contract)
    system_hint_sha256 = (
        hashlib.sha256(system_hint.encode("utf-8")).hexdigest()
        if isinstance(system_hint, str)
        else None
    )
    expected_requests = sum(
        int(entry.get("model_boundary_call_count", 0))
        for entry in runtime_turn_manifest
        if isinstance(entry, Mapping)
        and _positive_int(entry.get("model_boundary_call_count"))
    )
    summary: dict[str, Any] = {
        "schema_version": 1,
        "benchmark_id": LIFECYCLE_BENCHMARK_ID,
        "harness": normalized_harness,
        "contract_id": contract_id if isinstance(contract_id, str) else None,
        "contract_sha256": contract_sha256,
        "system_hint_sha256": system_hint_sha256,
        "expected_reasoning_effort": expected_reasoning_effort,
        "expected_turns": len(runtime_turn_manifest),
        "expected_requests": expected_requests,
        "validated_turns": 0,
        "tasks_gateway_schema_sha256": lifecycle_tasks_gateway_schema_sha256(),
        "eliza_response_handler_schema_sha256_by_stage": {
            "stage_1": LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256,
            "completion_evaluator": LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256,
        },
        "tasks_parallel_tool_calls": None,
        "generated_forbidden_match_counts": {},
        "observed_instruction_match_counts": {},
        "observed_generated_match_counts": {},
        "validation_status": "failed",
        "rejection_reason": "subscription_lifecycle_gateway_contract_invalid",
    }
    try:
        _validate_lifecycle_gateway_execution(
            harness=normalized_harness,
            records=records,
            runtime_turn_manifest=runtime_turn_manifest,
            content_contract=content_contract,
            expected_reasoning_effort=expected_reasoning_effort,
            summary=summary,
        )
    except _LifecycleGatewayValidationFailure as error:
        # error-policy:J3 audited provider metadata is untrusted input; retain
        # only the controlled invalid-contract code in persisted evidence.
        summary["rejection_reason"] = error.code
        return summary
    summary["validation_status"] = "succeeded"
    summary["rejection_reason"] = None
    return summary


def _validate_lifecycle_gateway_execution(
    *,
    harness: str,
    records: Sequence[Mapping[str, Any]],
    runtime_turn_manifest: Sequence[Mapping[str, Any]],
    content_contract: Mapping[str, object],
    expected_reasoning_effort: str,
    summary: dict[str, Any],
) -> None:
    if harness not in EXPECTED_COHORT_HARNESSES:
        _lifecycle_fail("subscription_lifecycle_gateway_unknown_harness")
    if expected_reasoning_effort not in ALLOWED_REASONING_EFFORTS:
        _lifecycle_fail("subscription_lifecycle_reasoning_effort_invalid")
    if expected_reasoning_effort != "medium":
        _lifecycle_fail("subscription_lifecycle_reasoning_effort_profile_mismatch")
    contract_id = content_contract.get("contract_id")
    system_hint = content_contract.get("system_hint")
    public_turns = content_contract.get("public_user_turns")
    forbidden = content_contract.get("forbidden_text_by_category")
    observed = content_contract.get("observed_text_by_category")
    if (
        content_contract.get("schema_version") != 1
        or not isinstance(contract_id, str)
        or not _SAFE_CONTRACT_ID.fullmatch(contract_id)
        or not isinstance(system_hint, str)
        or not system_hint
        or not isinstance(public_turns, list)
        or not all(isinstance(turn, str) and turn for turn in public_turns)
        or not isinstance(forbidden, Mapping)
        or not forbidden
        or not isinstance(observed, Mapping)
        or not observed
    ):
        _lifecycle_fail("subscription_lifecycle_content_contract_invalid")
    if len(public_turns) != len(runtime_turn_manifest):
        _lifecycle_fail("subscription_lifecycle_turn_contract_count_mismatch")
    if len(records) != summary["expected_requests"]:
        _lifecycle_fail("subscription_lifecycle_gateway_request_count_mismatch")
    if any(not _valid_audit_record(record) for record in records):
        _lifecycle_fail("subscription_lifecycle_gateway_record_invalid")
    request_ids = [record.get("request_id") for record in records]
    if len(set(request_ids)) != len(request_ids):
        _lifecycle_fail("subscription_lifecycle_gateway_request_id_reused")
    if any(
        record.get("status") != "succeeded"
        or record.get("error_code") not in (None, "")
        for record in records
    ):
        _lifecycle_fail("subscription_lifecycle_gateway_request_failure")

    forbidden_categories = set(forbidden)
    observed_categories = set(observed)
    if any(
        not isinstance(category, str) or not _SAFE_CATEGORY.fullmatch(category)
        for category in forbidden_categories | observed_categories
    ):
        _lifecycle_fail("subscription_lifecycle_content_categories_invalid")
    generated_forbidden = {category: 0 for category in sorted(forbidden_categories)}
    observed_instruction = {category: 0 for category in sorted(observed_categories)}
    observed_generated = {category: 0 for category in sorted(observed_categories)}
    tasks_parallel_values: set[bool] = set()
    record_offset = 0
    contract_sha256 = gateway_content_contract_sha256(content_contract)
    hint_sha256 = hashlib.sha256(system_hint.encode("utf-8")).hexdigest()

    for ordinal, (turn, public_turn) in enumerate(
        zip(runtime_turn_manifest, public_turns, strict=True)
    ):
        call_count = _validate_lifecycle_turn_manifest_entry(
            harness=harness,
            turn=turn,
            ordinal=ordinal,
        )
        segment = list(records[record_offset : record_offset + call_count])
        if len(segment) != call_count:
            _lifecycle_fail("subscription_lifecycle_gateway_segmentation_mismatch")
        expected_user_sha256 = hashlib.sha256(public_turn.encode("utf-8")).hexdigest()
        for record in segment:
            if record.get("reasoning_effort") != expected_reasoning_effort:
                _lifecycle_fail("subscription_lifecycle_reasoning_effort_mismatch")
            if not isinstance(record.get("parallel_tool_calls"), bool):
                _lifecycle_fail("subscription_lifecycle_parallel_tool_calls_missing")
            attestation = record.get("content_attestation")
            if not isinstance(attestation, Mapping):
                _lifecycle_fail("subscription_lifecycle_content_attestation_missing")
            _validate_lifecycle_content_attestation(
                attestation=attestation,
                contract_id=contract_id,
                contract_sha256=contract_sha256,
                hint_sha256=hint_sha256,
                expected_user_sha256=expected_user_sha256,
                forbidden_categories=forbidden_categories,
                observed_categories=observed_categories,
            )
            for category, count in attestation[
                "forbidden_generated_match_counts"
            ].items():
                generated_forbidden[str(category)] += int(count)
            for category, count in attestation[
                "observed_instruction_match_counts"
            ].items():
                observed_instruction[str(category)] += int(count)
            for category, count in attestation[
                "observed_generated_match_counts"
            ].items():
                observed_generated[str(category)] += int(count)
        if harness == "eliza":
            _validate_eliza_lifecycle_segment(
                records=segment,
                turn=turn,
                tasks_parallel_values=tasks_parallel_values,
            )
        else:
            _validate_external_lifecycle_segment(
                harness=harness,
                records=segment,
                turn=turn,
                tasks_parallel_values=tasks_parallel_values,
            )
        record_offset += call_count
        summary["validated_turns"] = ordinal + 1

    if record_offset != len(records):
        _lifecycle_fail("subscription_lifecycle_gateway_segmentation_mismatch")
    if len(tasks_parallel_values) > 1:
        _lifecycle_fail("subscription_lifecycle_parallel_tool_calls_lane_mismatch")
    summary["tasks_parallel_tool_calls"] = (
        next(iter(tasks_parallel_values)) if tasks_parallel_values else None
    )
    summary["generated_forbidden_match_counts"] = generated_forbidden
    summary["observed_instruction_match_counts"] = observed_instruction
    summary["observed_generated_match_counts"] = observed_generated


def _validate_lifecycle_turn_manifest_entry(
    *,
    harness: str,
    turn: Mapping[str, Any],
    ordinal: int,
) -> int:
    call_count = turn.get("model_boundary_call_count")
    task_turn_index = turn.get("task_turn_index")
    task_id_sha256 = turn.get("task_id_sha256")
    tool_call_names = turn.get("tool_call_names")
    result_names = turn.get("lifecycle_result_names")
    model_type_counts = turn.get("model_type_call_counts")
    if (
        turn.get("ordinal") != ordinal
        or not _positive_int(call_count)
        or not _nonnegative_int(task_turn_index)
        or not isinstance(task_id_sha256, str)
        or not _is_sha256(task_id_sha256)
        or not isinstance(tool_call_names, list)
        or not all(name == LIFECYCLE_TASKS_TOOL for name in tool_call_names)
        or result_names != tool_call_names
        or not isinstance(model_type_counts, Mapping)
    ):
        _lifecycle_fail("subscription_lifecycle_runtime_turn_manifest_invalid")
    if harness == "eliza":
        response_calls = model_type_counts.get("RESPONSE_HANDLER", 0)
        planner_calls = model_type_counts.get("ACTION_PLANNER", 0)
        if (
            set(model_type_counts).difference(
                {"RESPONSE_HANDLER", "ACTION_PLANNER"}
            )
            or any(not _positive_int(count) for count in model_type_counts.values())
            or sum(int(count) for count in model_type_counts.values()) != call_count
            or not (
                (response_calls == 1 and planner_calls == 0)
                or (response_calls == 2 and _positive_int(planner_calls))
            )
        ):
            _lifecycle_fail("subscription_lifecycle_eliza_model_grammar_invalid")
    elif model_type_counts:
        _lifecycle_fail("subscription_lifecycle_external_model_types_present")
    return int(call_count)


def _validate_lifecycle_content_attestation(
    *,
    attestation: Mapping[str, Any],
    contract_id: str,
    contract_sha256: str,
    hint_sha256: str,
    expected_user_sha256: str,
    forbidden_categories: set[object],
    observed_categories: set[object],
) -> None:
    if (
        attestation.get("contract_id") != contract_id
        or attestation.get("contract_sha256") != contract_sha256
        or attestation.get("system_hint_sha256") != hint_sha256
        or attestation.get("system_hint_instruction_occurrences") != 1
        or attestation.get("system_hint_user_occurrences") != 0
    ):
        _lifecycle_fail("subscription_lifecycle_content_binding_mismatch")
    public_matches = attestation.get("public_user_matches")
    instruction_matches = attestation.get("public_user_instruction_matches")
    if (
        not isinstance(public_matches, Mapping)
        or public_matches.get(expected_user_sha256) != 1
        or instruction_matches != {}
    ):
        _lifecycle_fail("subscription_lifecycle_user_role_binding_mismatch")
    forbidden_ingress = attestation.get("forbidden_ingress_match_counts")
    forbidden_generated = attestation.get("forbidden_generated_match_counts")
    if (
        not isinstance(forbidden_ingress, Mapping)
        or set(forbidden_ingress) != forbidden_categories
        or any(count != 0 for count in forbidden_ingress.values())
        or attestation.get("forbidden_ingress_match_total") != 0
        or not isinstance(forbidden_generated, Mapping)
        or set(forbidden_generated) != forbidden_categories
    ):
        _lifecycle_fail("subscription_lifecycle_forbidden_ingress_detected")
    observed_instruction = attestation.get("observed_instruction_match_counts")
    observed_user = attestation.get("observed_user_match_counts")
    observed_ingress = attestation.get("observed_ingress_match_counts")
    observed_generated = attestation.get("observed_generated_match_counts")
    if (
        not isinstance(observed_instruction, Mapping)
        or set(observed_instruction) != observed_categories
        or not isinstance(observed_user, Mapping)
        or set(observed_user) != observed_categories
        or any(count != 0 for count in observed_user.values())
        or not isinstance(observed_ingress, Mapping)
        or set(observed_ingress) != observed_categories
        or not isinstance(observed_generated, Mapping)
        or set(observed_generated) != observed_categories
    ):
        _lifecycle_fail("subscription_lifecycle_workspace_path_user_leak")


def _validate_single_tool_stage(
    record: Mapping[str, Any],
    *,
    tool_name: str,
    schema_sha256: str,
    tool_choice: str,
) -> list[str]:
    if (
        record.get("tool_names") != [tool_name]
        or record.get("tool_choice") != tool_choice
        or record.get("tool_schema_sha256") != schema_sha256
        or record.get("tool_schema_sha256_by_name")
        != {tool_name: schema_sha256}
    ):
        _lifecycle_fail("subscription_lifecycle_tool_contract_mismatch")
    call_names = record.get("tool_call_names")
    if not isinstance(call_names, list) or any(name != tool_name for name in call_names):
        _lifecycle_fail("subscription_lifecycle_tool_call_identity_mismatch")
    expected_finish = "tool_calls" if call_names else "stop"
    if record.get("finish_reason") != expected_finish:
        _lifecycle_fail("subscription_lifecycle_finish_reason_mismatch")
    return list(call_names)


def _validate_eliza_lifecycle_segment(
    *,
    records: Sequence[Mapping[str, Any]],
    turn: Mapping[str, Any],
    tasks_parallel_values: set[bool],
) -> None:
    model_type_counts = turn["model_type_call_counts"]
    planner_calls = int(model_type_counts.get("ACTION_PLANNER", 0))
    expected_count = 1 if planner_calls == 0 else planner_calls + 2
    if len(records) != expected_count:
        _lifecycle_fail("subscription_lifecycle_eliza_stage_count_mismatch")
    stage_one_calls = _validate_single_tool_stage(
        records[0],
        tool_name=LIFECYCLE_RESPONSE_TOOL,
        schema_sha256=LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256,
        tool_choice="required",
    )
    if stage_one_calls != [LIFECYCLE_RESPONSE_TOOL] or records[0].get(
        "message_roles"
    ) != ["system", "user"]:
        _lifecycle_fail("subscription_lifecycle_eliza_stage1_grammar_mismatch")
    if planner_calls == 0:
        if turn.get("tool_call_names") != []:
            _lifecycle_fail("subscription_lifecycle_eliza_clarification_mismatch")
        return

    flattened_tasks: list[str] = []
    expected_roles = ["system", "user"]
    for record in records[1:-1]:
        if record.get("message_roles") != expected_roles:
            _lifecycle_fail("subscription_lifecycle_eliza_planner_roles_mismatch")
        calls = _validate_single_tool_stage(
            record,
            tool_name=LIFECYCLE_TASKS_TOOL,
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="required",
        )
        if not calls:
            _lifecycle_fail("subscription_lifecycle_eliza_tasks_call_missing")
        flattened_tasks.extend(calls)
        tasks_parallel_values.add(bool(record["parallel_tool_calls"]))
        expected_roles = [
            *expected_roles,
            "assistant",
            *("tool" for _ in calls),
        ]
    final_record = records[-1]
    final_calls = _validate_single_tool_stage(
        final_record,
        tool_name=LIFECYCLE_RESPONSE_TOOL,
        schema_sha256=LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256,
        tool_choice="required",
    )
    if final_calls != [LIFECYCLE_RESPONSE_TOOL] or final_record.get(
        "message_roles"
    ) != expected_roles:
        _lifecycle_fail("subscription_lifecycle_eliza_evaluator_grammar_mismatch")
    if flattened_tasks != turn.get("tool_call_names"):
        _lifecycle_fail("subscription_lifecycle_eliza_tool_manifest_mismatch")


def _validate_external_lifecycle_segment(
    *,
    harness: str,
    records: Sequence[Mapping[str, Any]],
    turn: Mapping[str, Any],
    tasks_parallel_values: set[bool],
) -> None:
    task_turn_index = int(turn["task_turn_index"])
    expected_roles = (
        ["system", *(["user", "assistant"] * task_turn_index), "user"]
        if harness == "hermes"
        else ["system", "user"]
    )
    flattened_tasks: list[str] = []
    for index, record in enumerate(records):
        if record.get("message_roles") != expected_roles:
            _lifecycle_fail("subscription_lifecycle_external_message_roles_mismatch")
        calls = _validate_single_tool_stage(
            record,
            tool_name=LIFECYCLE_TASKS_TOOL,
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="auto",
        )
        tasks_parallel_values.add(bool(record["parallel_tool_calls"]))
        terminal = index == len(records) - 1
        if terminal:
            if calls:
                _lifecycle_fail("subscription_lifecycle_external_terminal_call")
        elif not calls:
            _lifecycle_fail("subscription_lifecycle_external_early_stop")
        flattened_tasks.extend(calls)
        expected_roles = [
            *expected_roles,
            "assistant",
            *("tool" for _ in calls),
        ]
    if flattened_tasks != turn.get("tool_call_names"):
        _lifecycle_fail("subscription_lifecycle_external_tool_manifest_mismatch")


def _lifecycle_fail(code: str) -> None:
    raise _LifecycleGatewayValidationFailure(code)


def attach_subscription_gateway_provenance(
    connection: Any,
    *,
    run_group_id: str,
    audit_path: Path,
) -> dict[str, str]:
    """Attach lane-scoped audit summaries before cohort publication.

    The returned mapping contains only rows that violate the gateway contract;
    callers use it to stop the serial campaign before another benchmark starts.
    This tri-harness boundary also rejects every lane when the run group is
    incomplete or its applied reasoning-effort union is not a singleton.
    """

    table_columns = {
        str(column[1])
        for column in connection.execute("PRAGMA table_info(benchmark_runs)").fetchall()
    }
    attempt_expression = "attempt" if "attempt" in table_columns else "0 AS attempt"
    started_expression = (
        "started_at" if "started_at" in table_columns else "'' AS started_at"
    )
    rows = connection.execute(
        """
        SELECT run_id, benchmark_id, agent, provider, model, status,
               extra_config_json, metrics_json, artifacts_json, error,
               {attempt_expression}, {started_expression}
        FROM benchmark_runs
        WHERE run_group_id = ? AND provider = 'claude-subscription'
        """.format(
            attempt_expression=attempt_expression,
            started_expression=started_expression,
        ),
        (run_group_id,),
    ).fetchall()
    indexed_rows = list(enumerate(rows))
    latest_rows_by_harness: dict[str, tuple[int, Any]] = {}
    for row_index, row in indexed_rows:
        if str(row["status"] or "").strip().lower() != "succeeded":
            continue
        harness = str(row["agent"] or "").strip().lower()
        attempt = row["attempt"] if isinstance(row["attempt"], int) else 0
        started_at = str(row["started_at"] or "")
        candidate_key = (attempt, started_at, row_index)
        current = latest_rows_by_harness.get(harness)
        if current is None:
            latest_rows_by_harness[harness] = (row_index, row)
            continue
        current_index, current_row = current
        current_attempt = (
            current_row["attempt"]
            if isinstance(current_row["attempt"], int)
            else 0
        )
        current_key = (
            current_attempt,
            str(current_row["started_at"] or ""),
            current_index,
        )
        if candidate_key > current_key:
            latest_rows_by_harness[harness] = (row_index, row)
    publication_rows = [
        entry[1]
        for _, entry in sorted(
            latest_rows_by_harness.items(), key=lambda item: item[0]
        )
    ]
    row_harnesses = [
        str(row["agent"] or "").strip().lower() for row in publication_rows
    ]
    cohort_rows_complete = (
        len(row_harnesses) == len(EXPECTED_COHORT_HARNESSES)
        and set(row_harnesses) == EXPECTED_COHORT_HARNESSES
    )
    lifecycle_rows = [
        row
        for row in publication_rows
        if str(row["benchmark_id"] or "").strip().lower()
        == LIFECYCLE_BENCHMARK_ID
    ]
    cohort_summaries = summarize_subscription_gateway_audits(
        audit_path,
        harnesses=tuple(sorted(EXPECTED_COHORT_HARNESSES)),
        retain_request_manifests=(
            bool(publication_rows) and len(lifecycle_rows) == len(publication_rows)
        ),
    )
    lifecycle_content_contract = (
        build_lifecycle_gateway_content_contract(Path(__file__).resolve().parents[2])
        if lifecycle_rows
        else None
    )
    lifecycle_validations: dict[str, dict[str, Any]] = {}
    if lifecycle_content_contract is not None:
        for row in lifecycle_rows:
            harness = str(row["agent"] or "").strip().lower()
            metrics = _json_object(row["metrics_json"])
            runtime_provenance = metrics.get("runtime_provenance")
            runtime_manifest = (
                runtime_provenance.get("lifecycle_gateway_turn_manifest")
                if isinstance(runtime_provenance, Mapping)
                else None
            )
            extra_config = _json_object(row["extra_config_json"])
            requested_effort = extra_config.get("reasoning_effort")
            lifecycle_validations[harness] = evaluate_lifecycle_gateway_execution(
                harness=harness,
                records=cohort_summaries[harness].get(
                    "gateway_request_manifest", []
                ),
                runtime_turn_manifest=(
                    runtime_manifest if isinstance(runtime_manifest, list) else []
                ),
                content_contract=lifecycle_content_contract,
                expected_reasoning_effort=(
                    requested_effort if isinstance(requested_effort, str) else ""
                ),
            )
            cohort_summaries[harness]["lifecycle_execution_contract"] = (
                lifecycle_validations[harness]
            )
    cohort_reasoning_effort_parity = all(
        summary.get("cohort_reasoning_effort_parity") is True
        for summary in cohort_summaries.values()
    )
    cohort_tier_hmac_parity = all(
        summary.get("cohort_credential_tier_hmac_parity") is True
        for summary in cohort_summaries.values()
    )
    cohort_capability_hmac_parity = all(
        summary.get("cohort_credential_capability_hmac_parity") is True
        for summary in cohort_summaries.values()
    )
    cohort_reason: str | None = None
    if not cohort_rows_complete or not cohort_reasoning_effort_parity:
        cohort_reason = "subscription_gateway_reasoning_effort_cohort_mismatch"
    elif not cohort_tier_hmac_parity:
        cohort_reason = "subscription_gateway_credential_tier_cohort_mismatch"
    elif not cohort_capability_hmac_parity:
        cohort_reason = "subscription_gateway_credential_capability_cohort_mismatch"
    lifecycle_parallel_values = {
        validation.get("tasks_parallel_tool_calls")
        for validation in lifecycle_validations.values()
        if validation.get("validation_status") == "succeeded"
        and isinstance(validation.get("tasks_parallel_tool_calls"), bool)
    }
    lifecycle_parallel_parity = (
        len(lifecycle_validations) == len(EXPECTED_COHORT_HARNESSES)
        and all(
            validation.get("validation_status") == "succeeded"
            for validation in lifecycle_validations.values()
        )
        and len(lifecycle_parallel_values) == 1
    )
    if lifecycle_validations:
        for summary in cohort_summaries.values():
            summary["cohort_lifecycle_parallel_tool_calls_parity"] = (
                lifecycle_parallel_parity
            )
            summary["cohort_lifecycle_parallel_tool_calls"] = (
                next(iter(lifecycle_parallel_values))
                if lifecycle_parallel_parity
                else None
            )
        if (
            cohort_reason is None
            and all(
                validation.get("validation_status") == "succeeded"
                for validation in lifecycle_validations.values()
            )
            and not lifecycle_parallel_parity
        ):
            cohort_reason = (
                "subscription_lifecycle_parallel_tool_calls_cohort_mismatch"
            )
    reasons: dict[str, str] = {}
    pause_history_by_harness = {harness: 0 for harness in EXPECTED_COHORT_HARNESSES}
    for row in rows:
        row_status = str(row["status"] or "").strip().lower()
        row_harness = str(row["agent"] or "").strip().lower()
        if row_status in {"paused", "paused_unknown"}:
            pause_history_by_harness[row_harness] = (
                pause_history_by_harness.get(row_harness, 0) + 1
            )
    pause_history_count = sum(pause_history_by_harness.values())
    for row in publication_rows:
        run_id = str(row["run_id"])
        harness = str(row["agent"] or "").strip().lower()
        metrics = _json_object(row["metrics_json"])
        runtime_provenance = metrics.get("runtime_provenance")
        minimum_request_count = (
            runtime_provenance.get("telemetry_records")
            if isinstance(runtime_provenance, Mapping)
            and isinstance(runtime_provenance.get("telemetry_records"), int)
            else None
        )
        summary = dict(cohort_summaries[harness])
        summary["cohort_run_group_harnesses"] = sorted(set(row_harnesses))
        summary["cohort_run_group_complete"] = cohort_rows_complete
        summary["cohort_run_group_reasoning_effort_parity"] = (
            cohort_reasoning_effort_parity
        )
        summary["cohort_pause_history_count"] = pause_history_count
        summary["cohort_pause_history_by_harness"] = dict(
            sorted(pause_history_by_harness.items())
        )
        summary["lane_pause_history_count"] = pause_history_by_harness.get(
            harness, 0
        )
        metrics["subscription_gateway_provenance"] = summary
        artifacts = _json_list(row["artifacts_json"])
        audit_label = str(audit_path)
        if audit_label not in artifacts:
            artifacts.append(audit_label)
        lane_reason = subscription_gateway_quarantine_reason(
            agent=harness,
            provider=str(row["provider"] or ""),
            model=str(row["model"] or ""),
            provenance=summary,
            minimum_request_count=minimum_request_count,
            benchmark_id=str(row["benchmark_id"] or ""),
        )
        reason = cohort_reason or lane_reason
        persisted_status = str(row["status"] or "")
        persisted_error = row["error"]
        if reason is not None and persisted_status == "succeeded":
            persisted_status = "failed"
            persisted_error = persisted_error or (
                "Claude subscription gateway evidence rejected: " + reason
            )
        connection.execute(
            """
            UPDATE benchmark_runs
            SET metrics_json = ?, artifacts_json = ?, status = ?, error = ?
            WHERE run_id = ?
            """,
            (
                json.dumps(metrics, sort_keys=True, ensure_ascii=True),
                json.dumps(artifacts, sort_keys=True, ensure_ascii=True),
                persisted_status,
                persisted_error,
                run_id,
            ),
        )
        if reason is not None:
            reasons[run_id] = reason
    connection.commit()
    return reasons


@dataclass
class _AuditReadState:
    hasher: Any = field(default_factory=hashlib.sha256)
    file_exists: bool = False
    read_error: bool = False
    bytes_read: int = 0
    committed_lines: int = 0
    torn_tail_bytes: int = 0
    torn_tail_oversized: bool = False


@dataclass(frozen=True)
class _CommittedAuditLine:
    payload: bytes | None
    size: int


def _iter_committed_audit_lines(
    audit_path: Path,
    state: _AuditReadState,
) -> Iterator[_CommittedAuditLine]:
    """Yield only newline-committed records while hashing every file byte."""

    line = bytearray()
    line_size = 0
    oversized = False
    try:
        with audit_path.open("rb") as audit_file:
            state.file_exists = True
            while chunk := audit_file.read(_AUDIT_READ_CHUNK_BYTES):
                state.hasher.update(chunk)
                state.bytes_read += len(chunk)
                cursor = 0
                while cursor < len(chunk):
                    newline = chunk.find(b"\n", cursor)
                    boundary = len(chunk) if newline < 0 else newline
                    segment = chunk[cursor:boundary]
                    line_size += len(segment)
                    if not oversized:
                        if len(line) + len(segment) <= _MAX_AUDIT_LINE_BYTES:
                            line.extend(segment)
                        else:
                            line.clear()
                            oversized = True
                    if newline < 0:
                        break
                    state.committed_lines += 1
                    yield _CommittedAuditLine(
                        payload=None if oversized else bytes(line),
                        size=line_size,
                    )
                    line.clear()
                    line_size = 0
                    oversized = False
                    cursor = newline + 1
    except OSError:
        # error-policy:J3 read failures remain an explicit, fail-closed signal.
        state.read_error = True
    if line_size:
        state.torn_tail_bytes = line_size
        state.torn_tail_oversized = oversized


@dataclass
class _BoundedStrings:
    values: set[str] = field(default_factory=set)
    overflow_records: int = 0

    def add(self, value: str) -> None:
        if value in self.values:
            return
        if len(self.values) < _MAX_DIMENSION_VALUES:
            self.values.add(value)
        else:
            self.overflow_records += 1


@dataclass
class _CanonicalListHasher:
    count: int = 0
    _hasher: Any = field(default_factory=hashlib.sha256)

    def __post_init__(self) -> None:
        self._hasher.update(b"[")

    def add(self, value: object) -> None:
        if self.count:
            self._hasher.update(b",")
        self._hasher.update(
            json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        self.count += 1

    def digest(self) -> str | None:
        if not self.count:
            return None
        completed = self._hasher.copy()
        completed.update(b"]")
        return completed.hexdigest()


@dataclass
class _StreamingDurationSummary:
    count: int = 0
    total: float = 0.0
    maximum: float | None = None
    _initial: list[float] = field(default_factory=list)
    _markers: list[float] | None = None
    _positions: list[int] | None = None
    _desired: list[float] | None = None

    def add(self, raw_value: object) -> None:
        value = float(raw_value)
        self.count += 1
        self.total += value
        self.maximum = value if self.maximum is None else max(self.maximum, value)
        if self._markers is None:
            self._initial.append(value)
            if len(self._initial) == 5:
                self._markers = sorted(self._initial)
                self._positions = [1, 2, 3, 4, 5]
                self._desired = [1.0, 2.9, 4.8, 4.9, 5.0]
            return
        markers = self._markers
        positions = self._positions
        desired = self._desired
        assert positions is not None and desired is not None
        if value < markers[0]:
            markers[0] = value
            bucket = 0
        elif value < markers[1]:
            bucket = 0
        elif value < markers[2]:
            bucket = 1
        elif value < markers[3]:
            bucket = 2
        elif value <= markers[4]:
            bucket = 3
        else:
            markers[4] = value
            bucket = 3
        for index in range(bucket + 1, 5):
            positions[index] += 1
        for index, increment in enumerate((0.0, 0.475, 0.95, 0.975, 1.0)):
            desired[index] += increment
        for index in range(1, 4):
            difference = desired[index] - positions[index]
            direction = 1 if difference >= 1 else -1 if difference <= -1 else 0
            if not direction or positions[index + direction] - positions[index] <= 1:
                continue
            left = positions[index] - positions[index - 1]
            right = positions[index + 1] - positions[index]
            span = positions[index + 1] - positions[index - 1]
            candidate = markers[index] + direction / span * (
                (left + direction)
                * (markers[index + 1] - markers[index])
                / right
                + (right - direction)
                * (markers[index] - markers[index - 1])
                / left
            )
            if markers[index - 1] < candidate < markers[index + 1]:
                markers[index] = candidate
            else:
                neighbor = index + direction
                markers[index] += direction * (
                    markers[neighbor] - markers[index]
                ) / (positions[neighbor] - positions[index])
            positions[index] += direction

    def summary(self) -> dict[str, float | int | None]:
        if not self.count:
            return {
                "count": 0,
                "total": None,
                "mean": None,
                "p95": None,
                "max": None,
            }
        if self._markers is None:
            ordered = sorted(self._initial)
            p95 = ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]
        else:
            p95 = self._markers[2]
        return {
            "count": self.count,
            "total": self.total,
            "mean": self.total / self.count,
            "p95": p95,
            "max": self.maximum,
        }


def subscription_gateway_logical_key_sha256(
    *,
    harness: str,
    logical_namespace_sha256: str,
    logical_ordinal: int,
    request_sha256: str,
    model_requested: str,
    reasoning_effort: str | None,
) -> str:
    """Derive the campaign-stable identity shared by gateway and reducer."""

    return _canonical_json_sha256(
        {
            "harness": harness,
            "logical_namespace_sha256": logical_namespace_sha256,
            "logical_ordinal": logical_ordinal,
            "model_requested": model_requested,
            "reasoning_effort": reasoning_effort,
            "request_sha256": request_sha256,
        }
    )


@dataclass
class _AuditIntegrityState:
    mode: str | None = None
    expected_sequence: int = 0
    previous_record_sha256: str = _ZERO_SHA256
    logical_namespace_sha256: str | None = None
    durable_records: int = 0
    invalid_chain_records: int = 0

    def validate(self, record: Mapping[str, Any]) -> tuple[bool, bool]:
        present = _DURABLE_AUDIT_FIELDS.intersection(record)
        durable = bool(present) or record.get("schema_version") == 2
        candidate_mode = "sha256-chain-v2" if durable else "legacy-v1"
        valid = True
        if self.mode is None:
            self.mode = candidate_mode
        elif self.mode != candidate_mode:
            valid = False
        if not durable:
            if not valid:
                self.invalid_chain_records += 1
            return False, valid
        self.durable_records += 1
        if present != _DURABLE_AUDIT_FIELDS or record.get("schema_version") != 2:
            valid = False
        sequence = record.get("audit_sequence")
        previous = record.get("previous_record_sha256")
        record_sha256 = record.get("record_sha256")
        namespace = record.get("logical_namespace_sha256")
        ordinal = record.get("logical_ordinal")
        attempt = record.get("delivery_attempt")
        origin = record.get("execution_origin")
        event = record.get("audit_event")
        epoch_hmac = record.get("credential_epoch_hmac_sha256")
        tier_hmac = record.get("credential_tier_hmac_sha256")
        capability_hmac = record.get("credential_capability_hmac_sha256")
        if not _safe_nonnegative_int(sequence) or sequence != self.expected_sequence:
            valid = False
        if not isinstance(previous, str) or not _is_sha256(previous):
            valid = False
        elif previous != self.previous_record_sha256:
            valid = False
        if not isinstance(record_sha256, str) or not _is_sha256(record_sha256):
            valid = False
        if not isinstance(namespace, str) or not _is_sha256(namespace):
            valid = False
        elif self.logical_namespace_sha256 is None:
            self.logical_namespace_sha256 = namespace
        elif namespace != self.logical_namespace_sha256:
            valid = False
        if not _safe_nonnegative_int(ordinal):
            valid = False
        if attempt is not None and not _safe_positive_int(attempt):
            valid = False
        if (
            not isinstance(origin, str)
            or origin not in _EXECUTION_ORIGINS
            or not isinstance(event, str)
            or event not in _AUDIT_EVENTS
        ):
            valid = False
        successful_event = isinstance(event, str) and event in {
            "logical_completion",
            "replay_delivery",
        }
        credential_hmacs = (epoch_hmac, tier_hmac, capability_hmac)
        if successful_event:
            if any(
                not isinstance(value, str) or not _is_sha256(value)
                for value in credential_hmacs
            ):
                valid = False
        elif any(value is not None for value in credential_hmacs):
            valid = False
        status = record.get("status")
        if not isinstance(event, str) or (
            (
                event in {"logical_completion", "replay_delivery"}
                and status != "succeeded"
            )
            or (event == "failure" and status != "failed")
            or (event == "pause_control" and status != "paused")
            or (event == "replay_delivery" and origin != "replay")
        ):
            valid = False
        if event == "logical_completion" and attempt not in (None, 1):
            valid = False
        if event == "pause_control":
            retry_at = record.get("retry_at")
            pause_reason = record.get("pause_reason")
            if (
                "retry_at" not in record
                or not isinstance(pause_reason, str)
                or pause_reason not in _PAUSE_REASONS
                or (
                    pause_reason == "rate_limit"
                    and _clean_string(retry_at) is None
                )
                or (
                    pause_reason in {"rate_limit_unknown", "storage_reserve"}
                    and retry_at is not None
                )
            ):
                valid = False
        elif record.get("retry_at") is not None or record.get("pause_reason") is not None:
            valid = False
        if (
            isinstance(namespace, str)
            and _is_sha256(namespace)
            and _safe_nonnegative_int(ordinal)
            and isinstance(record.get("request_sha256"), str)
            and _is_sha256(str(record.get("request_sha256")))
            and isinstance(record.get("model_requested"), str)
            and (
                record.get("reasoning_effort") is None
                or (
                    isinstance(record.get("reasoning_effort"), str)
                    and record.get("reasoning_effort") in ALLOWED_REASONING_EFFORTS
                )
            )
        ):
            logical_key = subscription_gateway_logical_key_sha256(
                harness=str(record.get("harness") or ""),
                logical_namespace_sha256=namespace,
                logical_ordinal=ordinal,
                request_sha256=str(record["request_sha256"]),
                model_requested=str(record["model_requested"]),
                reasoning_effort=record.get("reasoning_effort"),
            )
            if record.get("logical_key_sha256") != logical_key:
                valid = False
            if record.get("request_id") != f"logical_{logical_key}":
                valid = False
        else:
            valid = False
        if isinstance(record_sha256, str) and _is_sha256(record_sha256):
            hash_payload = {
                key: value for key, value in record.items() if key != "record_sha256"
            }
            if _canonical_json_sha256(hash_payload) != record_sha256:
                valid = False
        if _safe_nonnegative_int(sequence):
            self.expected_sequence = sequence + 1
        else:
            self.expected_sequence += 1
        if isinstance(record_sha256, str) and _is_sha256(record_sha256):
            self.previous_record_sha256 = record_sha256
        if not valid:
            self.invalid_chain_records += 1
        return True, valid


def _json_depth_exceeds(value: Any, limit: int) -> bool:
    """Iteratively bound container nesting so the check itself cannot recurse."""

    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > limit:
            return True
        if isinstance(node, Mapping):
            stack.extend((child, depth + 1) for child in node.values())
        elif isinstance(node, list):
            stack.extend((child, depth + 1) for child in node)
    return False


def _scan_subscription_gateway_audit(
    audit_path: Path,
    visit_record: Callable[[Mapping[str, Any], bool, bool], None],
) -> dict[str, Any]:
    """Exhaust one audit pass and report every artifact-level diagnostic."""

    read_state = _AuditReadState()
    integrity = _AuditIntegrityState()
    invalid_json_lines = 0
    invalid_contract_records = 0
    oversized_json_lines = 0
    for committed_line in _iter_committed_audit_lines(audit_path, read_state):
        if committed_line.payload is None:
            oversized_json_lines += 1
            invalid_json_lines += 1
            continue
        if not committed_line.payload.strip():
            continue
        try:
            decoded = json.loads(committed_line.payload)
        except (ValueError, UnicodeDecodeError, RecursionError):
            # error-policy:J3 committed malformed input is an explicit rejection.
            invalid_json_lines += 1
            continue
        if _json_depth_exceeds(decoded, _MAX_AUDIT_JSON_DEPTH):
            invalid_json_lines += 1
            continue
        if not isinstance(decoded, Mapping):
            invalid_contract_records += 1
            continue
        durable, chain_valid = integrity.validate(decoded)
        visit_record(decoded, durable, chain_valid)
    return {
        "audit_file": str(audit_path),
        "audit_file_exists": read_state.file_exists,
        "audit_read_error": read_state.read_error,
        "audit_sha256": read_state.hasher.hexdigest(),
        "audit_bytes": read_state.bytes_read,
        "audit_committed_lines": read_state.committed_lines,
        "audit_ignored_torn_tail_bytes": read_state.torn_tail_bytes,
        "audit_ignored_torn_tail_oversized": read_state.torn_tail_oversized,
        "invalid_json_lines": invalid_json_lines,
        "oversized_json_lines": oversized_json_lines,
        "global_invalid_contract_records": invalid_contract_records,
        "audit_chain_mode": integrity.mode or "empty",
        "audit_chain_records": integrity.durable_records,
        "invalid_chain_records": integrity.invalid_chain_records,
        "audit_chain_head_sha256": (
            integrity.previous_record_sha256 if integrity.durable_records else None
        ),
        "logical_namespace_sha256": integrity.logical_namespace_sha256,
    }


def scan_subscription_gateway_audit(
    audit_path: Path,
    visit_record: Callable[[Mapping[str, Any]], None],
) -> dict[str, Any]:
    """Visit fully valid records, then return diagnostics from the exhausted scan.

    Callers must inspect every returned rejection counter before acting on the
    visited state. A malformed committed line or chain failure suppresses that
    record but never stops validation of the remaining tail.
    """

    invalid_contract_records = 0

    def visit_if_valid(
        record: Mapping[str, Any],
        durable: bool,
        chain_valid: bool,
    ) -> None:
        nonlocal invalid_contract_records
        record_valid = _valid_audit_record(record)
        if not record_valid:
            invalid_contract_records += 1
        if record_valid and (not durable or chain_valid):
            visit_record(record)

    diagnostics = _scan_subscription_gateway_audit(audit_path, visit_if_valid)
    diagnostics["invalid_contract_records"] = (
        diagnostics["global_invalid_contract_records"] + invalid_contract_records
    )
    return diagnostics


_DIMENSION_FIELDS = (
    ("harness", "harnesses"),
    ("transport", "transports"),
    ("credential_source", "credential_sources"),
    ("sdk_api_key_source", "sdk_api_key_sources"),
    ("sdk_version", "sdk_versions"),
    ("claude_code_version", "claude_code_versions"),
    ("tool_execution", "tool_execution_modes"),
    ("serializer", "serializers"),
    ("response_mode", "response_modes"),
    ("model_requested", "models_requested"),
    ("model_effective", "models_effective"),
)


@dataclass
class _LaneAuditAccumulator:
    harness: str
    retain_manifest: bool
    dimensions: dict[str, _BoundedStrings] = field(
        default_factory=lambda: {
            target: _BoundedStrings() for _, target in _DIMENSION_FIELDS
        }
    )
    audit_records: int = 0
    valid_records: int = 0
    audit_delivery_records: int = 0
    valid_delivery_records: int = 0
    invalid_contract_records: int = 0
    invalid_logical_records: int = 0
    succeeded_records: int = 0
    failed_records: int = 0
    paused_records: int = 0
    replay_delivery_records: int = 0
    original_delivery_records: int = 0
    recovered_completion_records: int = 0
    next_completion_ordinal: int = 0
    fresh_session_records: int = 0
    fresh_session_false_records: int = 0
    reasoning_effort_records: int = 0
    reasoning_effort_unset_records: int = 0
    reasoning_efforts: _BoundedStrings = field(default_factory=_BoundedStrings)
    queue_wait: _StreamingDurationSummary = field(
        default_factory=_StreamingDurationSummary
    )
    service: _StreamingDurationSummary = field(
        default_factory=_StreamingDurationSummary
    )
    delivery_queue_wait: _StreamingDurationSummary = field(
        default_factory=_StreamingDurationSummary
    )
    delivery_service: _StreamingDurationSummary = field(
        default_factory=_StreamingDurationSummary
    )
    request_manifest_hash: _CanonicalListHasher = field(
        default_factory=_CanonicalListHasher
    )
    credential_epoch_hash: _CanonicalListHasher = field(
        default_factory=_CanonicalListHasher
    )
    credential_tier_hash: _CanonicalListHasher = field(
        default_factory=_CanonicalListHasher
    )
    credential_capability_hash: _CanonicalListHasher = field(
        default_factory=_CanonicalListHasher
    )
    credential_tier_values: _BoundedStrings = field(default_factory=_BoundedStrings)
    credential_capability_values: _BoundedStrings = field(
        default_factory=_BoundedStrings
    )
    request_manifest: list[dict[str, Any]] | None = None

    def __post_init__(self) -> None:
        if self.retain_manifest:
            self.request_manifest = []

    def consume(
        self,
        record: Mapping[str, Any],
        *,
        durable: bool,
        chain_valid: bool,
    ) -> bool:
        self.audit_delivery_records += 1
        if not _valid_audit_record(record):
            if not durable:
                self.audit_records += 1
            self.invalid_contract_records += 1
            return False
        if durable and not chain_valid:
            return False
        self.valid_delivery_records += 1
        self.delivery_queue_wait.add(record["queue_wait_ms"])
        self.delivery_service.add(record["service_ms"])
        if not durable:
            self.audit_records += 1
            self.valid_records += 1
            if record.get("status") == "failed":
                self.failed_records += 1
            else:
                self.succeeded_records += 1
            self._record_completion(record)
            return record.get("status") == "succeeded"
        event = record.get("audit_event")
        ordinal = record.get("logical_ordinal")
        if event == "logical_completion":
            if ordinal != self.next_completion_ordinal:
                self.invalid_logical_records += 1
                self.invalid_contract_records += 1
                return False
            self.next_completion_ordinal += 1
            self.audit_records += 1
            self.valid_records += 1
            self.succeeded_records += 1
            if record.get("execution_origin") == "replay":
                self.recovered_completion_records += 1
            else:
                self.original_delivery_records += 1
            self._record_completion(record)
            return True
        if not _nonnegative_int(ordinal) or ordinal > self.next_completion_ordinal:
            self.invalid_logical_records += 1
            self.invalid_contract_records += 1
            return False
        if event == "replay_delivery":
            if ordinal >= self.next_completion_ordinal:
                self.invalid_logical_records += 1
                self.invalid_contract_records += 1
                return False
            self.replay_delivery_records += 1
        elif event == "failure":
            self.failed_records += 1
        elif event == "pause_control":
            self.paused_records += 1
        return False

    def _record_completion(self, record: Mapping[str, Any]) -> None:
        for source, target in _DIMENSION_FIELDS:
            value = _clean_string(record.get(source))
            if value is not None:
                self.dimensions[target].add(value)
        self.fresh_session_records += 1
        if record.get("fresh_session") is not True:
            self.fresh_session_false_records += 1
        self.reasoning_effort_records += 1
        reasoning_effort = record.get("reasoning_effort")
        if isinstance(reasoning_effort, str):
            self.reasoning_efforts.add(reasoning_effort)
        else:
            self.reasoning_effort_unset_records += 1
        self.queue_wait.add(record["queue_wait_ms"])
        self.service.add(record["service_ms"])
        manifest_entry = _gateway_request_manifest_entry(record)
        self.request_manifest_hash.add(manifest_entry)
        if self.request_manifest is not None:
            self.request_manifest.append(manifest_entry)
        if record.get("schema_version") == 2:
            epoch_hmac = str(record["credential_epoch_hmac_sha256"])
            tier_hmac = str(record["credential_tier_hmac_sha256"])
            capability_hmac = str(record["credential_capability_hmac_sha256"])
            self.credential_epoch_hash.add(epoch_hmac)
            self.credential_tier_hash.add(tier_hmac)
            self.credential_capability_hash.add(capability_hmac)
            self.credential_tier_values.add(tier_hmac)
            self.credential_capability_values.add(capability_hmac)

    def summary(self) -> dict[str, Any]:
        dimension_overflow = sum(
            dimension.overflow_records for dimension in self.dimensions.values()
        ) + sum(
            values.overflow_records
            for values in (
                self.reasoning_efforts,
                self.credential_tier_values,
                self.credential_capability_values,
            )
        )
        summary: dict[str, Any] = {
            "audit_records": self.audit_records,
            "valid_records": self.valid_records,
            "audit_delivery_records": self.audit_delivery_records,
            "valid_delivery_records": self.valid_delivery_records,
            "invalid_contract_records": self.invalid_contract_records,
            "invalid_logical_records": self.invalid_logical_records,
            "succeeded_records": self.succeeded_records,
            "failed_records": self.failed_records,
            "paused_records": self.paused_records,
            "replay_delivery_records": self.replay_delivery_records,
            "original_delivery_records": self.original_delivery_records,
            "recovered_completion_records": self.recovered_completion_records,
            "dimension_value_overflow_records": dimension_overflow,
            **{
                key: sorted(dimension.values)
                for key, dimension in self.dimensions.items()
            },
            "fresh_session_all": bool(self.fresh_session_records)
            and self.fresh_session_false_records == 0,
            "reasoning_effort_records": self.reasoning_effort_records,
            "reasoning_efforts": sorted(self.reasoning_efforts.values),
            "reasoning_effort_unset_records": self.reasoning_effort_unset_records,
            "gateway_request_manifest_retained": self.request_manifest is not None,
            "gateway_request_manifest_count": self.request_manifest_hash.count,
            "gateway_request_manifest_sha256": self.request_manifest_hash.digest(),
            "credential_epoch_hmac_records": self.credential_epoch_hash.count,
            "credential_epoch_hmac_manifest_sha256": self.credential_epoch_hash.digest(),
            "credential_tier_hmac_records": self.credential_tier_hash.count,
            "credential_tier_hmac_manifest_sha256": self.credential_tier_hash.digest(),
            "credential_tier_hmacs": sorted(self.credential_tier_values.values),
            "credential_capability_hmac_records": (
                self.credential_capability_hash.count
            ),
            "credential_capability_hmac_manifest_sha256": (
                self.credential_capability_hash.digest()
            ),
            "credential_capability_hmacs": sorted(
                self.credential_capability_values.values
            ),
            "queue_wait_ms": self.queue_wait.summary(),
            "service_ms": self.service.summary(),
            "delivery_queue_wait_ms": self.delivery_queue_wait.summary(),
            "delivery_service_ms": self.delivery_service.summary(),
        }
        if self.request_manifest is not None:
            summary["gateway_request_manifest"] = self.request_manifest
        return summary


def summarize_subscription_gateway_audits(
    audit_path: Path,
    *,
    harnesses: Sequence[str] = tuple(sorted(EXPECTED_COHORT_HARNESSES)),
    retain_request_manifests: bool = False,
) -> dict[str, dict[str, Any]]:
    """Reduce all requested harness lanes in one bounded binary file pass."""

    normalized_harnesses = tuple(
        dict.fromkeys(harness.strip().lower() for harness in harnesses)
    )
    accumulator_harnesses = set(normalized_harnesses) | EXPECTED_COHORT_HARNESSES
    accumulators = {
        harness: _LaneAuditAccumulator(harness, retain_request_manifests)
        for harness in accumulator_harnesses
    }
    unexpected_harness_records = 0
    cohort_harnesses = _BoundedStrings()
    cohort_reasoning_efforts = {
        harness: _BoundedStrings() for harness in EXPECTED_COHORT_HARNESSES
    }
    cohort_reasoning_effort_unset_records = 0
    cohort_reasoning_effort_invalid_records = 0

    def consume_record(
        record: Mapping[str, Any],
        durable: bool,
        chain_valid: bool,
    ) -> None:
        nonlocal unexpected_harness_records
        nonlocal cohort_reasoning_effort_unset_records
        nonlocal cohort_reasoning_effort_invalid_records
        record_harness = _clean_string(record.get("harness"))
        completion_candidate = (
            record.get("audit_event") == "logical_completion"
            if durable
            else record.get("status") == "succeeded"
        )
        if record_harness in EXPECTED_COHORT_HARNESSES and completion_candidate:
            cohort_harnesses.add(record_harness)
            effort = record.get("reasoning_effort")
            if effort is None:
                cohort_reasoning_effort_unset_records += 1
            elif isinstance(effort, str) and effort in ALLOWED_REASONING_EFFORTS:
                cohort_reasoning_efforts[record_harness].add(effort)
            else:
                cohort_reasoning_effort_invalid_records += 1
        accumulator = accumulators.get(record_harness or "")
        if accumulator is None:
            unexpected_harness_records += 1
            return
        accumulator.consume(record, durable=durable, chain_valid=chain_valid)

    scan_diagnostics = _scan_subscription_gateway_audit(audit_path, consume_record)

    cohort_union = set().union(
        *(values.values for values in cohort_reasoning_efforts.values())
    )
    cohort_tier_hmacs = set().union(
        *(
            accumulators[harness].credential_tier_values.values
            for harness in EXPECTED_COHORT_HARNESSES
        )
    )
    cohort_capability_hmacs = set().union(
        *(
            accumulators[harness].credential_capability_values.values
            for harness in EXPECTED_COHORT_HARNESSES
        )
    )
    cohort_overflow = cohort_harnesses.overflow_records + sum(
        values.overflow_records for values in cohort_reasoning_efforts.values()
    )
    cohort_parity = (
        cohort_harnesses.values == EXPECTED_COHORT_HARNESSES
        and cohort_reasoning_effort_unset_records == 0
        and cohort_reasoning_effort_invalid_records == 0
        and cohort_overflow == 0
        and all(len(values.values) == 1 for values in cohort_reasoning_efforts.values())
        and len(cohort_union) == 1
    )
    cohort_tier_hmac_parity = (
        cohort_harnesses.values == EXPECTED_COHORT_HARNESSES
        and all(
            len(accumulators[harness].credential_tier_values.values) == 1
            and accumulators[harness].credential_tier_values.overflow_records == 0
            for harness in EXPECTED_COHORT_HARNESSES
        )
        and len(cohort_tier_hmacs) == 1
    )
    cohort_capability_hmac_parity = (
        cohort_harnesses.values == EXPECTED_COHORT_HARNESSES
        and all(
            len(accumulators[harness].credential_capability_values.values) == 1
            and accumulators[
                harness
            ].credential_capability_values.overflow_records
            == 0
            for harness in EXPECTED_COHORT_HARNESSES
        )
        and len(cohort_capability_hmacs) == 1
    )
    shared = {
        "schema_version": 2,
        **scan_diagnostics,
        "unexpected_harness_records": unexpected_harness_records,
        "cohort_harnesses": sorted(cohort_harnesses.values),
        "cohort_reasoning_efforts": sorted(cohort_union),
        "cohort_reasoning_efforts_by_harness": {
            harness: sorted(cohort_reasoning_efforts[harness].values)
            for harness in sorted(EXPECTED_COHORT_HARNESSES)
        },
        "cohort_reasoning_effort_unset_records": (
            cohort_reasoning_effort_unset_records
        ),
        "cohort_reasoning_effort_invalid_records": (
            cohort_reasoning_effort_invalid_records
        ),
        "cohort_dimension_value_overflow_records": cohort_overflow,
        "cohort_reasoning_effort_parity": cohort_parity,
        "cohort_reasoning_effort": (
            next(iter(cohort_union)) if cohort_parity else None
        ),
        "cohort_credential_tier_hmac_parity": cohort_tier_hmac_parity,
        "cohort_credential_tier_hmac_sha256": (
            next(iter(cohort_tier_hmacs)) if cohort_tier_hmac_parity else None
        ),
        "cohort_credential_capability_hmac_parity": (
            cohort_capability_hmac_parity
        ),
        "cohort_credential_capability_hmac_sha256": (
            next(iter(cohort_capability_hmacs))
            if cohort_capability_hmac_parity
            else None
        ),
        "shared_subscription_serial_queue": True,
        "wall_clock_latency_comparable": False,
    }
    summaries: dict[str, dict[str, Any]] = {}
    for harness in normalized_harnesses:
        lane_summary = accumulators[harness].summary()
        lane_summary["invalid_contract_records"] += scan_diagnostics[
            "global_invalid_contract_records"
        ]
        summaries[harness] = {**shared, **lane_summary}
    return summaries


def summarize_subscription_gateway_audit(
    audit_path: Path,
    *,
    harness: str,
    benchmark_id: str | None = None,
) -> dict[str, Any]:
    """Return one lane summary while preserving bounded defaults."""

    normalized_harness = harness.strip().lower()
    return summarize_subscription_gateway_audits(
        audit_path,
        harnesses=(normalized_harness,),
        retain_request_manifests=(
            (benchmark_id or "").strip().lower() == LIFECYCLE_BENCHMARK_ID
        ),
    )[normalized_harness]


def subscription_gateway_quarantine_reason(
    *,
    agent: str,
    provider: str,
    model: str,
    provenance: Mapping[str, Any] | None,
    minimum_request_count: int | None,
    benchmark_id: str | None = None,
) -> str | None:
    """Return the first fail-closed reason for a subscription gateway summary."""

    if provider.strip().lower() != "claude-subscription":
        return None
    harness = agent.strip().lower()
    if harness not in {"eliza", "hermes", "openclaw"}:
        return "subscription_gateway_unknown_harness"
    if not isinstance(provenance, Mapping):
        return "subscription_missing_gateway_provenance"
    records = provenance.get("audit_records")
    valid_records = provenance.get("valid_records")
    if not isinstance(records, int) or records <= 0:
        return "subscription_missing_gateway_audit"
    if valid_records != records:
        return "subscription_invalid_gateway_audit"
    if provenance.get("audit_chain_mode") != "sha256-chain-v2":
        return "subscription_gateway_durable_audit_required"
    if provenance.get("audit_read_error") is True:
        return "subscription_gateway_audit_read_failure"
    if provenance.get("invalid_json_lines") not in (0, None):
        return "subscription_invalid_gateway_jsonl"
    if provenance.get("invalid_contract_records") not in (0, None):
        return "subscription_invalid_gateway_record"
    if provenance.get("invalid_chain_records") not in (0, None):
        return "subscription_gateway_audit_chain_invalid"
    if provenance.get("invalid_logical_records") not in (0, None):
        return "subscription_gateway_logical_sequence_invalid"
    if provenance.get("unexpected_harness_records") not in (0, None):
        return "subscription_gateway_unknown_harness_record"
    if provenance.get("dimension_value_overflow_records") not in (0, None):
        return "subscription_gateway_dimension_overflow"
    if provenance.get("cohort_dimension_value_overflow_records") not in (0, None):
        return "subscription_gateway_cohort_dimension_overflow"
    if isinstance(minimum_request_count, int) and records < minimum_request_count:
        return "subscription_incomplete_gateway_audit"
    if provenance.get("succeeded_records") != records:
        return "subscription_gateway_request_failure"
    if provenance.get("failed_records") not in (0, None):
        return "subscription_gateway_request_failure"
    if provenance.get("gateway_request_manifest_count") != records:
        return "subscription_gateway_request_manifest_mismatch"
    if provenance.get("credential_epoch_hmac_records") != records:
        return "subscription_gateway_credential_epoch_attestation_missing"
    if provenance.get("credential_tier_hmac_records") != records:
        return "subscription_gateway_credential_tier_attestation_missing"
    if provenance.get("credential_capability_hmac_records") != records:
        return "subscription_gateway_credential_capability_attestation_missing"
    tier_hmacs = provenance.get("credential_tier_hmacs")
    if (
        not isinstance(tier_hmacs, list)
        or len(tier_hmacs) != 1
        or not isinstance(tier_hmacs[0], str)
        or not _is_sha256(tier_hmacs[0])
    ):
        return "subscription_gateway_credential_tier_mismatch"
    capability_hmacs = provenance.get("credential_capability_hmacs")
    if (
        not isinstance(capability_hmacs, list)
        or len(capability_hmacs) != 1
        or not isinstance(capability_hmacs[0], str)
        or not _is_sha256(capability_hmacs[0])
    ):
        return "subscription_gateway_credential_capability_mismatch"
    if provenance.get("cohort_run_group_complete") is True:
        if provenance.get("cohort_credential_tier_hmac_parity") is not True:
            return "subscription_gateway_credential_tier_cohort_mismatch"
        if provenance.get("cohort_credential_capability_hmac_parity") is not True:
            return "subscription_gateway_credential_capability_cohort_mismatch"
    if provenance.get("harnesses") != [harness]:
        return "subscription_gateway_harness_mismatch"
    if provenance.get("transports") != [EXPECTED_TRANSPORT]:
        return "subscription_gateway_transport_mismatch"
    if provenance.get("credential_sources") != [EXPECTED_CREDENTIAL_SOURCE]:
        return "subscription_gateway_credential_source_mismatch"
    if provenance.get("sdk_api_key_sources") != [EXPECTED_SDK_API_KEY_SOURCE]:
        return "subscription_gateway_api_billing_detected"
    if provenance.get("sdk_versions") != [EXPECTED_SDK_VERSION]:
        return "subscription_gateway_sdk_version_mismatch"
    if provenance.get("tool_execution_modes") != [EXPECTED_TOOL_EXECUTION]:
        return "subscription_gateway_tool_execution_mismatch"
    if provenance.get("serializers") != [EXPECTED_SERIALIZER]:
        return "subscription_gateway_serializer_mismatch"
    response_modes = provenance.get("response_modes")
    if (
        not isinstance(response_modes, list)
        or not response_modes
        or not set(response_modes).issubset(ALLOWED_RESPONSE_MODES)
    ):
        return "subscription_gateway_response_mode_mismatch"
    if provenance.get("fresh_session_all") is not True:
        return "subscription_gateway_reused_session"
    if provenance.get("reasoning_effort_records") != records:
        return "subscription_gateway_reasoning_effort_missing"
    if provenance.get("reasoning_effort_unset_records") != 0:
        return "subscription_gateway_reasoning_effort_unset"
    reasoning_efforts = provenance.get("reasoning_efforts")
    if (
        not isinstance(reasoning_efforts, list)
        or len(reasoning_efforts) != 1
        or reasoning_efforts[0] not in ALLOWED_REASONING_EFFORTS
    ):
        return "subscription_gateway_reasoning_effort_mismatch"
    normalized_model = model.strip().split("/", 1)[-1]
    if provenance.get("models_requested") != [normalized_model]:
        return "subscription_gateway_requested_model_mismatch"
    if provenance.get("models_effective") != [normalized_model]:
        return "subscription_gateway_effective_model_mismatch"
    claude_versions = provenance.get("claude_code_versions")
    if not isinstance(claude_versions, list) or not claude_versions:
        return "subscription_gateway_missing_claude_code_version"
    if provenance.get("audit_file_exists") is not True:
        return "subscription_gateway_audit_artifact_missing"
    audit_sha256 = provenance.get("audit_sha256")
    if not isinstance(audit_sha256, str) or not _is_sha256(audit_sha256):
        return "subscription_gateway_audit_hash_missing"
    if provenance.get("shared_subscription_serial_queue") is not True:
        return "subscription_gateway_queue_contract_missing"
    if provenance.get("wall_clock_latency_comparable") is not False:
        return "subscription_gateway_latency_mislabeled"
    if (benchmark_id or "").strip().lower() == LIFECYCLE_BENCHMARK_ID:
        lifecycle_contract = provenance.get("lifecycle_execution_contract")
        if not isinstance(lifecycle_contract, Mapping):
            return "subscription_lifecycle_gateway_contract_missing"
        if lifecycle_contract.get("validation_status") != "succeeded":
            rejection_reason = lifecycle_contract.get("rejection_reason")
            return (
                rejection_reason
                if isinstance(rejection_reason, str) and rejection_reason
                else "subscription_lifecycle_gateway_contract_invalid"
            )
        if lifecycle_contract.get("expected_requests") != records:
            return "subscription_lifecycle_gateway_request_count_mismatch"
        if provenance.get("cohort_lifecycle_parallel_tool_calls_parity") is not True:
            return "subscription_lifecycle_parallel_tool_calls_cohort_mismatch"
    return None


def validate_subscription_gateway_audit_artifact(
    provenance: Mapping[str, Any] | None,
) -> str | None:
    """Re-hash a referenced audit so later publication detects lost evidence."""

    if not isinstance(provenance, Mapping):
        return "subscription_missing_gateway_provenance"
    raw_path = provenance.get("audit_file")
    expected_hash = provenance.get("audit_sha256")
    if not isinstance(raw_path, str) or not raw_path:
        return "subscription_gateway_audit_artifact_missing"
    if not isinstance(expected_hash, str) or not _is_sha256(expected_hash):
        return "subscription_gateway_audit_hash_missing"
    path = Path(raw_path)
    try:
        hasher = hashlib.sha256()
        with path.open("rb") as audit_file:
            while chunk := audit_file.read(_AUDIT_READ_CHUNK_BYTES):
                hasher.update(chunk)
        actual_hash = hasher.hexdigest()
    except OSError:
        # error-policy:J3 artifact verification returns a typed rejection code,
        # not a healthy empty digest.
        return "subscription_gateway_audit_artifact_missing"
    if actual_hash != expected_hash:
        return "subscription_gateway_audit_hash_mismatch"
    return None


def _gateway_request_manifest_entry(
    record: Mapping[str, Any],
) -> dict[str, Any]:
    """Retain ordered, content-free request facts needed by publication."""

    content_attestation = record.get("content_attestation")
    return {
        "schema_version": record.get("schema_version"),
        "audit_event": record.get("audit_event"),
        "audit_sequence": record.get("audit_sequence"),
        "previous_record_sha256": record.get("previous_record_sha256"),
        "record_sha256": record.get("record_sha256"),
        "logical_namespace_sha256": record.get("logical_namespace_sha256"),
        "logical_key_sha256": record.get("logical_key_sha256"),
        "logical_ordinal": record.get("logical_ordinal"),
        "delivery_attempt": record.get("delivery_attempt"),
        "execution_origin": record.get("execution_origin"),
        "credential_epoch_hmac_sha256": record.get(
            "credential_epoch_hmac_sha256"
        ),
        "credential_tier_hmac_sha256": record.get(
            "credential_tier_hmac_sha256"
        ),
        "credential_capability_hmac_sha256": record.get(
            "credential_capability_hmac_sha256"
        ),
        "request_id": record.get("request_id"),
        "recorded_at": record.get("recorded_at"),
        "harness": record.get("harness"),
        "transport": record.get("transport"),
        "credential_source": record.get("credential_source"),
        "sdk_version": record.get("sdk_version"),
        "sdk_api_key_source": record.get("sdk_api_key_source"),
        "claude_code_version": record.get("claude_code_version"),
        "fresh_session": record.get("fresh_session"),
        "tool_execution": record.get("tool_execution"),
        "serializer": record.get("serializer"),
        "response_mode": record.get("response_mode"),
        "model_requested": record.get("model_requested"),
        "model_effective": record.get("model_effective"),
        "reasoning_effort": record.get("reasoning_effort"),
        "message_count": record.get("message_count"),
        "message_roles": list(record.get("message_roles") or []),
        "tool_names": list(record.get("tool_names") or []),
        "tool_choice": record.get("tool_choice"),
        "parallel_tool_calls": record.get("parallel_tool_calls"),
        "tool_call_names": list(record.get("tool_call_names") or []),
        "tool_schema_sha256": record.get("tool_schema_sha256"),
        "tool_schema_sha256_by_name": dict(
            record.get("tool_schema_sha256_by_name") or {}
        ),
        "request_sha256": record.get("request_sha256"),
        "prompt_sha256": record.get("prompt_sha256"),
        "system_prompt_sha256": record.get("system_prompt_sha256"),
        "status": record.get("status"),
        "finish_reason": record.get("finish_reason"),
        "result_subtype": record.get("result_subtype"),
        "terminal_reason": record.get("terminal_reason"),
        "unapplied_parameters": list(record.get("unapplied_parameters") or []),
        "error_code": record.get("error_code"),
        "content_attestation": (
            json.loads(json.dumps(content_attestation, sort_keys=True))
            if isinstance(content_attestation, Mapping)
            else None
        ),
        "queue_wait_ms": record.get("queue_wait_ms"),
        "service_ms": record.get("service_ms"),
    }


def _valid_content_attestation(
    value: object,
    *,
    message_roles: object,
    message_count: object,
) -> bool:
    if not isinstance(value, Mapping) or set(value) != _CONTENT_ATTESTATION_KEYS:
        return False
    if value.get("schema_version") != 1:
        return False
    contract_id = value.get("contract_id")
    if not isinstance(contract_id, str) or not _SAFE_CONTRACT_ID.fullmatch(contract_id):
        return False
    if any(
        not isinstance(value.get(key), str) or not _is_sha256(str(value.get(key)))
        for key in ("contract_sha256", "system_hint_sha256")
    ):
        return False
    for key in (
        "system_hint_instruction_occurrences",
        "system_hint_user_occurrences",
        "system_hint_generated_occurrences",
        "forbidden_ingress_match_total",
        "forbidden_generated_match_total",
    ):
        if not _nonnegative_int(value.get(key)):
            return False
    for key in (
        "public_user_matches",
        "public_user_instruction_matches",
        "public_user_generated_matches",
    ):
        matches = value.get(key)
        if not isinstance(matches, Mapping) or any(
            not isinstance(digest, str)
            or not _is_sha256(digest)
            or not _positive_int(count)
            for digest, count in matches.items()
        ):
            return False
    category_maps: dict[str, Mapping[str, object]] = {}
    for key in (
        "forbidden_ingress_match_counts",
        "forbidden_generated_match_counts",
        "observed_instruction_match_counts",
        "observed_user_match_counts",
        "observed_ingress_match_counts",
        "observed_generated_match_counts",
    ):
        counts = value.get(key)
        if (
            not isinstance(counts, Mapping)
            or not counts
            or any(
                not isinstance(category, str)
                or not _SAFE_CATEGORY.fullmatch(category)
                or not _nonnegative_int(count)
                for category, count in counts.items()
            )
        ):
            return False
        category_maps[key] = counts
    if set(category_maps["forbidden_ingress_match_counts"]) != set(
        category_maps["forbidden_generated_match_counts"]
    ):
        return False
    observed_keys = set(category_maps["observed_instruction_match_counts"])
    if any(
        set(category_maps[key]) != observed_keys
        for key in (
            "observed_user_match_counts",
            "observed_ingress_match_counts",
            "observed_generated_match_counts",
        )
    ):
        return False
    forbidden_ingress = category_maps["forbidden_ingress_match_counts"]
    forbidden_generated = category_maps["forbidden_generated_match_counts"]
    if value.get("forbidden_ingress_match_total") != sum(
        int(count) for count in forbidden_ingress.values()
    ) or value.get("forbidden_generated_match_total") != sum(
        int(count) for count in forbidden_generated.values()
    ):
        return False
    instruction_counts = category_maps["observed_instruction_match_counts"]
    user_counts = category_maps["observed_user_match_counts"]
    ingress_counts = category_maps["observed_ingress_match_counts"]
    if any(
        ingress_counts[category]
        != int(instruction_counts[category]) + int(user_counts[category])
        for category in observed_keys
    ):
        return False
    if (
        not isinstance(message_roles, list)
        or not isinstance(message_count, int)
        or isinstance(message_count, bool)
        or len(message_roles) != message_count
    ):
        return False
    manifest = value.get("message_content_manifest")
    if not isinstance(manifest, list) or len(manifest) != message_count:
        return False
    for index, entry in enumerate(manifest):
        if (
            not isinstance(entry, Mapping)
            or set(entry) != _CONTENT_MANIFEST_KEYS
            or entry.get("index") != index
            or entry.get("role") != message_roles[index]
            or entry.get("role") not in _CHAT_ROLES
            or not isinstance(entry.get("sha256"), str)
            or not _is_sha256(str(entry.get("sha256")))
        ):
            return False
    return True


def _valid_audit_record(record: Mapping[str, Any]) -> bool:
    required_strings = (
        "request_id",
        "recorded_at",
        "harness",
        "transport",
        "credential_source",
        "sdk_version",
        "sdk_api_key_source",
        "tool_execution",
        "serializer",
        "response_mode",
        "model_requested",
        "tool_choice",
        "status",
    )
    schema_version = record.get("schema_version")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version not in {1, 2}
    ):
        return False
    if schema_version == 2 and not _DURABLE_AUDIT_FIELDS.issubset(record):
        return False
    if any(_clean_string(record.get(key)) is None for key in required_strings):
        return False
    event = record.get("audit_event")
    if schema_version == 1 or (
        isinstance(event, str)
        and event in {"logical_completion", "replay_delivery"}
    ):
        if any(
            _clean_string(record.get(key)) is None
            for key in ("claude_code_version", "model_effective")
        ):
            return False
    elif (
        isinstance(event, str)
        and event in {"failure", "pause_control"}
        and (
            record.get("claude_code_version") is not None
            or record.get("model_effective") is not None
        )
    ):
        return False
    if record.get("fresh_session") is not True:
        return False
    status = record.get("status")
    if (
        (schema_version == 1 and status not in {"succeeded", "failed"})
        or (schema_version == 2 and status not in _AUDIT_STATUSES)
    ):
        return False
    if record.get("response_mode") not in ALLOWED_RESPONSE_MODES:
        return False
    reasoning_effort = record.get("reasoning_effort")
    if "reasoning_effort" not in record or (
        reasoning_effort is not None
        and (
            not isinstance(reasoning_effort, str)
            or reasoning_effort not in ALLOWED_REASONING_EFFORTS
        )
    ):
        return False
    for key in (
        "message_roles",
        "tool_names",
        "tool_call_names",
        "unapplied_parameters",
    ):
        if not _string_list(record.get(key)):
            return False
    if not isinstance(record.get("message_count"), int) or record["message_count"] <= 0:
        return False
    message_roles = record.get("message_roles")
    if (
        not isinstance(message_roles, list)
        or len(message_roles) != record["message_count"]
        or any(role not in _CHAT_ROLES for role in message_roles)
    ):
        return False
    if "parallel_tool_calls" in record and not isinstance(
        record.get("parallel_tool_calls"), bool
    ):
        return False
    for key in ("queue_wait_ms", "service_ms"):
        if not _valid_duration(record.get(key)):
            return False
    if any(
        not isinstance(record.get(key), str) or not _is_sha256(record[key])
        for key in HASH_FIELDS
    ):
        return False
    per_tool_hashes = record.get("tool_schema_sha256_by_name")
    if per_tool_hashes is not None:
        tool_names = record.get("tool_names")
        if (
            not isinstance(per_tool_hashes, Mapping)
            or not isinstance(tool_names, list)
            or set(per_tool_hashes) != set(tool_names)
            or any(
                not isinstance(name, str)
                or not isinstance(value, str)
                or not _is_sha256(value)
                for name, value in per_tool_hashes.items()
            )
        ):
            return False
    if "content_attestation" in record and record.get("content_attestation") is not None:
        if not _valid_content_attestation(
            record.get("content_attestation"),
            message_roles=message_roles,
            message_count=record.get("message_count"),
        ):
            return False
    return True


def _clean_string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _string_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _nonnegative_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _safe_positive_int(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 < value <= 2**53 - 1
    )


def _safe_nonnegative_int(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 2**53 - 1
    )


def _valid_duration(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if value < 0:
        return False
    if isinstance(value, float):
        return math.isfinite(value)
    return value <= 10**308


def _canonical_json_sha256(value: object) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _json_object(raw: object) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise TypeError("Benchmark metrics JSON must be stored as text")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise TypeError("Benchmark metrics JSON must contain an object")
    return dict(value)


def _json_list(raw: object) -> list[str]:
    if not isinstance(raw, str):
        raise TypeError("Benchmark artifacts JSON must be stored as text")
    value = json.loads(raw)
    if not isinstance(value, list):
        raise TypeError("Benchmark artifacts JSON must contain an array")
    if not all(isinstance(item, str) for item in value):
        raise TypeError("Benchmark artifact entries must be strings")
    return list(value)
