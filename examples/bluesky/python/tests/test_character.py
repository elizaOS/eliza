"""Tests for the character configuration."""

from __future__ import annotations

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from character import character


class TestCharacter:
    """Tests for character configuration."""

    def test_has_name(self) -> None:
        """Character should have a name."""
        assert character.name == "BlueSkyBot"

    def test_has_bio(self) -> None:
        """Character should have a bio."""
        assert character.bio is not None
        assert len(character.bio) > 0

    def test_has_system_prompt(self) -> None:
        """Character should have a system prompt."""
        assert character.system is not None
        assert "Bluesky" in character.system

    def test_has_topics(self) -> None:
        """Character should have topics."""
        assert character.topics is not None
        assert len(character.topics) > 0

    def test_has_adjectives(self) -> None:
        """Character should have adjectives."""
        assert character.adjectives is not None
        assert len(character.adjectives) > 0

    def test_has_message_examples(self) -> None:
        """Character should have message examples for few-shot learning."""
        assert character.message_examples is not None
        assert len(character.message_examples) > 0

    def test_has_post_examples(self) -> None:
        """Character should have post examples for automated posting."""
        assert character.post_examples is not None
        assert len(character.post_examples) > 0

    def test_has_style_guidelines(self) -> None:
        """Character should have style guidelines."""
        assert character.style is not None
        assert "all" in character.style
