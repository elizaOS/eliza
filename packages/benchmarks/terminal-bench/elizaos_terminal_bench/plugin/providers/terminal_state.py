"""TERMINAL_STATE provider for injecting terminal environment state into context."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def _get_terminal_state(
    runtime: IAgentRuntime, _message: Memory, _state: State
) -> ProviderResult:
    """
    Get the current terminal environment state.

    This provider injects terminal state information including recent commands,
    working directory, and environment details.
    """
    session = runtime.get_setting("CURRENT_SESSION")
    env = runtime.get_setting("TERMINAL_ENVIRONMENT")

    if session is None and env is None:
        return ProviderResult(
            text="",
            values={},
            data={},
        )

    parts = []
    parts.append("## Terminal Environment State")
    parts.append("")

    # Working directory
    working_dir = "/workspace"
    if session:
        working_dir = session.working_directory
    parts.append(f"**Working directory:** {working_dir}")

    # Recent commands
    if session and session.commands:
        parts.append("")
        parts.append("**Recent commands:**")
        # Show last 5 commands
        recent = session.commands[-5:]
        for cmd in recent:
            status = "✓" if cmd.exit_code == 0 else f"✗ (exit {cmd.exit_code})"
            cmd_preview = cmd.command[:80] + ("..." if len(cmd.command) > 80 else "")
            line = f"  {status} `{cmd_preview}`"
            if cmd.exit_code != 0 and cmd.stderr:
                err_preview = cmd.stderr.strip().splitlines()[0][:160]
                line += f" — stderr: {err_preview}"
            parts.append(line)

        # Provide a bit more detail on the last command so the model can debug.
        last = session.commands[-1]
        last_stdout = (last.stdout or "").strip()
        last_stderr = (last.stderr or "").strip()
        if last_stdout or last_stderr:
            parts.append("")
            parts.append("**Last command output (truncated):**")
            if last_stdout:
                parts.append(f"stdout: {last_stdout[:300]}")
            if last_stderr:
                parts.append(f"stderr: {last_stderr[:300]}")

    # Environment info
    if env:
        parts.append("")
        parts.append(f"**Container image:** {getattr(env, 'image', 'unknown')}")
        network = getattr(env, 'network_mode', 'none')
        parts.append(f"**Network:** {'enabled' if network != 'none' else 'disabled'}")

    text = "\n".join(parts)

    # Build data
    data: dict = {
        "workingDirectory": working_dir,
    }
    if session:
        data["commandCount"] = len(session.commands)
        if session.commands:
            last_cmd = session.commands[-1]
            data["lastCommand"] = {
                "command": last_cmd.command,
                "exitCode": last_cmd.exit_code,
                "stdout": last_cmd.stdout[:500] if last_cmd.stdout else "",
                "stderr": last_cmd.stderr[:500] if last_cmd.stderr else "",
            }

    return ProviderResult(
        text=text,
        values={
            "workingDirectory": working_dir,
            "commandCount": len(session.commands) if session else 0,
        },
        data=data,
    )


terminal_state_provider = Provider(
    name="TERMINAL_STATE",
    description="Provides the current terminal environment state including recent commands",
    position=55,  # After TASK_CONTEXT
    private=False,
    get=_get_terminal_state,
)
