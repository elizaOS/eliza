"""
Run Skill Script Action

Executes scripts bundled with installed skills.
Scripts run via subprocess without loading their contents into context.
"""

from __future__ import annotations

import asyncio
import os
from typing import TYPE_CHECKING, Optional

from elizaos.types.components import (
    Action,
    ActionResult,
    HandlerCallback,
    HandlerOptions,
)

if TYPE_CHECKING:
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

from ..service import AgentSkillsService


def _get_service(runtime: "IAgentRuntime") -> Optional[AgentSkillsService]:
    return getattr(runtime, "_agent_skills_service", None)


async def _validate(
    runtime: "IAgentRuntime",
    _message: "Memory",
    _state: Optional["State"] = None,
) -> bool:
    return _get_service(runtime) is not None


async def _execute_script(
    script_path: str, args: list[str]
) -> dict[str, object]:
    """Execute a script and capture output."""
    ext = os.path.splitext(script_path)[1].lower()

    if ext == ".py":
        cmd = ["python3", script_path, *args]
    elif ext == ".sh":
        cmd = ["bash", script_path, *args]
    elif ext == ".js":
        cmd = ["node", script_path, *args]
    else:
        cmd = [script_path, *args]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=60.0
        )
        return {
            "success": proc.returncode == 0,
            "exit_code": proc.returncode or 0,
            "stdout": (stdout_bytes or b"").decode().strip(),
            "stderr": (stderr_bytes or b"").decode().strip(),
        }
    except asyncio.TimeoutError:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": "Script timed out after 60 seconds",
        }
    except Exception as e:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": str(e),
        }


async def _handler(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: Optional["State"] = None,
    options: Optional[HandlerOptions] = None,
    callback: Optional[HandlerCallback] = None,
    _memories: Optional[list] = None,
) -> Optional[ActionResult]:
    try:
        service = _get_service(runtime)
        if service is None:
            raise RuntimeError("AgentSkillsService not available")

        # Parse options
        skill_slug: Optional[str] = None
        script_name: Optional[str] = None
        args: list[str] = []

        if options:
            skill_slug = getattr(options, "skill_slug", None) or getattr(options, "skillSlug", None)
            script_name = getattr(options, "script", None)
            args = getattr(options, "args", []) or []

        if not skill_slug or not script_name:
            return ActionResult(
                success=False,
                error="Both skillSlug and script are required",
            )

        # Get script path
        script_path = service.get_script_path(skill_slug, script_name)
        if not script_path:
            return ActionResult(
                success=False,
                error=f'Script "{script_name}" not found in skill "{skill_slug}"',
            )

        # Execute script
        result = await _execute_script(script_path, args)

        if result["success"]:
            text = f"Script executed successfully:\n```\n{result['stdout']}\n```"
        else:
            text = f"Script failed:\n```\n{result['stderr']}\n```"

        if callback:
            await callback({"text": text})

        return ActionResult(
            success=bool(result["success"]),
            text=text,
        )

    except Exception as e:
        error_msg = str(e)
        if callback:
            await callback({"text": f"Error executing script: {error_msg}"})
        return ActionResult(success=False, error=error_msg)


run_skill_script_action = Action(
    name="RUN_SKILL_SCRIPT",
    description="Execute a script bundled with an installed skill. Provide skill slug and script name.",
    handler=_handler,
    validate=_validate,
    similes=["EXECUTE_SKILL_SCRIPT", "SKILL_SCRIPT"],
)
