"""Tests for ELIZA Classic Plugin."""

import pytest

from elizaos_plugin_eliza_classic import (
    ElizaClassicPlugin,
    generate_response,
    get_greeting,
    reflect,
)


class TestReflect:
    """Tests for pronoun reflection."""

    def test_reflect_i_to_you(self) -> None:
        assert reflect("i am happy") == "you are happy"

    def test_reflect_my_to_your(self) -> None:
        assert reflect("my car") == "your car"

    def test_reflect_you_to_me(self) -> None:
        assert reflect("you are nice") == "me are nice"

    def test_reflect_preserves_unknown_words(self) -> None:
        assert reflect("the cat sat") == "the cat sat"


class TestGenerateResponse:
    """Tests for response generation."""

    def test_greeting(self) -> None:
        response = generate_response("hello")
        assert response in [
            "How do you do. Please state your problem.",
            "Hi. What seems to be your problem?",
            "Hello. Tell me what's on your mind.",
        ]

    def test_sad_response(self) -> None:
        response = generate_response("I am sad")
        assert len(response) > 0
        # Should be a comforting response

    def test_family_response(self) -> None:
        response = generate_response("my mother is kind")
        assert len(response) > 0
        # Should mention family

    def test_computer_response(self) -> None:
        response = generate_response("I think about computers")
        assert len(response) > 0

    def test_empty_input(self) -> None:
        response = generate_response("")
        assert response == "I didn't catch that. Could you please repeat?"

    def test_default_response(self) -> None:
        # An input that won't match any pattern
        response = generate_response("xyzzy")
        assert len(response) > 0


class TestElizaClassicPlugin:
    """Tests for the plugin class."""

    def test_generate_response(self, plugin: ElizaClassicPlugin) -> None:
        response = plugin.generate_response("hello")
        assert len(response) > 0

    def test_get_greeting(self, plugin: ElizaClassicPlugin) -> None:
        greeting = plugin.get_greeting()
        assert "ELIZA" in greeting

    def test_reset_history(self, plugin: ElizaClassicPlugin) -> None:
        plugin.generate_response("hello")
        plugin.reset_history()
        # After reset, should still work
        response = plugin.generate_response("hello")
        assert len(response) > 0


class TestGetGreeting:
    """Tests for the greeting function."""

    def test_greeting_contains_eliza(self) -> None:
        greeting = get_greeting()
        assert "ELIZA" in greeting

    def test_greeting_is_string(self) -> None:
        greeting = get_greeting()
        assert isinstance(greeting, str)




