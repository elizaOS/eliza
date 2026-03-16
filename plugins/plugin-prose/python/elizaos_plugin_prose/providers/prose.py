"""Prose provider for context injection."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from elizaos_plugin_prose.services.prose_service import ProseService
from elizaos_plugin_prose.types import ProseStateMode

logger = logging.getLogger(__name__)


@dataclass
class ProseProvider:
    """Provider that supplies OpenProse VM context."""

    name: str = "prose"
    description: str = "Provides OpenProse VM context for running and authoring .prose programs"
    position: int = 100

    _service: ProseService | None = None

    async def get(
        self,
        message: dict[str, Any],
        state: dict[str, Any] | None = None,
        service: ProseService | None = None,
    ) -> dict[str, Any]:
        """Get OpenProse VM context for the agent."""
        if service:
            self._service = service

        if self._service is None:
            self._service = ProseService()

        content = message.get("content", {})
        text = content.get("text", "") if isinstance(content, dict) else str(content)
        lower = text.lower()

        # Detect prose-related commands
        is_prose_run = "prose run" in lower or ("run" in lower and ".prose" in lower)
        is_prose_compile = "prose compile" in lower or (
            "validate" in lower and ".prose" in lower
        )
        is_prose_help = (
            "prose help" in lower
            or "prose examples" in lower
            or "prose syntax" in lower
            or "how do i write a prose" in lower
        )
        is_prose_update = "prose update" in lower

        # Not a prose command - return minimal context
        if not is_prose_run and not is_prose_compile and not is_prose_help and not is_prose_update:
            # Check if there's an active prose run in state
            active_run_id = (state or {}).get("proseRunId")
            if not active_run_id:
                return {
                    "values": {"available": True},
                    "text": 'OpenProse is available. Use "prose run <file>" to execute programs, "prose help" for guidance.',
                    "data": {"available": True},
                }

        # Get state mode from state or default
        state_mode_str = (state or {}).get("proseStateMode", "filesystem")
        try:
            state_mode = ProseStateMode(state_mode_str)
        except ValueError:
            state_mode = ProseStateMode.FILESYSTEM

        # For help/examples, return the skill spec and help docs
        if is_prose_help:
            skill_spec = self._service.get_skill_spec()
            help_doc = self._service.get_help()
            examples = await self._service.list_examples()

            parts: list[str] = []

            if skill_spec:
                parts.append("## OpenProse Skill\n")
                parts.append(skill_spec)

            if help_doc:
                parts.append("\n## Help Documentation\n")
                parts.append(help_doc)

            if examples:
                parts.append("\n## Available Examples\n")
                parts.append("The following example programs are available:\n")
                for ex in examples:
                    parts.append(f"- {ex}")
                parts.append('\nUse "prose run examples/<name>" to run one.')

            return {
                "values": {"available": True, "mode": "help"},
                "text": "\n".join(parts),
                "data": {"available": True, "mode": "help"},
            }

        # For compile/validate, include compiler spec
        if is_prose_compile:
            context = self._service.build_vm_context(
                state_mode=state_mode,
                include_compiler=True,
                include_guidance=True,
            )
            return {
                "values": {"available": True, "mode": "compile"},
                "text": context,
                "data": {"available": True, "mode": "compile"},
            }

        # For run or update, return full VM context
        if is_prose_run or is_prose_update:
            context = self._service.build_vm_context(
                state_mode=state_mode,
                include_compiler=False,
                include_guidance=False,
            )
            return {
                "values": {"available": True, "mode": "run"},
                "text": context,
                "data": {"available": True, "mode": "run", "stateMode": state_mode.value},
            }

        # Default: minimal context
        return {
            "values": {"available": True},
            "text": f"OpenProse VM is ready. Active state mode: {state_mode.value}",
            "data": {"available": True, "stateMode": state_mode.value},
        }
