"""Exercises the tri-harness canary coordinator entirely offline.

Fake processes and audit records prove synchronization and fail-closed evidence
contracts without starting a gateway, native runtime, or model request.
"""

from __future__ import annotations

import ast
import hashlib
import json
import multiprocessing
from pathlib import Path
import queue
import subprocess
import sys
import threading
from types import SimpleNamespace
from typing import Callable

import pytest

from benchmarks.orchestrator_lifecycle import canary


def _write_plan_inputs(
    workspace: Path, prompt: str = "Start delegated work now."
) -> None:
    request_path = (
        workspace / "benchmarks" / "orchestrator_lifecycle" / canary.CANARY_REQUEST
    )
    request_path.parent.mkdir(parents=True)
    request_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "kind": "orchestrator_lifecycle_transport_canary",
                "prompt": prompt,
            }
        ),
        encoding="utf-8",
    )
    canonical_contract = Path(canary.__file__).with_name("tasks-tool.json")
    (request_path.parent.parent / "tasks-tool.json").write_text(
        canonical_contract.read_text(encoding="utf-8"), encoding="utf-8"
    )


def _valid_response() -> dict[str, object]:
    arguments = {
        "action": "spawn_agent",
        "task": "Implement the login timeout fix.",
    }
    return {
        "text": "I delegated the fix and will report back.",
        "thought": None,
        "actions": ["TASKS"],
        "params": {
            "tool_calls": [
                {
                    "id": "call-native-1",
                    "name": "TASKS",
                    "arguments": arguments,
                }
            ],
            "lifecycle_results": [
                {
                    "name": "TASKS",
                    "arguments": arguments,
                    "result": dict(canary.EXPECTED_CAPTURE_RESULT),
                }
            ],
        },
    }


def _valid_eliza_health() -> dict[str, object]:
    return {
        "status": "ready",
        "lifecycle_profile_active": True,
        "lifecycle_task_action_registered": True,
        "lifecycle_action_catalog": ["TASKS"],
        "lifecycle_action_count": 1,
        "lifecycle_task_contexts": [
            "general",
            "code",
            "automation",
            "agent_internal",
            "connectors",
        ],
        "lifecycle_tool_bridge": "lifecycle_capture_only",
        "lifecycle_task_unconditionally_planner_available": True,
        "subscription_chat_only": True,
        "embeddingMode": "disabled-text-only",
        "semanticMemoryEnabled": False,
        "standIn": False,
        "releaseEvidence": True,
        "lifecycle_force_tool_call_disabled": True,
        "lifecycle_benchmark_provider_mode": "shared_system_hint_only",
        "lifecycle_benchmark_provider_registered": True,
        "lifecycle_benchmark_provider_payload_neutral": True,
        "model_handlers": {
            model_type: [{"provider": "openai", "priority": 0}]
            for model_type in (
                "ACTION_PLANNER",
                "RESPONSE_HANDLER",
                "TEXT_LARGE",
                "TEXT_MEDIUM",
                "TEXT_MEGA",
                "TEXT_NANO",
                "TEXT_SMALL",
                "TEXT_TOKENIZER_DECODE",
                "TEXT_TOKENIZER_ENCODE",
            )
        },
    }


def _valid_eliza_hint_telemetry() -> dict[str, object]:
    return {
        "usage": {"callCount": 3},
        "runtime_provenance": {
            "lifecycle_system_hint_attestation": {
                "schema_version": 1,
                "system_hint_sha256": (
                    canary.ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256
                ),
                "model_boundary_call_count": 3,
                "model_boundary_attested_call_count": 3,
                "model_boundary_hint_occurrence_count": 3,
                "exact_once_per_model_call": True,
                "model_type_call_counts": {
                    "ACTION_PLANNER": 1,
                    "RESPONSE_HANDLER": 2,
                },
            }
        },
    }


