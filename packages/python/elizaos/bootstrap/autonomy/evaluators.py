"""Post-action evaluator for the autonomous loop.

After actions complete during an autonomous cycle, this evaluator asks the LLM
whether the agent has satisfied its goal or should continue with more actions.
If the LLM says CONTINUE, the evaluator recursively triggers another full
message-handling cycle so the agent can pick and execute additional actions.
This repeats until the LLM says PAUSE or the safety limit is reached.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from elizaos.types.components import ActionResult, Evaluator, HandlerOptions
from elizaos.types.memory import Memory
from elizaos.types.model import ModelType
from elizaos.types.primitives import Content

from .service import AUTONOMY_SERVICE_TYPE, AutonomyService

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

_logger = logging.getLogger(__name__)

# Safety limit – the evaluator will stop recursing after this many
# consecutive CONTINUE decisions within a single evaluation chain.
MAX_CONTINUATION_DEPTH = 10

POST_ACTION_EVALUATION_TEMPLATE = """\
You are evaluating whether an autonomous agent has completed its current objective.

Recent actions and their results:
{action_results}

Recent context:
{recent_context}

Based on the above, decide:
- If the agent has completed everything it set out to do, or there is nothing \
more it can meaningfully do right now, respond with exactly: PAUSE
- If there are remaining steps, errors that need retrying, or follow-up actions \
the agent should take immediately, respond with exactly: CONTINUE

Respond with a single word: CONTINUE or PAUSE
"""


async def _validate_post_action(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    """Run when the message originated from the autonomy service."""
    if not message.content:
        return False

    # Check content.data for autonomy markers
    data = message.content.data
    if isinstance(data, dict):
        if data.get("isAutonomous") is True or data.get("source") == "autonomy-service":
            return True

    # Check content.source field
    source = getattr(message.content, "source", None)
    return bool(isinstance(source, str) and source == "autonomy-service")


def _collect_action_results_text(runtime: IAgentRuntime, message: Memory) -> str:
    """Build a human-readable summary of most recent action results."""
    if not message.id:
        return "(no action results available)"

    results = runtime.get_action_results(message.id)
    if not results:
        return "(no action results available)"

    lines: list[str] = []
    for r in results:
        name = ""
        data = getattr(r, "data", None)
        if isinstance(data, dict):
            v = data.get("actionName")
            if isinstance(v, str):
                name = v
        success = getattr(r, "success", True)
        text = getattr(r, "text", "")
        status = "success" if success else "failed"
        lines.append(f"- {name} ({status}): {text}")

    return "\n".join(lines) if lines else "(no action results available)"


async def _collect_recent_context(runtime: IAgentRuntime, room_id: Any) -> str:
    """Gather a short snippet of recent memories for the evaluation prompt."""
    try:
        recent_memories = await runtime.get_memories(
            {"roomId": room_id, "count": 5, "tableName": "memories"}
        )
    except Exception:
        return "(no recent context)"

    if not recent_memories:
        return "(no recent context)"

    ctx_lines: list[str] = []
    for m in recent_memories:
        if m.content and m.content.text:
            ctx_lines.append(m.content.text[:200])

    return "\n".join(ctx_lines[-3:]) if ctx_lines else "(no recent context)"


async def _handle_post_action(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: Callable[[Content], Awaitable[None]] | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult | None:
    """Evaluate whether the agent should continue with more actions.

    Runs after ``processActions`` completes during an autonomy cycle.
    If the LLM says CONTINUE, it recursively triggers another autonomous
    think iteration.  This repeats until the LLM says PAUSE or the
    safety depth limit is reached.
    """
    autonomy_service = runtime.get_service(AUTONOMY_SERVICE_TYPE)
    if not autonomy_service or not isinstance(autonomy_service, AutonomyService):
        return None

    # Don't evaluate if autonomy is not actually running
    if not autonomy_service.is_loop_running():
        return None

    # Track recursion depth via an attribute on the service instance
    depth: int = getattr(autonomy_service, "_eval_depth", 0)

    action_results_text = _collect_action_results_text(runtime, message)

    room_id = autonomy_service.get_autonomous_room_id() or message.room_id
    recent_context = await _collect_recent_context(runtime, room_id)

    prompt = POST_ACTION_EVALUATION_TEMPLATE.format(
        action_results=action_results_text,
        recent_context=recent_context,
    )

    try:
        result = await runtime.use_model(
            ModelType.TEXT_SMALL,
            {"prompt": prompt, "temperature": 0.1, "maxTokens": 10},
        )
        decision = str(result).strip().upper()
    except Exception as e:
        _logger.warning(f"Post-action evaluation LLM call failed: {e}")
        autonomy_service._eval_depth = 0  # type: ignore[attr-defined]
        return None

    if "CONTINUE" in decision:
        depth += 1

        if depth >= MAX_CONTINUATION_DEPTH:
            runtime.logger.warning(
                f"[post-action-evaluator] Safety limit reached ({MAX_CONTINUATION_DEPTH} "
                "consecutive actions). Pausing."
            )
            autonomy_service._eval_depth = 0  # type: ignore[attr-defined]
            return ActionResult(
                success=True,
                text=f"Paused after {MAX_CONTINUATION_DEPTH} consecutive actions",
                data={"decision": "PAUSE", "reason": "depth_limit", "depth": depth},
            )

        runtime.logger.info(
            f"[post-action-evaluator] CONTINUE (depth {depth}) – "
            "triggering another autonomous think cycle"
        )
        autonomy_service._eval_depth = depth  # type: ignore[attr-defined]

        # Recurse: trigger another full think → actions → evaluate cycle
        await autonomy_service.perform_autonomous_think()

        return ActionResult(
            success=True,
            text=f"Continued with additional actions (depth {depth})",
            data={"decision": "CONTINUE", "depth": depth},
        )

    # PAUSE (or unrecognised → default to pause)
    runtime.logger.info(
        f"[post-action-evaluator] PAUSE after {depth} continuation(s) – agent is satisfied"
    )
    autonomy_service._eval_depth = 0  # type: ignore[attr-defined]

    return ActionResult(
        success=True,
        text="Agent is satisfied, pausing",
        data={"decision": "PAUSE", "depth": depth},
    )


post_action_evaluator = Evaluator(
    name="POST_ACTION_EVALUATOR",
    description=(
        "Evaluates after autonomous actions complete to determine if the agent "
        "should recursively continue with more actions or pause."
    ),
    validate=_validate_post_action,
    handler=_handle_post_action,
    always_run=True,
)
