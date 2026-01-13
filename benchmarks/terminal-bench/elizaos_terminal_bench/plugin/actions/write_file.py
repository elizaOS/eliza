"""WRITE_FILE action for writing content to files in terminal environment."""

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


async def _validate_write_file(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Validate that we have an environment to write files to."""
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    return env is not None


async def _handle_write_file(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Write content to a file in the terminal environment."""
    _ = message, state, responses

    # Get parameters
    path = ""
    content = ""
    if options and options.parameters:
        path = str(options.parameters.get("path", ""))
        content = str(options.parameters.get("content", ""))

    if not path:
        return ActionResult(
            text="No file path provided",
            success=False,
            error="Missing required parameter: path",
        )

    # Heuristic: if the model provided escaped newlines (\"\\n\") instead of actual newlines,
    # normalize them so scripts/source files compile/execute correctly.
    normalized_content = content
    if "\n" not in normalized_content and "\\n" in normalized_content:
        normalized_content = normalized_content.replace("\\n", "\n")
    if "\t" not in normalized_content and "\\t" in normalized_content:
        normalized_content = normalized_content.replace("\\t", "\t")

    # Get the terminal environment from runtime
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    if env is None:
        return ActionResult(
            text="Terminal environment not available",
            success=False,
            error="Terminal environment not configured in runtime",
        )

    try:
        # Write via heredoc
        safe_path = shlex.quote(path)
        # Escape any ELIZAEOF in content
        safe_content = normalized_content.replace("ELIZAEOF", "ELIZA_EOF")
        # IMPORTANT: if content is empty, heredoc would still write a trailing newline,
        # producing a non-empty file. Use a truncation redirect instead.
        if safe_content == "":
            command = f"> {safe_path}"
        else:
            command = f"cat << 'ELIZAEOF' > {safe_path}\n{safe_content}\nELIZAEOF"

        result = await env.execute(command)

        # Record command in current benchmark session (if available)
        session = runtime.get_setting("CURRENT_SESSION")
        if session is not None and hasattr(session, "commands"):
            try:
                session.commands.append(result)
            except Exception:
                pass

        if result.exit_code == 0:
            response_content = Content(
                text=f"Successfully wrote to {path}",
                actions=["WRITE_FILE"],
            )

            if callback:
                await callback(response_content)

            return ActionResult(
                text=f"Wrote file: {path}",
                values={
                    "lastWrittenFile": path,
                    "bytesWritten": len(normalized_content.encode()),
                },
                data={
                    "actionName": "WRITE_FILE",
                    "path": path,
                    "bytesWritten": len(normalized_content.encode()),
                    "lineCount": len(normalized_content.splitlines()),
                },
                success=True,
            )
        else:
            error_msg = result.stderr or f"Failed to write {path}"
            return ActionResult(
                text=f"Failed to write file: {error_msg}",
                success=False,
                error=error_msg,
            )

    except Exception as e:
        return ActionResult(
            text=f"Failed to write file: {e}",
            success=False,
            error=str(e),
        )


write_file_action = Action(
    name="WRITE_FILE",
    description=(
        "Write content to a file in the terminal environment. "
        "Specify the path and the content to write. "
        "This will create the file if it doesn't exist or overwrite if it does."
    ),
    similes=["CREATE_FILE", "SAVE", "SAVE_FILE", "PUT_FILE"],
    validate=_validate_write_file,
    handler=_handle_write_file,
    parameters=[
        ActionParameter(
            name="path",
            description="The path to the file to write",
            required=True,
            schema=ActionParameterSchema(
                type="string",
                description="Full path to the file (e.g., '/workspace/output.txt')",
            ),
        ),
        ActionParameter(
            name="content",
            description="The content to write to the file",
            # Content is required; to create an intentionally empty file use an empty string.
            required=True,
            schema=ActionParameterSchema(
                type="string",
                description="Content to write to the file",
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Create a hello world Python script"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Creating hello.py...",
                    actions=["WRITE_FILE"],
                ),
            ),
        ],
    ],
)