def _gateway_record(
    *,
    harness: str,
    index: int,
    tool_names: tuple[str, ...],
    call_names: tuple[str, ...],
    tool_choice: str,
) -> dict[str, object]:
    package_root = Path(canary.__file__).resolve().parents[2]
    public_prompt = canary._load_canary_prompt(package_root)
    content_contract = canary.build_lifecycle_gateway_content_contract(
        package_root,
        public_user_turns=[public_prompt],
        contract_id=canary.CANARY_CONTENT_CONTRACT_ID,
    )
    contract_sha256 = hashlib.sha256(
        json.dumps(
            content_contract,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    forbidden = content_contract["forbidden_text_by_category"]
    observed = content_contract["observed_text_by_category"]
    assert isinstance(forbidden, dict)
    assert isinstance(observed, dict)

    external_first_stage = harness in {"hermes", "openclaw"} and index == 0
    roles = ["system", "user"]
    if (harness == "eliza" and index == 2) or (
        harness in {"hermes", "openclaw"} and index == 1
    ):
        roles.extend(("assistant", "tool"))
    schema_hashes = {
        name: (
            canary.EXPECTED_TASKS_GATEWAY_SCHEMA_SHA256
            if name == "TASKS"
            else (
                canary.LIFECYCLE_STAGE1_GATEWAY_SCHEMA_SHA256
                if index == 0
                else canary.LIFECYCLE_EVALUATOR_GATEWAY_SCHEMA_SHA256
            )
        )
        for name in tool_names
    }
    request_id = f"request-{harness}-{index}"
    public_prompt_sha256 = hashlib.sha256(public_prompt.encode("utf-8")).hexdigest()
    return {
        "schema_version": 1,
        "harness": harness,
        "request_id": request_id,
        "recorded_at": "2026-07-20T20:00:00Z",
        "transport": "claude-agent-sdk",
        "credential_source": "claude-code-managed",
        "sdk_version": "0.3.200",
        "sdk_api_key_source": "none",
        "claude_code_version": "2.1.214",
        "fresh_session": True,
        "tool_execution": "capture-only",
        "serializer": "openai-full-history-v1",
        "response_mode": "json",
        "model_requested": canary.DEFAULT_MODEL,
        "model_effective": canary.DEFAULT_MODEL,
        "request_sha256": (
            "e" * 64
            if external_first_stage
            else hashlib.sha256(f"request-{harness}-{index}".encode()).hexdigest()
        ),
        "status": "succeeded",
        "error_code": None,
        "reasoning_effort": canary.CANARY_REASONING_EFFORT,
        "message_count": len(roles),
        "tool_names": list(tool_names),
        "tool_call_names": list(call_names),
        "tool_choice": tool_choice,
        "parallel_tool_calls": True,
        "tool_schema_sha256": next(iter(schema_hashes.values())),
        "tool_schema_sha256_by_name": schema_hashes,
        "prompt_sha256": (
            "c" * 64
            if external_first_stage
            else hashlib.sha256(f"prompt-{harness}-{index}".encode()).hexdigest()
        ),
        "system_prompt_sha256": (
            "d" * 64
            if external_first_stage
            else hashlib.sha256(f"system-{harness}-{index}".encode()).hexdigest()
        ),
        "finish_reason": "tool_calls" if call_names else "stop",
        "result_subtype": "success",
        "terminal_reason": None,
        "unapplied_parameters": [],
        "queue_wait_ms": 0.0,
        "service_ms": 250.0,
        "message_roles": roles,
        "content_attestation": {
            "schema_version": 1,
            "contract_id": content_contract["contract_id"],
            "contract_sha256": contract_sha256,
            "system_hint_sha256": hashlib.sha256(
                str(content_contract["system_hint"]).encode("utf-8")
            ).hexdigest(),
            "system_hint_instruction_occurrences": 1,
            "system_hint_user_occurrences": 0,
            "system_hint_generated_occurrences": 0,
            "public_user_matches": {public_prompt_sha256: 1},
            "public_user_instruction_matches": {},
            "public_user_generated_matches": {},
            "forbidden_ingress_match_counts": {
                category: 0 for category in forbidden
            },
            "forbidden_ingress_match_total": 0,
            "forbidden_generated_match_counts": {
                category: 0 for category in forbidden
            },
            "forbidden_generated_match_total": 0,
            "observed_instruction_match_counts": {
                category: 0 for category in observed
            },
            "observed_user_match_counts": {category: 0 for category in observed},
            "observed_ingress_match_counts": {
                category: 0 for category in observed
            },
            "observed_generated_match_counts": {
                category: 0 for category in observed
            },
            "message_content_manifest": [
                {
                    "index": role_index,
                    "role": role,
                    "sha256": (
                        public_prompt_sha256
                        if role == "user"
                        else hashlib.sha256(
                            f"{request_id}:{role_index}:{role}".encode("utf-8")
                        ).hexdigest()
                    ),
                }
                for role_index, role in enumerate(roles)
            ],
        },
    }


def _valid_gateway_records() -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for harness in canary.HARNESSES:
        for index, (tools, calls, choice) in enumerate(
            zip(
                canary.EXPECTED_STAGE_TOOL_NAMES[harness],
                canary.EXPECTED_STAGE_CALL_NAMES[harness],
                canary.EXPECTED_STAGE_TOOL_CHOICES[harness],
                strict=True,
            )
        ):
            records.append(
                _gateway_record(
                    harness=harness,
                    index=index,
                    tool_names=tools,
                    call_names=calls,
                    tool_choice=choice,
                )
            )
    return records


def test_plan_is_opaque_and_performs_no_writes(tmp_path: Path) -> None:
    workspace = tmp_path / "packages"
    prompt = (
        "Start a delegated task now for this concrete assignment: inspect the "
        "current workspace and return a change plan."
    )
    _write_plan_inputs(workspace, prompt)

    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_test",
    )

    assert plan.prompt == prompt
    assert not plan.artifact_root.exists()
    assert set(plan.task_ids) == set(canary.HARNESSES)
    assert all(
        canary.OPAQUE_TASK_ID_RE.fullmatch(value) for value in plan.task_ids.values()
    )
    assert len(set(plan.task_ids.values())) == 3
    public = plan.public_payload()
    assert public["expected_gateway_requests_total"] == 7
    assert public["expected_reasoning_effort"] == "medium"
    assert (
        public["canary_request_sha256"]
        == hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    )
    assert public["expected_tasks_gateway_schema_sha256"] == (
        canary.EXPECTED_TASKS_GATEWAY_SCHEMA_SHA256
    )
    assert canary._normalized_tasks_gateway_schema_sha256(
        canary._LIFECYCLE_TASKS_TOOLS[0]
    ) == (canary.EXPECTED_TASKS_GATEWAY_SCHEMA_SHA256)
    assert public["system_hint_sha256"] == (
        "21a9634f076e39bf3f4f4c193ef5807e6c5d5fe1497f42ba32dccd2c36751d09"
    )
    assert public["scored"] is False
    assert public["publication_eligible"] is False


def test_plan_reuses_checkpoint_identity_without_reusing_artifact_root(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)

    first = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_first",
    )
    second = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_second",
    )

    assert first.artifact_root != second.artifact_root
    assert first.execution_namespace == second.execution_namespace
    assert first.task_ids == second.task_ids
    assert first.replay_file == second.replay_file
    assert first.hmac_key_file == second.hmac_key_file
    assert not first.checkpoint_root.exists()


def test_checkpoint_identity_changes_when_canary_source_changes(tmp_path: Path) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    source = workspace / "benchmarks" / "eliza-adapter" / "adapter.py"
    source.parent.mkdir(parents=True)
    source.write_text("VALUE = 1\n", encoding="utf-8")
    first = canary.build_canary_plan(workspace_root=workspace)

    source.write_text("VALUE = 2\n", encoding="utf-8")
    second = canary.build_canary_plan(workspace_root=workspace)

    assert first.source_fingerprint_sha256 != second.source_fingerprint_sha256
    assert first.execution_namespace != second.execution_namespace
    assert first.replay_file != second.replay_file


def test_low_storage_stops_before_artifact_auth_or_gateway(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(workspace_root=workspace)
    gateway_started = False

    def forbidden_gateway_start(**_kwargs: object) -> object:
        nonlocal gateway_started
        gateway_started = True
        raise AssertionError("gateway must not start below the storage reserve")

    monkeypatch.setattr(
        canary.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=plan.minimum_free_bytes - 1),
    )
    monkeypatch.setattr(
        canary,
        "start_claude_subscription_gateway",
        forbidden_gateway_start,
    )

    with pytest.raises(canary.CanaryStoragePreflightError):
        canary.run_live_canary(plan)

    assert gateway_started is False
    assert not plan.output_root.exists()
    assert not plan.artifact_root.exists()
    assert not plan.checkpoint_root.exists()


