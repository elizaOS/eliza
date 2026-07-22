"""Checks fail-closed subscription evidence without retaining model content."""

from __future__ import annotations

import json
import hashlib
import sqlite3
import tracemalloc
from pathlib import Path

import pytest

from benchmarks.publication_contracts import (
    WEBSHOP_FULL_REPORT_CONTRACT,
    WEBSHOP_FULL_SCENARIO_ID_MANIFEST_SHA256,
)
from benchmarks.orchestrator.runner import _publication_quarantine_reason
from benchmarks.orchestrator.runtime_provenance import EXPECTED_NATIVE_RUNTIME
from benchmarks.orchestrator.subscription_gateway import (
    GatewayLifecycleError,
    GatewayPauseStatus,
    read_gateway_pause_state,
)
from benchmarks.orchestrator.subscription_provenance import (
    LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256,
    LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256,
    LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
    attach_subscription_gateway_provenance,
    evaluate_lifecycle_gateway_execution,
    gateway_content_contract_sha256,
    lifecycle_tasks_gateway_schema_sha256,
    scan_subscription_gateway_audit,
    subscription_gateway_logical_key_sha256,
    subscription_gateway_quarantine_reason,
    summarize_subscription_gateway_audit,
    summarize_subscription_gateway_audits,
    validate_subscription_gateway_audit_artifact,
)


HASH = "a" * 64
NAMESPACE_HASH = "b" * 64
EPOCH_HMAC = "c" * 64
TIER_HMAC = "d" * 64
CAPABILITY_HMAC = "e" * 64


def _record(
    harness: str,
    *,
    request_id: str,
    queue_wait_ms: float,
    response_mode: str = "json",
    api_key_source: str = "none",
    reasoning_effort: str | None = "medium",
) -> dict:
    return {
        "schema_version": 1,
        "request_id": request_id,
        "recorded_at": "2026-07-20T20:00:00Z",
        "harness": harness,
        "transport": "claude-agent-sdk",
        "credential_source": "claude-code-managed",
        "sdk_version": "0.3.200",
        "sdk_api_key_source": api_key_source,
        "claude_code_version": "2.1.214",
        "fresh_session": True,
        "tool_execution": "capture-only",
        "serializer": "openai-full-history-v1",
        "response_mode": response_mode,
        "model_requested": "claude-opus-4-6",
        "model_effective": "claude-opus-4-6",
        "reasoning_effort": reasoning_effort,
        "message_count": 2,
        "message_roles": ["system", "user"],
        "tool_names": ["lookup"],
        "tool_choice": "auto",
        "tool_call_names": [],
        "prompt_sha256": HASH,
        "system_prompt_sha256": HASH,
        "tool_schema_sha256": HASH,
        "tool_schema_sha256_by_name": {"lookup": HASH},
        "request_sha256": HASH,
        "queue_wait_ms": queue_wait_ms,
        "service_ms": 250.0,
        "status": "succeeded",
        "finish_reason": "stop",
        "result_subtype": "success",
        "terminal_reason": None,
        "unapplied_parameters": [],
        "error_code": None,
    }


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _durable_records(records: list[dict]) -> list[dict]:
    completed_by_harness: dict[str, int] = {}
    durable: list[dict] = []
    previous = "0" * 64
    for sequence, source in enumerate(records):
        record = dict(source)
        harness = str(record["harness"])
        event = str(record.get("audit_event") or "logical_completion")
        ordinal = record.get("logical_ordinal")
        if ordinal is None:
            ordinal = completed_by_harness.get(harness, 0)
        assert isinstance(ordinal, int)
        if event == "logical_completion":
            completed_by_harness[harness] = ordinal + 1
        status = {
            "logical_completion": "succeeded",
            "replay_delivery": "succeeded",
            "failure": "failed",
            "pause_control": "paused",
        }[event]
        origin = str(
            record.get("execution_origin")
            or ("replay" if event == "replay_delivery" else "original")
        )
        logical_key = subscription_gateway_logical_key_sha256(
            harness=harness,
            logical_namespace_sha256=NAMESPACE_HASH,
            logical_ordinal=ordinal,
            request_sha256=str(record["request_sha256"]),
            model_requested=str(record["model_requested"]),
            reasoning_effort=record.get("reasoning_effort"),
        )
        record.update(
            {
                "schema_version": 2,
                "audit_event": event,
                "audit_sequence": sequence,
                "previous_record_sha256": previous,
                "logical_namespace_sha256": NAMESPACE_HASH,
                "logical_key_sha256": logical_key,
                "logical_ordinal": ordinal,
                "delivery_attempt": 1 if event == "logical_completion" else None,
                "execution_origin": origin,
                "credential_epoch_hmac_sha256": (
                    EPOCH_HMAC
                    if event in {"logical_completion", "replay_delivery"}
                    else None
                ),
                "credential_tier_hmac_sha256": (
                    TIER_HMAC
                    if event in {"logical_completion", "replay_delivery"}
                    else None
                ),
                "credential_capability_hmac_sha256": (
                    CAPABILITY_HMAC
                    if event in {"logical_completion", "replay_delivery"}
                    else None
                ),
                "request_id": f"logical_{logical_key}",
                "status": status,
                "claude_code_version": (
                    record["claude_code_version"]
                    if event in {"logical_completion", "replay_delivery"}
                    else None
                ),
                "model_effective": (
                    record["model_effective"]
                    if event in {"logical_completion", "replay_delivery"}
                    else None
                ),
            }
        )
        if event == "pause_control":
            record.setdefault("pause_reason", "rate_limit_unknown")
            record.setdefault("retry_at", None)
        record["record_sha256"] = _canonical_sha256(record)
        previous = record["record_sha256"]
        durable.append(record)
    return durable


def _reseal_durable_records(records: list[dict]) -> None:
    previous = "0" * 64
    for sequence, record in enumerate(records):
        record["audit_sequence"] = sequence
        record["previous_record_sha256"] = previous
        record.pop("record_sha256", None)
        record["record_sha256"] = _canonical_sha256(record)
        previous = record["record_sha256"]


def _lifecycle_contract(*turns: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "contract_id": "lifecycle_unit_v1",
        "system_hint": "reviewed lifecycle hint",
        "public_user_turns": list(turns),
        "forbidden_text_by_category": {
            "scenario_ids": ["hidden_scenario"],
            "scoring_behavior_labels": ["spawn_subagent"],
        },
        "observed_text_by_category": {
            "workspace_paths": ["/reviewed/workspace"]
        },
    }


