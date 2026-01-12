from typing import TYPE_CHECKING

from elizaos_plugin_eliza_classic.plugin import get_greeting

if TYPE_CHECKING:
    from typing import Any


class ElizaGreetingProvider:
    @property
    def name(self) -> str:
        return "eliza-greeting"

    @property
    def description(self) -> str:
        return "Provides the ELIZA greeting message."

    async def get(self, context: "Any") -> dict[str, "Any"]:
        greeting = get_greeting()

        return {
            "text": greeting,
            "values": {"greeting": greeting},
            "data": {"greeting": greeting},
        }