@pytest.mark.parametrize("contract_text", ["{}\n", "not-json\n"])
def test_plan_rejects_malformed_workspace_tasks_contract(
    tmp_path: Path,
    contract_text: str,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    contract_path = (
        workspace / "benchmarks" / "orchestrator_lifecycle" / "tasks-tool.json"
    )
    contract_path.write_text(contract_text, encoding="utf-8")

    with pytest.raises(canary.CanaryError, match="TASKS source contract"):
        canary.build_canary_plan(
            workspace_root=workspace,
            run_group_id="canary_orchestrator_lifecycle_bad_contract_test",
        )


def test_plan_rejects_drifted_workspace_tasks_contract(tmp_path: Path) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    contract_path = (
        workspace / "benchmarks" / "orchestrator_lifecycle" / "tasks-tool.json"
    )
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    contract["function"]["description"] += " drift"
    contract_path.write_text(json.dumps(contract), encoding="utf-8")

    with pytest.raises(canary.CanaryError, match="pinned full contract"):
        canary.build_canary_plan(
            workspace_root=workspace,
            run_group_id="canary_orchestrator_lifecycle_drifted_contract_test",
        )


def test_lane_environment_scrubs_ambient_providers_and_sampling(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_env_test",
    )
    scrubbed_names = (
        "ANTHROPIC_API_KEY",
        "CEREBRAS_API_KEY",
        "CEREBRAS_BASE_URL",
        "GROQ_API_KEY",
        "GROQ_BASE_URL",
        "OPENCLAW_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENROUTER_BASE_URL",
        "BENCHMARK_TEMPERATURE",
        "TEMPERATURE",
        "BENCHMARK_MAX_TOKENS",
        "MAX_TOKENS",
    )
    for name in scrubbed_names:
        monkeypatch.setenv(name, "ambient-sentinel")
    monkeypatch.setenv("BENCHMARK_REASONING_EFFORT", "ambient-sentinel")
    monkeypatch.setenv("OPENAI_REASONING_EFFORT", "ambient-sentinel")
    monkeypatch.setenv("OPENCLAW_THINKING_LEVEL", "ambient-sentinel")
    gateway_env = {
        "CLAUDE_SUBSCRIPTION_GATEWAY_URL": "http://127.0.0.1:31337",
        "CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN": "gateway-sentinel",
        "OPENAI_BASE_URL": "http://127.0.0.1:31337/v1",
        "OPENAI_API_KEY": "gateway-sentinel",
    }

    env = canary._lane_environment(
        plan=plan,
        harness="eliza",
        gateway_env=gateway_env,
        lane_root=tmp_path / "lane",
    )

    assert all(name not in env for name in scrubbed_names)
    assert env["OPENAI_BASE_URL"] == gateway_env["OPENAI_BASE_URL"]
    assert env["OPENAI_API_KEY"] == gateway_env["OPENAI_API_KEY"]
    assert env["ELIZA_BENCH_FORCE_TOOL_CALL"] == "0"
    assert env["ELIZA_BENCH_SUBSCRIPTION_CHAT_ONLY"] == "1"
    assert env["ELIZA_BENCH_DISABLE_DOTENV"] == "1"
    assert env["BENCHMARK_REASONING_EFFORT"] == "medium"
    assert env["OPENAI_REASONING_EFFORT"] == "medium"
    assert env["OPENCLAW_THINKING_LEVEL"] == "medium"
    assert env["BENCHMARK_WORKSPACE_PATH"] == str(workspace.parent.resolve())


def test_lane_context_pins_effort_and_keeps_workspace_path_control_only(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_context_test",
    )

    for harness in canary.HARNESSES:
        context = canary._lane_context(plan, harness, plan.task_ids[harness])
        assert context["reasoning_effort"] == "medium"
        if harness == "eliza":
            assert "benchmark_workspace_path" not in context
        else:
            assert context["benchmark_workspace_path"] == str(
                workspace.parent.resolve()
            )
    target_path = str(workspace.parent.resolve())
    assert target_path not in plan.prompt
    assert target_path not in canary._LIFECYCLE_SYSTEM_HINT


def test_response_requires_exact_shared_handler_result() -> None:
    response = _valid_response()

    assert canary.validate_lane_response(response) == {
        "action": "spawn_agent",
        "task": "Implement the login timeout fix.",
    }

    response["params"]["lifecycle_results"][0]["result"]["effect"] = "executed"
    with pytest.raises(canary.CanaryError, match="capture-only result"):
        canary.validate_lane_response(response)


def test_response_accepts_both_shared_start_actions() -> None:
    response = _valid_response()
    response["params"]["tool_calls"][0]["arguments"]["action"] = "create"
    response["params"]["lifecycle_results"][0]["arguments"]["action"] = "create"

    assert canary.validate_lane_response(response)["action"] == "create"


@pytest.mark.parametrize(
    "field",
    (
        "lifecycle_force_tool_call_disabled",
        "lifecycle_benchmark_provider_registered",
        "lifecycle_benchmark_provider_payload_neutral",
    ),
)
def test_eliza_health_rejects_force_tool_or_provider_leakage(field: str) -> None:
    health = _valid_eliza_health()
    canary._validate_health("eliza", health)
    health[field] = False

    with pytest.raises(canary.CanaryError, match="health contract"):
        canary._validate_health("eliza", health)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda payload: payload.update(actions=["TASKS", "TASKS"]), "one TASKS"),
        (
            lambda payload: payload["params"]["tool_calls"][0]["arguments"].update(
                surprise=True
            ),
            "extra fields",
        ),
        (
            lambda payload: payload["params"]["tool_calls"][0]["arguments"].update(
                action="list_agents"
            ),
            "start action",
        ),
    ],
)
def test_response_rejects_extra_dispatches_or_schema_drift(
    mutation: Callable[[dict[str, object]], None],
    message: str,
) -> None:
    payload = _valid_response()
    mutation(payload)
    if "params" in payload:
        params = payload["params"]
        if isinstance(params, dict) and isinstance(params.get("tool_calls"), list):
            call = params["tool_calls"][0]
            execution = params["lifecycle_results"][0]
            if isinstance(call, dict) and isinstance(execution, dict):
                execution["arguments"] = dict(call.get("arguments") or {})

    with pytest.raises(canary.CanaryError, match=message):
        canary.validate_lane_response(payload)


def test_gateway_stages_accept_scaffold_specific_hashes_and_shared_schema() -> None:
    records = _valid_gateway_records()
    openclaw_first = next(
        record
        for record in records
        if record["harness"] == "openclaw" and str(record["request_id"]).endswith("-0")
    )
    openclaw_first.update(
        {
            "request_sha256": "f" * 64,
            "prompt_sha256": "a" * 64,
            "system_prompt_sha256": "9" * 64,
        }
    )

    summary = canary.validate_gateway_stages(records)

    assert summary["records"] == 7
    assert summary["reasoning_effort"] == "medium"
    assert summary["reasoning_effort_parity"] is True
    assert summary["tasks_gateway_schema_sha256"] == (
        canary.EXPECTED_TASKS_GATEWAY_SCHEMA_SHA256
    )
    assert summary["stages"]["eliza"][1]["tool_call_names"] == ["TASKS"]
    assert summary["stages"]["hermes"][1]["tool_call_names"] == []
    external_hashes = summary["external_first_stage_hashes_by_harness"]
    assert external_hashes["hermes"] != external_hashes["openclaw"]


@pytest.mark.parametrize(
    "field", ["request_sha256", "prompt_sha256", "system_prompt_sha256"]
)
def test_gateway_stages_reject_invalid_payload_hash(field: str) -> None:
    records = _valid_gateway_records()
    openclaw_first = next(
        record
        for record in records
        if record["harness"] == "openclaw" and str(record["request_id"]).endswith("-0")
    )
    openclaw_first[field] = "not-a-sha256"

    with pytest.raises(canary.CanaryError, match=field):
        canary.validate_gateway_stages(records)


