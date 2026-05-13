"""Multi-turn runner for VoiceAgentBench.

For each task, the runner walks the user turns one at a time:

  1. Transcribe ``query.audio_bytes`` via the STT backend; populate the
     new user :class:`MessageTurn` with both ``content`` (transcript)
     and ``audio_input`` (raw bytes) so direct-audio adapters can opt
     into the bytes path.
  2. Drive the agent in a tool-call loop: assistant turn -> dispatch any
     tool calls via the stub executor -> append synthetic tool responses
     -> back to the assistant until it returns a text-only turn or the
     per-turn cap is hit.
  3. Move to the next user turn; repeat.

Tool execution is stubbed - the benchmark scores the *selection* and
*parameter extraction*, not the runtime semantics of the tool.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .evaluator import (
    CoherenceJudge,
    evaluate_task,
)
from .stt import STTBackend
from .types import (
    AgentFn,
    MessageTurn,
    VoiceTask,
    VoiceTaskResult,
)

logger = logging.getLogger(__name__)

MAX_TOOL_DISPATCHES_PER_USER_TURN = 8


def _extract_tool_calls(turn: MessageTurn) -> list[dict[str, Any]]:
    """Normalize ``MessageTurn.tool_calls`` to a flat list of call dicts."""
    calls = turn.tool_calls or []
    out: list[dict[str, Any]] = []
    for c in calls:
        if not isinstance(c, dict):
            continue
        if "function" in c and isinstance(c["function"], dict):
            fn = c["function"]
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            out.append(
                {
                    "id": c.get("id"),
                    "name": str(fn.get("name") or ""),
                    "arguments": args or {},
                }
            )
        else:
            name = c.get("name") or c.get("tool_name") or ""
            args = c.get("arguments") or c.get("kwargs") or c.get("parameters") or {}
            out.append(
                {
                    "id": c.get("id"),
                    "name": str(name),
                    "arguments": dict(args) if isinstance(args, dict) else {},
                }
            )
    return out


def _stub_tool_response(call: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "tool": call.get("name"),
        "args": call.get("arguments") or {},
    }


async def run_task(
    task: VoiceTask,
    *,
    agent: AgentFn,
    stt: STTBackend,
    judge: CoherenceJudge | None,
    seed: int,
    pass_threshold: float = 0.5,
) -> VoiceTaskResult:
    """Run one task end-to-end and return its result."""
    history: list[MessageTurn] = []
    transcripts: list[str] = []
    agent_messages: list[str] = []
    all_tool_calls: list[dict[str, Any]] = []
    final_text = ""
    start = time.monotonic()
    error: str | None = None

    try:
        for query in task.queries:
            transcript = stt.transcribe(query)
            transcripts.append(transcript)
            history.append(
                MessageTurn(
                    role="user",
                    content=transcript,
                    audio_input=query.audio_bytes,
                )
            )

            dispatches = 0
            while dispatches < MAX_TOOL_DISPATCHES_PER_USER_TURN:
                assistant = await agent(history, task.tool_manifest)
                history.append(assistant)
                calls = _extract_tool_calls(assistant)
                if calls:
                    all_tool_calls.extend(calls)
                    for call in calls:
                        result = _stub_tool_response(call)
                        history.append(
                            MessageTurn(
                                role="tool",
                                content=json.dumps(result),
                                name=str(call.get("name") or ""),
                                tool_call_id=call.get("id"),
                            )
                        )
                    dispatches += 1
                    continue
                final_text = assistant.content or ""
                agent_messages.append(final_text)
                break
            else:
                agent_messages.append("")
    except Exception as exc:  # noqa: BLE001 - boundary capture for the report
        error = f"{type(exc).__name__}: {exc}"

    latency_ms = (time.monotonic() - start) * 1000.0

    axis = evaluate_task(
        task,
        predicted_calls=all_tool_calls,
        final_text=final_text,
        transcripts=transcripts,
        agent_messages=agent_messages,
        judge=judge,
    )
    total = axis.total()
    passed = error is None and total >= pass_threshold
    if axis.safety is not None and axis.safety < 1.0:
        passed = False

    return VoiceTaskResult(
        task_id=task.task_id,
        suite=task.suite,
        seed=seed,
        passed=passed,
        tool_selection_score=axis.tool_selection,
        parameter_match_score=axis.parameter_match,
        coherence_score=axis.coherence,
        safety_score=axis.safety,
        total_score=total,
        agent_tool_calls=all_tool_calls,
        agent_final_text=final_text,
        transcripts=transcripts,
        latency_ms=latency_ms,
        error=error,
    )


async def run_tasks(
    tasks: list[VoiceTask],
    *,
    agent: AgentFn,
    stt: STTBackend,
    judge: CoherenceJudge | None,
    seeds: int = 1,
    on_result: Callable[[VoiceTaskResult], Awaitable[None]] | None = None,
) -> list[VoiceTaskResult]:
    """Run every task ``seeds`` times sequentially."""
    if seeds < 1:
        raise ValueError("seeds must be >= 1")
    results: list[VoiceTaskResult] = []
    for seed in range(seeds):
        for task in tasks:
            result = await run_task(
                task, agent=agent, stt=stt, judge=judge, seed=seed
            )
            results.append(result)
            if on_result is not None:
                await on_result(result)
    return results
