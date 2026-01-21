from typing import TYPE_CHECKING

from elizaos_plugin_eliza_classic.plugin import generate_response

if TYPE_CHECKING:
    from collections.abc import Mapping


class GenerateResponseAction:
    @property
    def name(self) -> str:
        return "generate-response"

    @property
    def description(self) -> str:
        return (
            "Generate an ELIZA response for user input using classic pattern matching."
        )

    @property
    def similes(self) -> list[str]:
        return [
            "ELIZA_RESPOND",
            "ELIZA_CHAT",
            "CLASSIC_ELIZA",
            "chat",
            "respond",
            "talk",
        ]

    async def validate(self, context: "Mapping[str, object] | object") -> bool:
        return True

    async def handler(
        self, context: "Mapping[str, object] | object"
    ) -> dict[str, object]:
        message = context.get("message", {}) if isinstance(context, dict) else {}
        content = message.get("content", {}) if isinstance(message, dict) else {}

        if isinstance(content, dict):
            user_input = content.get("text", "")
        else:
            user_input = str(content) if content else ""

        options = context.get("options", {}) if isinstance(context, dict) else {}
        if not user_input and isinstance(options, dict):
            user_input = (
                options.get("input", "")
                or options.get("prompt", "")
                or options.get("text", "")
            )

        if not user_input.strip():
            return {
                "success": False,
                "error": "No user input provided",
            }

        response = generate_response(user_input)

        return {
            "success": True,
            "text": response,
        }