def test_gateway_stages_reject_a_shared_but_drifted_tasks_schema() -> None:
    records = _valid_gateway_records()
    for record in records:
        if "TASKS" in record["tool_names"]:
            record["tool_schema_sha256_by_name"]["TASKS"] = "f" * 64

    with pytest.raises(canary.CanaryError, match="tool_contract_mismatch"):
        canary.validate_gateway_stages(records)


@pytest.mark.parametrize("mutation", ["missing", "high"])
def test_gateway_stages_reject_missing_or_unequal_reasoning_effort(
    mutation: str,
) -> None:
    records = _valid_gateway_records()
    if mutation == "missing":
        records[0].pop("reasoning_effort")
    else:
        records[-1]["reasoning_effort"] = mutation

    with pytest.raises(canary.CanaryError, match="reasoning effort"):
        canary.validate_gateway_stages(records)


def test_gateway_stages_reject_retry_or_stage_drift() -> None:
    records = _valid_gateway_records()
    retry = dict(records[-1])
    retry["request_id"] = "request-retry"
    retry["request_sha256"] = "f" * 64

    with pytest.raises(canary.CanaryError, match="expected 7"):
        canary.validate_gateway_stages([*records, retry])

    records = _valid_gateway_records()
    records[1]["tool_call_names"] = []
    records[1]["finish_reason"] = "stop"
    with pytest.raises(canary.CanaryError, match="eliza_tasks_call_missing"):
        canary.validate_gateway_stages(records)


def test_gateway_partial_stage_reducer_keeps_allowlisted_failed_evidence() -> None:
    records = _valid_gateway_records()
    retry = dict(records[-1])
    retry["request_id"] = "request-retry"
    retry["request_sha256"] = "f" * 64

    summary = canary._safe_gateway_stage_evidence([*records, retry])

    assert summary["validation_status"] == "unvalidated"
    assert summary["publication_eligible"] is False
    assert summary["records"] == 8
    assert summary["records_by_harness"] == {
        "eliza": canary.EXPECTED_GATEWAY_REQUESTS["eliza"],
        "hermes": canary.EXPECTED_GATEWAY_REQUESTS["hermes"],
        "openclaw": canary.EXPECTED_GATEWAY_REQUESTS["openclaw"] + 1,
    }
    assert summary["reasoning_effort_field_records"] == 8
    assert summary["reasoning_efforts_observed"] == ["medium"]
    assert summary["stages"]["openclaw"][-1]["tool_call_names"] == []
    assert summary["stages"]["openclaw"][-1]["parallel_tool_calls"] is True


