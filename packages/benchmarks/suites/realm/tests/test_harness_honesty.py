"""Planning transport must not manufacture execution or usage measurements."""

import sys
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "harnesses" / "eliza"))
from benchmarks.realm.evaluator import MetricsCalculator
from benchmarks.realm.types import (
    PlanningTrajectory,
    RealmProblem,
    REALMResult,
    REALMTask,
)
from eliza_adapter.realm import ElizaREALMAgent, _measured_tokens


class Client:
    def __init__(self, actions, usages=None):
        self.actions = iter(actions)
        self.usages = iter(usages or [None] * len(actions))
        self.requests = []

    def wait_until_ready(self, **kwargs):
        pass

    def reset(self, **kwargs):
        pass

    def send_message(self, **kwargs):
        self.requests.append(kwargs)
        return NS(
            actions=[next(self.actions)],
            text="",
            thought="",
            params={"usage": next(self.usages)},
        )


def task():
    return REALMTask(
        id="no-executor",
        name="no-executor",
        description="No executor",
        goal="Perform work",
        problem=RealmProblem.P1,
        metadata={"available_tools": ["invented_tool"]},
    )


@pytest.mark.asyncio
async def test_no_execution_or_fallback_plan_is_fabricated():
    client = Client(["GENERATE_PLAN", "EXECUTE_STEP", "COMPLETE_TASK"])
    result = await ElizaREALMAgent(client=client, max_steps=3).solve_task(task())
    assert result.overall_success is False
    assert result.steps == []
    assert result.tokens_used is None
    assert result.solution == {}
    assert client.requests[1]["context"]["current_plan"] == []
    assert "No action was executed" in client.requests[2]["text"]


@pytest.mark.asyncio
async def test_only_complete_measured_usage_is_reported():
    client = Client(
        ["GENERATE_PLAN", "COMPLETE_TASK"],
        [{"prompt_tokens": 11, "completion_tokens": 3}, {"total_tokens": 7}],
    )
    result = await ElizaREALMAgent(client=client, max_steps=2).solve_task(task())
    assert result.tokens_used == 21


@pytest.mark.asyncio
async def test_partial_usage_stays_unknown():
    client = Client(["GENERATE_PLAN", "COMPLETE_TASK"], [{"total_tokens": 9}, None])
    result = await ElizaREALMAgent(client=client, max_steps=2).solve_task(task())
    assert result.tokens_used is None


@pytest.mark.parametrize(
    "usage",
    [None, {}, {"total_tokens": True}, {"total_tokens": -1}, {"prompt_tokens": 4}],
)
def test_missing_or_invalid_usage_is_unknown(usage):
    assert _measured_tokens(usage) is None


def test_aggregate_does_not_treat_missing_usage_as_zero():
    def result(tokens):
        return REALMResult(
            task_id="x",
            problem=RealmProblem.P1,
            trajectory=PlanningTrajectory(task_id="x"),
            success=False,
            steps_executed=0,
            actions_performed=[],
            token_usage=tokens,
        )

    metrics = MetricsCalculator().calculate([result(12), result(None)])
    assert metrics.total_tokens is None and metrics.avg_tokens_per_task is None
    metrics = MetricsCalculator().calculate([result(12), result(0)])
    assert metrics.total_tokens == 12 and metrics.avg_tokens_per_task == 6


@pytest.mark.asyncio
async def test_solution_is_preserved_for_independent_evaluation():
    solution = {"route": ["depot", "stop", "depot"]}

    class SolutionClient(Client):
        def send_message(self, **kwargs):
            response = super().send_message(**kwargs)
            response.params["solution"] = solution
            return response

    result = await ElizaREALMAgent(
        client=SolutionClient(["COMPLETE_TASK"]), max_steps=1
    ).solve_task(task())
    assert result.solution == solution
    assert result.steps == []
    assert result.overall_success is False
    assert "awaiting independent evaluation" in result.final_outcome
