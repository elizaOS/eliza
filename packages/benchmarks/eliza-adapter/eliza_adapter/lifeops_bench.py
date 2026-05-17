"""LifeOpsBench agent_fn backed by the eliza benchmark server.

LifeOpsBench drives Eliza through the bench server's lifeops_bench routes:
on the first turn we POST /reset with a `world_snapshot_path` so the TS
side hydrates an in-process LifeWorld fake backend; subsequent turns POST
/message with the latest user text. The TS server runs Eliza's planner,
executes any emitted actions against the fake backend, and returns the
assistant turn including parsed tool_calls.

The adapter is deliberately thin — it owns no scenario state and treats
the bench server as the source of truth. State-hash scoring on the
Python side calls `fetch_world_state()` to pull the post-scenario
LifeWorld JSON.

This adapter mirrors the canonical pattern in
``eliza_adapter.woobench.build_eliza_bridge_agent_fn`` and re-uses
``ElizaClient`` for transport.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any, Awaitable, Callable

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


# LifeOpsBench types are imported lazily — the adapter package must remain
# usable without the lifeops-bench package installed (e.g. for OpenClaw or
# Hermes consumers that share the same eliza_adapter wheel).


def build_lifeops_bench_agent_fn(
    *,
    client: ElizaClient | None = None,
    world_snapshot_path: str,
    now_iso: str = "2026-05-10T12:00:00Z",
    model_name: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[Any]]:
    """Create a LifeOpsBench-compatible ``agent_fn`` backed by the eliza
    benchmark server.

    The returned coroutine has signature
    ``agent_fn(history: list[MessageTurn], tools: list[dict]) -> MessageTurn``
    so it plugs straight into ``LifeOpsBenchRunner``.

    A unique ``task_id`` is generated per returned agent function. The first
    call with a user message hits ``/reset`` with the snapshot path; subsequent
    calls post the latest user message to the same session. Do not key this by
    ``id(conversation_history)``: LifeOpsBench passes a fresh ``list(history)``
    into the agent every turn, so identity-based keys reset the fake backend
    and erase prior tool results.
    """
    from eliza_lifeops_bench.types import MessageTurn  # noqa: WPS433 — lazy

    server_manager = None
    if client is not None:
        bridge = client
    else:
        bridge = ElizaClient()
        harness = (
            os.environ.get("ELIZA_BENCH_HARNESS")
            or os.environ.get("BENCHMARK_HARNESS")
            or "eliza"
        ).strip().lower()
        if (
            getattr(bridge, "_delegate", None) is None
            and not os.environ.get("ELIZA_BENCH_URL")
            and harness in {"", "eliza"}
        ):
            from eliza_adapter.server_manager import ElizaServerManager  # noqa: WPS433

            server_manager = ElizaServerManager()
            server_manager.start()
            bridge = server_manager.client
    task_id: str | None = None
    reset_done = False
    bridge.wait_until_ready(timeout=120)

    async def _agent_fn(
        conversation_history: list[Any],
        tools: list[dict[str, Any]],
    ) -> Any:
        nonlocal reset_done, task_id

        # Pull the most recent user turn from the history. The LifeOpsBench
        # runner appends user/assistant turns in order, so the last user-role
        # turn is what we should forward to the server.
        last_user_text = ""
        for turn in reversed(conversation_history):
            role = getattr(turn, "role", None) or (turn.get("role") if isinstance(turn, dict) else None)
            content = getattr(turn, "content", None) or (turn.get("content") if isinstance(turn, dict) else "")
            if role == "user":
                last_user_text = str(content or "")
                break
        if not last_user_text:
            return MessageTurn(role="assistant", content="", tool_calls=None)

        if task_id is None:
            task_id = f"lifeops-{uuid.uuid4().hex[:12]}"
        if not reset_done:
            try:
                bridge.reset(
                    task_id=task_id,
                    benchmark="lifeops_bench",
                    world_snapshot_path=world_snapshot_path,
                    now_iso=now_iso,
                )
                reset_done = True
            except Exception:
                logger.exception("[eliza-lifeops] reset failed")
                raise

        try:
            raw = bridge.lifeops_message(
                task_id=task_id,
                text=last_user_text,
                tools=tools or None,
            )
        except Exception as exc:
            logger.exception("[eliza-lifeops] bridge call failed")
            raise RuntimeError("Eliza LifeOps bridge call failed") from exc

        text = str(raw.get("text") or "")
        tool_calls_raw = raw.get("tool_calls") or []
        # Map the server tool-call records into the OpenAI chat-completions
        # tool_calls shape so downstream consumers (scoring + judge prompts)
        # can read a uniform structure across adapters.
        tool_calls: list[dict[str, Any]] = []
        if isinstance(tool_calls_raw, list):
            for entry in tool_calls_raw:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "")
                if not name:
                    continue
                args = entry.get("arguments")
                if not isinstance(args, dict):
                    args = {}
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "type": "function",
                        "function": {"name": name, "arguments": args},
                        # Preserve execution metadata for scoring.
                        "_executed": {
                            "ok": bool(entry.get("ok", True)),
                            "result": entry.get("result"),
                            "error": entry.get("error"),
                        },
                    }
                )

        usage = raw.get("usage") or {}
        turn = MessageTurn(
            role="assistant",
            content=text,
            tool_calls=tool_calls or None,
        )
        # Attach optional usage metadata that LifeOpsBenchRunner reads via
        # getattr() — see runner.py's per-turn telemetry block.
        if isinstance(usage, dict):
            for attr, key in (
                ("input_tokens", "promptTokens"),
                ("output_tokens", "completionTokens"),
            ):
                value = usage.get(key)
                if isinstance(value, (int, float)):
                    setattr(turn, attr, int(value))
            # Cache telemetry comes from the TS bench server's MODEL_USED
            # buffer rollup. `cacheReadInputTokens` is omitted when no LLM
            # call in the turn reported cache info — we propagate that as
            # ``None`` so the runner records "unknown" rather than a silent
            # 0. Per AGENTS.md Cmd #8.
            cache_read_raw = usage.get("cacheReadInputTokens")
            cache_creation_raw = usage.get("cacheCreationInputTokens")
            setattr(
                turn,
                "cache_read_input_tokens",
                int(cache_read_raw)
                if isinstance(cache_read_raw, (int, float))
                else None,
            )
            setattr(
                turn,
                "cache_creation_input_tokens",
                int(cache_creation_raw)
                if isinstance(cache_creation_raw, (int, float))
                else None,
            )
            # Eliza routes through plugin-openai (OpenAI / Cerebras) or
            # plugin-anthropic — both support prompt caching.
            setattr(turn, "cache_supported", True)
        # Stash model identity so result records can attribute spend.
        if model_name:
            setattr(turn, "model_name", model_name)
        return turn

    # Keep the subprocess manager alive for as long as the returned callable
    # is alive. The manager also registers atexit cleanup.
    setattr(_agent_fn, "_eliza_server_manager", server_manager)
    return _agent_fn


def fetch_world_state(client: ElizaClient, task_id: str) -> dict[str, Any]:
    """Pull the post-scenario LifeWorld JSON for state-hash scoring.

    Returns the parsed body of ``GET /api/benchmark/lifeops_bench/<task_id>/world_state``.
    Callers can rebuild a ``LifeWorld`` from the embedded ``world`` field and
    call ``.state_hash()`` to compare against expected.
    """
    return client.lifeops_world_state(task_id)


def teardown_lifeops_session(client: ElizaClient, task_id: str) -> dict[str, Any]:
    """Free the per-task fake backend on the server. Idempotent."""
    return client.lifeops_teardown(task_id)
