"""Tests for character utilities."""

import json
import os
import tempfile

import pytest

from elizaos.character import (
    CharacterLoadError,
    CharacterValidationError,
    build_character_plugins,
    load_character_from_file,
    merge_character_defaults,
    parse_character,
    validate_character_config,
)
from elizaos.types import Character


class TestParseCharacter:
    """Tests for parse_character function."""

    def test_parse_character_object(self) -> None:
        """Test parsing a Character object."""
        character = Character(name="Test", bio="A test agent")
        result = parse_character(character)
        assert result.name == "Test"
        assert result.bio == "A test agent"

    def test_parse_character_dict(self) -> None:
        """Test parsing a dictionary."""
        data = {"name": "Test", "bio": "A test agent"}
        result = parse_character(data)
        assert result.name == "Test"
        assert result.bio == "A test agent"

    def test_parse_character_invalid_dict(self) -> None:
        """Test parsing an invalid dictionary."""
        data = {"bio": "Missing name"}  # Missing required field
        with pytest.raises(CharacterValidationError):
            parse_character(data)

    def test_parse_character_file_path(self) -> None:
        """Test parsing from file path."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump({"name": "FileAgent", "bio": "From file"}, f)
            f.flush()

            try:
                result = parse_character(f.name)
                assert result.name == "FileAgent"
            finally:
                os.unlink(f.name)


class TestLoadCharacterFromFile:
    """Tests for load_character_from_file function."""

    def test_load_valid_file(self) -> None:
        """Test loading a valid character file."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(
                {
                    "name": "FileAgent",
                    "bio": "A file-based agent",
                    "topics": ["testing"],
                },
                f,
            )
            f.flush()

            try:
                result = load_character_from_file(f.name)
                assert result.name == "FileAgent"
                assert result.topics == ["testing"]
            finally:
                os.unlink(f.name)

    def test_load_nonexistent_file(self) -> None:
        """Test loading a nonexistent file."""
        with pytest.raises(CharacterLoadError, match="not found"):
            load_character_from_file("/nonexistent/path/character.json")

    def test_load_invalid_json(self) -> None:
        """Test loading a file with invalid JSON."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write("not valid json {")
            f.flush()

            try:
                with pytest.raises(CharacterLoadError, match="Invalid JSON"):
                    load_character_from_file(f.name)
            finally:
                os.unlink(f.name)


class TestValidateCharacterConfig:
    """Tests for validate_character_config function."""

    def test_valid_character(self) -> None:
        """Test validating a valid character."""
        character = Character(name="Test", bio="A test agent")
        result = validate_character_config(character)
        assert result["isValid"] is True
        assert result["errors"] == []

    def test_character_with_all_fields(self) -> None:
        """Test validating a fully configured character."""
        character = Character(
            name="CompleteAgent",
            username="complete",
            bio=["Line 1", "Line 2"],
            system="You are a complete agent.",
            topics=["all", "topics"],
            adjectives=["thorough", "complete"],
            plugins=["@elizaos/plugin-sql"],
        )
        result = validate_character_config(character)
        assert result["isValid"] is True


class TestMergeCharacterDefaults:
    """Tests for merge_character_defaults function."""

    def test_merge_empty(self) -> None:
        """Test merging with empty input."""
        result = merge_character_defaults({})
        assert result.name == "Unnamed Character"
        assert result.settings == {}
        assert result.plugins == []

    def test_merge_partial(self) -> None:
        """Test merging with partial input."""
        result = merge_character_defaults({"name": "CustomAgent", "bio": "Custom bio"})
        assert result.name == "CustomAgent"
        assert result.bio == "Custom bio"
        assert result.settings == {}

    def test_merge_preserves_values(self) -> None:
        """Test that merge preserves provided values."""
        result = merge_character_defaults(
            {
                "name": "Agent",
                "bio": "Bio",
                "settings": {"key": "value"},
                "plugins": ["plugin-1"],
            }
        )
        assert result.settings == {"key": "value"}
        assert result.plugins == ["plugin-1"]


class TestBuildCharacterPlugins:
    """Tests for build_character_plugins function."""

    def test_default_plugins(self) -> None:
        """Test building plugins with no env vars."""
        plugins = build_character_plugins({})
        assert "@elizaos/plugin-sql" in plugins
        # Bootstrap is now part of core and loaded automatically
        assert "@elizaos/plugin-ollama" in plugins  # Fallback

    def test_with_openai(self) -> None:
        """Test building plugins with OpenAI configured."""
        plugins = build_character_plugins({"OPENAI_API_KEY": "test-key"})
        assert "@elizaos/plugin-openai" in plugins
        assert "@elizaos/plugin-ollama" not in plugins  # No fallback needed

    def test_with_anthropic(self) -> None:
        """Test building plugins with Anthropic configured."""
        plugins = build_character_plugins({"ANTHROPIC_API_KEY": "test-key"})
        assert "@elizaos/plugin-anthropic" in plugins
        assert "@elizaos/plugin-ollama" not in plugins

    def test_with_discord(self) -> None:
        """Test building plugins with Discord configured."""
        plugins = build_character_plugins(
            {
                "DISCORD_API_TOKEN": "test-token",
                "OPENAI_API_KEY": "test-key",  # Need an LLM
            }
        )
        assert "@elizaos/plugin-discord" in plugins

    def test_bootstrap_in_core(self) -> None:
        """Test that bootstrap is not in plugins list (it's now part of core)."""
        plugins = build_character_plugins({})
        # Bootstrap is now part of core, not a separate plugin
        assert "@elizaos/plugin-bootstrap" not in plugins

    def test_plugin_order(self) -> None:
        """Test that plugins are in correct order."""
        plugins = build_character_plugins(
            {
                "OPENAI_API_KEY": "key1",
                "ANTHROPIC_API_KEY": "key2",
                "DISCORD_API_TOKEN": "token",
            }
        )
        # Core plugins first
        assert plugins.index("@elizaos/plugin-sql") == 0
        # Anthropic (text-only) before OpenAI (embedding-capable)
        assert plugins.index("@elizaos/plugin-anthropic") < plugins.index("@elizaos/plugin-openai")
        # Platform plugins after LLM plugins
        assert plugins.index("@elizaos/plugin-discord") > plugins.index("@elizaos/plugin-openai")


