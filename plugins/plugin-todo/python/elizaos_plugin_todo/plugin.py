from __future__ import annotations

from typing import Any

from elizaos.types import Action, ActionResult, Plugin

from elizaos_plugin_todo.actions import (
    CANCEL_TODO_ACTION,
    COMPLETE_TODO_ACTION,
    CONFIRM_TODO_ACTION,
    CREATE_TODO_ACTION,
    UPDATE_TODO_ACTION,
    handle_cancel_todo,
    handle_complete_todo,
    handle_confirm_todo,
    handle_create_todo,
    handle_update_todo,
    validate_cancel_todo,
    validate_complete_todo,
    validate_confirm_todo,
    validate_create_todo,
    validate_update_todo,
)
from elizaos_plugin_todo.providers import TODOS_PROVIDER


def _wrap_action(
    spec: dict[str, object],
    validate_fn: Any,  # noqa: ANN401
    handler_fn: Any,  # noqa: ANN401
) -> Action:
    name = str(spec.get("name", ""))
    description = str(spec.get("description", ""))
    similes_obj = spec.get("similes")
    similes = (
        [s for s in similes_obj if isinstance(s, str)] if isinstance(similes_obj, list) else None
    )

    examples = spec.get("examples")

    async def handler(runtime, message, state, options, callback, responses) -> ActionResult | None:  # noqa: ANN001
        res = await handler_fn(runtime, message, state, options, callback, responses)
        if res is None:
            return None
        return ActionResult(
            success=bool(getattr(res, "success", False)),
            text=getattr(res, "text", None),
            error=getattr(res, "error", None),
            data={
                **(getattr(res, "data", {}) if isinstance(getattr(res, "data", {}), dict) else {}),
                "actionName": name,
            },
        )

    return Action(
        name=name,
        description=description,
        similes=similes,
        examples=examples,  # let pydantic coerce dict → ActionExample/Content
        validate=validate_fn,
        handler=handler,
    )


async def init_todo_plugin(config, runtime) -> None:  # noqa: ANN001
    _ = config, runtime


todo_plugin = Plugin(
    name="@elizaos/plugin-todo",
    description="Todo task management plugin for elizaOS agents (python runtime)",
    init=init_todo_plugin,
    actions=[
        _wrap_action(CREATE_TODO_ACTION, validate_create_todo, handle_create_todo),
        _wrap_action(CONFIRM_TODO_ACTION, validate_confirm_todo, handle_confirm_todo),
        _wrap_action(UPDATE_TODO_ACTION, validate_update_todo, handle_update_todo),
        _wrap_action(COMPLETE_TODO_ACTION, validate_complete_todo, handle_complete_todo),
        _wrap_action(CANCEL_TODO_ACTION, validate_cancel_todo, handle_cancel_todo),
    ],
    providers=[TODOS_PROVIDER],
)
