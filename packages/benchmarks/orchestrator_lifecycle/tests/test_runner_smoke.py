"""Runner smoke + bridge-dispatch tests.

Simulate mode must stay runnable with no keys/server, but its report must be
explicitly smoke-marked (`scored: false`, `metrics.overall_score: null`) so
the suite registry refuses to publish it as a benchmark result. Bridge
dispatch must return the full per-turn record (reply text + planner actions +
extracted lifecycle events), never just prose.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import benchmarks.orchestrator_lifecycle.runner as runner_module
from benchmarks.orchestrator_lifecycle.runner import (
    _LIFECYCLE_SYSTEM_HINT,
    LifecycleRunner,
    _LIFECYCLE_TASKS_TOOLS,
    _ensure_eliza_adapter_on_path,
    _simulate_turn,
)
from benchmarks.orchestrator_lifecycle.types import (
    LifecycleConfig,
    Scenario,
    ScenarioTurn,
    TurnRecord,
)
from benchmarks.registry.scores import _score_from_orchestrator_lifecycle_json

_ensure_eliza_adapter_on_path()
from eliza_adapter.client import MessageResponse  # noqa: E402


def test_runner_smoke_simulate_report_is_unscored(tmp_path: Path) -> None:
    config = LifecycleConfig(
        output_dir=str(tmp_path),
        scenario_dir="benchmarks/orchestrator_lifecycle/scenarios",
        max_scenarios=2,
        strict=False,
        mode="simulate",
    )
    runner = LifecycleRunner(config)
    results, metrics, report_path = runner.run()
    assert len(results) == 2
    assert metrics.total_scenarios == 2
    report = json.loads(Path(report_path).read_text())
    assert report["mode"] == "simulate"
    assert report["scored"] is False
    assert report["metadata"]["mode"] == "simulate"
    assert report["metadata"]["scored"] is False
    # The published score field is withheld so the registry cannot extract
    # a benchmark score from a smoke run.
    assert report["metrics"]["overall_score"] is None
    with pytest.raises(ValueError, match="scored bridge"):
        _score_from_orchestrator_lifecycle_json(report)


def test_partial_bridge_report_is_not_publishable(tmp_path: Path) -> None:
    from benchmarks.orchestrator_lifecycle.evaluator import LifecycleEvaluator
    from benchmarks.orchestrator_lifecycle.reporting import save_report
    from benchmarks.orchestrator_lifecycle.types import Scenario

    evaluator = LifecycleEvaluator()
    scenario = Scenario(
        scenario_id="cancel_task",
        title="cancel",
        category="test",
        turns=[
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task"],
            )
        ],
    )
    result = evaluator.evaluate_scenario(
        scenario, [TurnRecord(reply_text="Shut down.", events=["cancel"])]
    )
    metrics = evaluator.compute_metrics([result])
    report_path = save_report(
        config=LifecycleConfig(output_dir=str(tmp_path)),
        results=[result],
        metrics=metrics,
        transcripts={},
        mode="bridge",
    )
    report = json.loads(Path(report_path).read_text())
    assert report["scored"] is True
    assert report["scenarios"][0]["category"] == "test"
    with pytest.raises(ValueError, match="exactly 132 scenarios"):
        _score_from_orchestrator_lifecycle_json(report)


def test_no_strict_bridge_report_is_intrinsically_unscored(tmp_path: Path) -> None:
    from benchmarks.orchestrator_lifecycle.reporting import save_report
    from benchmarks.orchestrator_lifecycle.types import LifecycleMetrics

    report_path = save_report(
        config=LifecycleConfig(output_dir=str(tmp_path), strict=False),
        results=[],
        metrics=LifecycleMetrics(0.0, 0.0, 0, 0, 0.0, 0.0, 0.0, 0.0),
        transcripts={},
        mode="bridge",
    )
    report = json.loads(Path(report_path).read_text())
    assert report["mode"] == "bridge"
    assert report["scored"] is False
    assert report["metadata"]["strict"] is False
    assert report["metadata"]["scored"] is False
    assert report["metrics"]["overall_score"] is None
    with pytest.raises(ValueError, match="scored bridge"):
        _score_from_orchestrator_lifecycle_json(report)


def test_strict_runner_rejects_partial_selection_before_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runner_module,
        "_ensure_eliza_adapter_on_path",
        lambda: (_ for _ in ()).throw(AssertionError("runtime construction reached")),
    )

    with pytest.raises(RuntimeError, match="strict mode does not permit"):
        LifecycleRunner(LifecycleConfig(max_scenarios=1, strict=True, mode="bridge"))


def test_strict_runner_rejects_corpus_drift_before_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drifted = [
        Scenario(
            scenario_id="drifted",
            title="drifted",
            category="status",
            turns=[ScenarioTurn(actor="user", message="Status?")],
        )
    ]
    monkeypatch.setattr(
        runner_module.LifecycleDataset,
        "validate_scenarios",
        lambda _self: {"valid": True},
    )
    monkeypatch.setattr(
        runner_module.LifecycleDataset,
        "load",
        lambda _self: drifted,
    )
    monkeypatch.setattr(
        runner_module,
        "_ensure_eliza_adapter_on_path",
        lambda: (_ for _ in ()).throw(AssertionError("runtime construction reached")),
    )

    with pytest.raises(RuntimeError, match="132-scenario/154-turn corpus"):
        LifecycleRunner(LifecycleConfig(strict=True, mode="bridge"))


def test_strict_runner_rejects_tool_contract_drift_before_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner_module, "_LIFECYCLE_TASKS_TOOLS", ())
    monkeypatch.setattr(
        runner_module,
        "_ensure_eliza_adapter_on_path",
        lambda: (_ for _ in ()).throw(AssertionError("runtime construction reached")),
    )

    with pytest.raises(RuntimeError, match="single TASKS tool contract"):
        LifecycleRunner(LifecycleConfig(strict=True, mode="bridge"))


def test_strict_runner_rejects_simulate_before_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        runner_module,
        "_ensure_eliza_adapter_on_path",
        lambda: (_ for _ in ()).throw(AssertionError("runtime construction reached")),
    )

    with pytest.raises(RuntimeError, match="strict mode requires bridge mode"):
        LifecycleRunner(LifecycleConfig(strict=True, mode="simulate"))


def _turn(message: str) -> ScenarioTurn:
    return ScenarioTurn(actor="user", message=message)


def test_simulator_distinguishes_spawn_from_status_reporting() -> None:
    delegated_only = _simulate_turn(
        ScenarioTurn(
            actor="user",
            message="Implement the login timeout fix.",
            expected_behaviors=["spawn_subagent"],
        )
    )
    assert delegated_only.events == ["spawn"]

    delegated_with_status = _simulate_turn(
        ScenarioTurn(
            actor="user",
            message=(
                "In the current workspace, fix login sessions that remain active "
                "past the configured timeout."
            ),
            expected_behaviors=["spawn_subagent", "report_active_subagent_status"],
        )
    )
    assert delegated_with_status.events == ["spawn", "status_query"]


def _bridge_runner(client: object) -> LifecycleRunner:
    runner = LifecycleRunner.__new__(LifecycleRunner)
    runner.config = LifecycleConfig(mode="bridge")
    runner._mode = "bridge"
    runner._client = client
    runner._server_manager = None
    return runner


def _healthy_lifecycle_health() -> dict[str, object]:
    return {
        "lifecycle_profile_active": True,
        "lifecycle_task_action_registered": True,
        "lifecycle_task_actions": ["TASKS"],
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
        "lifecycle_force_tool_call_disabled": True,
        "lifecycle_benchmark_provider_mode": "shared_system_hint_only",
        "lifecycle_benchmark_provider_registered": True,
        "lifecycle_benchmark_provider_payload_neutral": True,
        "subscription_chat_only": True,
        "embeddingMode": "disabled-text-only",
        "semanticMemoryEnabled": False,
        "standIn": False,
        "releaseEvidence": True,
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


def test_lifecycle_system_hint_is_truthful_without_scoring_disclosure() -> None:
    import hashlib

    from benchmarks.publication_contracts import (
        ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256,
    )

    normalized = _LIFECYCLE_SYSTEM_HINT.lower()
    assert (
        hashlib.sha256(_LIFECYCLE_SYSTEM_HINT.encode("utf-8")).hexdigest()
        == ORCHESTRATOR_LIFECYCLE_SYSTEM_HINT_SHA256
    )
    assert "score" not in normalized
    assert "evaluator" not in normalized
    assert "synthetic" not in normalized
    assert (
        "report lifecycle outcomes according to the returned action result"
        in normalized
    )
    assert "do not claim success" in normalized
    assert "captured true and effect not_executed" in normalized
    assert "terminal for the current user turn" in normalized
    assert "do not retry it or substitute another tasks action solely" in normalized
    assert "execution was not performed" in normalized


def test_eliza_runtime_readiness_requires_scoped_native_tasks_catalog(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ELIZA_BENCH_HARNESS", raising=False)
    monkeypatch.delenv("BENCHMARK_HARNESS", raising=False)

    class HealthyClient:
        def health(self) -> dict[str, object]:
            return _healthy_lifecycle_health()

    runner = _bridge_runner(HealthyClient())
    runner._assert_lifecycle_runtime_ready()


@pytest.mark.parametrize(
    "health",
    [
        {},
        {
            "lifecycle_profile_active": False,
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
        },
        {
            "lifecycle_profile_active": True,
            "lifecycle_task_action_registered": False,
            "lifecycle_action_catalog": [],
            "lifecycle_action_count": 0,
            "lifecycle_task_contexts": [
                "general",
                "code",
                "automation",
                "agent_internal",
                "connectors",
            ],
            "lifecycle_tool_bridge": "lifecycle_capture_only",
            "lifecycle_task_unconditionally_planner_available": True,
        },
        {
            "lifecycle_profile_active": True,
            "lifecycle_task_action_registered": True,
            "lifecycle_action_catalog": ["TASKS", "UNRELATED"],
            "lifecycle_action_count": 2,
            "lifecycle_task_contexts": [
                "general",
                "code",
                "automation",
                "agent_internal",
                "connectors",
            ],
            "lifecycle_tool_bridge": "lifecycle_capture_only",
            "lifecycle_task_unconditionally_planner_available": True,
        },
        {
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
            "lifecycle_tool_bridge": "native_action_capture",
            "lifecycle_task_unconditionally_planner_available": True,
        },
    ],
)
def test_eliza_runtime_readiness_fails_closed_on_unfair_catalog(
    health: dict[str, object],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ELIZA_BENCH_HARNESS", raising=False)
    monkeypatch.delenv("BENCHMARK_HARNESS", raising=False)

    class UnreadyClient:
        def health(self) -> dict[str, object]:
            return health

    runner = _bridge_runner(UnreadyClient())
    with pytest.raises(RuntimeError, match="scoped native TASKS catalog"):
        runner._assert_lifecycle_runtime_ready()


@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("lifecycle_force_tool_call_disabled", False),
        ("lifecycle_benchmark_provider_mode", "full_benchmark_context"),
        ("lifecycle_benchmark_provider_registered", False),
        ("lifecycle_benchmark_provider_payload_neutral", False),
        ("subscription_chat_only", False),
        ("embeddingMode", "runtime-provider"),
        ("semanticMemoryEnabled", True),
        ("standIn", True),
        ("releaseEvidence", False),
        (
            "model_handlers",
            {"TEXT_LARGE": [{"provider": "anthropic", "priority": 0}]},
        ),
    ],
)
def test_eliza_runtime_readiness_fails_closed_on_provider_profile_drift(
    field: str,
    invalid_value: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ELIZA_BENCH_HARNESS", raising=False)
    monkeypatch.delenv("BENCHMARK_HARNESS", raising=False)
    health = _healthy_lifecycle_health()
    health[field] = invalid_value

    class UnreadyClient:
        def health(self) -> dict[str, object]:
            return health

    runner = _bridge_runner(UnreadyClient())
    with pytest.raises(RuntimeError, match="subscription-only model profile"):
        runner._assert_lifecycle_runtime_ready()


def test_bridge_reply_returns_record_with_extracted_events() -> None:
    class FakeClient:
        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            return MessageResponse(
                text="Done — the work is shut down.",
                thought=None,
                actions=["TASKS"],
                params={"action": "cancel"},
            )

    runner = _bridge_runner(FakeClient())
    record = runner._reply_via_bridge(
        turn=_turn("Cancel this task."),
        task_id="task-1",
        scenario_id="cancel_task",
    )
    assert isinstance(record, TurnRecord)
    assert record.reply_text == "Done — the work is shut down."
    assert record.actions == ["TASKS"]
    assert record.events == ["cancel"]


@pytest.mark.parametrize("harness", ["hermes", "openclaw"])
def test_external_lifecycle_bridge_receives_tasks_tool_and_prior_turns(
    harness: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from benchmarks.orchestrator_lifecycle.evaluator import LifecycleEvaluator

    monkeypatch.delenv("ELIZA_BENCH_HARNESS", raising=False)
    monkeypatch.setenv("BENCHMARK_HARNESS", harness)

    class FakeClient:
        def __init__(self) -> None:
            self.contexts: list[dict[str, object]] = []
            self.texts: list[str] = []

        def reset(self, *, task_id: str, benchmark: str) -> dict[str, object]:
            return {"task_id": task_id, "benchmark": benchmark}

        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            assert context is not None
            self.texts.append(text)
            self.contexts.append(context)
            workspace_provenance: dict[str, object]
            if harness == "hermes":
                workspace_provenance = {
                    "benchmark_workspace_path": str(runner_module._REPOSITORY_ROOT),
                    "native_process_cwd": str(runner_module._REPOSITORY_ROOT),
                }
            else:
                workspace_provenance = {
                    "openclaw_adapter": {
                        "benchmark_workspace_path": str(runner_module._REPOSITORY_ROOT),
                        "runtime_workspace_isolated": True,
                    }
                }
            if len(self.contexts) == 1:
                return MessageResponse(
                    text="The task is cancelled.",
                    thought=None,
                    actions=["TASKS"],
                    params={
                        "action": "cancel",
                        "_meta": workspace_provenance,
                    },
                )
            return MessageResponse(
                text="The task is running again.",
                thought=None,
                actions=["TASKS"],
                params={
                    "action": "control",
                    "controlAction": "resume",
                    "_meta": workspace_provenance,
                },
            )

    class TwoTurnDataset:
        def load(self) -> list[Scenario]:
            return [
                Scenario(
                    scenario_id="cancel_then_resume",
                    title="cancel then resume",
                    category="interrupt",
                    turns=[
                        ScenarioTurn(
                            actor="user",
                            message="Cancel this task.",
                            expected_behaviors=["cancel_task"],
                        ),
                        ScenarioTurn(
                            actor="user",
                            message="Undo cancel and continue.",
                            expected_behaviors=["resume_task"],
                        ),
                    ],
                )
            ]

    client = FakeClient()
    runner = _bridge_runner(client)
    runner.config = LifecycleConfig(
        output_dir=str(tmp_path), mode="bridge", strict=False
    )
    runner.dataset = TwoTurnDataset()
    runner.evaluator = LifecycleEvaluator()

    runner.run()

    assert len(client.contexts) == 2
    for context in client.contexts:
        assert context["tools"] == list(_LIFECYCLE_TASKS_TOOLS)
        assert context["tool_choice"] == "auto"
        assert context["reasoning_effort"] == "medium"
        assert context["benchmark_workspace_path"] == str(
            runner_module._REPOSITORY_ROOT
        )
        function = context["tools"][0]["function"]
        assert function["name"] == "TASKS"
        assert function["parameters"]["required"] == ["action"]
    assert client.contexts[0]["benchmark_messages"] == []
    assert client.contexts[1]["benchmark_messages"] == [
        {"role": "user", "content": "Cancel this task."},
        {"role": "assistant", "content": "The task is cancelled."},
    ]
    for text, context in zip(client.texts, client.contexts, strict=True):
        serialized = json.dumps({"text": text, "context": context})
        assert "cancel_then_resume" not in serialized
        assert "cancel_task" not in serialized
        assert "resume_task" not in serialized
        assert str(context["task_id"]).startswith("orchestrator-lifecycle-")
        assert (
            len(str(context["task_id"]).removeprefix("orchestrator-lifecycle-")) == 32
        )


def test_strict_subscription_ignores_ambient_eliza_server_and_restores_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import eliza_adapter.client as client_module
    import eliza_adapter.server_manager as manager_module

    monkeypatch.setattr(
        LifecycleRunner,
        "_validate_strict_configuration_before_runtime",
        lambda _self: [],
    )
    monkeypatch.delenv("ELIZA_BENCH_HARNESS", raising=False)
    monkeypatch.delenv("BENCHMARK_HARNESS", raising=False)
    monkeypatch.delenv("BENCHMARK_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("OPENAI_REASONING_EFFORT", raising=False)
    monkeypatch.delenv("OPENCLAW_THINKING_LEVEL", raising=False)
    monkeypatch.setenv("ELIZA_BENCH_URL", "http://ambient.example.invalid")
    monkeypatch.setenv("ELIZA_BENCH_TOKEN", "ambient-token")
    observed: dict[str, object] = {}

    class FakeClient:
        def health(self) -> dict[str, object]:
            return _healthy_lifecycle_health()

    class FakeManager:
        def __init__(self, *, repo_root: Path) -> None:
            observed["repo_root"] = repo_root
            observed["url"] = os.environ.get("ELIZA_BENCH_URL")
            observed["token"] = os.environ.get("ELIZA_BENCH_TOKEN")
            observed["workspace"] = os.environ.get(
                "ORCHESTRATOR_LIFECYCLE_WORKSPACE_PATH"
            )
            observed["reasoning"] = (
                os.environ.get("BENCHMARK_REASONING_EFFORT"),
                os.environ.get("OPENAI_REASONING_EFFORT"),
                os.environ.get("OPENCLAW_THINKING_LEVEL"),
            )
            observed["profile"] = (
                os.environ.get("ELIZA_BENCH_REQUIRE_ORCHESTRATOR"),
                os.environ.get("ELIZA_BENCH_LIFECYCLE_PROFILE"),
            )
            self.client = FakeClient()

        def start(self) -> None:
            observed["started"] = True

        def stop(self) -> None:
            pass

    class ForbiddenExistingClient:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            raise AssertionError("strict subscription reused an ambient server")

    monkeypatch.setattr(client_module, "ElizaClient", ForbiddenExistingClient)
    monkeypatch.setattr(manager_module, "ElizaServerManager", FakeManager)

    runner = LifecycleRunner(
        LifecycleConfig(
            strict=True,
            mode="bridge",
            provider="claude-subscription",
        )
    )
    runner.close()

    assert observed == {
        "repo_root": runner_module._REPOSITORY_ROOT,
        "url": None,
        "token": None,
        "workspace": str(runner_module._REPOSITORY_ROOT),
        "reasoning": ("medium", "medium", "medium"),
        "profile": ("1", "1"),
        "started": True,
    }
    assert os.environ["ELIZA_BENCH_URL"] == "http://ambient.example.invalid"
    assert os.environ["ELIZA_BENCH_TOKEN"] == "ambient-token"
    assert "ORCHESTRATOR_LIFECYCLE_WORKSPACE_PATH" not in os.environ
    assert "BENCHMARK_REASONING_EFFORT" not in os.environ
    assert "OPENAI_REASONING_EFFORT" not in os.environ
    assert "OPENCLAW_THINKING_LEVEL" not in os.environ


def test_non_subscription_lifecycle_may_reuse_explicit_eliza_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import eliza_adapter.client as client_module
    import eliza_adapter.server_manager as manager_module

    monkeypatch.setattr(
        LifecycleRunner,
        "_validate_strict_configuration_before_runtime",
        lambda _self: [],
    )
    monkeypatch.delenv("ELIZA_BENCH_HARNESS", raising=False)
    monkeypatch.delenv("BENCHMARK_HARNESS", raising=False)
    monkeypatch.setenv("ELIZA_BENCH_URL", "http://intentional.example.invalid")
    observed: dict[str, object] = {}

    class ExistingClient:
        def __init__(self, base_url: str) -> None:
            observed["base_url"] = base_url

        def wait_until_ready(self, *, timeout: float) -> None:
            observed["timeout"] = timeout

        def health(self) -> dict[str, object]:
            return _healthy_lifecycle_health()

    class ForbiddenManager:
        def __init__(self, **_kwargs: object) -> None:
            raise AssertionError("explicit non-subscription server was not reused")

    monkeypatch.setattr(client_module, "ElizaClient", ExistingClient)
    monkeypatch.setattr(manager_module, "ElizaServerManager", ForbiddenManager)

    LifecycleRunner(
        LifecycleConfig(strict=True, mode="bridge", provider="openai")
    ).close()

    assert observed == {
        "base_url": "http://intentional.example.invalid",
        "timeout": 120,
    }


def test_eliza_lifecycle_bridge_keeps_native_session_and_action_surface(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ELIZA_BENCH_HARNESS", raising=False)
    monkeypatch.delenv("BENCHMARK_HARNESS", raising=False)

    class FakeClient:
        context: dict[str, object] | None = None

        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            self.context = context
            return MessageResponse(
                text="I need the missing target.",
                thought=None,
                actions=["REPLY"],
                params={},
            )

    client = FakeClient()
    runner = _bridge_runner(client)
    runner._reply_via_bridge(
        turn=_turn("Handle that task."),
        task_id="task-1",
        scenario_id="clarify",
        benchmark_messages=[{"role": "user", "content": "This must not be replayed."}],
    )

    assert client.context is not None
    assert "tools" not in client.context
    assert "tool_choice" not in client.context
    assert "benchmark_messages" not in client.context
    assert "benchmark_workspace_path" not in client.context


def test_bridge_reply_prose_without_actions_yields_no_events() -> None:
    # An agent that only TALKS about cancelling gets no lifecycle event —
    # the runner must not synthesize events from prose.
    class FakeClient:
        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            return MessageResponse(
                text="Task cancelled and execution stopped. Cancel confirmed.",
                thought=None,
                actions=["REPLY"],
                params={},
            )

    runner = _bridge_runner(FakeClient())
    record = runner._reply_via_bridge(
        turn=_turn("Cancel this task."),
        task_id="task-1",
        scenario_id="cancel_task",
    )
    assert record.events == []


def test_bridge_reply_scores_empty_response_without_retrying() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[dict[str, object] | None] = []

        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            self.calls.append(context)
            return MessageResponse(text="", thought=None, actions=[], params={})

    client = FakeClient()
    runner = _bridge_runner(client)
    record = runner._reply_via_bridge(
        turn=_turn("Cancel this task."),
        task_id="task-1",
        scenario_id="cancel_then_undo_resume",
    )
    assert record.reply_text == ""
    assert record.events == []
    assert len(client.calls) == 1


def test_bridge_reply_does_not_classify_model_prose_as_retryable() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[dict[str, object] | None] = []

        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            self.calls.append(context)
            return MessageResponse(
                text="Oops, something went wrong on my end. Please try again.",
                thought=None,
                actions=[],
                params={},
            )

    client = FakeClient()
    runner = _bridge_runner(client)
    record = runner._reply_via_bridge(
        turn=_turn("Change scope: skip the UI and only ship API updates."),
        task_id="task-1",
        scenario_id="scope_change_midflight",
    )
    assert (
        record.reply_text == "Oops, something went wrong on my end. Please try again."
    )
    assert record.events == []
    assert len(client.calls) == 1


def test_bridge_transport_failure_is_not_scored_as_empty_reply() -> None:
    class FailingClient:
        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            raise TimeoutError("gateway timed out")

    runner = _bridge_runner(FailingClient())
    with pytest.raises(RuntimeError, match="bridge call failed.*cancel_task"):
        runner._reply_via_bridge(
            turn=_turn("Cancel this task."),
            task_id="task-1",
            scenario_id="cancel_task",
        )


def test_bridge_reset_failure_aborts_before_turn_dispatch(tmp_path: Path) -> None:
    class FakeClient:
        def reset(self, *, task_id: str, benchmark: str) -> dict[str, object]:
            raise RuntimeError("reset endpoint unavailable")

        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            raise AssertionError("run must abort before dispatching turns")

    class OneScenarioDataset:
        def load(self) -> list[Scenario]:
            return [
                Scenario(
                    scenario_id="reset_failure_case",
                    title="reset failure",
                    category="status",
                    turns=[
                        ScenarioTurn(
                            actor="user",
                            message="How is it going?",
                            expected_behaviors=["report_active_subagent_status"],
                        )
                    ],
                )
            ]

    runner = _bridge_runner(FakeClient())
    runner.config = LifecycleConfig(
        output_dir=str(tmp_path), mode="bridge", strict=False
    )
    runner.dataset = OneScenarioDataset()

    with pytest.raises(
        RuntimeError, match="reset failed for scenario reset_failure_case"
    ):
        runner.run()
