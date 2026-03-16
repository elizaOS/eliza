"""
Get Skill Guidance Action

Main action for skill-powered assistance. When the agent needs guidance
on how to do something, this action:

1. Checks if a matching skill is already installed (fast)
2. If not, searches the registry for a relevant skill
3. Auto-installs the best match if found
4. Returns the skill instructions
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
from ..types import Skill


def _get_service(runtime: "IAgentRuntime") -> Optional[AgentSkillsService]:
    return getattr(runtime, "_agent_skills_service", None)


_STOP_WORDS = {
    "search", "find", "look", "for", "a", "an", "the", "skill", "skills",
    "please", "can", "you", "help", "me", "with", "how", "to", "do", "i",
    "need", "want", "get", "use", "using", "about", "is", "are", "there",
    "any", "some", "show", "list", "give", "tell", "what", "which",
}


def _extract_search_terms(query: str) -> str:
    """Extract meaningful search terms from a query."""
    cleaned = query.lower()
    cleaned = re.sub(r"\b(on|in|from|at)\s+(clawhub|registry)\b", "", cleaned)
    cleaned = re.sub(r"\b(clawhub|registry)\s+(catalog|platform|site)\b", "", cleaned)
    words = [
        w for w in re.sub(r"[^\w\s-]", " ", cleaned).split()
        if len(w) > 1 and w not in _STOP_WORDS
    ]
    return " ".join(words) or query.lower()


def _find_best_local_match(
    skills: list[Skill], query: str
) -> Optional[tuple[Skill, int]]:
    """Find the best matching skill from installed skills."""
    query_lower = query.lower()
    query_words = [w for w in query_lower.split() if len(w) > 2]
    best: Optional[tuple[Skill, int]] = None

    for skill in skills:
        score = 0
        slug_lower = skill.slug.lower()
        name_lower = skill.name.lower()

        if query_lower in slug_lower or any(
            slug_lower.find(w) >= 0 for w in query_words if len(w) > 3
        ):
            score += 10

        if query_lower in name_lower or any(
            name_lower.find(w) >= 0 for w in query_words if len(w) > 3
        ):
            score += 8

        if score > 0 and (best is None or score > best[1]):
            best = (skill, score)

    return best


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

        query = (message.content.text if message.content else "") or ""
        if len(query) < 3:
            return ActionResult(success=False, error="Query too short")

        search_terms = _extract_search_terms(query)

        # Step 1: Search registry for best match
        search_results = await service.search(search_terms, limit=5)

        # Step 2: Check installed skills
        installed_skills = service.get_loaded_skills()
        local_match = _find_best_local_match(installed_skills, search_terms)

        # Step 3: Decide best option
        best_remote = search_results[0] if search_results else None
        remote_score = best_remote.score * 100 if best_remote else 0
        local_is_strong = local_match is not None and local_match[1] >= 8

        if not best_remote or (best_remote.score < 0.25 and not local_is_strong):
            text = f'I couldn\'t find a specific skill for "{search_terms}". I\'ll do my best with my general knowledge.'
            if callback:
                await callback({"text": text})
            return ActionResult(success=True, text=text)

        # Prefer local if strong match
        use_local = local_is_strong and (
            not best_remote or local_match[1] >= remote_score  # type: ignore[index]
        )

        if use_local and local_match:
            skill, _ = local_match
            instructions = service.get_skill_instructions(skill.slug)
            return await _build_success_result(
                skill, instructions.body if instructions else None, "local", callback
            )

        if not best_remote:
            text = f'I couldn\'t find a specific skill for "{search_terms}".'
            if callback:
                await callback({"text": text})
            return ActionResult(success=True, text=text)

        # Step 4: Auto-install the best remote skill
        already_installed = service.get_loaded_skill(best_remote.slug)

        if not already_installed:
            installed = await service.install(best_remote.slug)
            if not installed:
                if local_match:
                    skill, _ = local_match
                    instructions = service.get_skill_instructions(skill.slug)
                    return await _build_success_result(
                        skill, instructions.body if instructions else None, "local", callback
                    )
                text = f'Found "{best_remote.display_name}" skill but couldn\'t install it.'
                if callback:
                    await callback({"text": text})
                return ActionResult(success=True, text=text)

        # Step 5: Return installed skill instructions
        loaded = service.get_loaded_skill(best_remote.slug)
        instructions = service.get_skill_instructions(best_remote.slug) if loaded else None

        if loaded:
            return await _build_success_result(
                loaded,
                instructions.body if instructions else None,
                "local" if already_installed else "installed",
                callback,
            )

        # Fallback: build a minimal skill object
        fallback_skill = Skill(
            slug=best_remote.slug,
            name=best_remote.display_name,
            description=best_remote.summary,
            version=best_remote.version,
            content="",
            frontmatter=None,  # type: ignore[arg-type]
            path="",
            scripts=[],
            references=[],
            assets=[],
            loaded_at=0,
        )
        return await _build_success_result(fallback_skill, None, "installed", callback)

    except Exception as e:
        error_msg = str(e)
        if callback:
            await callback({"text": f"Error finding skill guidance: {error_msg}"})
        return ActionResult(success=False, error=error_msg)


async def _build_success_result(
    skill: Skill,
    instructions: Optional[str],
    source: str,
    callback: Optional[HandlerCallback],
) -> ActionResult:
    """Build a success result with skill instructions."""
    text = f"## {skill.name}\n\n"

    if source == "installed":
        text += "*Skill installed from registry*\n\n"

    text += f"{skill.description}\n\n"

    if instructions:
        max_len = 3500
        truncated = (
            instructions[:max_len] + "\n\n...[truncated]"
            if len(instructions) > max_len
            else instructions
        )
        text += f"### Instructions\n\n{truncated}"

    if callback:
        await callback({"text": text, "actions": ["GET_SKILL_GUIDANCE"]})

    return ActionResult(success=True, text=text)


get_skill_guidance_action = Action(
    name="GET_SKILL_GUIDANCE",
    description="Search for and get skill instructions. Use when user asks to find a skill or when you need instructions for a capability.",
    handler=_handler,
    validate=_validate,
    similes=[
        "FIND_SKILL", "SEARCH_SKILLS", "SKILL_HELP", "HOW_TO",
        "GET_INSTRUCTIONS", "LEARN_SKILL", "LOOKUP_SKILL",
    ],
)
