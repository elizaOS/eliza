"""Tests for SWE-bench character."""

import pytest

from benchmarks.swe_bench.character import (
    SWE_BENCH_MESSAGE_HANDLER_TEMPLATE,
    SWE_BENCH_REPLY_TEMPLATE,
    create_swe_bench_character,
    swe_bench_character,
)


class TestCharacterTemplates:
    """Test character templates."""

    def test_message_handler_template_has_required_elements(self) -> None:
        """Test message handler template has all required elements."""
        template = SWE_BENCH_MESSAGE_HANDLER_TEMPLATE
        
        # Should have provider injection point
        assert "{{providers}}" in template
        
        # Should have recent messages injection point
        assert "{{recentMessages}}" in template
        
        # Should describe XML response format
        assert "<response>" in template
        assert "<thought>" in template
        assert "<text>" in template
        assert "<actions>" in template
        assert "<params>" in template
        
        # Should have examples of all actions
        assert "SEARCH_CODE" in template
        assert "READ_FILE" in template
        assert "EDIT_FILE" in template
        assert "SUBMIT" in template

    def test_reply_template_has_required_elements(self) -> None:
        """Test reply template has required elements."""
        template = SWE_BENCH_REPLY_TEMPLATE
        
        assert "{{providers}}" in template
        assert "<response>" in template


class TestCreateCharacter:
    """Test character creation."""

    def test_create_default_character(self) -> None:
        """Test creating character with default settings."""
        character = create_swe_bench_character()
        
        assert character.name == "SWE-Agent"
        assert character.username == "swe-agent"
        assert "software engineering" in character.bio.lower()

    def test_create_custom_name_character(self) -> None:
        """Test creating character with custom name."""
        character = create_swe_bench_character(name="CustomAgent")
        
        assert character.name == "CustomAgent"

    def test_create_custom_model_character(self) -> None:
        """Test creating character with custom model."""
        character = create_swe_bench_character(model_name="gpt-4-turbo")
        
        assert character.settings is not None
        assert character.settings.get("model") == "gpt-4-turbo"

    def test_character_has_check_should_respond_disabled(self) -> None:
        """Test character has CHECK_SHOULD_RESPOND disabled."""
        character = create_swe_bench_character()
        
        assert character.settings is not None
        assert character.settings.get("CHECK_SHOULD_RESPOND") is False

    def test_character_has_action_planning_enabled(self) -> None:
        """Test character has ACTION_PLANNING enabled."""
        character = create_swe_bench_character()
        
        assert character.settings is not None
        assert character.settings.get("ACTION_PLANNING") is True

    def test_character_has_templates(self) -> None:
        """Test character has custom templates."""
        character = create_swe_bench_character()
        
        assert character.templates is not None
        assert "messageHandlerTemplate" in character.templates
        assert "replyTemplate" in character.templates

    def test_character_has_system_prompt(self) -> None:
        """Test character has system prompt."""
        character = create_swe_bench_character()
        
        assert character.system is not None
        assert "software engineering" in character.system.lower()
        assert "systematic" in character.system.lower() or "analyze" in character.system.lower()


class TestDefaultCharacter:
    """Test default character instance."""

    def test_default_character_exists(self) -> None:
        """Test default character instance exists."""
        assert swe_bench_character is not None
        assert swe_bench_character.name == "SWE-Agent"

    def test_default_character_has_templates(self) -> None:
        """Test default character has templates."""
        assert swe_bench_character.templates is not None
        assert "messageHandlerTemplate" in swe_bench_character.templates