def test_publication_snapshot_detects_database_latest_and_viewer_changes(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "packages"
    output = workspace / "benchmarks" / "benchmark_results"
    latest = output / "latest"
    viewer = workspace / "benchmarks" / "viewer"
    latest.mkdir(parents=True)
    viewer.mkdir(parents=True)
    (output / "orchestrator.sqlite").write_bytes(b"before")
    (output / "viewer_data.json").write_text("{}\n", encoding="utf-8")
    (latest / "index.json").write_text("{}\n", encoding="utf-8")
    (viewer / "index.html").write_text("before\n", encoding="utf-8")
    before = canary.publication_snapshot(workspace)

    (latest / "index.json").write_text('{"changed":true}\n', encoding="utf-8")
    after = canary.publication_snapshot(workspace)

    assert before != after


def test_openclaw_system_surface_matches_preserved_agents_file_and_telemetry(
    tmp_path: Path,
) -> None:
    task_id = "orchestrator-lifecycle-" + "1" * 32
    target_workspace = tmp_path / "target-repo"
    target_workspace.mkdir()
    lane_root = tmp_path / "openclaw"
    turn_root = lane_root / "native-state" / canary.BENCHMARK_ID / task_id / "turn-0000"
    workspace = turn_root / "workspace"
    workspace.mkdir(parents=True)
    agents_path = workspace / "AGENTS.md"
    agents_path.write_text(canary._LIFECYCLE_SYSTEM_HINT, encoding="utf-8")
    session_path = turn_root / "agents" / "benchmark" / "sessions" / "turn.jsonl"
    session_path.parent.mkdir(parents=True)
    session_usage = {
        "input": 10,
        "output": 2,
        "totalTokens": 12,
        "cacheRead": 1,
        "cacheWrite": 0,
    }
    session_path.write_text(
        "\n".join(
            json.dumps(record)
            for record in (
                {"type": "thinking_level_change", "thinkingLevel": "medium"},
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "done"}],
                        "stopReason": "stop",
                        "usage": session_usage,
                    },
                },
            )
        )
        + "\n",
        encoding="utf-8",
    )
    native_version = "2026.5.7"
    native_build = "a" * 40
    trajectory_path = session_path.with_name("turn.trajectory.jsonl")
    trajectory_path.write_text(
        "\n".join(
            json.dumps(record)
            for record in (
                {
                    "type": "trace.metadata",
                    "data": {
                        "harness": {
                            "type": "openclaw",
                            "version": native_version,
                            "gitSha": native_build,
                        },
                        "model": {
                            "thinkLevel": "medium",
                            "reasoningLevel": "off",
                        },
                    },
                },
                {
                    "type": "model.completed",
                    "data": {
                        "usage": {
                            "input": 10,
                            "output": 2,
                            "total": 12,
                            "cacheRead": 1,
                            "cacheWrite": 0,
                        }
                    },
                },
                {
                    "type": "session.ended",
                    "data": {
                        "status": "success",
                        "aborted": False,
                        "timedOut": False,
                    },
                },
            )
        )
        + "\n",
        encoding="utf-8",
    )
    expected_sha256 = hashlib.sha256(
        canary._LIFECYCLE_SYSTEM_HINT.encode("utf-8")
    ).hexdigest()
    expected_session_sha256 = hashlib.sha256(session_path.read_bytes()).hexdigest()
    expected_trajectory_sha256 = hashlib.sha256(
        trajectory_path.read_bytes()
    ).hexdigest()
    normalized_usage = {
        "prompt_tokens": 10,
        "completion_tokens": 2,
        "total_tokens": 12,
        "prompt_tokens_details": {
            "cached_tokens": 1,
            "cache_write_tokens": 0,
        },
    }
    prompt_text = f"{canary._LIFECYCLE_SYSTEM_HINT}\nuser: delegate this"
    telemetry = {
        "prompt_text": prompt_text,
        "params": {
            "usage": normalized_usage,
            "_meta": {
                "openclaw_adapter": {
                    "native_system_prompt_surface": "workspace/AGENTS.md",
                    "native_system_prompt_sha256": expected_sha256,
                    "native_requested_system_prompt_sha256": expected_sha256,
                    "native_system_prompt_matches_requested": True,
                    "native_system_prompt_in_cli_message": False,
                    "native_prompt_sha256": hashlib.sha256(
                        prompt_text.encode("utf-8")
                    ).hexdigest(),
                    "benchmark_workspace_path": str(target_workspace.resolve()),
                    "benchmark_workspace_git_sha": "b" * 40,
                    "runtime_workspace_path": str(workspace.resolve()),
                    "runtime_workspace_isolated": True,
                    "native_session_evidence": "succeeded",
                    "native_session_sha256": expected_session_sha256,
                    "native_session_terminal_stop_reason": "stop",
                    "native_session_assistant_model_call_count": 1,
                    "native_usage_scope": "full_native_turn_aggregate",
                    "native_usage_sha256": canary.canonical_json_sha256(
                        normalized_usage
                    ),
                    "native_trajectory_evidence": "succeeded",
                    "native_trajectory_sha256": expected_trajectory_sha256,
                    "reasoning_effort_requested": "medium",
                    "thinking_level_requested": "medium",
                    "thinking_level_effective": "medium",
                    "thinking_level_trajectory": "medium",
                    "thinking_level_attested": True,
                    "native_cli_health_version": native_version,
                    "native_cli_health_build": native_build,
                    "native_trajectory_runtime_version": native_version,
                    "native_trajectory_runtime_git_sha": native_build,
                    "native_runtime_identity_attested": True,
                }
            },
        },
    }

    evidence = canary._validate_openclaw_system_surface(
        lane_root=lane_root,
        task_id=task_id,
        benchmark_workspace_path=target_workspace,
        telemetry_record=telemetry,
    )

    assert evidence["agents_path"] == str(agents_path)
    assert evidence["agents_sha256"] == expected_sha256
    assert evidence["session_path"] == str(session_path)
    assert evidence["session_sha256"] == expected_session_sha256
    assert evidence["session_terminal_stop_reason"] == "stop"
    assert evidence["trajectory_sha256"] == expected_trajectory_sha256
    assert evidence["native_usage_sha256"] == canary.canonical_json_sha256(
        normalized_usage
    )
    assert evidence["thinking_level_attested"] is True
    assert evidence["native_runtime_identity_attested"] is True
    telemetry["params"]["_meta"]["openclaw_adapter"][
        "native_system_prompt_in_cli_message"
    ] = True
    with pytest.raises(canary.CanaryError, match="does not match disk"):
        canary._validate_openclaw_system_surface(
            lane_root=lane_root,
            task_id=task_id,
            benchmark_workspace_path=target_workspace,
            telemetry_record=telemetry,
        )

    telemetry["params"]["_meta"]["openclaw_adapter"][
        "native_system_prompt_in_cli_message"
    ] = False
    telemetry["params"]["_meta"]["openclaw_adapter"]["native_session_sha256"] = "0" * 64
    with pytest.raises(canary.CanaryError, match="does not match disk"):
        canary._validate_openclaw_system_surface(
            lane_root=lane_root,
            task_id=task_id,
            benchmark_workspace_path=target_workspace,
            telemetry_record=telemetry,
        )

    session_path.write_text(
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "stopReason": "error",
                    "errorMessage": "Connection error.",
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    with pytest.raises(canary.CanaryError, match="complete stop state"):
        canary._validate_openclaw_system_surface(
            lane_root=lane_root,
            task_id=task_id,
            benchmark_workspace_path=target_workspace,
            telemetry_record=telemetry,
        )


def test_hermes_system_surface_contains_only_one_shared_hint_without_labels() -> None:
    prompt_text = (
        "Benchmark context:\n"
        "system_hint:\n"
        f"{canary._LIFECYCLE_SYSTEM_HINT}\n"
        "user: Start a concrete delegated task in the current workspace."
    )

    evidence = canary._validate_hermes_system_surface({"prompt_text": prompt_text})

    assert evidence["surface"] == "telemetry.prompt_text"
    assert evidence["shared_hint_occurrences"] == 1
    assert evidence["answer_labels_absent"] is True
    with pytest.raises(canary.CanaryError, match="exactly once"):
        canary._validate_hermes_system_surface(
            {"prompt_text": prompt_text + "\n" + canary._LIFECYCLE_SYSTEM_HINT}
        )
    with pytest.raises(canary.CanaryError, match="answer labels"):
        canary._validate_hermes_system_surface(
            {"prompt_text": prompt_text + "\nspecific_request_simple"}
        )


@pytest.mark.parametrize("harness", canary.HARNESSES)
def test_canary_user_request_occurs_once_in_each_telemetry_prompt(
    tmp_path: Path,
    harness: str,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id=f"canary_orchestrator_lifecycle_prompt_{harness}_test",
    )
    prompt_text = f"native system context\nuser: {plan.prompt}"

    evidence = canary._validate_canary_user_request_surface(
        plan,
        harness,
        {"prompt_text": prompt_text},
    )

    assert evidence == {
        "surface": "telemetry.prompt_text",
        "occurrences": 1,
        "request_sha256": hashlib.sha256(plan.prompt.encode("utf-8")).hexdigest(),
        "benchmark_workspace_path_absent": True,
    }
    with pytest.raises(canary.CanaryError, match="exactly once"):
        canary._validate_canary_user_request_surface(
            plan,
            harness,
            {"prompt_text": prompt_text + "\n" + plan.prompt},
        )
    with pytest.raises(canary.CanaryError, match="control path"):
        canary._validate_canary_user_request_surface(
            plan,
            harness,
            {"prompt_text": prompt_text + "\n" + str(workspace.parent.resolve())},
        )


def test_eliza_canary_pins_content_free_model_boundary_hint_attestation() -> None:
    telemetry = _valid_eliza_hint_telemetry()

    evidence = canary._validate_eliza_system_hint_attestation(telemetry)

    assert evidence == {
        "schema_version": 1,
        "surface": "runtime_provenance.lifecycle_system_hint_attestation",
        "system_hint_sha256": canary.ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
        "model_boundary_call_count": 3,
        "model_boundary_attested_call_count": 3,
        "model_boundary_hint_occurrence_count": 3,
        "exact_once_per_model_call": True,
        "model_type_call_counts": {
            "ACTION_PLANNER": 1,
            "RESPONSE_HANDLER": 2,
        },
        "usage_call_count": 3,
    }
    assert canary._LIFECYCLE_SYSTEM_HINT not in json.dumps(evidence)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda telemetry: telemetry["runtime_provenance"][
            "lifecycle_system_hint_attestation"
        ].update(system_hint_sha256="0" * 64),
        lambda telemetry: telemetry["runtime_provenance"][
            "lifecycle_system_hint_attestation"
        ].update(model_boundary_call_count=2),
        lambda telemetry: telemetry["runtime_provenance"][
            "lifecycle_system_hint_attestation"
        ].update(model_boundary_attested_call_count=2),
        lambda telemetry: telemetry["runtime_provenance"][
            "lifecycle_system_hint_attestation"
        ].update(model_boundary_hint_occurrence_count=2),
        lambda telemetry: telemetry["runtime_provenance"][
            "lifecycle_system_hint_attestation"
        ].update(exact_once_per_model_call=False),
        lambda telemetry: telemetry["runtime_provenance"][
            "lifecycle_system_hint_attestation"
        ].update(model_type_call_counts={"ACTION_PLANNER": 1}),
        lambda telemetry: telemetry["runtime_provenance"][
            "lifecycle_system_hint_attestation"
        ].update(system_hint=canary._LIFECYCLE_SYSTEM_HINT),
        lambda telemetry: telemetry["usage"].update(callCount=2),
    ],
)
def test_eliza_canary_rejects_model_boundary_hint_attestation_drift(
    mutation: Callable[[dict[str, object]], None],
) -> None:
    telemetry = _valid_eliza_hint_telemetry()
    mutation(telemetry)

    with pytest.raises(canary.CanaryError, match="attestation drifted"):
        canary._validate_eliza_system_hint_attestation(telemetry)


