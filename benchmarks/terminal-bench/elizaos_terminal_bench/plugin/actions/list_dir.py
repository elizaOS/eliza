"""LIST_DIR action for listing directory contents in terminal environment."""

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


async def _validate_list_dir(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Validate that we have an environment to list directories in."""
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    return env is not None


async def _handle_list_dir(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """List contents of a directory in the terminal environment."""
    _ = message, state, responses

    # Get path from parameters (default to current directory)
    path = "."
    if options and options.parameters:
        path = str(options.parameters.get("path", "."))

    # Get the terminal environment from runtime
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    if env is None:
        return ActionResult(
            text="Terminal environment not available",
            success=False,
            error="Terminal environment not configured in runtime",
        )

    try:
        # List via ls -la
        safe_path = shlex.quote(path)
        result = await env.execute(f"ls -la {safe_path}")

        # Record command in current benchmark session (if available)
        session = runtime.get_setting("CURRENT_SESSION")
        if session is not None and hasattr(session, "commands"):
            try:
                session.commands.append(result)
            except Exception:
                pass

        if result.exit_code == 0:
            listing = result.stdout.strip()
            response_content = Content(
                text=f"Directory listing of {path}:\n{listing}",
                actions=["LIST_DIR"],
            )

            if callback:
                await callback(response_content)

            return ActionResult(
                text=f"Listed directory: {path}",
                values={
                    "lastListedDir": path,
                    "directoryListing": listing,
                },
                data={
                    "actionName": "LIST_DIR",
                    "path": path,
                    "listing": listing,
                    "entryCount": len(listing.splitlines()) - 1,  # Minus header
                },
                success=True,
            )
        else:
            error_msg = result.stderr or f"Failed to list {path}"
            return ActionResult(
                text=f"Failed to list directory: {error_msg}",
                success=False,
                error=error_msg,
            )

    except Exception as e:
        return ActionResult(
            text=f"Failed to list directory: {e}",
            success=False,
            error=str(e),
        )


list_dir_action = Action(
    name="LIST_DIR",
    description=(
        "List the contents of a directory in the terminal environment. "
        "Shows files and subdirectories with detailed information (permissions, size, etc.)."
    ),
    similes=["LS", "DIR", "LIST", "SHOW_DIR", "BROWSE"],
    validate=_validate_list_dir,
    handler=_handle_list_dir,
    parameters=[
        ActionParameter(
            name="path",
            description="The path to the directory to list",
            required=False,
            schema=ActionParameterSchema(
                type="string",
                description="Path to directory (defaults to current directory)",
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="What files are in the workspace?"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Let me check the workspace directory...",
                    actions=["LIST_DIR"],
                ),
            ),
        ],
    ],
)
