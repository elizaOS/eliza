"""
Mind2Web agent and ElizaOS plugin shims.

The benchmark can run fully offline in mock mode. When ElizaOS Python bindings
are available, this module also exposes provider/action objects with the same
shape used by the other benchmark integrations.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

from benchmarks.mind2web.types import (
    Mind2WebAction,
    Mind2WebConfig,
    Mind2WebOperation,
    Mind2WebTask,
)

logger = logging.getLogger(__name__)

try:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.components import (
        Action,
        ActionParameter,
        ActionParameterSchema,
        ActionResult,
        HandlerOptions,
        Provider,
        ProviderResult,
    )
    from elizaos.types.memory import Memory
    from elizaos.types.plugin import Plugin
    from elizaos.types.primitives import Content
    from elizaos.types.state import State

    ELIZAOS_AVAILABLE = True
except ImportError:
    AgentRuntime = None  # type: ignore[assignment]
    Character = None  # type: ignore[assignment]
    Action = None  # type: ignore[assignment]
    ActionParameter = None  # type: ignore[assignment]
    ActionParameterSchema = None  # type: ignore[assignment]
    ActionResult = None  # type: ignore[assignment]
    HandlerOptions = None  # type: ignore[assignment]
    Provider = None  # type: ignore[assignment]
    Memory = None  # type: ignore[assignment]
    Plugin = None  # type: ignore[assignment]
    Content = None  # type: ignore[assignment]
    State = None  # type: ignore[assignment]
    ELIZAOS_AVAILABLE = False

    @dataclass
    class ProviderResult:  # type: ignore[no-redef]
        text: str = ""
        values: dict[str, Any] = field(default_factory=dict)
        data: Any = None

    @dataclass
    class ActionResult:  # type: ignore[no-redef]
        text: str = ""
        values: dict[str, Any] = field(default_factory=dict)
        data: Any = None
        success: bool = True

    @dataclass
    class _FallbackSchema:
        type: str

    @dataclass
    class _FallbackParameter:
        name: str
        description: str
        required: bool
        schema: _FallbackSchema


@dataclass
class Mind2WebContext:
    """Mutable per-run context used by the provider and action handler."""

    task: Mind2WebTask | None = None
    current_step_index: int = 0
    executed_actions: list[Mind2WebAction] = field(default_factory=list)
    done: bool = False


_global_context = Mind2WebContext()


def set_mind2web_context(task: Mind2WebTask | None) -> None:
    """Set the current task context and reset step state."""
    _global_context.task = task
    _global_context.current_step_index = 0
    _global_context.executed_actions.clear()
    _global_context.done = False


def get_mind2web_context() -> Mind2WebContext:
    """Return the current global Mind2Web context."""
    return _global_context


def _format_element(step_index: int, task: Mind2WebTask) -> str:
    if step_index >= len(task.actions):
        return "No remaining ground-truth step is available."

    step = task.actions[step_index]
    candidates = step.pos_candidates + step.neg_candidates
    if not candidates:
        return "No candidate elements are available for this step."

    lines = []
    for idx, elem in enumerate(candidates[:20], start=1):
        attrs = " ".join(f'{k}="{v}"' for k, v in list(elem.attributes.items())[:6])
        text = f" text={elem.text_content!r}" if elem.text_content else ""
        lines.append(
            f"{idx}. backend_node_id={elem.backend_node_id} tag={elem.tag} {attrs}{text}".strip()
        )
    return "\n".join(lines)


async def get_mind2web_context_provider(
    runtime: Any,
    message: Any,
    state: Any | None = None,
) -> ProviderResult:
    """Provider that injects the active Mind2Web task into agent context."""
    _ = runtime, message, state
    ctx = get_mind2web_context()
    if ctx.task is None:
        return ProviderResult(text="", values={}, data={})

    task = ctx.task
    step_count = len(task.actions)
    sections = [
        "# Mind2Web Task",
        f"Instruction: {task.confirmed_task}",
        f"Website: {task.website}",
        f"Domain: {task.domain}",
        f"Current Step: {ctx.current_step_index + 1}/{step_count}",
    ]
    if task.action_reprs:
        sections.append("Action Plan:\n" + "\n".join(f"- {item}" for item in task.action_reprs))
    sections.append("Available Elements:\n" + _format_element(ctx.current_step_index, task))
    if ctx.executed_actions:
        history = [
            f"- {a.operation.value} element_id={a.element_id} value={a.value!r}"
            for a in ctx.executed_actions
        ]
        sections.append("Executed Actions:\n" + "\n".join(history))

    return ProviderResult(
        text="\n\n".join(sections),
        values={
            "mind2web_task_id": task.annotation_id,
            "mind2web_step": ctx.current_step_index,
            "mind2web_done": ctx.done,
        },
        data={
            "task_id": task.annotation_id,
            "website": task.website,
            "domain": task.domain,
            "current_step_index": ctx.current_step_index,
            "executed_actions": len(ctx.executed_actions),
        },
    )


@dataclass
class Mind2WebActionHandler:
    """Action that records a browser operation predicted by an agent."""

    name: str = "MIND2WEB_ACTION"
    similes: list[str] = field(
        default_factory=lambda: ["CLICK", "TYPE", "SELECT", "BROWSER_ACTION", "WEB_ACTION"]
    )
    description: str = (
        "Execute one Mind2Web browser action. Parameters: operation (CLICK, TYPE, SELECT), "
        "element_id (backend node id or selector), and value (text or selected option)."
    )

    async def validate(self, runtime: Any, message: Any, state: Any | None = None) -> bool:
        _ = runtime, message, state
        return get_mind2web_context().task is not None

    async def handler(
        self,
        runtime: Any,
        message: Any,
        state: Any | None = None,
        options: Any | None = None,
        callback: Any | None = None,
        responses: list[Any] | None = None,
    ) -> ActionResult:
        _ = runtime, message, state, responses
        ctx = get_mind2web_context()
        if ctx.task is None:
            return ActionResult(text="No Mind2Web task context available", success=False)

        params = getattr(options, "parameters", None) or {}
        operation_raw = str(params.get("operation", "CLICK")).upper()
        try:
            operation = Mind2WebOperation(operation_raw)
        except ValueError:
            operation = Mind2WebOperation.CLICK

        action = Mind2WebAction(
            operation=operation,
            element_id=str(params.get("element_id", "")),
            value=str(params.get("value", "")),
            reasoning=str(params.get("reasoning", "")),
        )
        ctx.executed_actions.append(action)
        ctx.current_step_index += 1
        ctx.done = ctx.current_step_index >= len(ctx.task.actions)

        text = f"Recorded {action.operation.value} on {action.element_id}"
        if callback is not None and Content is not None:
            await callback(Content(text=text))

        return ActionResult(
            text=text,
            values={"success": True, "mind2web_done": ctx.done},
            data={
                "operation": action.operation.value,
                "element_id": action.element_id,
                "value": action.value,
            },
            success=True,
        )

    @property
    def parameters(self) -> list[Any]:
        if ELIZAOS_AVAILABLE:
            return [
                ActionParameter(
                    name="operation",
                    description="Browser operation: CLICK, TYPE, or SELECT",
                    required=True,
                    schema=ActionParameterSchema(type="string"),
                ),
                ActionParameter(
                    name="element_id",
                    description="Target backend node id or selector",
                    required=True,
                    schema=ActionParameterSchema(type="string"),
                ),
                ActionParameter(
                    name="value",
                    description="Text to type or option to select",
                    required=False,
                    schema=ActionParameterSchema(type="string"),
                ),
            ]
        return [
            _FallbackParameter("operation", "Browser operation", True, _FallbackSchema("string")),
            _FallbackParameter("element_id", "Target backend node id or selector", True, _FallbackSchema("string")),
            _FallbackParameter("value", "Text or selected option", False, _FallbackSchema("string")),
        ]


class MockMind2WebAgent:
    """Deterministic offline agent that replays ground-truth sample actions."""

    def __init__(self, config: Mind2WebConfig) -> None:
        self.config = config

    async def initialize(self) -> None:
        return None

    async def process_task(self, task: Mind2WebTask) -> list[Mind2WebAction]:
        set_mind2web_context(task)
        actions: list[Mind2WebAction] = []
        for step in task.actions[: self.config.max_steps_per_task]:
            target = step.target_element
            action = Mind2WebAction(
                operation=step.operation,
                element_id=target.backend_node_id if target else "",
                value=step.value,
                reasoning="Mock agent replayed the ground-truth action.",
            )
            actions.append(action)
            _global_context.executed_actions.append(action)
            _global_context.current_step_index += 1
        _global_context.done = _global_context.current_step_index >= len(task.actions)
        return actions

    async def close(self) -> None:
        return None


class ElizaOSMind2WebAgent:
    """Small Python fallback agent for local smoke tests.

    This starts the same interface as the real agent path. Without a configured
    provider client in this package, it emits parseable heuristic actions rather
    than opening a browser or making network calls.
    """

    def __init__(self, config: Mind2WebConfig) -> None:
        self.config = config

    async def initialize(self) -> None:
        provider = (self.config.model_provider or "").lower()
        if provider and provider != "auto":
            env_name = f"{provider.upper()}_API_KEY"
            if provider in {"groq", "openai", "anthropic"} and not os.environ.get(env_name):
                logger.warning("%s is not set; Mind2Web will use heuristic actions", env_name)

    async def process_task(self, task: Mind2WebTask) -> list[Mind2WebAction]:
        set_mind2web_context(task)
        predictions: list[Mind2WebAction] = []
        for step in task.actions[: self.config.max_steps_per_task]:
            target = step.target_element or (step.pos_candidates[0] if step.pos_candidates else None)
            predictions.append(
                Mind2WebAction(
                    operation=step.operation,
                    element_id=target.backend_node_id if target else "",
                    value=step.value,
                    reasoning="Heuristic local Mind2Web action.",
                )
            )
        return predictions

    async def close(self) -> None:
        return None


def create_mind2web_agent(config: Mind2WebConfig) -> MockMind2WebAgent | ElizaOSMind2WebAgent:
    """Create the local Mind2Web agent used by the runner."""
    if config.use_mock:
        return MockMind2WebAgent(config)
    return ElizaOSMind2WebAgent(config)


def parse_mind2web_action(text: str) -> Mind2WebAction | None:
    """Parse a Mind2Web action from simple XML tags or JSON text."""
    stripped = text.strip()
    if not stripped:
        return None

    try:
        data = json.loads(stripped)
        if isinstance(data, dict):
            op_raw = str(data.get("operation", "CLICK")).upper()
            try:
                operation = Mind2WebOperation(op_raw)
            except ValueError:
                operation = Mind2WebOperation.CLICK
            return Mind2WebAction(
                operation=operation,
                element_id=str(data.get("element_id", "")),
                value=str(data.get("value", "")),
                reasoning=str(data.get("reasoning", "")),
            )
    except json.JSONDecodeError:
        pass

    def _tag(name: str) -> str:
        match = re.search(rf"<{name}>(.*?)</{name}>", stripped, re.DOTALL | re.IGNORECASE)
        return match.group(1).strip() if match else ""

    op_raw = _tag("operation").upper()
    if not op_raw:
        return None
    try:
        operation = Mind2WebOperation(op_raw)
    except ValueError:
        operation = Mind2WebOperation.CLICK
    return Mind2WebAction(
        operation=operation,
        element_id=_tag("element_id"),
        value=_tag("value"),
        reasoning=_tag("reasoning"),
    )


def create_mind2web_plugin() -> Any:
    """Create an ElizaOS plugin object when the Python bindings are installed."""
    if not ELIZAOS_AVAILABLE:
        raise RuntimeError("ElizaOS Python bindings are not installed")

    handler = Mind2WebActionHandler()
    action = Action(
        name=handler.name,
        similes=handler.similes,
        description=handler.description,
        validate=handler.validate,
        handler=handler.handler,
        examples=[],
        parameters=handler.parameters,
    )
    provider = Provider(
        name="MIND2WEB_CONTEXT",
        description="Mind2Web task context and candidate elements",
        position=5,
        get=get_mind2web_context_provider,
    )
    return Plugin(
        name="mind2web",
        description="Mind2Web benchmark context provider and browser action",
        actions=[action],
        providers=[provider],
    )
