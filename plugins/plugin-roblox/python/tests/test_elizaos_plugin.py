from __future__ import annotations

from elizaos_plugin_roblox.plugin import create_roblox_elizaos_plugin


def test_create_plugin_smoke() -> None:
    plugin = create_roblox_elizaos_plugin()
    assert plugin.name == "roblox"
    assert plugin.services is not None
    assert plugin.actions is not None
    assert len(plugin.actions) >= 2

