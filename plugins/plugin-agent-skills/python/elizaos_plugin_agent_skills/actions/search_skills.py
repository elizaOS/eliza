"""
Search Skills Action

Search the skill registry for available skills by keyword or category.
"""

from __future__ import annotations

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
    """Get the AgentSkillsService from the runtime."""
    return getattr(runtime, "_agent_skills_service", None)


async def _validate(
    runtime: "IAgentRuntime",
    _message: "Memory",
    _state: Optional["State"] = None,
) -> bool:
    return _get_service(runtime) is not None


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

        query = message.content.text if message.content else ""
        results = await service.search(query or "", limit=10)

        if not results:
            text = f'No skills found matching "{query}".'
            if callback:
                await callback({"text": text})
            return ActionResult(success=True, text=text)

        skill_list = "\n\n".join(
            f"{i + 1}. **{r.display_name}** (`{r.slug}`)\n   {r.summary}"
            for i, r in enumerate(results)
        )

        text = (
            f'## Skills matching "{query}"\n\n'
            f"{skill_list}\n\n"
            "Use GET_SKILL_GUIDANCE with a skill name to get detailed instructions."
        )

        if callback:
            await callback({"text": text})

        return ActionResult(success=True, text=text)

    except Exception as e:
        error_msg = str(e)
        if callback:
            await callback({"text": f"Error searching skills: {error_msg}"})
        return ActionResult(success=False, error=error_msg)


search_skills_action = Action(
    name="SEARCH_SKILLS",
    description="Search the skill registry for available skills by keyword or category.",
    handler=_handler,
    validate=_validate,
    similes=["BROWSE_SKILLS", "LIST_SKILLS", "FIND_SKILLS"],
)
