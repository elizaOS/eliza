"""TOUCH action for creating empty files in terminal environment."""

from __future__ import annotations

import os
import shlex
from typing import TYPE_CHECKING

from elizaos.types import (
    Action,
    ActionExample,
    ActionParameter,
    ActionParameterSchema,
    ActionResult,
    Content,
)

if TYPE_CHECKING:
    from elizaos.types import (
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )


async def _validate_touch(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    return env is not None


async def _handle_touch(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    _ = message, state, responses

    path = ""
    if options and options.parameters:
        path = str(options.parameters.get("path", ""))

    if not path:
        return ActionResult(
            text="No file path provided",
            success=False,
            error="Missing required parameter: path",
        )

    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    if env is None:
        return ActionResult(
            text="Terminal environment not available",
            success=False,
            error="Terminal environment not configured in runtime",
        )

    try:
        directory = os.path.dirname(path)
        safe_path = shlex.quote(path)
        if directory:
            safe_dir = shlex.quote(directory)
            command = f"mkdir -p {safe_dir} && : > {safe_path}"
        else:
            command = f": > {safe_path}"

        result = await env.execute(command)

        session = runtime.get_setting("CURRENT_SESSION")
        if session is not None and hasattr(session, "commands"):
            try:
                session.commands.append(result)
            except Exception:
                pass

        if result.exit_code != 0:
            error_msg = result.stderr or f"Failed to touch {path}"
            return ActionResult(
                text=f"Failed to create empty file: {error_msg}",
                success=False,
                error=error_msg,
            )

        response_content = Content(
            text=f"Created empty file: {path}",
            actions=["TOUCH"],
        )
        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Touched file: {path}",
            values={"lastTouchedFile": path},
            data={"actionName": "TOUCH", "path": path},
            success=True,
        )

    except Exception as e:
        return ActionResult(
            text=f"Failed to create empty file: {e}",
            success=False,
            error=str(e),
        )


touch_action = Action(
    name="TOUCH",
    description=(
        "Create an empty file at the given path (truncates to zero bytes if it exists). "
        "Use this for intentionally empty files like __init__.py."
    ),
    similes=["CREATE_EMPTY_FILE", "TRUNCATE_FILE", "EMPTY_FILE"],
    validate=_validate_touch,
    handler=_handle_touch,
    parameters=[
        ActionParameter(
            name="path",
            description="The path to the file to create/truncate",
            required=True,
            schema=ActionParameterSchema(
                type="string",
                description="Full path to the file (e.g., '/workspace/project/src/__init__.py')",
            ),
        )
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Create an empty __init__.py in /workspace/pkg"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(text="Creating empty file...", actions=["TOUCH"]),
            ),
        ]
    ],
)