def _lifecycle_gateway_record(
    *,
    harness: str,
    request_id: str,
    contract: dict[str, object],
    public_turn: str,
    roles: list[str],
    tool_name: str,
    schema_sha256: str,
    tool_choice: str,
    call_names: list[str],
    parallel_tool_calls: bool = True,
    generated_forbidden: int = 0,
) -> dict:
    record = _record(
        harness,
        request_id=request_id,
        queue_wait_ms=0,
        reasoning_effort="medium",
    )
    record.update(
        {
            "message_count": len(roles),
            "message_roles": roles,
            "tool_names": [tool_name],
            "tool_choice": tool_choice,
            "parallel_tool_calls": parallel_tool_calls,
            "tool_call_names": call_names,
            "tool_schema_sha256": schema_sha256,
            "tool_schema_sha256_by_name": {tool_name: schema_sha256},
            "finish_reason": "tool_calls" if call_names else "stop",
        }
    )
    public_turns = contract["public_user_turns"]
    assert isinstance(public_turns, list)
    public_matches = {
        hashlib.sha256(candidate.encode("utf-8")).hexdigest(): public_turn.count(
            candidate
        )
        for candidate in public_turns
        if isinstance(candidate, str) and public_turn.count(candidate) > 0
    }
    forbidden_generated = {
        "scenario_ids": 0,
        "scoring_behavior_labels": generated_forbidden,
    }
    record["content_attestation"] = {
        "schema_version": 1,
        "contract_id": contract["contract_id"],
        "contract_sha256": gateway_content_contract_sha256(contract),
        "system_hint_sha256": hashlib.sha256(
            str(contract["system_hint"]).encode("utf-8")
        ).hexdigest(),
        "system_hint_instruction_occurrences": 1,
        "system_hint_user_occurrences": 0,
        "system_hint_generated_occurrences": 0,
        "public_user_matches": public_matches,
        "public_user_instruction_matches": {},
        "public_user_generated_matches": {},
        "forbidden_ingress_match_counts": {
            "scenario_ids": 0,
            "scoring_behavior_labels": 0,
        },
        "forbidden_ingress_match_total": 0,
        "forbidden_generated_match_counts": forbidden_generated,
        "forbidden_generated_match_total": generated_forbidden,
        "observed_instruction_match_counts": {"workspace_paths": 1},
        "observed_user_match_counts": {"workspace_paths": 0},
        "observed_ingress_match_counts": {"workspace_paths": 1},
        "observed_generated_match_counts": {"workspace_paths": 0},
        "message_content_manifest": [
            {
                "index": index,
                "role": role,
                "sha256": hashlib.sha256(
                    f"{request_id}:{index}:{role}".encode("utf-8")
                ).hexdigest(),
            }
            for index, role in enumerate(roles)
        ],
    }
    return record


def _lifecycle_turn(
    *,
    ordinal: int,
    task_turn_index: int,
    model_calls: int,
    tool_calls: list[str],
    model_types: dict[str, int] | None = None,
) -> dict[str, object]:
    return {
        "ordinal": ordinal,
        "task_id_sha256": hashlib.sha256(b"opaque-task").hexdigest(),
        "task_turn_index": task_turn_index,
        "model_boundary_call_count": model_calls,
        "model_call_count_source": "unit",
        "model_type_call_counts": model_types or {},
        "tool_call_names": tool_calls,
        "lifecycle_result_names": tool_calls,
    }


def _write_audit(
    path: Path,
    records: list[dict],
    *,
    complete_cohort: bool = True,
    durable: bool = True,
) -> None:
    payload = list(records)
    if complete_cohort:
        observed = {str(record.get("harness") or "") for record in payload}
        for harness in ("eliza", "hermes", "openclaw"):
            if harness not in observed:
                payload.append(
                    _record(
                        harness,
                        request_id=f"cohort-{harness}",
                        queue_wait_ms=0,
                    )
                )
    if durable and not any(record.get("schema_version") == 2 for record in payload):
        payload = _durable_records(payload)
    path.write_text(
        "".join(f"{json.dumps(record, sort_keys=True)}\n" for record in payload),
        encoding="utf-8",
    )


def test_logical_request_identity_matches_typescript_parity_vector() -> None:
    logical_key = subscription_gateway_logical_key_sha256(
        harness="hermes",
        logical_namespace_sha256=NAMESPACE_HASH,
        logical_ordinal=17,
        request_sha256=HASH,
        model_requested="claude-opus-4-6",
        reasoning_effort="medium",
    )

    assert logical_key == (
        "3754bb89fae2c50ce3c9d5deceae329461dd3aba5860d77120af8092cc6b5a19"
    )
    assert f"logical_{logical_key}" == (
        "logical_3754bb89fae2c50ce3c9d5deceae329461dd3aba5860d77120af8092cc6b5a19"
    )


def _runtime_summary(harness: str, *, telemetry_records: int) -> dict:
    expected = EXPECTED_NATIVE_RUNTIME[harness]
    summary = {
        "telemetry_records": telemetry_records,
        "provenance_records": telemetry_records,
        "invalid_json_lines": 0,
        "harnesses": [harness],
        "providers": ["claude-subscription"],
        "models": ["claude-opus-4-6"],
        "agent_runtimes": [expected["agent_runtime"]],
        "native_runtime_classes": [expected["native_runtime_class"]],
        "native_runtime_apis": [expected["native_runtime_api"]],
        "transports": [expected["transport"]],
        "publishable_native_all": True,
        "stub_embedding_enabled": False,
        "task_id_records": telemetry_records,
        "missing_task_id_records": 0,
        "task_id_manifest_count": 5_500,
        "task_id_manifest_sha256": WEBSHOP_FULL_SCENARIO_ID_MANIFEST_SHA256,
    }
    if harness == "eliza":
        summary.update(
            {
                "invalid_native_route_records": 0,
                "direct_model_bypass_all_false": True,
                "stand_in_all_false": True,
                "release_evidence_all": True,
            }
        )
    elif harness == "openclaw":
        summary.update(
            {
                "openclaw_native_session_records": telemetry_records,
                "openclaw_native_session_evidence_all_succeeded": True,
                "openclaw_native_session_sha256_all_valid": True,
                "openclaw_native_session_sha256_manifest_count": telemetry_records,
                "openclaw_native_session_terminal_reason_records": telemetry_records,
                "openclaw_native_session_terminal_reasons": ["stop"],
                "openclaw_native_trajectory_evidence_all_succeeded": True,
                "openclaw_native_trajectory_sha256_all_valid": True,
                "openclaw_native_trajectory_sha256_manifest_count": (telemetry_records),
                "openclaw_full_native_usage_all_attested": True,
                "openclaw_native_usage_sha256_all_valid": True,
                "openclaw_runtime_identity_all_attested": True,
                "openclaw_thinking_level_all_attested": True,
            }
        )
    return summary


def test_lifecycle_tasks_gateway_hash_is_derived_from_full_contract() -> None:
    assert (
        lifecycle_tasks_gateway_schema_sha256()
        == LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256
    )


