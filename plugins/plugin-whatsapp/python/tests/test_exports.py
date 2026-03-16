from elizaos_plugin_whatsapp import (
    WHATSAPP_SERVICE_NAME,
    WhatsAppService,
    chat_state_provider,
    create_plugin,
    send_message_action,
)


def test_plugin_metadata() -> None:
    plugin = create_plugin()
    assert plugin.name == WHATSAPP_SERVICE_NAME
    assert "WhatsApp" in plugin.description
    assert isinstance(plugin.actions, list)
    assert isinstance(plugin.providers, list)
    assert isinstance(plugin.services, list)


def test_plugin_exports() -> None:
    assert WhatsAppService is not None
    assert send_message_action is not None
    assert chat_state_provider is not None
