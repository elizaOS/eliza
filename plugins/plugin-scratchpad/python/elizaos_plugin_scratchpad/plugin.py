"""Plugin definition for the Scratchpad plugin."""

from __future__ import annotations

from typing import Any

from elizaos.types import Action, ActionResult, Plugin

from elizaos_plugin_scratchpad.actions import (
    SCRATCHPAD_APPEND_ACTION,
    SCRATCHPAD_DELETE_ACTION,
    SCRATCHPAD_LIST_ACTION,
    SCRATCHPAD_READ_ACTION,
    SCRATCHPAD_SEARCH_ACTION,
    SCRATCHPAD_WRITE_ACTION,
    handle_scratchpad_append,
    handle_scratchpad_delete,
    handle_scratchpad_list,
    handle_scratchpad_read,
    handle_scratchpad_search,
    handle_scratchpad_write,
    validate_scratchpad_append,
    validate_scratchpad_delete,
    validate_scratchpad_list,
    validate_scratchpad_read,
    validate_scratchpad_search,
    validate_scratchpad_write,
)
from elizaos_plugin_scratchpad.providers import SCRATCHPAD_PROVIDER


def _wrap_action(
    spec: dict[str, object],
    validate_fn: Any,  # noqa: ANN401
    handler_fn: Any,  # noqa: ANN401
) -> Action:
    """Wrap a spec dict + validate/handler functions into an Action object."""
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
                **(
                    getattr(res, "data", {})
                    if isinstance(getattr(res, "data", {}), dict)
                    else {}
                ),
                "actionName": name,
            },
        )

    return Action(
        name=name,
        description=description,
        similes=similes,
        examples=examples,
        validate=validate_fn,
        handler=handler,
    )


async def init_scratchpad_plugin(config, runtime) -> None:  # noqa: ANN001
    """Initialize the scratchpad plugin."""
    _ = config, runtime


scratchpad_plugin = Plugin(
    name="@elizaos/plugin-scratchpad",
    description="File-based memory storage for persistent notes and memories that can be written, read, searched, and managed across sessions.",
    init=init_scratchpad_plugin,
    actions=[
        _wrap_action(SCRATCHPAD_WRITE_ACTION, validate_scratchpad_write, handle_scratchpad_write),
        _wrap_action(SCRATCHPAD_READ_ACTION, validate_scratchpad_read, handle_scratchpad_read),
        _wrap_action(
            SCRATCHPAD_SEARCH_ACTION, validate_scratchpad_search, handle_scratchpad_search
        ),
        _wrap_action(SCRATCHPAD_LIST_ACTION, validate_scratchpad_list, handle_scratchpad_list),
        _wrap_action(
            SCRATCHPAD_DELETE_ACTION, validate_scratchpad_delete, handle_scratchpad_delete
        ),
        _wrap_action(
            SCRATCHPAD_APPEND_ACTION, validate_scratchpad_append, handle_scratchpad_append
        ),
    ],
    providers=[SCRATCHPAD_PROVIDER],
)
