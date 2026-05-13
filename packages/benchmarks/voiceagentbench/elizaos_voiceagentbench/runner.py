"""Multi-turn runner for VoiceAgentBench.

For each task, the runner walks the user turns one at a time:

  1. Transcribe ``query.audio_bytes`` via the STT backend; populate the
     new user :class:`MessageTurn` with both ``content`` (transcript)
     and ``audio_input`` (raw bytes) so direct-audio adapters can opt
     into the bytes path.
  2. Drive the agent in a tool-call loop: assistant turn -> dispatch any
     tool calls via the benchmark executor -> append deterministic tool
     result envelopes -> back to the assistant until it returns a
     text-only turn or the per-turn cap is hit.
  3. Move to the next user turn; repeat.

Tool execution is intentionally reduced to deterministic result envelopes:
the benchmark scores the *selection* and *parameter extraction*, not the
runtime semantics of the tool.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
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


def _resolve_telemetry_path() -> Path | None:
    explicit = os.environ.get("BENCHMARK_TELEMETRY_JSONL", "").strip()
    if explicit:
        return Path(explicit)
    run_dir = os.environ.get("BENCHMARK_RUN_DIR", "").strip()
    if run_dir:
        return Path(run_dir) / "telemetry.jsonl"
    return None


def _number_or_none(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def _int_or_none(value: Any) -> int | None:
    number = _number_or_none(value)
    return int(number) if number is not None else None


def _float_or_none(value: Any) -> float | None:
    number = _number_or_none(value)
    return float(number) if number is not None else None


def _write_turn_telemetry(
    *,
    task: VoiceTask,
    seed: int,
    user_turn_index: int,
    dispatch_index: int,
    prompt_text: str,
    assistant: MessageTurn,
    calls: list[dict[str, Any]],
) -> None:
    """Write one assistant-turn telemetry row for orchestrator accounting.

    Hermes writes its own adapter telemetry JSONL, but the Eliza/OpenClaw
    VoiceAgentBench paths reuse LifeOps-style in-process agents that attach
    token/cost fields to ``MessageTurn`` and do not write the JSONL envelope.
    This bridge keeps that telemetry first-class without inventing estimated
    token fallbacks.
    """

    telemetry_path = _resolve_telemetry_path()
    if telemetry_path is None:
        return

    input_tokens = _int_or_none(getattr(assistant, "input_tokens", None))
    output_tokens = _int_or_none(getattr(assistant, "output_tokens", None))
    total_tokens = (
        input_tokens + output_tokens
        if input_tokens is not None and output_tokens is not None
        else None
    )
    cache_read = _int_or_none(getattr(assistant, "cache_read_input_tokens", None))
    cache_creation = _int_or_none(
        getattr(assistant, "cache_creation_input_tokens", None)
    )
    latency_ms = _float_or_none(getattr(assistant, "latency_ms", None))
    cost_usd = _float_or_none(getattr(assistant, "cost_usd", None))

    # Do not emit placeholder rows. Missing usage must remain visible to the
    # publication gate instead of becoming a fake zero-token call.
    if (
        input_tokens is None
        and output_tokens is None
        and latency_ms is None
        and cost_usd is None
    ):
        return

    usage: dict[str, Any] = {}
    if input_tokens is not None:
        usage["promptTokens"] = input_tokens
        usage["prompt_tokens"] = input_tokens
    if output_tokens is not None:
        usage["completionTokens"] = output_tokens
        usage["completion_tokens"] = output_tokens
    if total_tokens is not None:
        usage["totalTokens"] = total_tokens
        usage["total_tokens"] = total_tokens
    if cache_read is not None:
        usage["cachedTokens"] = cache_read
        usage["cache_read_input_tokens"] = cache_read
    if cache_creation is not None:
        usage["cacheCreationInputTokens"] = cache_creation
        usage["cache_creation_input_tokens"] = cache_creation
    if latency_ms is not None:
        usage["latency_ms"] = latency_ms
    if cost_usd is not None:
        usage["cost_usd"] = cost_usd

    row = {
        "benchmark": "voiceagentbench",
        "source": "voiceagentbench_runner",
        "task_id": task.task_id,
        "suite": task.suite.value,
        "seed": seed,
        "user_turn_index": user_turn_index,
        "dispatch_index": dispatch_index,
        "prompt_text": prompt_text,
        "response_text": assistant.content or "",
        "tool_calls": calls,
        "usage": usage,
        "latency_ms": latency_ms,
        "cost_usd": cost_usd,
    }
    try:
        telemetry_path.parent.mkdir(parents=True, exist_ok=True)
        with telemetry_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=True, sort_keys=True) + "\n")
    except OSError as exc:
        logger.debug("failed to write VoiceAgentBench telemetry: %s", exc)


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


def _benchmark_tool_response(call: dict[str, Any]) -> dict[str, Any]:
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
    emit_telemetry: bool = False,
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
        for user_turn_index, query in enumerate(task.queries):
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
                dispatch_index = dispatches
                assistant = await agent(history, task.tool_manifest)
                history.append(assistant)
                calls = _extract_tool_calls(assistant)
                if emit_telemetry:
                    _write_turn_telemetry(
                        task=task,
                        seed=seed,
                        user_turn_index=user_turn_index,
                        dispatch_index=dispatch_index,
                        prompt_text=transcript,
                        assistant=assistant,
                        calls=calls,
                    )
                if calls:
                    all_tool_calls.extend(calls)
                    for call in calls:
                        result = _benchmark_tool_response(call)
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
    emit_telemetry: bool = False,
) -> list[VoiceTaskResult]:
    """Run every task ``seeds`` times sequentially."""
    if seeds < 1:
        raise ValueError("seeds must be >= 1")
    results: list[VoiceTaskResult] = []
    for seed in range(seeds):
        for task in tasks:
            result = await run_task(
                task,
                agent=agent,
                stt=stt,
                judge=judge,
                seed=seed,
                emit_telemetry=emit_telemetry,
            )
            results.append(result)
            if on_result is not None:
                await on_result(result)
    return results
