"""Exercises fail-closed provenance checks over real adapter telemetry shapes."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from benchmarks.publication_contracts import (
    ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
)
from benchmarks.orchestrator.runtime_provenance import (
    ELIZA_NATIVE_RUNTIME_ROUTES,
    EXPECTED_NATIVE_RUNTIME,
    native_runtime_quarantine_reason,
    summarize_runtime_provenance,
)


def _native_runtime_record(
    harness: str,
    *,
    native_runtime_api: str | None = None,
    tool_bridge: str | None = None,
    stand_in: bool = False,
    release_evidence: bool = True,
) -> dict[str, object]:
    runtime: dict[str, object] = {
        **EXPECTED_NATIVE_RUNTIME[harness],
        "publishable_native": True,
        "path_label": f"{harness}-native-loop",
    }
    if harness == "eliza":
        api = native_runtime_api or "messageService.handleMessage"
        runtime.update(
            {
                "native_runtime_api": api,
                "tool_bridge": tool_bridge
                or next(iter(ELIZA_NATIVE_RUNTIME_ROUTES[api])),
                "direct_model_bypass": False,
                "stand_in": stand_in,
                "release_evidence": release_evidence,
            }
        )
    elif harness == "openclaw":
        runtime.update(
            {
                "native_session_evidence": "succeeded",
                "native_session_sha256": "a" * 64,
                "native_session_terminal_stop_reason": "stop",
                "native_session_assistant_model_call_count": 2,
                "native_trajectory_evidence": "succeeded",
                "native_trajectory_sha256": "b" * 64,
                "native_usage_scope": "full_native_turn_aggregate",
                "native_usage_sha256": "c" * 64,
                "native_runtime_identity_attested": True,
                "thinking_level_attested": True,
                "benchmark_workspace_path": "/repo",
                "benchmark_workspace_git_sha": "d" * 40,
                "runtime_workspace_isolated": True,
            }
        )
    elif harness == "hermes":
        runtime.update(
            {
                "benchmark_workspace_path": "/repo",
                "native_process_cwd": "/repo",
                "native_api_calls": 2,
            }
        )
    return runtime


def _telemetry_record(
    harness: str,
    runtime: dict[str, object],
    *,
    task_id: str = "scenario-1",
    benchmark_id: str = "test-benchmark",
) -> dict[str, object]:
    runtime_record = dict(runtime)
    record: dict[str, object] = {
        "harness": harness,
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
        "benchmark": benchmark_id,
        "task_id": task_id,
        "runtime_provenance": runtime_record,
    }
    if harness == "eliza" and benchmark_id == "orchestrator_lifecycle":
        runtime_record.setdefault(
            "lifecycle_system_hint_attestation",
            {
                "schema_version": 1,
                "system_hint_sha256": ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
                "model_boundary_call_count": 3,
                "model_boundary_attested_call_count": 3,
                "model_boundary_hint_occurrence_count": 3,
                "exact_once_per_model_call": True,
                "model_type_call_counts": {
                    "ACTION_PLANNER": 1,
                    "RESPONSE_HANDLER": 2,
                },
            },
        )
        record["usage"] = {"callCount": 3}
    elif benchmark_id == "orchestrator_lifecycle":
        record["params"] = {"tool_calls": [], "lifecycle_results": []}
    return record


def _lifecycle_telemetry_records(
    harness: str,
    runtime: dict[str, object],
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    task_ids = [
        task_id
        for index in range(132)
        for task_id in [f"scenario-{index}"] * (2 if index < 22 else 1)
    ]
    for index, task_id in enumerate(task_ids):
        turn_runtime = dict(runtime)
        if harness == "openclaw":
            turn_runtime["native_session_sha256"] = hashlib.sha256(
                f"native-session-{index}".encode()
            ).hexdigest()
            turn_runtime["native_trajectory_sha256"] = hashlib.sha256(
                f"native-trajectory-{index}".encode()
            ).hexdigest()
        records.append(
            _telemetry_record(
                harness,
                turn_runtime,
                task_id=task_id,
                benchmark_id="orchestrator_lifecycle",
            )
        )
    return records


def _quarantine_reason(
    harness: str,
    summary: dict[str, object],
    *,
    benchmark_id: str = "test-benchmark",
) -> str | None:
    return native_runtime_quarantine_reason(
        agent=harness,
        provider="claude-subscription",
        model="anthropic/claude-opus-4-6",
        provenance=summary,
        benchmark_id=benchmark_id,
    )


@pytest.mark.parametrize("harness", sorted(EXPECTED_NATIVE_RUNTIME))
def test_subscription_native_provenance_accepts_each_agent_runtime(
    tmp_path: Path,
    harness: str,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(harness)
    telemetry.write_text(
        "\n".join(json.dumps(_telemetry_record(harness, runtime)) for _ in range(2))
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["telemetry_records"] == 2
    assert summary["provenance_records"] == 2
    assert summary["task_id_records"] == 2
    assert summary["task_id_manifest_count"] == 1
    assert _quarantine_reason(harness, summary) is None


def test_runtime_summary_hashes_the_exact_unique_task_manifest(tmp_path: Path) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("openclaw")
    telemetry.write_text(
        "\n".join(
            json.dumps(_telemetry_record("openclaw", runtime, task_id=task_id))
            for task_id in ("scenario-b", "scenario-a", "scenario-b")
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["task_id_records"] == 3
    assert summary["missing_task_id_records"] == 0
    assert summary["task_id_manifest_count"] == 2
    assert summary["task_id_manifest_sha256"] == (
        "1a407f299d9822ef1981849041a74b207c8b5d091dde725587f4b0963fab4e40"
    )


@pytest.mark.parametrize(
    ("mutation", "terminal_reasons"),
    [
        ({"native_session_evidence": "missing"}, ["stop"]),
        ({"native_session_sha256": "not-a-hash"}, ["stop"]),
        ({"native_session_terminal_stop_reason": None}, []),
        ({"native_session_terminal_stop_reason": "error"}, ["error"]),
        ({"native_session_terminal_stop_reason": "aborted"}, ["aborted"]),
    ],
)
def test_openclaw_requires_attested_native_session_terminal_state(
    tmp_path: Path,
    mutation: dict[str, object],
    terminal_reasons: list[str],
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("openclaw")
    runtime.update(mutation)
    telemetry.write_text(
        json.dumps(_telemetry_record("openclaw", runtime)) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["openclaw_native_session_terminal_reasons"] == terminal_reasons
    assert (
        _quarantine_reason("openclaw", summary)
        == "subscription_native_session_evidence_mismatch"
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("native_trajectory_evidence", "missing"),
        ("native_trajectory_sha256", "not-a-hash"),
        ("native_usage_scope", "last_model_call"),
        ("native_session_assistant_model_call_count", 0),
        ("native_usage_sha256", "not-a-hash"),
        ("native_runtime_identity_attested", False),
        ("thinking_level_attested", False),
    ],
)
def test_openclaw_requires_trajectory_full_usage_identity_and_thinking(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("openclaw")
    runtime[field] = value
    telemetry.write_text(
        json.dumps(_telemetry_record("openclaw", runtime)) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert (
        _quarantine_reason("openclaw", summary)
        == "subscription_native_session_evidence_mismatch"
    )


@pytest.mark.parametrize("terminal_reason", ["stop", "length", "toolUse"])
def test_openclaw_accepts_typed_non_error_native_session_terminal_states(
    tmp_path: Path,
    terminal_reason: str,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("openclaw")
    runtime["native_session_terminal_stop_reason"] = terminal_reason
    telemetry.write_text(
        json.dumps(_telemetry_record("openclaw", runtime)) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert _quarantine_reason("openclaw", summary) is None


def test_runtime_summary_counts_untagged_model_calls(tmp_path: Path) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("hermes")
    record = _telemetry_record("hermes", runtime)
    record.pop("task_id")
    telemetry.write_text(json.dumps(record) + "\n", encoding="utf-8")

    summary = summarize_runtime_provenance(telemetry)

    assert summary["task_id_records"] == 0
    assert summary["missing_task_id_records"] == 1
    assert summary["task_id_manifest_count"] == 0
    assert summary["task_id_manifest_sha256"] is None


@pytest.mark.parametrize(
    ("native_runtime_api", "tool_bridge"),
    [
        ("messageService.handleMessage", "native_action_capture"),
        ("useModel", "runtime_model_native_tools"),
        ("useModel", "runtime_model_text"),
    ],
)
def test_eliza_accepts_only_truthful_native_routes(
    tmp_path: Path,
    native_runtime_api: str,
    tool_bridge: str,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        "eliza",
        native_runtime_api=native_runtime_api,
        tool_bridge=tool_bridge,
    )
    telemetry.write_text(
        json.dumps(_telemetry_record("eliza", runtime)) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["native_runtime_apis"] == [native_runtime_api]
    assert summary["invalid_native_route_records"] == 0
    assert _quarantine_reason("eliza", summary) is None


def test_eliza_accepts_mixed_message_service_and_model_routes(tmp_path: Path) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtimes = [
        _native_runtime_record(
            "eliza",
            native_runtime_api="messageService.handleMessage",
            tool_bridge="native_action_capture",
        ),
        _native_runtime_record(
            "eliza",
            native_runtime_api="useModel",
            tool_bridge="runtime_model_native_tools",
        ),
    ]
    telemetry.write_text(
        "\n".join(
            json.dumps(_telemetry_record("eliza", runtime)) for runtime in runtimes
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["native_runtime_apis"] == [
        "messageService.handleMessage",
        "useModel",
    ]
    assert _quarantine_reason("eliza", summary) is None


@pytest.mark.parametrize(
    ("mutation", "usage_call_count"),
    [
        ({"system_hint_sha256": "0" * 64}, 3),
        ({"model_boundary_call_count": 2}, 3),
        ({"model_boundary_attested_call_count": 2}, 3),
        ({"model_boundary_hint_occurrence_count": 2}, 3),
        ({"exact_once_per_model_call": False}, 3),
        ({"model_type_call_counts": {"ACTION_PLANNER": 1}}, 3),
        ({"system_hint": "raw prompt material is forbidden"}, 3),
        ({}, 2),
    ],
)
def test_eliza_lifecycle_rejects_model_boundary_hint_attestation_drift(
    tmp_path: Path,
    mutation: dict[str, object],
    usage_call_count: int,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        "eliza",
        native_runtime_api="messageService.handleMessage",
        tool_bridge="lifecycle_capture_only",
    )
    record = _telemetry_record(
        "eliza",
        runtime,
        task_id="canary-task",
        benchmark_id="orchestrator_lifecycle",
    )
    runtime_provenance = record["runtime_provenance"]
    assert isinstance(runtime_provenance, dict)
    attestation = runtime_provenance["lifecycle_system_hint_attestation"]
    assert isinstance(attestation, dict)
    attestation.update(mutation)
    record["usage"] = {"callCount": usage_call_count}
    telemetry.write_text(json.dumps(record) + "\n", encoding="utf-8")

    summary = summarize_runtime_provenance(telemetry)

    assert (
        native_runtime_quarantine_reason(
            agent="eliza",
            provider="claude-subscription",
            model="anthropic/claude-opus-4-6",
            provenance=summary,
            benchmark_id="orchestrator_lifecycle",
            expected_lifecycle_turn_count=1,
            expected_lifecycle_scenario_count=1,
        )
        == "subscription_lifecycle_system_hint_attestation_mismatch"
    )


def test_eliza_lifecycle_rejects_missing_model_boundary_hint_attestation(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    record = _telemetry_record(
        "eliza",
        _native_runtime_record(
            "eliza",
            native_runtime_api="messageService.handleMessage",
            tool_bridge="lifecycle_capture_only",
        ),
        task_id="canary-task",
        benchmark_id="orchestrator_lifecycle",
    )
    runtime_provenance = record["runtime_provenance"]
    assert isinstance(runtime_provenance, dict)
    runtime_provenance.pop("lifecycle_system_hint_attestation")
    telemetry.write_text(json.dumps(record) + "\n", encoding="utf-8")

    summary = summarize_runtime_provenance(telemetry)

    assert (
        native_runtime_quarantine_reason(
            agent="eliza",
            provider="claude-subscription",
            model="anthropic/claude-opus-4-6",
            provenance=summary,
            benchmark_id="orchestrator_lifecycle",
            expected_lifecycle_turn_count=1,
            expected_lifecycle_scenario_count=1,
        )
        == "subscription_lifecycle_system_hint_attestation_mismatch"
    )

def test_eliza_accepts_lifecycle_capture_only_for_lifecycle_benchmark(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        "eliza",
        native_runtime_api="messageService.handleMessage",
        tool_bridge="lifecycle_capture_only",
    )
    telemetry.write_text(
        "\n".join(
            json.dumps(record)
            for record in _lifecycle_telemetry_records("eliza", runtime)
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["invalid_native_route_records"] == 0
    assert summary["eliza_lifecycle_system_hint_attestation_records"] == 154
    assert summary["eliza_lifecycle_system_hint_attestation_all_valid"] is True
    assert summary["eliza_lifecycle_system_hint_sha256s"] == [
        ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256
    ]
    assert (
        summary["eliza_lifecycle_system_hint_model_boundary_call_count_total"]
        == 462
    )
    assert (
        summary[
            "eliza_lifecycle_system_hint_model_boundary_attested_call_count_total"
        ]
        == 462
    )
    assert summary["eliza_lifecycle_system_hint_occurrence_count_total"] == 462
    assert summary["eliza_lifecycle_system_hint_model_type_call_counts"] == {
        "ACTION_PLANNER": 154,
        "RESPONSE_HANDLER": 308,
    }
    assert (
        _quarantine_reason(
            "eliza",
            summary,
            benchmark_id="orchestrator_lifecycle",
        )
        is None
    )


@pytest.mark.parametrize("harness", ("hermes", "openclaw"))
def test_external_lifecycle_runtime_requires_complete_workload_provenance(
    tmp_path: Path,
    harness: str,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(harness)
    records = _lifecycle_telemetry_records(harness, runtime)
    telemetry.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )
    complete = summarize_runtime_provenance(telemetry)
    assert (
        _quarantine_reason(
            harness,
            complete,
            benchmark_id="orchestrator_lifecycle",
        )
        is None
    )

    telemetry.write_text(
        "\n".join(json.dumps(record) for record in records[:-1]) + "\n",
        encoding="utf-8",
    )
    incomplete = summarize_runtime_provenance(telemetry)
    assert (
        _quarantine_reason(
            harness,
            incomplete,
            benchmark_id="orchestrator_lifecycle",
        )
        == "subscription_lifecycle_workload_provenance_mismatch"
    )


@pytest.mark.parametrize("harness", ("eliza", "hermes", "openclaw"))
def test_lifecycle_canary_can_require_one_exact_native_turn(
    tmp_path: Path,
    harness: str,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        harness,
        native_runtime_api=(
            "messageService.handleMessage" if harness == "eliza" else None
        ),
        tool_bridge="lifecycle_capture_only" if harness == "eliza" else None,
    )
    telemetry.write_text(
        json.dumps(
            _telemetry_record(
                harness,
                runtime,
                task_id="canary-task",
                benchmark_id="orchestrator_lifecycle",
            )
        )
        + "\n",
        encoding="utf-8",
    )
    summary = summarize_runtime_provenance(telemetry)

    assert (
        native_runtime_quarantine_reason(
            agent=harness,
            provider="claude-subscription",
            model="anthropic/claude-opus-4-6",
            provenance=summary,
            benchmark_id="orchestrator_lifecycle",
            expected_lifecycle_turn_count=1,
            expected_lifecycle_scenario_count=1,
        )
        is None
    )
    assert (
        _quarantine_reason(
            harness,
            summary,
            benchmark_id="orchestrator_lifecycle",
        )
        == "subscription_lifecycle_workload_provenance_mismatch"
    )


def test_openclaw_lifecycle_requires_complete_stop_terminal_state(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("openclaw")
    runtime["native_session_terminal_stop_reason"] = "length"
    telemetry.write_text(
        "\n".join(
            json.dumps(record)
            for record in _lifecycle_telemetry_records("openclaw", runtime)
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert (
        _quarantine_reason(
            "openclaw",
            summary,
            benchmark_id="orchestrator_lifecycle",
        )
        == "subscription_native_session_evidence_mismatch"
    )


def test_openclaw_lifecycle_rejects_one_missing_terminal_reason(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    records = _lifecycle_telemetry_records(
        "openclaw", _native_runtime_record("openclaw")
    )
    final_runtime = records[-1]["runtime_provenance"]
    assert isinstance(final_runtime, dict)
    final_runtime.pop("native_session_terminal_stop_reason")
    telemetry.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["openclaw_native_session_terminal_reasons"] == ["stop"]
    assert summary["openclaw_native_session_terminal_reason_records"] == 153
    assert (
        _quarantine_reason(
            "openclaw",
            summary,
            benchmark_id="orchestrator_lifecycle",
        )
        == "subscription_native_session_evidence_mismatch"
    )


def test_openclaw_lifecycle_requires_unique_trajectory_per_turn(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    records = _lifecycle_telemetry_records(
        "openclaw", _native_runtime_record("openclaw")
    )
    first_runtime = records[0]["runtime_provenance"]
    second_runtime = records[1]["runtime_provenance"]
    assert isinstance(first_runtime, dict)
    assert isinstance(second_runtime, dict)
    second_runtime["native_trajectory_sha256"] = first_runtime[
        "native_trajectory_sha256"
    ]
    telemetry.write_text(
        "\n".join(json.dumps(record) for record in records) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert (
        _quarantine_reason("openclaw", summary, benchmark_id="orchestrator_lifecycle")
        == "subscription_native_session_evidence_mismatch"
    )


@pytest.mark.parametrize(
    ("harness", "field", "value"),
    [
        ("hermes", "native_process_cwd", "/different-repo"),
        ("openclaw", "benchmark_workspace_git_sha", "not-a-git-sha"),
        ("openclaw", "runtime_workspace_isolated", False),
    ],
)
def test_external_lifecycle_rejects_workspace_provenance_drift(
    tmp_path: Path,
    harness: str,
    field: str,
    value: object,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(harness)
    runtime[field] = value
    telemetry.write_text(
        "\n".join(
            json.dumps(record)
            for record in _lifecycle_telemetry_records(harness, runtime)
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert (
        _quarantine_reason(harness, summary, benchmark_id="orchestrator_lifecycle")
        == "subscription_lifecycle_workspace_provenance_mismatch"
    )


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("task_id_records", 153),
        ("missing_task_id_records", 1),
        ("task_id_manifest_count", 131),
        ("benchmark_ids", ["another_benchmark"]),
    ),
)
def test_lifecycle_runtime_rejects_inconsistent_turn_and_task_manifests(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("openclaw")
    telemetry.write_text(
        "\n".join(
            json.dumps(record)
            for record in _lifecycle_telemetry_records("openclaw", runtime)
        )
        + "\n",
        encoding="utf-8",
    )
    summary = summarize_runtime_provenance(telemetry)
    summary[field] = value

    assert (
        _quarantine_reason(
            "openclaw",
            summary,
            benchmark_id="orchestrator_lifecycle",
        )
        == "subscription_lifecycle_workload_provenance_mismatch"
    )


def test_eliza_rejects_lifecycle_capture_on_non_lifecycle_telemetry(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        "eliza",
        native_runtime_api="messageService.handleMessage",
        tool_bridge="lifecycle_capture_only",
    )
    telemetry.write_text(
        json.dumps(_telemetry_record("eliza", runtime, benchmark_id="bfcl")) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["invalid_native_route_records"] == 1
    assert (
        _quarantine_reason("eliza", summary, benchmark_id="bfcl")
        == "subscription_native_runtime_route_mismatch"
    )


def test_eliza_rejects_lifecycle_telemetry_attached_to_another_benchmark(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        "eliza",
        native_runtime_api="messageService.handleMessage",
        tool_bridge="lifecycle_capture_only",
    )
    telemetry.write_text(
        json.dumps(
            _telemetry_record(
                "eliza",
                runtime,
                benchmark_id="orchestrator_lifecycle",
            )
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["invalid_native_route_records"] == 0
    assert (
        _quarantine_reason("eliza", summary, benchmark_id="bfcl")
        == "subscription_native_runtime_route_mismatch"
    )


def test_eliza_lifecycle_benchmark_requires_lifecycle_capture_bridge(
    tmp_path: Path,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        "eliza",
        native_runtime_api="messageService.handleMessage",
        tool_bridge="native_action_capture",
    )
    telemetry.write_text(
        json.dumps(
            _telemetry_record(
                "eliza",
                runtime,
                benchmark_id="orchestrator_lifecycle",
            )
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert summary["invalid_native_route_records"] == 0
    assert (
        _quarantine_reason(
            "eliza",
            summary,
            benchmark_id="orchestrator_lifecycle",
        )
        == "subscription_native_runtime_route_mismatch"
    )


def test_eliza_rejects_obsolete_message_received_handler(tmp_path: Path) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("eliza")
    runtime["native_runtime_api"] = "messageReceivedHandler"
    telemetry.write_text(
        json.dumps(_telemetry_record("eliza", runtime)) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert (
        _quarantine_reason("eliza", summary)
        == "subscription_native_runtime_api_mismatch"
    )


def test_eliza_rejects_mismatched_native_api_and_tool_bridge(tmp_path: Path) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        "eliza",
        native_runtime_api="messageService.handleMessage",
        tool_bridge="runtime_model_native_tools",
    )
    telemetry.write_text(
        json.dumps(_telemetry_record("eliza", runtime)) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert (
        _quarantine_reason("eliza", summary)
        == "subscription_native_runtime_route_mismatch"
    )


@pytest.mark.parametrize("direct_model_bypass", [True, None])
def test_eliza_requires_explicitly_false_direct_model_bypass(
    tmp_path: Path,
    direct_model_bypass: bool | None,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record("eliza")
    runtime["direct_model_bypass"] = direct_model_bypass
    telemetry.write_text(
        json.dumps(_telemetry_record("eliza", runtime)) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert _quarantine_reason("eliza", summary) == "subscription_direct_model_bypass"


@pytest.mark.parametrize(
    ("stand_in", "release_evidence", "expected_reason"),
    [
        (True, True, "subscription_runtime_stand_in"),
        (False, False, "subscription_runtime_not_release_evidence"),
    ],
)
def test_eliza_rejects_non_release_runtime_components(
    tmp_path: Path,
    stand_in: bool,
    release_evidence: bool,
    expected_reason: str,
) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    runtime = _native_runtime_record(
        "eliza",
        stand_in=stand_in,
        release_evidence=release_evidence,
    )
    telemetry.write_text(
        json.dumps(_telemetry_record("eliza", runtime)) + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert _quarantine_reason("eliza", summary) == expected_reason


def test_subscription_provenance_rejects_direct_openclaw_bypass(tmp_path: Path) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    telemetry.write_text(
        json.dumps(
            {
                "harness": "openclaw",
                "provider": "claude-subscription",
                "model": "claude-opus-4-6",
                "params": {
                    "_meta": {
                        "openclaw_adapter": {
                            "transport": "direct_openai_compatible",
                            "publishable_native": False,
                        }
                    }
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert (
        native_runtime_quarantine_reason(
            agent="openclaw",
            provider="claude-subscription",
            model="claude-opus-4-6",
            provenance=summary,
        )
        == "subscription_non_native_transport"
    )


def test_subscription_provenance_rejects_missing_turn_proof(tmp_path: Path) -> None:
    telemetry = tmp_path / "telemetry.jsonl"
    telemetry.write_text(
        json.dumps(
            {
                "harness": "eliza",
                "provider": "claude-subscription",
                "model": "claude-opus-4-6",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    summary = summarize_runtime_provenance(telemetry)

    assert (
        native_runtime_quarantine_reason(
            agent="eliza",
            provider="claude-subscription",
            model="claude-opus-4-6",
            provenance=summary,
        )
        == "subscription_incomplete_runtime_provenance"
    )
