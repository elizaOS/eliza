from __future__ import annotations

from elizaos_plugin_eliza_coder.providers import CoderStatusProvider
from elizaos_plugin_eliza_coder.service import CoderService


async def test_coder_status_provider(service: CoderService) -> None:
    provider = CoderStatusProvider()
    result = await provider.get(
        {"room_id": "room-1", "agent_id": "agent-1", "content": {"text": ""}}, {}, service
    )
    assert result.values["allowedDirectory"] == service.allowed_directory
