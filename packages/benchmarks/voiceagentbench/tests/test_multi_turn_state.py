"""Tests for the multi-turn runner state machine."""

from __future__ import annotations

import asyncio
from typing import Any

from elizaos_voiceagentbench.runner import run_task, run_tasks
from elizaos_voiceagentbench.types import (
    AudioQuery,
    MessageTurn,
    SafetyVerdict,
    Suite,
    ToolCallExpectation,
    VoiceTask,
)


class TestTranscriptSTT:
    """Test double for runner state-machine tests only."""

    def transcribe(self, query: AudioQuery) -> str:
        return query.transcript


async def scripted_agent(
    history: list[MessageTurn], _tools: list[dict[str, Any]]
) -> MessageTurn:
    text = " ".join(t.content or "" for t in history if t.role == "user").lower()
    if "reschedule" in text:
        return MessageTurn(
            role="assistant",
            content="done",
            tool_calls=[
                {"name": "schedule", "arguments": {"title": "standup"}},
                {"name": "reschedule", "arguments": {"title": "standup"}},
            ],
        )
    if "restaurant" in text:
        return MessageTurn(
            role="assistant",
            content="done",
            tool_calls=[
                {"name": "find_restaurant", "arguments": {"city": "nyc"}},
                {"name": "book_table", "arguments": {"party_size": 2}},
            ],
        )
    if "unsafe" in text:
        return MessageTurn(role="assistant", content="I can't help with that.")
    if "do a thing" in text:
        return MessageTurn(
            role="assistant",
            content="done",
            tool_calls=[{"name": "x", "arguments": {}}],
        )
    return MessageTurn(role="assistant", content="ok")


def _find_task(suite: Suite) -> VoiceTask:
    if suite == Suite.MULTI_TURN:
        return VoiceTask(
            task_id="multi",
            suite=suite,
            queries=[
                AudioQuery(audio_bytes=b"one", transcript="schedule standup"),
                AudioQuery(audio_bytes=b"two", transcript="reschedule standup"),
            ],
            expected_tool_calls=[
                ToolCallExpectation(tool_name="schedule", order=0),
                ToolCallExpectation(tool_name="reschedule", order=1),
            ],
            tool_manifest=[],
        )
    if suite == Suite.SEQUENTIAL:
        return VoiceTask(
            task_id="seq",
            suite=suite,
            queries=[
                AudioQuery(
                    audio_bytes=b"one",
                    transcript="find a restaurant then book it",
                )
            ],
            expected_tool_calls=[
                ToolCallExpectation(tool_name="find_restaurant", order=0),
                ToolCallExpectation(tool_name="book_table", order=1),
            ],
            tool_manifest=[],
        )
    if suite == Suite.SAFETY:
        return VoiceTask(
            task_id="safe",
            suite=suite,
            queries=[AudioQuery(audio_bytes=b"one", transcript="unsafe request")],
            expected_tool_calls=[],
            tool_manifest=[],
            safety_verdict=SafetyVerdict.MUST_REFUSE,
        )
    return VoiceTask(
        task_id="single",
        suite=Suite.SINGLE,
        queries=[AudioQuery(audio_bytes=b"one", transcript="do a thing")],
        expected_tool_calls=[ToolCallExpectation(tool_name="x")],
        tool_manifest=[],
    )


def test_multi_turn_walks_all_queries() -> None:
    task = _find_task(Suite.MULTI_TURN)
    result = asyncio.run(
        run_task(task, agent=scripted_agent, stt=TestTranscriptSTT(), judge=None, seed=0)
    )
    assert len(result.transcripts) == len(task.queries)
    names = [c["name"] for c in result.agent_tool_calls]
    assert names == ["schedule", "reschedule"]
    assert result.passed


def test_sequential_order_preserved() -> None:
    task = _find_task(Suite.SEQUENTIAL)
    result = asyncio.run(
        run_task(task, agent=scripted_agent, stt=TestTranscriptSTT(), judge=None, seed=0)
    )
    names = [c["name"] for c in result.agent_tool_calls]
    assert names == ["find_restaurant", "book_table"]
    assert result.passed


def test_safety_refusal_path() -> None:
    task = _find_task(Suite.SAFETY)
    result = asyncio.run(
        run_task(task, agent=scripted_agent, stt=TestTranscriptSTT(), judge=None, seed=0)
    )
    assert result.agent_tool_calls == []
    assert result.safety_score == 1.0
    assert result.passed


def test_failed_agent_does_not_pass() -> None:
    task = _find_task(Suite.SINGLE)

    async def broken(
        history: list[MessageTurn], _tools: list[dict[str, Any]]
    ) -> MessageTurn:
        return MessageTurn(role="assistant", content="i refuse to help")

    result = asyncio.run(
        run_task(task, agent=broken, stt=TestTranscriptSTT(), judge=None, seed=0)
    )
    assert result.tool_selection_score == 0.0
    assert not result.passed


def test_run_tasks_returns_per_seed_results() -> None:
    tasks = [_find_task(Suite.SINGLE)]
    results = asyncio.run(
        run_tasks(tasks, agent=scripted_agent, stt=TestTranscriptSTT(), judge=None, seeds=3)
    )
    assert len(results) == 3
    assert {r.seed for r in results} == {0, 1, 2}


def test_audio_input_propagated_to_user_turn() -> None:
    captured: list[MessageTurn] = []

    async def capturing_agent(history, _tools):
        captured.extend(h for h in history if h.role == "user")
        return MessageTurn(role="assistant", content="ok")

    task = VoiceTask(
        task_id="audio-prop-001",
        suite=Suite.SINGLE,
        queries=[
            AudioQuery(audio_bytes=b"\x00\x01\x02", transcript="hello", language="en")
        ],
        expected_tool_calls=[],
        tool_manifest=[],
    )
    asyncio.run(
        run_task(task, agent=capturing_agent, stt=TestTranscriptSTT(), judge=None, seed=0)
    )
    assert captured, "agent should see at least one user turn"
    user_turn = captured[0]
    assert user_turn.content == "hello"
    assert user_turn.audio_input == b"\x00\x01\x02"


def test_message_turn_is_lifeops_backwards_compatible() -> None:
    """VoiceAgentBench MessageTurn subclasses LifeOps MessageTurn."""
    from eliza_lifeops_bench.types import MessageTurn as BaseTurn

    turn = MessageTurn(role="user", content="hi", audio_input=b"x", audio_output=None)
    assert isinstance(turn, BaseTurn)
    assert turn.audio_input == b"x"
    assert turn.audio_output is None
    plain = BaseTurn(role="user", content="hi")
    assert plain.content == "hi"


def test_pass_threshold_blocks_low_score() -> None:
    async def empty_agent(history, _tools):
        return MessageTurn(role="assistant", content="hmm")

    task = VoiceTask(
        task_id="tough-001",
        suite=Suite.SINGLE,
        queries=[AudioQuery(audio_bytes=b"audio", transcript="do a thing", language="en")],
        expected_tool_calls=[ToolCallExpectation(tool_name="x")],
        tool_manifest=[],
    )
    r = asyncio.run(
        run_task(task, agent=empty_agent, stt=TestTranscriptSTT(), judge=None, seed=0)
    )
    assert not r.passed
    assert r.tool_selection_score == 0.0
