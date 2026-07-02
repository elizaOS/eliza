from __future__ import annotations

from pathlib import Path

from benchmarks.orchestrator_lifecycle.runner import LifecycleRunner
from benchmarks.orchestrator_lifecycle.types import LifecycleConfig
from eliza_adapter.client import MessageResponse


def test_runner_smoke(tmp_path: Path) -> None:
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
    assert Path(report_path).exists()


def test_bridge_reply_retries_empty_response() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[dict[str, object] | None] = []

        def send_message(self, text: str, context: dict[str, object] | None = None) -> MessageResponse:
            self.calls.append(context)
            if len(self.calls) == 1:
                return MessageResponse(text="", thought=None, actions=[], params={})
            return MessageResponse(
                text="Task cancelled, execution stopped.",
                thought=None,
                actions=[],
                params={},
            )

    runner = LifecycleRunner.__new__(LifecycleRunner)
    runner.config = LifecycleConfig(mode="bridge")
    runner._client = FakeClient()

    reply = runner._reply_via_bridge(
        turn=type(
            "Turn",
            (),
            {
                "message": "Cancel this task.",
                "expected_behaviors": ["cancel_task"],
                "forbidden_behaviors": [],
            },
        )(),
        task_id="task-1",
        scenario_id="cancel_then_undo_resume",
    )

    assert reply == "Task cancelled, execution stopped."
    assert len(runner._client.calls) == 2
    assert runner._client.calls[1]["retry_empty_response"] is True


def test_bridge_reply_retries_generic_failure_response() -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[dict[str, object] | None] = []

        def send_message(self, text: str, context: dict[str, object] | None = None) -> MessageResponse:
            self.calls.append(context)
            if len(self.calls) == 1:
                return MessageResponse(
                    text="Oops, something went wrong on my end. Please try again.",
                    thought=None,
                    actions=[],
                    params={},
                )
            return MessageResponse(
                text="Scope change acknowledged and updated plan has been applied.",
                thought=None,
                actions=[],
                params={},
            )

    runner = LifecycleRunner.__new__(LifecycleRunner)
    runner.config = LifecycleConfig(mode="bridge")
    runner._client = FakeClient()

    reply = runner._reply_via_bridge(
        turn=type(
            "Turn",
            (),
            {
                "message": "Change scope: skip the UI and only ship API updates.",
                "expected_behaviors": [
                    "ack_scope_change",
                    "apply_scope_change_to_task",
                ],
                "forbidden_behaviors": [],
            },
        )(),
        task_id="task-1",
        scenario_id="scope_change_midflight",
    )

    assert reply == "Scope change acknowledged and updated plan has been applied."
    assert len(runner._client.calls) == 2
    assert runner._client.calls[1]["retry_empty_response"] is True
