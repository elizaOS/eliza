"""
Agent Skills Plugin for elizaOS (Python)

Provides seamless access to Agent Skills with:
- Progressive disclosure (metadata → instructions → resources)
- ClawHub registry integration for skill discovery
- Otto compatibility for dependency management
- Background catalog sync

See: https://agentskills.io
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Dict, List, Optional

from elizaos.logger import create_logger
from elizaos.types.components import Provider, ProviderResult
from elizaos.types.plugin import Plugin

from .service import AgentSkillsService
from .types import Skill, SkillCatalogEntry

from .actions import (
    search_skills_action,
    get_skill_details_action,
    get_skill_guidance_action,
    sync_catalog_action,
    run_skill_script_action,
)

if TYPE_CHECKING:
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

logger = create_logger(namespace="plugin-agent-skills")

# Shared service instance
_service: Optional[AgentSkillsService] = None


def _get_or_create_service(runtime: "IAgentRuntime") -> AgentSkillsService:
    """Get or create the shared service instance."""
    global _service
    if _service is None:
        _service = AgentSkillsService(runtime)
    return _service


# ============================================================
# PROVIDERS
# ============================================================


async def skills_summary_provider_get(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: Optional["State"] = None,
) -> ProviderResult:
    """
    Skills Summary Provider (Medium Resolution)

    Lists installed skills with their descriptions.
    """
    service = _get_or_create_service(runtime)
    skills = service.get_loaded_skills()

    if not skills:
        return ProviderResult(
            text="**Skills:** None installed. Use GET_SKILL_GUIDANCE to find and install skills.",
            values={"skill_count": 0},
            data={"skills": []},
        )

    xml = service.generate_skills_prompt_xml(include_location=True)

    text = f"""## Installed Skills ({len(skills)})

{xml}

*More skills available via GET_SKILL_GUIDANCE*"""

    return ProviderResult(
        text=text,
        values={
            "skill_count": len(skills),
            "installed_skills": ", ".join(s.slug for s in skills),
        },
        data={
            "skills": [
                {
                    "slug": s.slug,
                    "name": s.name,
                    "description": s.description,
                    "version": s.version,
                }
                for s in skills
            ]
        },
    )


async def skill_instructions_provider_get(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: Optional["State"] = None,
) -> ProviderResult:
    """
    Skill Instructions Provider (High Resolution)

    Provides full instructions from the most relevant skill.
    """
    service = _get_or_create_service(runtime)
    skills = service.get_loaded_skills()

    if not skills:
        return ProviderResult(text="")

    message_text = (message.content.text if message.content else "").lower()
    recent_context = _get_recent_context(state)
    full_context = f"{message_text} {recent_context}".lower()

    # Score skills
    scored = [
        (skill, _calculate_relevance(skill, full_context)) for skill in skills
    ]
    scored = [(s, score) for s, score in scored if score > 0]
    scored.sort(key=lambda x: x[1], reverse=True)

    if not scored or scored[0][1] < 3:
        return ProviderResult(text="")

    top_skill, score = scored[0]
    instructions = service.get_skill_instructions(top_skill.slug)

    if not instructions:
        return ProviderResult(text="")

    # Truncate if needed
    max_chars = 4000
    body = instructions.body
    if len(body) > max_chars:
        body = body[:max_chars] + "\n\n...[truncated]"

    text = f"""## Active Skill: {top_skill.name}

{body}"""

    return ProviderResult(
        text=text,
        values={
            "active_skill": top_skill.slug,
            "skill_name": top_skill.name,
            "relevance_score": score,
            "estimated_tokens": instructions.estimated_tokens,
        },
        data={
            "active_skill": {
                "slug": top_skill.slug,
                "name": top_skill.name,
                "score": score,
            },
            "other_matches": [
                {"slug": s.slug, "score": sc} for s, sc in scored[1:3]
            ],
        },
    )


def _get_recent_context(state: Optional["State"]) -> str:
    """Extract recent context from state."""
    if not state:
        return ""
    recent = getattr(state, "recent_messages", None) or getattr(
        state, "recent_messages_data", []
    )
    if isinstance(recent, list):
        return " ".join(
            m.content.text if hasattr(m, "content") and m.content else ""
            for m in recent[-5:]
        )
    return ""


def _calculate_relevance(skill: Skill, context: str) -> int:
    """Calculate skill relevance score."""
    score = 0
    context_lower = context.lower()

    # Exact slug match
    if skill.slug.lower() in context_lower:
        score += 10

    # Name match
    if skill.name.lower() in context_lower:
        score += 8

    # Keyword matches
    name_words = [w for w in skill.name.split("-") if len(w) > 3]
    for word in name_words:
        if word.lower() in context_lower:
            score += 2

    # Description keywords
    stopwords = {
        "the", "and", "for", "with", "this", "that", "from", "will",
        "can", "are", "use", "when", "how", "what", "your", "you",
        "skill", "agent", "search", "install",
    }
    desc_words = skill.description.lower().split()
    for word in desc_words:
        if len(word) > 4 and word not in stopwords and word in context_lower:
            score += 1

    return score


# Provider definitions
skills_summary_provider = Provider(
    name="agent_skills",
    description="Medium-res list of installed Agent Skills with descriptions",
    dynamic=False,
    get=skills_summary_provider_get,
)

skill_instructions_provider = Provider(
    name="agent_skill_instructions",
    description="High-res instructions from the most relevant skill",
    dynamic=False,
    get=skill_instructions_provider_get,
)


# ============================================================
# PLUGIN INITIALIZATION
# ============================================================


async def plugin_init(config: Dict[str, object], runtime: "IAgentRuntime") -> None:
    """Initialize the Agent Skills plugin."""
    logger.info("Initializing Agent Skills plugin")

    service = _get_or_create_service(runtime)
    await service.initialize()

    logger.info(f"Agent Skills: {len(service.get_loaded_skills())} skills loaded")


# Plugin definition
plugin = Plugin(
    name="plugin-agent-skills",
    description="Agent Skills - modular capabilities with progressive disclosure",
    init=plugin_init,
    config={
        "SKILLS_DIR": os.getenv("SKILLS_DIR", "./skills"),
        "SKILLS_AUTO_LOAD": os.getenv("SKILLS_AUTO_LOAD", "true"),
        "SKILLS_REGISTRY": os.getenv("SKILLS_REGISTRY", "https://clawhub.ai"),
    },
    actions=[
        search_skills_action,
        get_skill_details_action,
        get_skill_guidance_action,
        sync_catalog_action,
        run_skill_script_action,
    ],
    providers=[skills_summary_provider, skill_instructions_provider],
    services=[],
    models={},
    tests=[],
)

# Alias for backwards compatibility
agent_skills_plugin = plugin

__all__ = ["plugin", "agent_skills_plugin"]
