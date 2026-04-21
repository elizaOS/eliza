"""READ_FILE action for reading file contents from terminal environment."""

from __future__ import annotations

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


async def _validate_read_file(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Validate that we have an environment to read files from."""
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    return env is not None


async def _handle_read_file(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Read contents of a file in the terminal environment."""
    _ = message, state, responses

    # Get path from parameters
    path = ""
    if options and options.parameters:
        path = str(options.parameters.get("path", ""))

    if not path:
        return ActionResult(
            text="No file path provided",
            success=False,
            error="Missing required parameter: path",
        )

    # Get the terminal environment from runtime
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    if env is None:
        return ActionResult(
            text="Terminal environment not available",
            success=False,
            error="Terminal environment not configured in runtime",
        )

    try:
        # Read via cat command
        safe_path = shlex.quote(path)
        result = await env.execute(f"cat {safe_path}")

        # Record command in current benchmark session (if available)
        session = runtime.get_setting("CURRENT_SESSION")
        if session is not None and hasattr(session, "commands"):
            try:
                session.commands.append(result)
            except Exception:
                pass

        if result.exit_code == 0:
            content = result.stdout.strip()
            response_content = Content(
                text=f"File content of {path}:\n{content}",
                actions=["READ_FILE"],
            )

            if callback:
                await callback(response_content)

            return ActionResult(
                text=f"Read file: {path}",
                values={
                    "lastReadFile": path,
                    "fileContent": content,
                },
                data={
                    "actionName": "READ_FILE",
                    "path": path,
                    "content": content,
                    "lineCount": len(content.splitlines()),
                },
                success=True,
            )
        else:
            error_msg = result.stderr or f"Failed to read {path}"
            return ActionResult(
                text=f"Failed to read file: {error_msg}",
                success=False,
                error=error_msg,
            )

    except Exception as e:
        return ActionResult(
            text=f"Failed to read file: {e}",
            success=False,
            error=str(e),
        )


read_file_action = Action(
    name="READ_FILE",
    description=(
        "Read the contents of a file from the terminal environment. "
        "Specify the full path to the file you want to read."
    ),
    similes=["CAT", "VIEW", "SHOW_FILE", "GET_FILE", "OPEN"],
    validate=_validate_read_file,
    handler=_handle_read_file,
    parameters=[
        ActionParameter(
            name="path",
            description="The path to the file to read",
            required=True,
            schema=ActionParameterSchema(
                type="string",
                description="Full path to the file (e.g., '/workspace/script.py')",
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Show me what's in config.json"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Reading config.json...",
                    actions=["READ_FILE"],
                ),
            ),
        ],
    ],
)
