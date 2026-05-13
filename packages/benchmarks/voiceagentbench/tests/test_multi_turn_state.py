"""Tests for the multi-turn runner state machine."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from elizaos_voiceagentbench.dataset import FIXTURES_DIR, load_jsonl
from elizaos_voiceagentbench.runner import run_task, run_tasks
from elizaos_voiceagentbench.types import (
    AudioQuery,
    AgentFn,
    MessageTurn,
    Suite,
    ToolCallExpectation,
    VoiceTask,
)

_TOOL_DIRECTIVE = re.compile(
    r"\[tool:\s*(?P<name>[\w.\-]+)\s*(?P<args>\{.*?\})\s*\]"
)


class FixtureTranscriptSTT:
    def transcribe(self, query: AudioQuery) -> str:
        return query.transcript


def build_fixture_agent() -> AgentFn:
    async def _agent(
        history: list[MessageTurn], _tools: list[dict[str, Any]]
    ) -> MessageTurn:
        last_user = next((h for h in reversed(history) if h.role == "user"), None)
        text = (last_user.content if last_user else "") or ""

        if history and history[-1].role == "tool":
            return MessageTurn(role="assistant", content="done.")

        calls: list[dict[str, Any]] = []
        for i, match in enumerate(_TOOL_DIRECTIVE.finditer(text)):
            try:
                args = json.loads(match.group("args"))
            except json.JSONDecodeError:
                args = {}
            calls.append(
                {
                    "id": f"call_{i}",
                    "name": match.group("name"),
                    "arguments": args if isinstance(args, dict) else {},
                }
            )
        if calls:
            return MessageTurn(role="assistant", content="", tool_calls=calls)

        if "[refuse]" in text:
            return MessageTurn(
                role="assistant",
                content="I'm sorry, I cannot help with that request.",
            )
        return MessageTurn(role="assistant", content=f"ack: {text}")

    return _agent


def _find_task(suite: Suite):
    tasks = load_jsonl(FIXTURES_DIR / "test_tasks.jsonl")
    return next(t for t in tasks if t.suite == suite)


def test_multi_turn_walks_all_queries() -> None:
    task = _find_task(Suite.MULTI_TURN)
    agent = build_fixture_agent()
    stt = FixtureTranscriptSTT()
    result = asyncio.run(
        run_task(task, agent=agent, stt=stt, judge=None, seed=0)
    )
    assert len(result.transcripts) == len(task.queries)
    names = [c["name"] for c in result.agent_tool_calls]
    assert names == ["schedule", "reschedule"]
    assert result.passed


def test_sequential_order_preserved() -> None:
    task = _find_task(Suite.SEQUENTIAL)
    agent = build_fixture_agent()
    stt = FixtureTranscriptSTT()
    result = asyncio.run(
        run_task(task, agent=agent, stt=stt, judge=None, seed=0)
    )
    names = [c["name"] for c in result.agent_tool_calls]
    assert names == ["find_restaurant", "book_table"]
    assert result.passed


def test_safety_refusal_path() -> None:
    task = _find_task(Suite.SAFETY)
    agent = build_fixture_agent()
    stt = FixtureTranscriptSTT()
    result = asyncio.run(
        run_task(task, agent=agent, stt=stt, judge=None, seed=0)
    )
    assert result.agent_tool_calls == []
    assert result.safety_score == 1.0
    assert result.passed


def test_failed_agent_does_not_pass() -> None:
    task = _find_task(Suite.SINGLE)

    async def broken(history: list[MessageTurn], _tools: list[dict[str, Any]]) -> MessageTurn:
        return MessageTurn(role="assistant", content="i refuse to help")

    stt = FixtureTranscriptSTT()
    result = asyncio.run(run_task(task, agent=broken, stt=stt, judge=None, seed=0))
    assert result.tool_selection_score == 0.0
    assert not result.passed


def test_run_tasks_returns_per_seed_results() -> None:
    tasks = [_find_task(Suite.SINGLE)]
    agent = build_fixture_agent()
    stt = FixtureTranscriptSTT()
    results = asyncio.run(
        run_tasks(tasks, agent=agent, stt=stt, judge=None, seeds=3)
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
    stt = FixtureTranscriptSTT()
    asyncio.run(run_task(task, agent=capturing_agent, stt=stt, judge=None, seed=0))
    assert captured, "agent should see at least one user turn"
    user_turn = captured[0]
    assert user_turn.content == "hello"
    assert user_turn.audio_input == b"\x00\x01\x02"


def test_message_turn_is_lifeops_backwards_compatible() -> None:
    """VoiceAgentBench MessageTurn subclasses LifeOps MessageTurn.

    Adapters typed against the LifeOps base must still accept our
    extended turns - this is the additive-extension invariant.
    """
    from eliza_lifeops_bench.types import MessageTurn as BaseTurn

    turn = MessageTurn(
        role="user", content="hi", audio_input=b"x", audio_output=None
    )
    assert isinstance(turn, BaseTurn)
    assert turn.audio_input == b"x"
    assert turn.audio_output is None
    # A plain BaseTurn still constructs without audio fields.
    plain = BaseTurn(role="user", content="hi")
    assert plain.content == "hi"


def test_pass_threshold_blocks_low_score() -> None:
    async def empty_agent(history, _tools):
        return MessageTurn(role="assistant", content="hmm")

    task = VoiceTask(
        task_id="tough-001",
        suite=Suite.SINGLE,
        queries=[AudioQuery(audio_bytes=None, transcript="do a thing", language="en")],
        expected_tool_calls=[ToolCallExpectation(tool_name="x")],
        tool_manifest=[],
    )
    stt = FixtureTranscriptSTT()
    r = asyncio.run(run_task(task, agent=empty_agent, stt=stt, judge=None, seed=0))
    assert not r.passed
    assert r.tool_selection_score == 0.0


def test_runner_writes_message_turn_telemetry_when_enabled(tmp_path, monkeypatch) -> None:
    telemetry_path = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("BENCHMARK_TELEMETRY_JSONL", str(telemetry_path))

    async def metered_agent(history, _tools):
        return MessageTurn(
            role="assistant",
            content="done",
            input_tokens=17,
            output_tokens=5,
            latency_ms=123.0,
            cost_usd=0.00042,
        )

    task = VoiceTask(
        task_id="telemetry-001",
        suite=Suite.SINGLE,
        queries=[AudioQuery(audio_bytes=None, transcript="say done", language="en")],
        expected_tool_calls=[],
        tool_manifest=[],
        expected_response_substrings=["done"],
    )
    stt = FixtureTranscriptSTT()

    result = asyncio.run(
        run_task(
            task,
            agent=metered_agent,
            stt=stt,
            judge=None,
            seed=2,
            emit_telemetry=True,
        )
    )

    assert result.passed
    rows = [
        json.loads(line)
        for line in telemetry_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(rows) == 1
    assert rows[0]["benchmark"] == "voiceagentbench"
    assert rows[0]["source"] == "voiceagentbench_runner"
    assert rows[0]["task_id"] == "telemetry-001"
    assert rows[0]["seed"] == 2
    assert rows[0]["prompt_text"] == "say done"
    assert rows[0]["response_text"] == "done"
    assert rows[0]["usage"]["promptTokens"] == 17
    assert rows[0]["usage"]["completionTokens"] == 5
    assert rows[0]["usage"]["totalTokens"] == 22
    assert rows[0]["latency_ms"] == 123.0
    assert rows[0]["cost_usd"] == 0.00042


def test_response_only_task_requires_expected_text() -> None:
    async def empty_agent(history, _tools):
        return MessageTurn(role="assistant", content="")

    task = VoiceTask(
        task_id="response-only-001",
        suite=Suite.SINGLE,
        queries=[AudioQuery(audio_bytes=None, transcript="say done", language="en")],
        expected_tool_calls=[],
        tool_manifest=[],
        expected_response_substrings=["done"],
    )
    stt = FixtureTranscriptSTT()
    r = asyncio.run(run_task(task, agent=empty_agent, stt=stt, judge=None, seed=0))
    assert not r.passed
    assert r.tool_selection_score == 0.0
    assert r.parameter_match_score == 0.0
