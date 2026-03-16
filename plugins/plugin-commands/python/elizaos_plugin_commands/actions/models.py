"""Models command action."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from elizaos_plugin_commands.actions.common import Message, get_text
from elizaos_plugin_commands.parser import parse_command
from elizaos_plugin_commands.registry import CommandRegistry
from elizaos_plugin_commands.types import CommandResult

_MODEL_DESCRIPTIONS: dict[str, str] = {
    "text_small": "Text (Small)",
    "text_large": "Text (Large)",
    "text_reasoning_small": "Reasoning (Small)",
    "text_reasoning_large": "Reasoning (Large)",
    "text_completion": "Text Completion",
    "text_embedding": "Embedding",
    "image": "Image Generation",
    "image_description": "Image Description",
    "transcription": "Transcription",
    "text_to_speech": "Text-to-Speech",
    "audio": "Audio",
    "video": "Video",
    "object_small": "Object (Small)",
    "object_large": "Object (Large)",
    "research": "Research",
}


def _describe_model_type(model_type: str) -> str:
    return _MODEL_DESCRIPTIONS.get(model_type, model_type)


@dataclass
class ModelsCommandAction:
    """MODELS_COMMAND - lists available models."""

    @property
    def name(self) -> str:
        return "MODELS_COMMAND"

    @property
    def similes(self) -> list[str]:
        return ["/models"]

    @property
    def description(self) -> str:
        return (
            "List available AI models and providers. "
            "Only activates for /models slash command."
        )

    async def validate(self, message: Message, _state: dict[str, object]) -> bool:
        text = get_text(message)
        parsed = parse_command(text)
        if parsed is None:
            return False
        return parsed.name == "models"

    async def handler(
        self,
        message: Message,
        state: dict[str, Any],
        registry: CommandRegistry | None = None,
    ) -> CommandResult:
        lines = ["**Available Models:**", ""]

        model_types = state.get("registered_model_types")
        if isinstance(model_types, list) and model_types:
            lines.append("**Registered Model Types:**")
            for mt in model_types:
                if isinstance(mt, str):
                    lines.append(f"  {_describe_model_type(mt)} (`{mt}`)")
        else:
            lines.append("No model information available.")

        # Show current configuration if available
        provider = message.get("model_provider") or state.get("model_provider")
        model_name = message.get("model_name") or state.get("model_name")

        if provider or model_name:
            lines.append("")
            lines.append("**Current Configuration:**")
            if provider:
                lines.append(f"  Provider: {provider}")
            if model_name:
                lines.append(f"  Model: {model_name}")

        lines.append("")
        lines.append("_Use /model <provider/model> to switch models._")

        text = "\n".join(lines)
        return CommandResult.ok(text)

    @property
    def examples(self) -> list[dict[str, str]]:
        return [
            {
                "user_message": "/models",
                "agent_response": "**Available Models:**\n\n**Registered Model Types:**\n  Text (Large) (`text_large`)\n  Text (Small) (`text_small`)...",
            },
        ]
