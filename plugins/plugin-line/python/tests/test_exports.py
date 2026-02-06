from elizaos_plugin_line import (
    LineService,
    chat_context_provider,
    get_plugin,
    send_flex_message_action,
    send_location_action,
    send_message_action,
    user_context_provider,
)


def test_plugin_metadata() -> None:
    plugin = get_plugin()
    assert plugin["name"] == "line"
    assert "LINE" in plugin["description"]
    assert isinstance(plugin["actions"], list)
    assert isinstance(plugin["providers"], list)
    assert isinstance(plugin["services"], list)


def test_plugin_exports() -> None:
    assert LineService is not None
    assert send_message_action is not None
    assert send_flex_message_action is not None
    assert send_location_action is not None
    assert chat_context_provider is not None
    assert user_context_provider is not None
