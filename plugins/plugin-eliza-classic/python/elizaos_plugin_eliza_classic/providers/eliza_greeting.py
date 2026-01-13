from typing import TYPE_CHECKING

from elizaos_plugin_eliza_classic.plugin import get_greeting

if TYPE_CHECKING:
    from collections.abc import Mapping


class ElizaGreetingProvider:
    @property
    def name(self) -> str:
        return "eliza-greeting"

    @property
    def description(self) -> str:
        return "Provides the ELIZA greeting message."

    async def get(self, context: "Mapping[str, object] | object") -> dict[str, object]:
        greeting = get_greeting()

        return {
            "text": greeting,
            "values": {"greeting": greeting},
            "data": {"greeting": greeting},
        }
