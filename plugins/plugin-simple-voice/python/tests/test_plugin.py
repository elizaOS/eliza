"""Tests for plugin module."""

from eliza_plugin_simple_voice import (
    SamTTSOptions,
    SamTTSService,
    say_aloud_action,
    simple_voice_plugin,
)
from eliza_plugin_simple_voice.plugin import SimpleVoicePlugin


class TestSimpleVoicePluginMetadata:
    """Tests for SimpleVoicePlugin metadata."""

    def test_plugin_name(self) -> None:
        """Test plugin name."""
        assert simple_voice_plugin.name == "@elizaos/plugin-simple-voice"

    def test_plugin_description(self) -> None:
        """Test plugin description contains SAM."""
        assert "SAM" in simple_voice_plugin.description

    def test_plugin_description_contains_tts(self) -> None:
        """Test plugin description mentions text-to-speech."""
        desc_lower = simple_voice_plugin.description.lower()
        assert "text-to-speech" in desc_lower or "tts" in desc_lower or "speech" in desc_lower


class TestSimpleVoicePluginActions:
    """Tests for SimpleVoicePlugin actions."""

    def test_has_one_action(self) -> None:
        """Test plugin registers one action."""
        assert len(simple_voice_plugin.actions) == 1

    def test_action_is_say_aloud(self) -> None:
        """Test registered action is SAY_ALOUD."""
        assert simple_voice_plugin.actions[0].name == "SAY_ALOUD"

    def test_action_is_same_instance(self) -> None:
        """Test registered action is say_aloud_action instance."""
        assert simple_voice_plugin.actions[0] is say_aloud_action


class TestSimpleVoicePluginServices:
    """Tests for SimpleVoicePlugin services."""

    def test_has_one_service(self) -> None:
        """Test plugin registers one service."""
        assert len(simple_voice_plugin.services) == 1

    def test_service_is_sam_tts(self) -> None:
        """Test registered service is SamTTSService."""
        assert simple_voice_plugin.services[0] is SamTTSService


class TestSimpleVoicePluginClass:
    """Tests for SimpleVoicePlugin class."""

    def test_can_create_new_instance(self) -> None:
        """Test creating new plugin instance."""
        plugin = SimpleVoicePlugin()
        assert plugin.name == "@elizaos/plugin-simple-voice"

    def test_default_values(self) -> None:
        """Test default values are set correctly."""
        plugin = SimpleVoicePlugin()
        assert len(plugin.actions) == 1
        assert len(plugin.services) == 1

    def test_custom_values(self) -> None:
        """Test custom values can be set."""
        plugin = SimpleVoicePlugin(name="custom-name", description="custom description")
        assert plugin.name == "custom-name"
        assert plugin.description == "custom description"


class TestPluginExports:
    """Tests for plugin module exports."""

    def test_exports_sam_tts_options(self) -> None:
        """Test SamTTSOptions is exported."""
        assert SamTTSOptions is not None
        options = SamTTSOptions()
        assert options.speed == 72

    def test_exports_sam_tts_service(self) -> None:
        """Test SamTTSService is exported."""
        assert SamTTSService is not None
        assert SamTTSService.service_type == "SAM_TTS"

    def test_exports_say_aloud_action(self) -> None:
        """Test say_aloud_action is exported."""
        assert say_aloud_action is not None
        assert say_aloud_action.name == "SAY_ALOUD"

    def test_exports_simple_voice_plugin(self) -> None:
        """Test simple_voice_plugin is exported."""
        assert simple_voice_plugin is not None
        assert simple_voice_plugin.name == "@elizaos/plugin-simple-voice"
