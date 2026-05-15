"""Tests for MINT harness adapters backed by async agent functions."""

from __future__ import annotations

import pytest

from benchmarks.mint.agent import AgentFnMINTAgent
from benchmarks.mint.types import MINTSubtask, MINTTask, TurnType


@pytest.mark.asyncio
async def test_agent_fn_agent_accepts_final_answer_text() -> None:
    calls: list[tuple[list[dict], list[dict]]] = []

    async def agent_fn(history: list[dict], tools: list[dict]) -> dict:
        calls.append((history, tools))
        return {"text": "Final answer: 42", "tool_calls": []}

    task = MINTTask(
        id="mint-final",
        subtask=MINTSubtask.MATH,
        initial_prompt="What is 40 + 2?",
        ground_truth="42",
        evaluation_metric="numeric",
        tools_allowed=[],
    )

    trajectory = await AgentFnMINTAgent(agent_fn).solve_task(
        task,
        enable_tools=False,
        enable_feedback=False,
    )

    assert trajectory.success is True
    assert trajectory.final_answer == "42"
    assert trajectory.per_turn_answers == ["42"]
    assert calls[0][1] == []


@pytest.mark.asyncio
async def test_agent_fn_agent_executes_python_tool_call_then_finishes() -> None:
    async def agent_fn(history: list[dict], tools: list[dict]) -> dict:
        assert tools and tools[0]["function"]["name"] == "python"
        if len([m for m in history if m["role"] == "assistant"]) == 0:
            return {
                "text": "",
                "tool_calls": [
                    {
                        "id": "call_python",
                        "type": "function",
                        "function": {
                            "name": "python",
                            "arguments": {"code": "print(6 * 7)"},
                        },
                    }
                ],
            }
        assert any(m["role"] == "tool" and "42" in m["content"] for m in history)
        return {"text": "Final answer: 42", "tool_calls": []}

    task = MINTTask(
        id="mint-tool",
        subtask=MINTSubtask.HUMANEVAL,
        initial_prompt="Use Python to compute 6 * 7.",
        ground_truth="42",
        evaluation_metric="numeric",
        max_turns=2,
        tools_allowed=["python"],
    )

    trajectory = await AgentFnMINTAgent(agent_fn).solve_task(
        task,
        enable_tools=True,
        enable_feedback=False,
    )

    assert trajectory.success is True
    assert trajectory.num_tool_uses == 1
    assert trajectory.per_turn_answers == [None, "42"]
    assert [turn.turn_type for turn in trajectory.turns] == [
        TurnType.ASSISTANT,
        TurnType.TOOL,
        TurnType.ASSISTANT,
    ]


@pytest.mark.asyncio
async def test_agent_fn_agent_synthesizes_tool_call_for_code_fence_history() -> None:
    calls: list[list[dict]] = []

    async def agent_fn(history: list[dict], tools: list[dict]) -> dict:
        calls.append(history)
        if len([m for m in history if m["role"] == "assistant"]) == 0:
            return {"text": "```python\nprint(40 + 2)\n```", "tool_calls": []}
        return {"text": "Final answer: 42", "tool_calls": []}

    task = MINTTask(
        id="mint-code-fence",
        subtask=MINTSubtask.HUMANEVAL,
        initial_prompt="Use Python to compute 40 + 2.",
        ground_truth="42",
        evaluation_metric="numeric",
        max_turns=2,
        tools_allowed=["python"],
    )

    trajectory = await AgentFnMINTAgent(agent_fn).solve_task(
        task,
        enable_tools=True,
        enable_feedback=False,
    )

    assert trajectory.success is True
    second_call_history = calls[1]
    assistant_messages = [
        m
        for m in second_call_history
        if m["role"] == "assistant" and m.get("tool_calls")
    ]
    tool_messages = [m for m in second_call_history if m["role"] == "tool"]
    assert assistant_messages[-1]["tool_calls"][0]["id"] == "call_python_text_0"
    assert tool_messages[-1]["tool_call_id"] == "call_python_text_0"
