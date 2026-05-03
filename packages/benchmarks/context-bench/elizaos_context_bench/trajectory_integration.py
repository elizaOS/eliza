"""Trajectory logging integration for context-bench (Python).

This module integrates the Python `elizaos_plugin_trajectory_logger` utilities with
the canonical Eliza agent loop by instrumenting an `AgentRuntime` instance.

Design goals:
- Capture **end-to-end** flow: provider composition, model calls, actions, evaluators.
- Keep the Eliza runtime canonical (no bypass of message handling/action execution).
- Produce ART / GRPO-compatible artifacts via plugin-trajectory-logger exporters.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING

from elizaos_plugin_trajectory_logger.types import (
    ActionAttempt,
    EnvironmentState,
    LLMCall,
    ProviderAccess,
    RewardComponents,
)
from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService

if TYPE_CHECKING:
    from elizaos.types.components import ActionResult, Evaluator
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

# Contextvars so concurrent tasks don't trample each other.
_CURRENT_TRAJECTORY_ID: ContextVar[str | None] = ContextVar("_CURRENT_TRAJECTORY_ID", default=None)
_CURRENT_STEP_ID: ContextVar[str | None] = ContextVar("_CURRENT_STEP_ID", default=None)


@contextmanager
def bind_trajectory(trajectory_id: str, step_id: str) -> Callable[[], None]:
    """Bind a trajectory/step to the current async context."""

    tok_traj = _CURRENT_TRAJECTORY_ID.set(trajectory_id)
    tok_step = _CURRENT_STEP_ID.set(step_id)
    try:
        yield
    finally:
        _CURRENT_TRAJECTORY_ID.reset(tok_traj)
        _CURRENT_STEP_ID.reset(tok_step)


def _now_ms() -> int:
    return int(time.time() * 1000)


def start_benchmark_trajectory(
    *,
    logger: TrajectoryLoggerService,
    agent_id: str,
    scenario_id: str,
    metadata: dict[str, object] | None,
) -> tuple[str, str]:
    """Start a trajectory + first step for a benchmark task."""

    trajectory_id = logger.start_trajectory(
        agent_id=agent_id,
        scenario_id=scenario_id,
        metadata=metadata,
    )

    env_state = EnvironmentState(
        timestamp=_now_ms(),
        agent_balance=0.0,
        agent_points=0.0,
        agent_pnl=0.0,
        open_positions=0,
        custom=metadata or {},
    )
    step_id = logger.start_step(trajectory_id, env_state)
    return trajectory_id, step_id


async def end_benchmark_trajectory(
    *,
    logger: TrajectoryLoggerService,
    trajectory_id: str,
    status: str,
    final_metrics: dict[str, object] | None,
) -> None:
    # plugin types use Literal FinalStatus, but we keep a string here to avoid
    # hard-coding the union in multiple places.
    await logger.end_trajectory(trajectory_id, status=status, final_metrics=final_metrics)  # type: ignore[arg-type]


def install_runtime_trajectory_hooks(
    *,
    runtime: "IAgentRuntime",
    logger: TrajectoryLoggerService,
) -> None:
    """Monkeypatch runtime methods to emit trajectory events.

    This is intentionally scoped to context-bench runs. It wraps:
    - `compose_state`  (logs the composed provider text)
    - `use_model`      (logs prompts/responses/latency)
    - `process_actions`(logs executed actions + ActionResult summary)
    - `evaluate`       (logs which evaluators ran)
    """

    # Avoid double-wrapping.
    if getattr(runtime, "_context_bench_traj_hooks_installed", False):
        return
    setattr(runtime, "_context_bench_traj_hooks_installed", True)

    original_compose_state = runtime.compose_state
    original_use_model = runtime.use_model
    original_process_actions = runtime.process_actions
    original_evaluate = runtime.evaluate

    async def compose_state_wrapped(
        message: "Memory",
        include_list: list[str] | None = None,
        only_include: bool = False,
        skip_cache: bool = False,
    ) -> "State":
        # Force fresh state for benchmark tasks (cache is keyed by room_id).
        state = await original_compose_state(
            message,
            include_list=include_list,
            only_include=only_include,
            skip_cache=True if not skip_cache else True,
        )

        step_id = _CURRENT_STEP_ID.get()
        if step_id:
            access = ProviderAccess(
                provider_id=str(uuid.uuid4()),
                provider_name="COMPOSE_STATE",
                timestamp=_now_ms(),
                query=None,
                data={
                    "providerCount": len(getattr(runtime, "providers", [])),
                    "text": state.text or "",
                    "valuesKeys": list((state.values or {}).keys()),
                },
                purpose="state",
            )
            logger.log_provider_access(step_id, access)

        return state

    async def use_model_wrapped(
        model_type: str | object,
        params: dict[str, object] | None = None,
        provider: str | None = None,
        **kwargs: object,
    ) -> object:
        started = _now_ms()
        result_obj = await original_use_model(model_type, params=params, provider=provider, **kwargs)
        ended = _now_ms()

        step_id = _CURRENT_STEP_ID.get()
        if step_id:
            merged: dict[str, object] = {}
            if params:
                merged.update(params)
            if kwargs:
                merged.update(kwargs)

            prompt = str(merged.get("prompt", ""))
            system_prompt = str(merged.get("system", ""))
            temperature_raw = merged.get("temperature")
            temperature = float(temperature_raw) if isinstance(temperature_raw, (int, float)) else 0.0
            max_tokens_raw = merged.get("maxTokens")
            max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, int) else 0

            call = LLMCall(
                call_id=str(uuid.uuid4()),
                timestamp=started,
                model=str(model_type),
                model_version=None,
                system_prompt=system_prompt,
                user_prompt=prompt,
                messages=None,
                response=str(result_obj),
                reasoning=None,
                temperature=temperature,
                max_tokens=max_tokens,
                top_p=None,
                prompt_tokens=None,
                completion_tokens=None,
                latency_ms=max(0, ended - started),
                purpose="action",
                action_type=None,
            )
            logger.log_llm_call(step_id, call)

        return result_obj

    async def process_actions_wrapped(
        message: "Memory",
        responses: list["Memory"],
        state: "State" | None = None,
        callback=None,
        _options: dict[str, object] | None = None,
    ) -> None:
        await original_process_actions(
            message,
            responses,
            state,
            callback,
            _options=_options,  # type: ignore[arg-type]
        )

        step_id = _CURRENT_STEP_ID.get()
        trajectory_id = _CURRENT_TRAJECTORY_ID.get()
        if not step_id or not trajectory_id:
            return

        # Best-effort: summarize the last action result (if any).
        action_name = "unknown"
        success = True
        error_msg: str | None = None
        parameters: dict[str, object] = {}

        if responses and responses[0].content and getattr(responses[0].content, "actions", None):
            actions = getattr(responses[0].content, "actions")
            if isinstance(actions, list) and actions and isinstance(actions[0], str):
                action_name = actions[0]

        results: list["ActionResult"] = []
        if message.id is not None:
            try:
                results = runtime.get_action_results(message.id)
            except Exception:
                results = []

        if results:
            last = results[-1]
            success = bool(getattr(last, "success", True))
            err = getattr(last, "error", None)
            error_msg = str(err) if err else None

        attempt = ActionAttempt(
            attempt_id=str(uuid.uuid4()),
            timestamp=_now_ms(),
            action_type="action",
            action_name=str(action_name),
            parameters=parameters,
            reasoning=None,
            llm_call_id=None,
            success=success,
            result=None,
            error=error_msg,
            immediate_reward=None,
        )

        logger.complete_current_step(
            trajectory_id,
            action=attempt,
            reward=None,
            components=RewardComponents(environment_reward=0.0),
        )

    async def evaluate_wrapped(
        message: "Memory",
        state: "State" | None = None,
        did_respond: bool = False,
        callback=None,
        responses: list["Memory"] | None = None,
    ) -> list["Evaluator"] | None:
        evaluators = await original_evaluate(
            message,
            state=state,
            did_respond=did_respond,
            callback=callback,
            responses=responses,
        )

        step_id = _CURRENT_STEP_ID.get()
        if step_id:
            names = [e.name for e in evaluators] if evaluators else []
            access = ProviderAccess(
                provider_id=str(uuid.uuid4()),
                provider_name="EVALUATORS",
                timestamp=_now_ms(),
                query=None,
                data={"evaluators": names, "didRespond": did_respond},
                purpose="evaluation",
            )
            logger.log_provider_access(step_id, access)

        return evaluators

    runtime.compose_state = compose_state_wrapped  # type: ignore[assignment]
    runtime.use_model = use_model_wrapped  # type: ignore[assignment]
    runtime.process_actions = process_actions_wrapped  # type: ignore[assignment]
    runtime.evaluate = evaluate_wrapped  # type: ignore[assignment]

