from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ProviderParams:
    conversation_id: str
    agent_id: str


@dataclass
class ProviderResult:
    values: dict[str, str]
    text: str
    data: dict[str, object]


@dataclass
class GameStateProvider:
    @property
    def name(self) -> str:
        return "roblox-game-state"

    @property
    def description(self) -> str:
        return "Provides information about the connected Roblox game/experience"

    @property
    def position(self) -> int:
        return 50

    async def get(self, params: ProviderParams) -> ProviderResult:
        values = {
            "universeId": "N/A",
            "placeId": "N/A",
            "experienceName": "N/A",
        }

        text = "Roblox service not connected. Configure ROBLOX_API_KEY and ROBLOX_UNIVERSE_ID to enable."

        data: dict[str, object] = {
            "connected": False,
        }

        return ProviderResult(values=values, text=text, data=data)
