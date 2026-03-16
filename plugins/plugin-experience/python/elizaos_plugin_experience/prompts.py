from __future__ import annotations

EXTRACT_EXPERIENCES_TEMPLATE: str

try:
    from elizaos_plugin_experience._generated_prompts import (
        EXTRACT_EXPERIENCES_TEMPLATE as _EXTRACT_EXPERIENCES_TEMPLATE,
    )

    EXTRACT_EXPERIENCES_TEMPLATE = _EXTRACT_EXPERIENCES_TEMPLATE
except ImportError as err:
    # Generated prompts not available - this should not happen in production
    # Prompts should be generated via build:prompts script
    raise ImportError(
        "Generated prompts not found. Run 'npm run build:prompts' to generate prompts."
    ) from err


def build_extract_experiences_prompt(conversation_context: str, existing_experiences: str) -> str:
    return (
        EXTRACT_EXPERIENCES_TEMPLATE.replace("{{conversation_context}}", conversation_context)
        .replace("{{existing_experiences}}", existing_experiences)
        .strip()
    )


__all__ = [
    "EXTRACT_EXPERIENCES_TEMPLATE",
    "build_extract_experiences_prompt",
]
