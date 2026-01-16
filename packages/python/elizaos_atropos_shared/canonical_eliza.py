"""
Shared helpers for integrating Atropos environments with the canonical ElizaOS pipeline.

Key idea:
- Store per-step environment context in a typed ContextStore
- Providers/actions read/write through that store
- Agents trigger decisions via runtime.message_service.handle_message(...)
- Trajectory logging is linked via MessageMetadata.trajectoryStepId when provided
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Generic, TypeVar

from elizaos.services.message_service import MessageProcessingResult
from elizaos.types import (
    Action,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    Character,
    Content,
    HandlerOptions,
    Plugin,
    Provider,
    ProviderResult,
)
from elizaos.types.memory import Memory, MessageMetadata
from elizaos.types.primitives import as_uuid

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types import State


JsonScalar = str | int | float | bool | None
JsonValue = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]

TContext = TypeVar("TContext")


class ContextStore(Generic[TContext]):
    """A typed in-memory store for the current decision context."""

    def __init__(self) -> None:
        self._ctx: TContext | None = None

    def set(self, ctx: TContext | None) -> None:
        self._ctx = ctx

    def get(self) -> TContext | None:
        return self._ctx

    def clear(self) -> None:
        self._ctx = None


def make_decision_message(
    *,
    source: str,
    text: str,
    trajectory_step_id: str | None = None,
) -> Memory:
    meta = MessageMetadata(source=source)
    if trajectory_step_id is not None:
        # MessageMetadata allows extra fields.
        meta.trajectoryStepId = trajectory_step_id

    return Memory(
        entity_id=as_uuid(str(uuid.uuid4())),
        room_id=as_uuid(str(uuid.uuid4())),
        content=Content(
            text=text,
            source=source,
            channel_type="API",
        ),
        metadata=meta,
    )


async def handle_decision_message(
    runtime: AgentRuntime,
    *,
    source: str,
    text: str,
    trajectory_step_id: str | None = None,
) -> MessageProcessingResult:
    message = make_decision_message(source=source, text=text, trajectory_step_id=trajectory_step_id)
    return await runtime.message_service.handle_message(runtime, message)


async def run_with_context(
    runtime: AgentRuntime,
    store: ContextStore[TContext],
    ctx: TContext,
    *,
    source: str,
    text: str,
    trajectory_step_id: str | None = None,
) -> tuple[MessageProcessingResult, TContext]:
    """
    Run one canonical ElizaOS message loop with a context set.

    Returns:
      (MessageProcessingResult, context_after_actions)
    """
    store.set(ctx)
    try:
        result = await handle_decision_message(
            runtime, source=source, text=text, trajectory_step_id=trajectory_step_id
        )
        ctx_after = store.get() or ctx
        return result, ctx_after
    finally:
        store.clear()


ProviderRenderFn = Callable[[TContext], ProviderResult]


def create_provider_from_store(
    *,
    name: str,
    description: str,
    store: ContextStore[TContext],
    render: ProviderRenderFn[TContext],
    position: int = -10,
) -> Provider:
    async def _get(
        _runtime: AgentRuntime, _message: Memory, _state: State | None = None
    ) -> ProviderResult:
        ctx = store.get()
        if ctx is None:
            return ProviderResult(
                text=f"No active {name} context.", values={f"has_{name}": False}, data={}
            )
        return render(ctx)

    return Provider(name=name, description=description, get=_get, dynamic=True, position=position)


@dataclass(frozen=True)
class CaptureActionResponse:
    ok: bool
    error: str | None = None
    values: dict[str, JsonValue] | None = None
    data: dict[str, JsonValue] | None = None
    text: str | None = None


def ok_capture(
    *,
    values: dict[str, JsonValue] | None = None,
    data: dict[str, JsonValue] | None = None,
    text: str | None = None,
) -> CaptureActionResponse:
    return CaptureActionResponse(ok=True, values=values, data=data, text=text)


def err_capture(error: str) -> CaptureActionResponse:
    return CaptureActionResponse(ok=False, error=error)


ApplyParamFn = Callable[[TContext, str], CaptureActionResponse]


def create_capture_action_from_store(
    *,
    name: str,
    description: str,
    store: ContextStore[TContext],
    param_name: str,
    schema: ActionParameterSchema,
    apply_param: ApplyParamFn[TContext],
) -> Action:
    async def validate(
        _runtime: AgentRuntime, _message: Memory, _state: State | None = None
    ) -> bool:
        return store.get() is not None

    async def handler(
        _runtime: AgentRuntime,
        _message: Memory,
        _state: State | None = None,
        options: HandlerOptions | None = None,
        _callback=None,
        _responses=None,
    ) -> ActionResult:
        ctx = store.get()
        if ctx is None:
            return ActionResult(success=False, error=f"No {name} context")

        raw = ""
        if options is not None and options.parameters is not None:
            val = options.parameters.get(param_name)
            raw = str(val) if val is not None else ""
        raw = raw.strip()
        if not raw:
            return ActionResult(success=False, error=f"Missing {param_name}")

        resp = apply_param(ctx, raw)
        if not resp.ok:
            return ActionResult(success=False, error=resp.error or "Invalid param")

        return ActionResult(success=True, values=resp.values, data=resp.data, text=resp.text)

    return Action(
        name=name,
        description=description,
        validate=validate,
        handler=handler,
        parameters=[
            ActionParameter(
                name=param_name,
                description=f"{param_name} parameter",
                required=True,
                schema=schema,
            )
        ],
    )


def create_action_only_template(
    *,
    task: str,
    instructions: str,
    action_name: str,
    param_name: str,
    param_placeholder: str,
) -> str:
    return f"""<task>{task}</task>

<providers>
{{{{providers}}}}
</providers>

<instructions>
{instructions}
</instructions>

<output>
Return XML only:
<response>
  <thought>brief</thought>
  <actions>{action_name}</actions>
  <params>
    <{action_name}>
      <{param_name}>{param_placeholder}</{param_name}>
    </{action_name}>
  </params>
  <text>short</text>
</response>
</output>"""


def create_basic_character(
    *,
    name: str,
    bio: list[str],
    system: str,
    template: str,
) -> Character:
    return Character(
        name=name,
        bio=bio,
        system=system,
        templates={"messageHandlerTemplate": template},
        settings={"checkShouldRespond": False},
    )


def create_simple_plugin(
    *,
    name: str,
    description: str,
    providers: list[Provider],
    actions: list[Action],
) -> Plugin:
    return Plugin(name=name, description=description, providers=providers, actions=actions)