class _FakeGateway:
    def env_for_harness(self, harness: str) -> dict[str, str]:
        return {"TOKEN": harness}


class _FakeProcess:
    def __init__(
        self,
        *,
        target: Callable[..., None],
        name: str,
        args: tuple[object, ...],
        fail_on_start: bool = False,
    ) -> None:
        self.target = target
        self.name = name
        self.args = args
        self.fail_on_start = fail_on_start
        self.thread: threading.Thread | None = None
        self.exitcode: int | None = None
        self.start_calls = 0
        self.join_calls = 0
        self.terminate_calls = 0
        self.kill_calls = 0

    def start(self) -> None:
        self.start_calls += 1
        if self.fail_on_start:
            raise RuntimeError(f"synthetic start failure: {self.name}")

        def run() -> None:
            try:
                self.target(*self.args)
                self.exitcode = 0
            except Exception:
                self.exitcode = 1

        self.thread = threading.Thread(target=run, name=self.name)
        self.thread.start()

    def join(self, timeout: float | None = None) -> None:
        self.join_calls += 1
        assert self.thread is not None
        self.thread.join(timeout)

    def is_alive(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def terminate(self) -> None:
        self.terminate_calls += 1
        self.exitcode = -15

    def kill(self) -> None:
        self.kill_calls += 1
        self.exitcode = -9


class _FakeProcessContext:
    def __init__(self, *, fail_start_index: int | None = None) -> None:
        self.created: list[_FakeProcess] = []
        self.fail_start_index = fail_start_index

    def Event(self) -> threading.Event:
        return threading.Event()

    def Queue(self) -> queue.Queue[dict[str, object]]:
        return queue.Queue()

    def Process(self, **kwargs: object) -> _FakeProcess:
        process = _FakeProcess(
            **kwargs,
            fail_on_start=len(self.created) == self.fail_start_index,
        )
        self.created.append(process)
        return process


def test_worker_supervisor_waits_for_three_ready_processes_before_release(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_process_test",
    )
    ready_before_release: list[str] = []

    def fake_worker(
        _plan: canary.CanaryPlan,
        harness: str,
        _gateway_env: dict[str, str],
        start_event: threading.Event,
        abort_event: threading.Event,
        result_queue: queue.Queue[dict[str, object]],
    ) -> None:
        assert not start_event.is_set()
        assert not abort_event.is_set()
        ready_before_release.append(harness)
        synthetic_pid = 10_000 + canary.HARNESSES.index(harness)
        result_queue.put({"phase": "ready", "harness": harness, "pid": synthetic_pid})
        assert start_event.wait(timeout=2)
        result_queue.put(
            {
                "phase": "complete",
                "harness": harness,
                "pid": synthetic_pid,
                "outer_dispatches": 1,
                "task_id": _plan.task_ids[harness],
            }
        )

    monkeypatch.setattr(canary, "_lane_worker", fake_worker)
    context = _FakeProcessContext()

    results = canary._run_workers(
        plan,
        _FakeGateway(),
        process_context=context,
    )

    assert set(ready_before_release) == set(canary.HARNESSES)
    assert len(context.created) == 3
    assert set(results) == set(canary.HARNESSES)
    assert all(result["outer_dispatches"] == 1 for result in results.values())


def test_worker_supervisor_collects_every_released_lane_before_failing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_failure_test",
    )
    reached_terminal: list[str] = []

    def fake_worker(
        _plan: canary.CanaryPlan,
        harness: str,
        _gateway_env: dict[str, str],
        start_event: threading.Event,
        abort_event: threading.Event,
        result_queue: queue.Queue[dict[str, object]],
    ) -> None:
        synthetic_pid = 20_000 + canary.HARNESSES.index(harness)
        result_queue.put({"phase": "ready", "harness": harness, "pid": synthetic_pid})
        assert start_event.wait(timeout=2)
        assert not abort_event.is_set()
        reached_terminal.append(harness)
        if harness == "hermes":
            result_queue.put(
                {
                    "phase": "error",
                    "harness": harness,
                    "pid": synthetic_pid,
                    "error": "synthetic failure",
                }
            )
            raise RuntimeError("synthetic failure")
        result_queue.put(
            {
                "phase": "complete",
                "harness": harness,
                "pid": synthetic_pid,
                "outer_dispatches": 1,
                "task_id": _plan.task_ids[harness],
            }
        )

    monkeypatch.setattr(canary, "_lane_worker", fake_worker)
    context = _FakeProcessContext()

    with pytest.raises(canary.CanaryWorkerError) as raised:
        canary._run_workers(plan, _FakeGateway(), process_context=context)

    assert set(reached_terminal) == set(canary.HARNESSES)
    assert set(raised.value.worker_results) == set(canary.HARNESSES)
    assert raised.value.worker_results["hermes"]["phase"] == "error"
    assert all(not process.is_alive() for process in context.created)


def test_worker_supervisor_aborts_ready_peers_without_dispatch_on_readiness_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_readiness_failure_test",
    )
    aborted: list[str] = []
    dispatched: list[str] = []

    def fake_worker(
        _plan: canary.CanaryPlan,
        harness: str,
        _gateway_env: dict[str, str],
        start_event: threading.Event,
        abort_event: threading.Event,
        result_queue: queue.Queue[dict[str, object]],
    ) -> None:
        synthetic_pid = 30_000 + canary.HARNESSES.index(harness)
        if harness == "hermes":
            result_queue.put(
                {
                    "phase": "error",
                    "harness": harness,
                    "pid": synthetic_pid,
                    "error": "synthetic readiness failure",
                }
            )
            raise RuntimeError("synthetic readiness failure")
        result_queue.put({"phase": "ready", "harness": harness, "pid": synthetic_pid})
        assert start_event.wait(timeout=2)
        if abort_event.is_set():
            aborted.append(harness)
            raise RuntimeError("synthetic graceful abort")
        dispatched.append(harness)

    monkeypatch.setattr(canary, "_lane_worker", fake_worker)
    context = _FakeProcessContext()

    with pytest.raises(canary.CanaryError, match="before synchronized release"):
        canary._run_workers(plan, _FakeGateway(), process_context=context)

    assert set(aborted) == {"eliza", "openclaw"}
    assert dispatched == []
    assert all(not process.is_alive() for process in context.created)


