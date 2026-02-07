"""
Get Skill Details Action

Get detailed information about a specific skill from the registry.
"""

from __future__ import annotations

import re
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


def _extract_slug(text: str) -> Optional[str]:
    """Try to extract a slug-like pattern from text."""
    match = re.search(r"\b([a-z][a-z0-9-]*[a-z0-9])\b", text)
    return match.group(1) if match else None


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

        # Extract slug from options or message text
        slug: Optional[str] = None
        if options and hasattr(options, "slug"):
            slug = getattr(options, "slug", None)
        if not slug:
            text = message.content.text if message.content else ""
            slug = _extract_slug(text or "")

        if not slug:
            return ActionResult(success=False, error="Skill slug is required")

        details = await service.get_skill_details(slug)
        if details is None:
            text = f'Skill "{slug}" not found in the registry.'
            if callback:
                await callback({"text": text})
            return ActionResult(success=False, error=text)

        is_installed = service.is_installed(slug)

        status = "Installed" if is_installed else "Available"
        text = (
            f"## {details.display_name}\n\n"
            f"**Slug:** `{details.slug}`\n"
            f"**Version:** {details.latest_version}\n"
            f"**Status:** {status}\n\n"
            f"{details.summary}\n\n"
            f"**Stats:**\n"
            f"- Downloads: {details.stats.get('downloads', 0)}\n"
            f"- Stars: {details.stats.get('stars', 0)}\n"
            f"- Versions: {details.stats.get('versions', 0)}\n"
        )

        if details.owner_handle:
            text += f"\n**Author:** {details.owner_display_name or ''} (@{details.owner_handle})"

        if details.changelog:
            text += f"\n**Changelog:** {details.changelog}"

        if callback:
            await callback({"text": text})

        return ActionResult(success=True, text=text)

    except Exception as e:
        error_msg = str(e)
        if callback:
            await callback({"text": f"Error getting skill details: {error_msg}"})
        return ActionResult(success=False, error=error_msg)


get_skill_details_action = Action(
    name="GET_SKILL_DETAILS",
    description="Get detailed information about a specific skill including version, owner, and stats.",
    handler=_handler,
    validate=_validate,
    similes=["SKILL_INFO", "SKILL_DETAILS"],
)