def test_lifecycle_external_gate_accepts_exact_loop_and_overlapping_edge_turn() -> None:
    base = "Delegate the workspace review."
    edge = "Delegate the workspace review. Keep the report brief."
    contract = _lifecycle_contract(base, edge)
    records = [
        _lifecycle_gateway_record(
            harness="hermes",
            request_id="h-0",
            contract=contract,
            public_turn=base,
            roles=["system", "user"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="auto",
            call_names=["TASKS"],
        ),
        _lifecycle_gateway_record(
            harness="hermes",
            request_id="h-1",
            contract=contract,
            public_turn=base,
            roles=["system", "user", "assistant", "tool"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="auto",
            call_names=[],
            generated_forbidden=1,
        ),
        _lifecycle_gateway_record(
            harness="hermes",
            request_id="h-2",
            contract=contract,
            public_turn=edge,
            roles=["system", "user", "assistant", "user"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="auto",
            call_names=[],
        ),
    ]
    # Request hashes are native-scaffold evidence, not a cross-harness parity key.
    records[0]["request_sha256"] = "1" * 64
    records[1]["request_sha256"] = "2" * 64
    records[2]["request_sha256"] = "3" * 64
    result = evaluate_lifecycle_gateway_execution(
        harness="hermes",
        records=records,
        runtime_turn_manifest=[
            _lifecycle_turn(
                ordinal=0,
                task_turn_index=0,
                model_calls=2,
                tool_calls=["TASKS"],
            ),
            _lifecycle_turn(
                ordinal=1,
                task_turn_index=1,
                model_calls=1,
                tool_calls=[],
            ),
        ],
        content_contract=contract,
        expected_reasoning_effort="medium",
    )

    assert result["validation_status"] == "succeeded"
    assert result["validated_turns"] == 2
    assert result["generated_forbidden_match_counts"] == {
        "scenario_ids": 0,
        "scoring_behavior_labels": 1,
    }
    assert result["observed_instruction_match_counts"] == {
        "workspace_paths": 3
    }


def test_lifecycle_eliza_gate_accepts_native_three_stage_graph() -> None:
    public_turn = "Start one delegated review."
    contract = _lifecycle_contract(public_turn)
    records = [
        _lifecycle_gateway_record(
            harness="eliza",
            request_id="e-0",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user"],
            tool_name="HANDLE_RESPONSE",
            schema_sha256=LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256,
            tool_choice="required",
            call_names=["HANDLE_RESPONSE"],
        ),
        _lifecycle_gateway_record(
            harness="eliza",
            request_id="e-1",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="required",
            call_names=["TASKS"],
        ),
        _lifecycle_gateway_record(
            harness="eliza",
            request_id="e-2",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user", "assistant", "tool"],
            tool_name="HANDLE_RESPONSE",
            schema_sha256=LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256,
            tool_choice="required",
            call_names=["HANDLE_RESPONSE"],
        ),
    ]
    result = evaluate_lifecycle_gateway_execution(
        harness="eliza",
        records=records,
        runtime_turn_manifest=[
            _lifecycle_turn(
                ordinal=0,
                task_turn_index=0,
                model_calls=3,
                tool_calls=["TASKS"],
                model_types={"ACTION_PLANNER": 1, "RESPONSE_HANDLER": 2},
            )
        ],
        content_contract=contract,
        expected_reasoning_effort="medium",
    )

    assert result["validation_status"] == "succeeded"
    assert result["tasks_parallel_tool_calls"] is True


def test_lifecycle_eliza_gate_preserves_no_action_clarification() -> None:
    public_turn = "Help with an unspecified task."
    contract = _lifecycle_contract(public_turn)
    record = _lifecycle_gateway_record(
        harness="eliza",
        request_id="e-clarify",
        contract=contract,
        public_turn=public_turn,
        roles=["system", "user"],
        tool_name="HANDLE_RESPONSE",
        schema_sha256=LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256,
        tool_choice="required",
        call_names=["HANDLE_RESPONSE"],
    )
    result = evaluate_lifecycle_gateway_execution(
        harness="eliza",
        records=[record],
        runtime_turn_manifest=[
            _lifecycle_turn(
                ordinal=0,
                task_turn_index=0,
                model_calls=1,
                tool_calls=[],
                model_types={"RESPONSE_HANDLER": 1},
            )
        ],
        content_contract=contract,
        expected_reasoning_effort="medium",
    )

    assert result["validation_status"] == "succeeded"
    assert result["tasks_parallel_tool_calls"] is None


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        ("effort", "subscription_lifecycle_reasoning_effort_mismatch"),
        ("schema", "subscription_lifecycle_tool_contract_mismatch"),
        ("early_stop", "subscription_lifecycle_external_early_stop"),
        (
            "instruction_leak",
            "subscription_lifecycle_user_role_binding_mismatch",
        ),
        (
            "workspace_user_leak",
            "subscription_lifecycle_workspace_path_user_leak",
        ),
    ],
)
def test_lifecycle_external_gate_rejects_stage_and_role_drift(
    mutation: str,
    reason: str,
) -> None:
    public_turn = "Delegate the reviewed task."
    contract = _lifecycle_contract(public_turn)
    records = [
        _lifecycle_gateway_record(
            harness="openclaw",
            request_id="o-0",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="auto",
            call_names=["TASKS"],
        ),
        _lifecycle_gateway_record(
            harness="openclaw",
            request_id="o-1",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user", "assistant", "tool"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="auto",
            call_names=[],
        ),
    ]
    if mutation == "effort":
        records[0]["reasoning_effort"] = "high"
    elif mutation == "schema":
        records[0]["tool_schema_sha256"] = "f" * 64
        records[0]["tool_schema_sha256_by_name"] = {"TASKS": "f" * 64}
    elif mutation == "early_stop":
        records[0]["tool_call_names"] = []
        records[0]["finish_reason"] = "stop"
    elif mutation == "instruction_leak":
        records[0]["content_attestation"]["public_user_instruction_matches"] = {
            hashlib.sha256(public_turn.encode()).hexdigest(): 1
        }
    else:
        attestation = records[0]["content_attestation"]
        attestation["observed_user_match_counts"] = {"workspace_paths": 1}
        attestation["observed_ingress_match_counts"] = {"workspace_paths": 2}

    result = evaluate_lifecycle_gateway_execution(
        harness="openclaw",
        records=records,
        runtime_turn_manifest=[
            _lifecycle_turn(
                ordinal=0,
                task_turn_index=0,
                model_calls=2,
                tool_calls=["TASKS"],
            )
        ],
        content_contract=contract,
        expected_reasoning_effort="medium",
    )

    assert result["validation_status"] == "failed"
    assert result["rejection_reason"] == reason


def test_lifecycle_gate_rejects_parallel_setting_drift_within_lane() -> None:
    public_turn = "Delegate the reviewed task."
    contract = _lifecycle_contract(public_turn)
    records = [
        _lifecycle_gateway_record(
            harness="openclaw",
            request_id="o-parallel-0",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="auto",
            call_names=["TASKS"],
            parallel_tool_calls=True,
        ),
        _lifecycle_gateway_record(
            harness="openclaw",
            request_id="o-parallel-1",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user", "assistant", "tool"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="auto",
            call_names=[],
            parallel_tool_calls=False,
        ),
    ]
    result = evaluate_lifecycle_gateway_execution(
        harness="openclaw",
        records=records,
        runtime_turn_manifest=[
            _lifecycle_turn(
                ordinal=0,
                task_turn_index=0,
                model_calls=2,
                tool_calls=["TASKS"],
            )
        ],
        content_contract=contract,
        expected_reasoning_effort="medium",
    )

    assert result["rejection_reason"] == (
        "subscription_lifecycle_parallel_tool_calls_lane_mismatch"
    )


def test_gateway_summary_is_lane_scoped_and_separates_queue_wait(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [
            _record("eliza", request_id="e1", queue_wait_ms=0),
            _record(
                "hermes",
                request_id="h1",
                queue_wait_ms=40,
                response_mode="sse",
            ),
            _record(
                "hermes",
                request_id="h2",
                queue_wait_ms=60,
                response_mode="sse",
            ),
        ],
    )

    summary = summarize_subscription_gateway_audit(audit, harness="hermes")

    assert summary["audit_records"] == 2
    assert summary["harnesses"] == ["hermes"]
    assert summary["response_modes"] == ["sse"]
    assert summary["reasoning_effort_records"] == 2
    assert summary["reasoning_efforts"] == ["medium"]
    assert summary["reasoning_effort_unset_records"] == 0
    assert summary["cohort_reasoning_effort_parity"] is True
    assert summary["cohort_reasoning_effort"] == "medium"
    assert summary["cohort_reasoning_efforts_by_harness"] == {
        "eliza": ["medium"],
        "hermes": ["medium"],
        "openclaw": ["medium"],
    }
    assert summary["queue_wait_ms"] == {
        "count": 2,
        "total": 100.0,
        "mean": 50.0,
        "p95": 60.0,
        "max": 60.0,
    }
    assert summary["service_ms"]["mean"] == 250.0
    assert summary["wall_clock_latency_comparable"] is False
    assert (
        subscription_gateway_quarantine_reason(
            agent="hermes",
            provider="claude-subscription",
            model="anthropic/claude-opus-4-6",
            provenance=summary,
            minimum_request_count=2,
        )
        is None
    )
    assert validate_subscription_gateway_audit_artifact(summary) is None


def test_durable_gateway_summary_counts_only_logical_completions(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "durable-audit.jsonl"
    records = _durable_records(
        [
            _record("hermes", request_id="ignored-0", queue_wait_ms=10),
            {
                **_record("hermes", request_id="ignored-replay", queue_wait_ms=20),
                "audit_event": "replay_delivery",
                "logical_ordinal": 0,
            },
            {
                **_record("hermes", request_id="ignored-pause", queue_wait_ms=30),
                "audit_event": "pause_control",
            },
            {
                **_record("hermes", request_id="ignored-1", queue_wait_ms=40),
                "execution_origin": "replay",
            },
        ]
    )
    _write_audit(audit, records, complete_cohort=False)

    summary = summarize_subscription_gateway_audit(
        audit,
        harness="hermes",
        benchmark_id="orchestrator_lifecycle",
    )

    assert summary["audit_chain_mode"] == "sha256-chain-v2"
    assert summary["invalid_chain_records"] == 0
    assert summary["audit_delivery_records"] == 4
    assert summary["audit_records"] == 2
    assert summary["valid_records"] == 2
    assert summary["succeeded_records"] == 2
    assert summary["replay_delivery_records"] == 1
    assert summary["paused_records"] == 1
    assert summary["recovered_completion_records"] == 1
    assert summary["gateway_request_manifest_retained"] is True
    assert summary["gateway_request_manifest_count"] == 2
    assert len(summary["gateway_request_manifest"]) == 2
    assert summary["credential_epoch_hmac_records"] == 2
    assert summary["credential_tier_hmac_records"] == 2
    assert summary["credential_capability_hmac_records"] == 2
    assert summary["queue_wait_ms"]["total"] == 50.0
    assert summary["delivery_queue_wait_ms"]["total"] == 100.0

    visited: list[str] = []
    diagnostics = scan_subscription_gateway_audit(
        audit,
        lambda record: visited.append(str(record["audit_event"])),
    )
    assert visited == [
        "logical_completion",
        "replay_delivery",
        "pause_control",
        "logical_completion",
    ]
    assert diagnostics["invalid_contract_records"] == 0
    assert diagnostics["invalid_chain_records"] == 0


def test_durable_gateway_rejects_hash_identity_and_ordinal_drift(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "durable-invalid.jsonl"
    records = _durable_records(
        [_record("hermes", request_id="ignored", queue_wait_ms=0)]
    )
    records[0]["service_ms"] = 251.0
    _write_audit(audit, records, complete_cohort=False)
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["invalid_chain_records"] == 1

    records = _durable_records(
        [_record("hermes", request_id="ignored", queue_wait_ms=0)]
    )
    records[0]["request_id"] = "logical_wrong"
    _reseal_durable_records(records)
    _write_audit(audit, records, complete_cohort=False)
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["invalid_chain_records"] == 1

    records = _durable_records(
        [
            {
                **_record("hermes", request_id="ignored", queue_wait_ms=0),
                "logical_ordinal": 1,
            }
        ]
    )
    _write_audit(audit, records, complete_cohort=False)
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["invalid_chain_records"] == 0
    assert summary["invalid_logical_records"] == 1
    assert summary["audit_records"] == 0


def test_durable_gateway_accepts_resultless_pause_and_failure_events(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "durable-control-events.jsonl"
    records = _durable_records(
        [
            _record("hermes", request_id="ignored-0", queue_wait_ms=0),
            {
                **_record("hermes", request_id="ignored-rate", queue_wait_ms=0),
                "audit_event": "pause_control",
                "pause_reason": "rate_limit",
                "retry_at": "2026-07-22T00:00:00Z",
            },
            {
                **_record("hermes", request_id="ignored-storage", queue_wait_ms=0),
                "audit_event": "pause_control",
                "pause_reason": "storage_reserve",
                "retry_at": None,
            },
            {
                **_record("hermes", request_id="ignored-failure", queue_wait_ms=0),
                "audit_event": "failure",
            },
        ]
    )
    _write_audit(audit, records, complete_cohort=False)

    visited: list[str] = []
    diagnostics = scan_subscription_gateway_audit(
        audit,
        lambda record: visited.append(str(record["audit_event"])),
    )
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")

    assert diagnostics["invalid_contract_records"] == 0
    assert diagnostics["invalid_chain_records"] == 0
    assert visited == [
        "logical_completion",
        "pause_control",
        "pause_control",
        "failure",
    ]
    assert summary["audit_records"] == 1
    assert summary["paused_records"] == 2
    assert summary["failed_records"] == 1
    assert summary["credential_capability_hmac_records"] == 1


def test_pause_reader_uses_validated_chain_and_success_resolves_logical_key(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "pause-state.jsonl"
    pause = {
        **_record("hermes", request_id="ignored-pause", queue_wait_ms=0),
        "audit_event": "pause_control",
        "logical_ordinal": 0,
        "pause_reason": "rate_limit",
        "retry_at": "2026-07-22T04:00:00Z",
        "error_code": "subscription_rate_limited",
    }
    _write_audit(
        audit,
        _durable_records([pause]),
        complete_cohort=False,
    )
    audit.chmod(0o600)

    state = read_gateway_pause_state(audit)

    assert state is not None
    assert state.status == GatewayPauseStatus.PAUSED
    assert state.retry_at == "2026-07-22T04:00:00+00:00"
    assert state.pause_reason == "rate_limit"
    assert state.affected_harnesses == ("hermes",)
    assert state.active_records == 1

    replay = {
        **_record("hermes", request_id="ignored-replay", queue_wait_ms=0),
        "audit_event": "replay_delivery",
        "logical_ordinal": 0,
    }
    _write_audit(
        audit,
        _durable_records([pause, replay]),
        complete_cohort=False,
    )
    audit.chmod(0o600)

    assert read_gateway_pause_state(audit) is None


def test_pause_reader_rejects_torn_tail_and_unbounded_harness_state(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "invalid-pause-state.jsonl"
    first = {
        **_record("hermes", request_id="ignored-first", queue_wait_ms=0),
        "audit_event": "pause_control",
        "logical_ordinal": 0,
        "pause_reason": "rate_limit_unknown",
        "retry_at": None,
        "error_code": "subscription_rate_limited",
    }
    second = {
        **_record("hermes", request_id="ignored-second", queue_wait_ms=0),
        "audit_event": "pause_control",
        "logical_ordinal": 1,
        "pause_reason": "rate_limit_unknown",
        "retry_at": None,
        "error_code": "subscription_rate_limited",
    }
    _write_audit(
        audit,
        _durable_records([first, second]),
        complete_cohort=False,
    )
    audit.chmod(0o600)

    with pytest.raises(GatewayLifecycleError) as duplicate_pause:
        read_gateway_pause_state(audit)
    assert duplicate_pause.value.code == "gateway_audit_invalid"

    _write_audit(
        audit,
        _durable_records([first]),
        complete_cohort=False,
    )
    with audit.open("ab") as handle:
        handle.write(b'{"torn":')
    audit.chmod(0o600)

    with pytest.raises(GatewayLifecycleError) as torn_tail:
        read_gateway_pause_state(audit)
    assert torn_tail.value.code == "gateway_audit_invalid"


def test_gateway_scanner_rejects_committed_corruption_but_ignores_torn_tail(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "torn-audit.jsonl"
    records = _durable_records(
        [
            _record("hermes", request_id="ignored-0", queue_wait_ms=0),
            _record("hermes", request_id="ignored-1", queue_wait_ms=0),
            _record("hermes", request_id="ignored-2", queue_wait_ms=0),
        ]
    )
    complete_prefix = b"".join(
        json.dumps(record, sort_keys=True).encode("utf-8") + b"\n"
        for record in records[:2]
    )
    torn_record = json.dumps(records[2], sort_keys=True).encode("utf-8")
    audit.write_bytes(complete_prefix + torn_record)

    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["audit_records"] == 2
    assert summary["invalid_json_lines"] == 0
    assert summary["invalid_chain_records"] == 0
    assert summary["audit_ignored_torn_tail_bytes"] == len(torn_record)

    audit.write_bytes(complete_prefix + b'{"broken":}\n')
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["audit_records"] == 2
    assert summary["invalid_json_lines"] == 1
    assert summary["audit_ignored_torn_tail_bytes"] == 0


def test_gateway_scanner_fails_closed_on_schema_and_untrusted_type_drift(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "schema-drift.jsonl"
    schema_two_without_chain = _record(
        "hermes", request_id="legacy-shaped", queue_wait_ms=0
    )
    schema_two_without_chain["schema_version"] = 2
    _write_audit(audit, [schema_two_without_chain], complete_cohort=False)
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["audit_records"] == 0
    assert summary["invalid_chain_records"] == 1

    records = _durable_records(
        [_record("hermes", request_id="ignored", queue_wait_ms=0)]
    )
    records[0]["audit_event"] = {"not": "hashable"}
    _reseal_durable_records(records)
    _write_audit(audit, records, complete_cohort=False)
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["invalid_chain_records"] == 1

    audit.write_bytes((b"[" * 2_000) + (b"]" * 2_000) + b"\n")
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["invalid_json_lines"] == 1


def test_large_gateway_summary_is_one_pass_and_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    total_records = 100_001
    virtual_path = tmp_path / "virtual-large-audit.jsonl"
    compact_record = _record(
        "hermes", request_id="same-legacy-record", queue_wait_ms=1
    )
    compact_record.pop("tool_schema_sha256_by_name")
    line = json.dumps(compact_record, sort_keys=True).encode("utf-8") + b"\n"
    open_calls = 0
    read_calls = 0

    class RepeatedAuditStream:
        def __init__(self) -> None:
            self.remaining = total_records

        def __enter__(self) -> "RepeatedAuditStream":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self, size: int) -> bytes:
            nonlocal read_calls
            read_calls += 1
            if not self.remaining:
                return b""
            records_in_chunk = min(self.remaining, max(1, size // len(line)))
            self.remaining -= records_in_chunk
            return line * records_in_chunk

    real_open = Path.open

    def open_virtual(path: Path, mode: str = "r", *args: object, **kwargs: object):
        nonlocal open_calls
        if path == virtual_path:
            assert mode == "rb"
            open_calls += 1
            return RepeatedAuditStream()
        return real_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", open_virtual)
    tracemalloc.start()
    try:
        summaries = summarize_subscription_gateway_audits(
            virtual_path,
            harnesses=("hermes",),
        )
        _, peak_bytes = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    summary = summaries["hermes"]
    assert open_calls == 1
    assert read_calls > 1
    assert summary["audit_records"] == total_records
    assert summary["gateway_request_manifest_count"] == total_records
    assert summary["gateway_request_manifest_retained"] is False
    assert "gateway_request_manifest" not in summary
    assert peak_bytes < 16 * 1024 * 1024


def test_gateway_summary_rejects_per_tool_hash_map_drift(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    record = _record("hermes", request_id="h1", queue_wait_ms=0)
    record["tool_schema_sha256_by_name"] = {"different-tool": HASH}
    _write_audit(audit, [record])

    summary = summarize_subscription_gateway_audit(audit, harness="hermes")

    assert summary["audit_records"] == 1
    assert summary["valid_records"] == 0
    assert summary["invalid_contract_records"] == 1


def test_per_lane_gate_keeps_single_harness_subscription_runs_publishable(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "single-lane-audit.jsonl"
    _write_audit(
        audit,
        [_record("hermes", request_id="h1", queue_wait_ms=0)],
        complete_cohort=False,
    )

    summary = summarize_subscription_gateway_audit(audit, harness="hermes")

    assert summary["cohort_reasoning_effort_parity"] is False
    assert summary["reasoning_efforts"] == ["medium"]
    assert (
        subscription_gateway_quarantine_reason(
            agent="hermes",
            provider="claude-subscription",
            model="claude-opus-4-6",
            provenance=summary,
            minimum_request_count=1,
        )
        is None
    )


def test_gateway_gate_reads_but_does_not_publish_legacy_audit(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "legacy-audit.jsonl"
    _write_audit(
        audit,
        [_record("hermes", request_id="legacy", queue_wait_ms=0)],
        complete_cohort=False,
        durable=False,
    )

    summary = summarize_subscription_gateway_audit(audit, harness="hermes")

    assert summary["audit_chain_mode"] == "legacy-v1"
    assert summary["audit_records"] == 1
    assert (
        subscription_gateway_quarantine_reason(
            agent="hermes",
            provider="claude-subscription",
            model="claude-opus-4-6",
            provenance=summary,
            minimum_request_count=1,
        )
        == "subscription_gateway_durable_audit_required"
    )


@pytest.mark.parametrize("reasoning_effort", ["missing", "ultra"])
def test_gateway_summary_rejects_missing_or_invalid_reasoning_effort(
    tmp_path: Path,
    reasoning_effort: str,
) -> None:
    audit = tmp_path / "audit.jsonl"
    record = _record("hermes", request_id="h1", queue_wait_ms=0)
    if reasoning_effort == "missing":
        record.pop("reasoning_effort")
    else:
        record["reasoning_effort"] = reasoning_effort
    _write_audit(audit, [record])

    summary = summarize_subscription_gateway_audit(audit, harness="hermes")

    assert summary["audit_records"] == 1
    assert summary["valid_records"] == 0
    assert summary["invalid_contract_records"] == 1


def test_gateway_gate_requires_at_least_every_agent_turn(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [_record("openclaw", request_id="o1", queue_wait_ms=0)],
    )
    summary = summarize_subscription_gateway_audit(audit, harness="openclaw")

    assert (
        subscription_gateway_quarantine_reason(
            agent="openclaw",
            provider="claude-subscription",
            model="claude-opus-4-6",
            provenance=summary,
            minimum_request_count=2,
        )
        == "subscription_incomplete_gateway_audit"
    )


def test_gateway_gate_requires_one_applied_reasoning_effort(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [
            _record(
                "hermes",
                request_id="h1",
                queue_wait_ms=0,
                reasoning_effort=None,
            )
        ],
    )
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["valid_records"] == 1
    assert (
        subscription_gateway_quarantine_reason(
            agent="hermes",
            provider="claude-subscription",
            model="claude-opus-4-6",
            provenance=summary,
            minimum_request_count=1,
        )
        == "subscription_gateway_reasoning_effort_unset"
    )

    _write_audit(
        audit,
        [
            _record(
                "hermes",
                request_id="h1",
                queue_wait_ms=0,
                reasoning_effort="low",
            ),
            _record(
                "hermes",
                request_id="h2",
                queue_wait_ms=0,
                reasoning_effort="medium",
            ),
        ],
    )
    summary = summarize_subscription_gateway_audit(audit, harness="hermes")
    assert summary["reasoning_efforts"] == ["low", "medium"]
    assert (
        subscription_gateway_quarantine_reason(
            agent="hermes",
            provider="claude-subscription",
            model="claude-opus-4-6",
            provenance=summary,
            minimum_request_count=2,
        )
        == "subscription_gateway_reasoning_effort_mismatch"
    )


def test_runner_publication_gate_uses_runtime_turn_count_for_gateway_audit(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [_record("openclaw", request_id="o1", queue_wait_ms=0)],
    )
    runtime = _runtime_summary("openclaw", telemetry_records=2)
    gateway = summarize_subscription_gateway_audit(audit, harness="openclaw")

    assert (
        _publication_quarantine_reason(
            status="succeeded",
            agent="openclaw",
            score=0.8,
            token_metrics=None,
            metrics={
                "runtime_provenance": runtime,
                "subscription_gateway_provenance": gateway,
            },
            provider="claude-subscription",
            model="anthropic/claude-opus-4-6",
        )
        == "subscription_incomplete_gateway_audit"
    )

    _write_audit(
        audit,
        [
            _record("openclaw", request_id="o1", queue_wait_ms=0),
            _record("openclaw", request_id="o2", queue_wait_ms=0),
        ],
    )
    gateway = summarize_subscription_gateway_audit(audit, harness="openclaw")

    assert (
        _publication_quarantine_reason(
            status="succeeded",
            agent="openclaw",
            score=0.8,
            token_metrics=None,
            metrics={
                "runtime_provenance": runtime,
                "subscription_gateway_provenance": gateway,
            },
            provider="claude-subscription",
            model="anthropic/claude-opus-4-6",
        )
        is None
    )


def test_runner_publication_gate_requires_gateway_provenance() -> None:
    assert (
        _publication_quarantine_reason(
            status="succeeded",
            agent="hermes",
            score=0.8,
            token_metrics=None,
            metrics={
                "runtime_provenance": _runtime_summary(
                    "hermes",
                    telemetry_records=1,
                )
            },
            provider="claude-subscription",
            model="claude-opus-4-6",
        )
        == "subscription_missing_gateway_provenance"
    )


def test_gateway_gate_rejects_api_billing_source(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [
            _record(
                "eliza",
                request_id="e1",
                queue_wait_ms=0,
                api_key_source="ANTHROPIC_API_KEY",
            )
        ],
    )
    summary = summarize_subscription_gateway_audit(audit, harness="eliza")

    assert (
        subscription_gateway_quarantine_reason(
            agent="eliza",
            provider="claude-subscription",
            model="claude-opus-4-6",
            provenance=summary,
            minimum_request_count=1,
        )
        == "subscription_gateway_api_billing_detected"
    )


def test_gateway_gate_rejects_missing_or_mutated_audit(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [_record("eliza", request_id="e1", queue_wait_ms=0)],
    )
    summary = summarize_subscription_gateway_audit(audit, harness="eliza")
    audit.write_text("mutated\n", encoding="utf-8")

    assert (
        validate_subscription_gateway_audit_artifact(summary)
        == "subscription_gateway_audit_hash_mismatch"
    )
    audit.unlink()
    assert (
        validate_subscription_gateway_audit_artifact(summary)
        == "subscription_gateway_audit_artifact_missing"
    )


def test_coordinator_attaches_lane_summary_before_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [
            _record("hermes", request_id="h1", queue_wait_ms=10),
            _record("hermes", request_id="h2", queue_wait_ms=20),
        ],
    )
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE benchmark_runs (
            run_id TEXT PRIMARY KEY,
            run_group_id TEXT NOT NULL,
            benchmark_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            extra_config_json TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            artifacts_json TEXT NOT NULL,
            error TEXT
        )
        """
    )
    connection.executemany(
        "INSERT INTO benchmark_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                f"run_{harness}",
                "rg_one",
                "webshop",
                harness,
                "claude-subscription",
                "claude-opus-4-6",
                "succeeded",
                "{}",
                json.dumps(
                    {
                        "runtime_provenance": {
                            "telemetry_records": 2 if harness == "hermes" else 1
                        }
                    }
                ),
                "[]",
                None,
            )
            for harness in ("eliza", "hermes", "openclaw")
        ],
    )

    real_open = Path.open
    audit_open_calls = 0

    def count_audit_open(
        path: Path, mode: str = "r", *args: object, **kwargs: object
    ):
        nonlocal audit_open_calls
        if path == audit and mode == "rb":
            audit_open_calls += 1
        return real_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", count_audit_open)
    reasons = attach_subscription_gateway_provenance(
        connection,
        run_group_id="rg_one",
        audit_path=audit,
    )

    assert reasons == {}
    assert audit_open_calls == 1
    row = connection.execute(
        "SELECT metrics_json, artifacts_json FROM benchmark_runs "
        "WHERE run_id = 'run_hermes'"
    ).fetchone()
    metrics = json.loads(row["metrics_json"])
    assert metrics["subscription_gateway_provenance"]["audit_records"] == 2
    assert (
        metrics["subscription_gateway_provenance"]["cohort_reasoning_effort_parity"]
        is True
    )
    assert (
        metrics["subscription_gateway_provenance"]["cohort_run_group_complete"] is True
    )
    assert (
        metrics["subscription_gateway_provenance"][
            "gateway_request_manifest_retained"
        ]
        is False
    )
    assert "gateway_request_manifest" not in metrics["subscription_gateway_provenance"]
    assert json.loads(row["artifacts_json"]) == [str(audit)]


def test_coordinator_publishes_latest_success_and_preserves_pause_history(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "resumed-audit.jsonl"
    _write_audit(
        audit,
        [
            _record(harness, request_id=f"{harness}-completion", queue_wait_ms=0)
            for harness in ("eliza", "hermes", "openclaw")
        ],
        complete_cohort=False,
    )
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE benchmark_runs (
            run_id TEXT PRIMARY KEY,
            run_group_id TEXT NOT NULL,
            benchmark_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            extra_config_json TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            artifacts_json TEXT NOT NULL,
            error TEXT,
            attempt INTEGER NOT NULL,
            started_at TEXT NOT NULL
        )
        """
    )
    rows: list[tuple[object, ...]] = []
    for harness in ("eliza", "hermes", "openclaw"):
        rows.extend(
            [
                (
                    f"old_{harness}",
                    "rg_resumed",
                    "webshop",
                    harness,
                    "claude-subscription",
                    "claude-opus-4-6",
                    "paused_unknown" if harness == "hermes" else "paused",
                    "{}",
                    json.dumps({"historical_pause": True}),
                    json.dumps(["paused-evidence"]),
                    "paused for retry",
                    1,
                    "2026-07-21T00:00:00Z",
                ),
                (
                    f"new_{harness}",
                    "rg_resumed",
                    "webshop",
                    harness,
                    "claude-subscription",
                    "claude-opus-4-6",
                    "succeeded",
                    "{}",
                    json.dumps(
                        {"runtime_provenance": {"telemetry_records": 1}}
                    ),
                    "[]",
                    None,
                    2,
                    "2026-07-21T01:00:00Z",
                ),
            ]
        )
    connection.executemany(
        "INSERT INTO benchmark_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )

    assert attach_subscription_gateway_provenance(
        connection,
        run_group_id="rg_resumed",
        audit_path=audit,
    ) == {}

    historical = connection.execute(
        "SELECT status, metrics_json, artifacts_json, error "
        "FROM benchmark_runs WHERE run_id LIKE 'old_%' ORDER BY run_id"
    ).fetchall()
    assert all(row["status"] in {"paused", "paused_unknown"} for row in historical)
    assert all(
        json.loads(row["metrics_json"]) == {"historical_pause": True}
        for row in historical
    )
    assert all(
        json.loads(row["artifacts_json"]) == ["paused-evidence"]
        for row in historical
    )
    latest = connection.execute(
        "SELECT metrics_json FROM benchmark_runs "
        "WHERE run_id LIKE 'new_%' ORDER BY run_id"
    ).fetchall()
    for row in latest:
        provenance = json.loads(row["metrics_json"])[
            "subscription_gateway_provenance"
        ]
        assert provenance["cohort_run_group_complete"] is True
        assert provenance["cohort_pause_history_count"] == 3
        assert provenance["lane_pause_history_count"] == 1


def test_coordinator_attaches_and_enforces_lifecycle_execution_contract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    public_turn = "Delegate this concrete task now."
    contract = _lifecycle_contract(public_turn)
    records = [
        _lifecycle_gateway_record(
            harness="eliza",
            request_id="e-stage-1",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user"],
            tool_name="HANDLE_RESPONSE",
            schema_sha256=LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256,
            tool_choice="required",
            call_names=["HANDLE_RESPONSE"],
        ),
        _lifecycle_gateway_record(
            harness="eliza",
            request_id="e-stage-2",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user"],
            tool_name="TASKS",
            schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
            tool_choice="required",
            call_names=["TASKS"],
        ),
        _lifecycle_gateway_record(
            harness="eliza",
            request_id="e-stage-3",
            contract=contract,
            public_turn=public_turn,
            roles=["system", "user", "assistant", "tool"],
            tool_name="HANDLE_RESPONSE",
            schema_sha256=LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256,
            tool_choice="required",
            call_names=["HANDLE_RESPONSE"],
        ),
    ]
    for harness in ("hermes", "openclaw"):
        records.extend(
            (
                _lifecycle_gateway_record(
                    harness=harness,
                    request_id=f"{harness}-stage-1",
                    contract=contract,
                    public_turn=public_turn,
                    roles=["system", "user"],
                    tool_name="TASKS",
                    schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
                    tool_choice="auto",
                    call_names=["TASKS"],
                ),
                _lifecycle_gateway_record(
                    harness=harness,
                    request_id=f"{harness}-stage-2",
                    contract=contract,
                    public_turn=public_turn,
                    roles=["system", "user", "assistant", "tool"],
                    tool_name="TASKS",
                    schema_sha256=LIFECYCLE_TASKS_GATEWAY_SCHEMA_SHA256,
                    tool_choice="auto",
                    call_names=[],
                ),
            )
        )
    audit = tmp_path / "lifecycle-audit.jsonl"
    _write_audit(audit, records, complete_cohort=False)
    monkeypatch.setattr(
        "benchmarks.orchestrator.subscription_provenance."
        "build_lifecycle_gateway_content_contract",
        lambda *_args, **_kwargs: contract,
    )

    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE benchmark_runs (
            run_id TEXT PRIMARY KEY,
            run_group_id TEXT NOT NULL,
            benchmark_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            extra_config_json TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            artifacts_json TEXT NOT NULL,
            error TEXT
        )
        """
    )
    connection.executemany(
        "INSERT INTO benchmark_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                f"run_{harness}",
                "rg_lifecycle",
                "orchestrator_lifecycle",
                harness,
                "claude-subscription",
                "claude-opus-4-6",
                "succeeded",
                json.dumps({"reasoning_effort": "medium"}),
                json.dumps(
                    {
                        "runtime_provenance": {
                            "telemetry_records": 1,
                            "lifecycle_gateway_turn_manifest": [
                                _lifecycle_turn(
                                    ordinal=0,
                                    task_turn_index=0,
                                    model_calls=3 if harness == "eliza" else 2,
                                    tool_calls=["TASKS"],
                                    model_types=(
                                        {
                                            "RESPONSE_HANDLER": 2,
                                            "ACTION_PLANNER": 1,
                                        }
                                        if harness == "eliza"
                                        else {}
                                    ),
                                )
                            ],
                        }
                    }
                ),
                "[]",
                None,
            )
            for harness in ("eliza", "hermes", "openclaw")
        ],
    )

    assert attach_subscription_gateway_provenance(
        connection,
        run_group_id="rg_lifecycle",
        audit_path=audit,
    ) == {}
    rows = connection.execute(
        "SELECT metrics_json FROM benchmark_runs ORDER BY agent"
    ).fetchall()
    for row in rows:
        gateway = json.loads(row["metrics_json"])[
            "subscription_gateway_provenance"
        ]
        assert gateway["lifecycle_execution_contract"]["validation_status"] == (
            "succeeded"
        )
        assert gateway["cohort_lifecycle_parallel_tool_calls_parity"] is True
        assert gateway["gateway_request_manifest_count"] in {2, 3}


def test_coordinator_reports_incomplete_lane_audit(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [_record("eliza", request_id="e1", queue_wait_ms=0)],
    )
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE benchmark_runs (
            run_id TEXT PRIMARY KEY,
            run_group_id TEXT NOT NULL,
            benchmark_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            extra_config_json TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            artifacts_json TEXT NOT NULL,
            error TEXT
        )
        """
    )
    connection.executemany(
        "INSERT INTO benchmark_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                f"run_{harness}",
                "rg_two",
                "webshop",
                harness,
                "claude-subscription",
                "claude-opus-4-6",
                "succeeded",
                "{}",
                json.dumps(
                    {
                        "runtime_provenance": {
                            "telemetry_records": 2 if harness == "eliza" else 1
                        }
                    }
                ),
                "[]",
                None,
            )
            for harness in ("eliza", "hermes", "openclaw")
        ],
    )

    assert attach_subscription_gateway_provenance(
        connection,
        run_group_id="rg_two",
        audit_path=audit,
    ) == {"run_eliza": "subscription_incomplete_gateway_audit"}
    row = connection.execute(
        "SELECT status, error FROM benchmark_runs WHERE run_id = 'run_eliza'"
    ).fetchone()
    assert row["status"] == "failed"
    assert "subscription_incomplete_gateway_audit" in row["error"]


def test_coordinator_fails_every_lane_on_reasoning_effort_cohort_mismatch(
    tmp_path: Path,
) -> None:
    audit = tmp_path / "audit.jsonl"
    _write_audit(
        audit,
        [
            _record("eliza", request_id="e1", queue_wait_ms=0),
            _record("hermes", request_id="h1", queue_wait_ms=0),
            _record(
                "openclaw",
                request_id="o1",
                queue_wait_ms=0,
                reasoning_effort="high",
            ),
        ],
    )
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE benchmark_runs (
            run_id TEXT PRIMARY KEY,
            run_group_id TEXT NOT NULL,
            benchmark_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            extra_config_json TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            artifacts_json TEXT NOT NULL,
            error TEXT
        )
        """
    )
    connection.executemany(
        "INSERT INTO benchmark_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                f"run_{harness}",
                "rg_mismatch",
                "webshop",
                harness,
                "claude-subscription",
                "claude-opus-4-6",
                "succeeded",
                "{}",
                json.dumps({"runtime_provenance": {"telemetry_records": 1}}),
                "[]",
                None,
            )
            for harness in ("eliza", "hermes", "openclaw")
        ],
    )

    reasons = attach_subscription_gateway_provenance(
        connection,
        run_group_id="rg_mismatch",
        audit_path=audit,
    )

    cohort_reason = "subscription_gateway_reasoning_effort_cohort_mismatch"
    assert reasons == {
        "run_eliza": cohort_reason,
        "run_hermes": cohort_reason,
        "run_openclaw": cohort_reason,
    }
    rows = connection.execute(
        "SELECT status, error, metrics_json FROM benchmark_runs ORDER BY run_id"
    ).fetchall()
    assert all(row["status"] == "failed" for row in rows)
    assert all(cohort_reason in row["error"] for row in rows)
    assert all(
        json.loads(row["metrics_json"])["subscription_gateway_provenance"][
            "cohort_reasoning_effort_parity"
        ]
        is False
        for row in rows
    )


def test_non_subscription_provider_does_not_require_gateway_proof() -> None:
    assert (
        subscription_gateway_quarantine_reason(
            agent="eliza",
            provider="cerebras",
            model="llama",
            provenance=None,
            minimum_request_count=None,
        )
        is None
    )


@pytest.mark.parametrize(
    ("telemetry_records", "expected_reason"),
    [
        (5_499, "webshop_incomplete_model_call_coverage"),
        (110_001, "webshop_model_call_count_exceeds_turn_budget"),
    ],
)
def test_full_webshop_requires_one_to_twenty_model_calls_per_scenario(
    telemetry_records: int,
    expected_reason: str,
) -> None:
    assert (
        _publication_quarantine_reason(
            benchmark_id="webshop",
            status="succeeded",
            agent="openclaw",
            score=0.5,
            token_metrics={},
            metrics={
                **WEBSHOP_FULL_REPORT_CONTRACT,
                "java_version": "openjdk version 21.0.8",
                "total_tasks": 5_500,
                "total_trials": 5_500,
                "runtime_provenance": _runtime_summary(
                    "openclaw", telemetry_records=telemetry_records
                ),
            },
            provider="claude-subscription",
            model="claude-opus-4-6",
        )
        == expected_reason
    )


def _complete_webshop_publication_metrics() -> dict:
    return {
        **WEBSHOP_FULL_REPORT_CONTRACT,
        "java_version": "openjdk version 21.0.8",
        "total_tasks": 5_500,
        "total_trials": 5_500,
        "runtime_provenance": _runtime_summary(
            "openclaw",
            telemetry_records=5_500,
        ),
    }


def test_full_webshop_accepts_exact_scenario_model_call_manifest() -> None:
    assert (
        _publication_quarantine_reason(
            benchmark_id="webshop",
            status="succeeded",
            agent="openclaw",
            score=0.5,
            token_metrics={},
            metrics=_complete_webshop_publication_metrics(),
            provider="cerebras",
            model="claude-opus-4-6",
        )
        is None
    )


@pytest.mark.parametrize(
    ("runtime_updates", "expected_reason"),
    [
        (
            {"task_id_manifest_count": 5_499},
            "webshop_incomplete_scenario_model_call_coverage",
        ),
        (
            {"task_id_manifest_sha256": "0" * 64},
            "webshop_scenario_model_call_manifest_mismatch",
        ),
        (
            {"task_id_records": 5_499, "missing_task_id_records": 1},
            "webshop_untagged_model_calls",
        ),
    ],
)
def test_full_webshop_rejects_inexact_scenario_model_call_provenance(
    runtime_updates: dict,
    expected_reason: str,
) -> None:
    metrics = _complete_webshop_publication_metrics()
    metrics["runtime_provenance"].update(runtime_updates)

    assert (
        _publication_quarantine_reason(
            benchmark_id="webshop",
            status="succeeded",
            agent="openclaw",
            score=0.5,
            token_metrics={},
            metrics=metrics,
            provider="cerebras",
            model="claude-opus-4-6",
        )
        == expected_reason
    )