def test_worker_supervisor_cleans_started_peer_when_later_start_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_partial_start_test",
    )
    aborted: list[str] = []

    def fake_worker(
        _plan: canary.CanaryPlan,
        harness: str,
        _gateway_env: dict[str, str],
        start_event: threading.Event,
        abort_event: threading.Event,
        _result_queue: queue.Queue[dict[str, object]],
    ) -> None:
        assert start_event.wait(timeout=2)
        assert abort_event.is_set()
        aborted.append(harness)

    monkeypatch.setattr(canary, "_lane_worker", fake_worker)
    context = _FakeProcessContext(fail_start_index=1)

    with pytest.raises(RuntimeError, match="synthetic start failure"):
        canary._run_workers(plan, _FakeGateway(), process_context=context)

    assert aborted == ["eliza"]
    assert [process.start_calls for process in context.created] == [1, 1, 0]
    assert context.created[0].join_calls >= 1
    assert context.created[1].join_calls == 0
    assert context.created[2].join_calls == 0
    assert all(not process.is_alive() for process in context.created)


def test_worker_supervisor_aborts_all_started_workers_on_invalid_control_message(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_invalid_control_test",
    )
    aborted: list[str] = []

    def fake_worker(
        _plan: canary.CanaryPlan,
        harness: str,
        _gateway_env: dict[str, str],
        start_event: threading.Event,
        abort_event: threading.Event,
        result_queue: queue.Queue[dict[str, object]],
    ) -> None:
        if harness == "eliza":
            result_queue.put({"phase": "invalid", "harness": harness, "pid": 40_000})
        assert start_event.wait(timeout=2)
        assert abort_event.is_set()
        aborted.append(harness)

    monkeypatch.setattr(canary, "_lane_worker", fake_worker)
    context = _FakeProcessContext()

    with pytest.raises(canary.CanaryError, match="Unexpected canary readiness"):
        canary._run_workers(plan, _FakeGateway(), process_context=context)

    assert set(aborted) == set(canary.HARNESSES)
    assert all(process.join_calls >= 1 for process in context.created)
    assert all(not process.is_alive() for process in context.created)


def test_worker_supervisor_aborts_all_started_workers_on_control_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_control_timeout_test",
    )
    aborted: list[str] = []

    def fake_worker(
        _plan: canary.CanaryPlan,
        harness: str,
        _gateway_env: dict[str, str],
        start_event: threading.Event,
        abort_event: threading.Event,
        _result_queue: queue.Queue[dict[str, object]],
    ) -> None:
        assert start_event.wait(timeout=2)
        assert abort_event.is_set()
        aborted.append(harness)

    monkeypatch.setattr(canary, "_lane_worker", fake_worker)
    monkeypatch.setattr(canary, "READINESS_TIMEOUT_SECONDS", 0.05)
    context = _FakeProcessContext()

    with pytest.raises(canary.CanaryError, match="Timed out waiting"):
        canary._run_workers(plan, _FakeGateway(), process_context=context)

    assert set(aborted) == set(canary.HARNESSES)
    assert all(process.join_calls >= 1 for process in context.created)
    assert all(not process.is_alive() for process in context.created)


class _SignalResistantProcess:
    def __init__(
        self,
        harness: str,
        trace: list[tuple[str, str]],
        *,
        survives_kill: bool = False,
    ) -> None:
        self.harness = harness
        self.trace = trace
        self.survives_kill = survives_kill
        self.alive = True

    def join(self, timeout: float | None = None) -> None:
        del timeout
        self.trace.append((self.harness, "join"))

    def is_alive(self) -> bool:
        return self.alive

    def terminate(self) -> None:
        self.trace.append((self.harness, "terminate"))

    def kill(self) -> None:
        self.trace.append((self.harness, "kill"))
        if not self.survives_kill:
            self.alive = False


def test_worker_cleanup_kills_every_sigterm_resistant_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    trace: list[tuple[str, str]] = []
    processes = {
        harness: _SignalResistantProcess(harness, trace)
        for harness in ("eliza", "hermes")
    }
    start_event = threading.Event()
    abort_event = threading.Event()
    monkeypatch.setattr(canary, "WORKER_GRACEFUL_EXIT_SECONDS", 0.0)
    monkeypatch.setattr(canary, "WORKER_TERMINATE_EXIT_SECONDS", 0.0)
    monkeypatch.setattr(canary, "WORKER_KILL_EXIT_SECONDS", 0.0)

    canary._shutdown_worker_processes(
        processes,
        start_event=start_event,
        abort_event=abort_event,
    )

    assert start_event.is_set()
    assert abort_event.is_set()
    assert trace == [
        ("eliza", "join"),
        ("hermes", "join"),
        ("eliza", "terminate"),
        ("hermes", "terminate"),
        ("eliza", "join"),
        ("hermes", "join"),
        ("eliza", "kill"),
        ("hermes", "kill"),
        ("eliza", "join"),
        ("hermes", "join"),
    ]
    assert all(not process.is_alive() for process in processes.values())


def test_worker_cleanup_fails_if_child_survives_kill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = _SignalResistantProcess("eliza", [], survives_kill=True)
    monkeypatch.setattr(canary, "WORKER_GRACEFUL_EXIT_SECONDS", 0.0)
    monkeypatch.setattr(canary, "WORKER_TERMINATE_EXIT_SECONDS", 0.0)
    monkeypatch.setattr(canary, "WORKER_KILL_EXIT_SECONDS", 0.0)

    with pytest.raises(canary.CanaryError, match="workers survived kill: eliza"):
        canary._shutdown_worker_processes(
            {"eliza": process},
            start_event=threading.Event(),
            abort_event=threading.Event(),
        )


def test_lane_worker_does_not_rethrow_unredacted_failure_to_child_stderr(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    try:
        context = multiprocessing.get_context("fork")
    except ValueError:
        pytest.skip(
            "fork context is required to inherit the deterministic fake manager"
        )

    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_redaction_test",
    )
    secret = "bearer-super-secret-sentinel"

    class ExplodingManager:
        client = None

        def start(self) -> None:
            raise RuntimeError(f"upstream rejected {secret}")

        def stop(self) -> None:
            return None

    monkeypatch.setattr(
        canary,
        "_manager_for_harness",
        lambda _harness, _workspace: ExplodingManager(),
    )
    result_queue = context.Queue()
    process = context.Process(
        target=canary._lane_worker,
        args=(
            plan,
            "eliza",
            {"CANARY_SECRET_TOKEN": secret},
            context.Event(),
            context.Event(),
            result_queue,
        ),
    )

    process.start()
    process.join(timeout=5)

    assert not process.is_alive()
    assert process.exitcode == 1
    message = result_queue.get(timeout=2)
    assert message["phase"] == "error"
    assert secret not in str(message["error"])
    assert "[REDACTED]" in str(message["error"])
    failure = json.loads(
        (plan.artifact_root / "eliza" / "failure.json").read_text(encoding="utf-8")
    )
    assert secret not in json.dumps(failure)
    assert "[REDACTED]" in failure["error"]
    captured = capfd.readouterr()
    assert secret not in captured.err


