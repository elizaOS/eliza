"""EXECUTE action for running shell commands in terminal environment."""

from __future__ import annotations

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


async def _validate_execute(
    runtime: IAgentRuntime, _message: Memory, _state: State | None = None
) -> bool:
    """Validate that we have an environment to execute commands in."""
    # Check if terminal environment is available in runtime services
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")
    return env is not None


async def _handle_execute(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Execute a shell command in the terminal environment."""
    _ = message, state, responses

    # Get command from parameters
    command = ""
    if options and options.parameters:
        command = str(options.parameters.get("command", ""))

    if not command:
        return ActionResult(
            text="No command provided",
            success=False,
            error="Missing required parameter: command",
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
        # Execute the command
        result = await env.execute(command)

        # Record command in current benchmark session (if available)
        session = runtime.get_setting("CURRENT_SESSION")
        if session is not None and hasattr(session, "commands"):
            try:
                session.commands.append(result)
            except Exception:
                pass

        output_parts = []
        if result.stdout:
            output_parts.append(f"stdout:\n{result.stdout}")
        if result.stderr:
            output_parts.append(f"stderr:\n{result.stderr}")
        if not output_parts:
            output_parts.append("(no output)")

        output = "\n".join(output_parts)

        response_content = Content(
            text=f"Command executed with exit code {result.exit_code}:\n{output}",
            actions=["EXECUTE"],
        )

        if callback:
            await callback(response_content)

        return ActionResult(
            text=f"Executed: {command}",
            values={
                "lastCommand": command,
                "exitCode": result.exit_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
            },
            data={
                "actionName": "EXECUTE",
                "command": command,
                "exitCode": result.exit_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "executionTimeMs": result.execution_time_ms,
            },
            success=result.exit_code == 0,
            error=result.stderr if result.exit_code != 0 else None,
        )

    except Exception as e:
        return ActionResult(
            text=f"Failed to execute command: {e}",
            success=False,
            error=str(e),
        )


execute_action = Action(
    name="EXECUTE",
    description=(
        "Execute a shell command in the terminal environment. "
        "Use this to run any shell commands like ls, cat, echo, mkdir, "
        "python, gcc, or any other CLI tools available in the container."
    ),
    similes=["RUN", "SHELL", "CMD", "COMMAND", "EXEC"],
    validate=_validate_execute,
    handler=_handle_execute,
    parameters=[
        ActionParameter(
            name="command",
            description="The shell command to execute",
            required=True,
            schema=ActionParameterSchema(
                type="string",
                description="Shell command to run (e.g., 'ls -la', 'cat file.txt')",
            ),
        ),
    ],
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="List files in the current directory"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Listing files in current directory...",
                    actions=["EXECUTE"],
                ),
            ),
        ],
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Run the Python script"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Running the script...",
                    actions=["EXECUTE"],
                ),
            ),
        ],
    ],
)
