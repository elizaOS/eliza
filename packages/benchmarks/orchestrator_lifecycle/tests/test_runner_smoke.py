"""Runner smoke + bridge-dispatch tests.

Simulate mode must stay runnable with no keys/server, but its report must be
explicitly smoke-marked (`scored: false`, `metrics.overall_score: null`) so
the suite registry refuses to publish it as a benchmark result. Bridge
dispatch must return the full per-turn record (reply text + planner actions +
extracted lifecycle events), never just prose.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benchmarks.orchestrator_lifecycle.runner import (
    LifecycleRunner,
    _ensure_eliza_adapter_on_path,
)
from benchmarks.orchestrator_lifecycle.types import (
    LifecycleConfig,
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
    with pytest.raises(ValueError, match="overall_score"):
        _score_from_orchestrator_lifecycle_json(report)


def test_bridge_report_is_scored(tmp_path: Path) -> None:
    # save_report is mode-driven; a bridge report keeps its real score and
    # the registry extractor accepts it.
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
    extraction = _score_from_orchestrator_lifecycle_json(report)
    assert extraction.score == 1.0


def _turn(message: str) -> ScenarioTurn:
    return ScenarioTurn(actor="user", message=message)


def _bridge_runner(client: object) -> LifecycleRunner:
    runner = LifecycleRunner.__new__(LifecycleRunner)
    runner.config = LifecycleConfig(mode="bridge")
    runner._mode = "bridge"
    runner._client = client
    runner._server_manager = None
    return runner


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


def test_bridge_reply_retries_empty_response() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[dict[str, object] | None] = []

        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            self.calls.append(context)
            if len(self.calls) == 1:
                return MessageResponse(text="", thought=None, actions=[], params={})
            return MessageResponse(
                text="Stopped the work.",
                thought=None,
                actions=["CANCEL_TASK"],
                params={},
            )

    client = FakeClient()
    runner = _bridge_runner(client)
    record = runner._reply_via_bridge(
        turn=_turn("Cancel this task."),
        task_id="task-1",
        scenario_id="cancel_then_undo_resume",
    )
    assert record.reply_text == "Stopped the work."
    assert record.events == ["cancel"]
    assert len(client.calls) == 2
    assert client.calls[1]["retry_empty_response"] is True


def test_bridge_reply_retries_generic_failure_response() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[dict[str, object] | None] = []

        def send_message(
            self, text: str, context: dict[str, object] | None = None
        ) -> MessageResponse:
            self.calls.append(context)
            if len(self.calls) == 1:
                return MessageResponse(
                    text="Oops, something went wrong on my end. Please try again.",
                    thought=None,
                    actions=[],
                    params={},
                )
            return MessageResponse(
                text="Folded the new scope into the running work.",
                thought=None,
                actions=["SEND_TO_AGENT"],
                params={},
            )

    client = FakeClient()
    runner = _bridge_runner(client)
    record = runner._reply_via_bridge(
        turn=_turn("Change scope: skip the UI and only ship API updates."),
        task_id="task-1",
        scenario_id="scope_change_midflight",
    )
    assert record.reply_text == "Folded the new scope into the running work."
    assert record.events == ["send"]
    assert len(client.calls) == 2
    assert client.calls[1]["retry_empty_response"] is True