def test_canary_module_has_no_scoring_or_publication_entrypoints() -> None:
    source = Path(canary.__file__).read_text(encoding="utf-8")

    forbidden_modules = {
        "benchmarks.orchestrator.runner",
        "benchmarks.orchestrator_lifecycle.reporting",
        "benchmarks.orchestrator_lifecycle.runner",
    }
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported_modules = {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            imported_modules = {node.module or ""}
            if node.level and node.module in {"reporting", "runner"}:
                pytest.fail(f"canary imports prohibited relative module .{node.module}")
        else:
            continue
        prohibited = imported_modules & forbidden_modules
        assert not prohibited, f"canary imports prohibited module(s): {prohibited}"

    for forbidden in (
        "run_benchmarks(",
        "run_benchmark_cohorts(",
        "connect_database(",
        "save_report(",
        "benchmarks.orchestrator.runner import",
        "_rebuild_latest",
        "_ensure_viewer_snapshot",
    ):
        assert forbidden not in source


def test_canary_import_does_not_load_scored_runner_or_reporting() -> None:
    code = """
import sys
import benchmarks.orchestrator_lifecycle.canary

for name in (
    "benchmarks.orchestrator_lifecycle.runner",
    "benchmarks.orchestrator_lifecycle.reporting",
    "benchmarks.orchestrator.runner",
):
    assert name not in sys.modules, name
"""
    subprocess.run([sys.executable, "-c", code], check=True)


def test_failed_canary_manifest_retains_independent_partial_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "packages"
    _write_plan_inputs(workspace)
    plan = canary.build_canary_plan(
        workspace_root=workspace,
        run_group_id="canary_orchestrator_lifecycle_failed_evidence_test",
        minimum_free_bytes=1,
    )
    audit_path = plan.artifact_root / "subscription-gateway" / "audit.jsonl"
    synthetic_content_contract = {
        "schema_version": 1,
        "contract_id": canary.CANARY_CONTENT_CONTRACT_ID,
        "system_hint": "reviewed canary lifecycle hint",
        "public_user_turns": [plan.prompt],
        "forbidden_text_by_category": {"scenario_ids": ["hidden_scenario"]},
        "observed_text_by_category": {"workspace_paths": [str(workspace)]},
    }
    started_with: dict[str, object] = {}

    class FakeClosedGateway:
        def close(self) -> Path:
            audit_path.parent.mkdir(parents=True, exist_ok=True)
            records = _valid_gateway_records()
            retry = dict(records[-1])
            retry["request_id"] = "request-openclaw-retry"
            retry["request_sha256"] = "f" * 64
            audit_path.write_text(
                "".join(
                    json.dumps(record, sort_keys=True) + "\n"
                    for record in [*records, retry]
                ),
                encoding="utf-8",
            )
            return audit_path

    def fake_run_workers(
        _plan: canary.CanaryPlan,
        _gateway: object,
    ) -> dict[str, dict[str, object]]:
        terminal: dict[str, dict[str, object]] = {}
        for harness in canary.HARNESSES:
            lane_root = _plan.artifact_root / harness
            lane_root.mkdir(parents=True)
            telemetry = {
                "task_id": _plan.task_ids[harness],
                "benchmark": canary.BENCHMARK_ID,
                "harness": harness,
                "provider": "claude-subscription",
                "model": _plan.model,
                "response_text": (
                    "Adapter returned a partial reply." if harness == "hermes" else ""
                ),
                "actions": ["TASKS"] if harness == "hermes" else [],
                "params": {"partial": True} if harness == "hermes" else {},
                "runtime_provenance": {},
                "error_if_any": "synthetic adapter failure",
            }
            (lane_root / "telemetry.jsonl").write_text(
                json.dumps(telemetry, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            terminal[harness] = {
                "phase": "error",
                "harness": harness,
                "outer_dispatches": 1,
            }
        raise canary.CanaryWorkerError(
            "synthetic released worker failure",
            worker_results=terminal,
        )

    def fake_start_gateway(**kwargs: object) -> FakeClosedGateway:
        started_with.update(kwargs)
        return FakeClosedGateway()

    monkeypatch.setattr(
        canary,
        "build_lifecycle_gateway_content_contract",
        lambda *_args, **_kwargs: synthetic_content_contract,
    )
    monkeypatch.setattr(canary, "start_claude_subscription_gateway", fake_start_gateway)
    monkeypatch.setattr(canary, "_run_workers", fake_run_workers)

    with pytest.raises(canary.CanaryError, match="preserved evidence"):
        canary.run_live_canary(plan)

    assert started_with["content_attestation_contract"] == synthetic_content_contract

    manifest = json.loads(
        (plan.artifact_root / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["status"] == "failed"
    assert set(manifest["runtime_provenance"]) == set(canary.HARNESSES)
    assert all(
        summary["telemetry_records"] == 1
        for summary in manifest["runtime_provenance"].values()
    )
    assert all(
        validation["status"] == "failed"
        for validation in manifest["runtime_provenance_validation"].values()
    )
    assert set(manifest["subscription_gateway_provenance"]) == set(canary.HARNESSES)
    assert all(
        summary["audit_records"] > 0
        for summary in manifest["subscription_gateway_provenance"].values()
    )
    assert {
        harness: validation["status"]
        for harness, validation in manifest[
            "subscription_gateway_provenance_validation"
        ].items()
    } == {"eliza": "succeeded", "hermes": "succeeded", "openclaw": "failed"}
    assert manifest["gateway_stage_provenance"]["validation_status"] == "failed"
    assert manifest["gateway_stage_provenance"]["records"] == 8
    assert manifest["gateway_stage_provenance"]["stages"]["openclaw"]
    assert manifest["publication_state_unchanged"] is True
    hermes_partial = manifest["lane_partial_evidence"]["hermes"]["response"]
    assert hermes_partial["validation_status"] == "unvalidated_partial"
    assert hermes_partial["publication_eligible"] is False
    assert hermes_partial["response_obtained"] is True
    partial_artifact = json.loads(
        Path(hermes_partial["artifact"]).read_text(encoding="utf-8")
    )
    assert partial_artifact["response"]["text"] == ("Adapter returned a partial reply.")
    assert partial_artifact["validation_status"] == "unvalidated_partial"
    assert partial_artifact["publication_eligible"] is False
