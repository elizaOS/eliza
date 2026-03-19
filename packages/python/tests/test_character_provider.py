"""Tests for the CHARACTER provider's context generation.

The character provider builds a structured text context from the character's
bio, adjectives, lore, topics, and style fields.

Note: We import the provider module carefully to avoid the circular import
between ``elizaos.basic_capabilities`` and ``elizaos.basic_capabilities``.
"""

from __future__ import annotations

import importlib
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

# ---------------------------------------------------------------------------
# Import helpers — break the circular import chain by pre-populating
# the problematic module paths with stubs before importing the provider.
# ---------------------------------------------------------------------------


def _import_character_provider():
    """Import the character provider module, bypassing circular import issues."""
    # Stub the generated spec helper so the module-level call succeeds
    _spec_mod = MagicMock()
    _spec_mod.require_provider_spec.return_value = {
        "name": "CHARACTER",
        "description": "Character provider",
        "dynamic": False,
    }
    saved = {}
    stubs = {
        "elizaos.generated.spec_helpers": _spec_mod,
    }
    for mod_name, stub in stubs.items():
        saved[mod_name] = sys.modules.get(mod_name)
        sys.modules[mod_name] = stub

    try:
        # Remove any partially-loaded module left by a failed prior import
        # so importlib picks up the stubs instead of the broken cache entry.
        sys.modules.pop("elizaos.basic_capabilities.providers.character", None)

        # Force a fresh import of just the character provider module
        mod = importlib.import_module("elizaos.basic_capabilities.providers.character")
        return mod
    finally:
        # Restore original module state
        for mod_name, original in saved.items():
            if original is None:
                sys.modules.pop(mod_name, None)
            else:
                sys.modules[mod_name] = original


# Try direct import first; fall back to stub-based import
try:
    from elizaos.basic_capabilities.providers.character import (
        get_character_context,
    )
except ImportError:
    _mod = _import_character_provider()
    get_character_context = _mod.get_character_context


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_character(
    name: str = "Sakuya",
    bio: list[str] | str | None = None,
    adjectives: list[str] | None = None,
    topics: list[str] | None = None,
    style: SimpleNamespace | None = None,
) -> SimpleNamespace:
    """Build a minimal character-like namespace for testing."""
    return SimpleNamespace(
        name=name,
        bio=bio or [],
        adjectives=adjectives or [],
        topics=topics or [],
        style=style,
    )


def _make_runtime(character: SimpleNamespace) -> SimpleNamespace:
    """Build a minimal runtime-like namespace for testing."""
    return SimpleNamespace(character=character)


def _make_style(
    all_: list[str] | None = None,
    chat: list[str] | None = None,
    post: list[str] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        all=all_ or [],
        chat=chat or [],
        post=post or [],
    )


# ---------------------------------------------------------------------------
# Integration tests for the full provider
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestCharacterProvider:
    async def test_agent_name_in_header(self) -> None:
        character = _make_character(name="Reimu")
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "# Agent: Reimu" in result.text

    async def test_bio_list(self) -> None:
        character = _make_character(
            bio=["A time-stopping maid.", "Works at the mansion."],
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "A time-stopping maid." in result.text
        assert "Works at the mansion." in result.text

    async def test_bio_string(self) -> None:
        character = _make_character(bio="An elegant maid.")
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "An elegant maid." in result.text

    async def test_adjectives(self) -> None:
        character = _make_character(
            adjectives=["elegant", "precise"],
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "elegant" in result.text
        assert "precise" in result.text

    async def test_topics(self) -> None:
        character = _make_character(
            topics=["knives", "time manipulation"],
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "knives" in result.text
        assert "time manipulation" in result.text

    async def test_style_all(self) -> None:
        character = _make_character(
            style=_make_style(all_=["Speak formally."]),
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Speak formally." in result.text

    async def test_style_chat(self) -> None:
        character = _make_character(
            style=_make_style(chat=["Be direct in chat."]),
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Be direct in chat." in result.text

    async def test_style_post(self) -> None:
        character = _make_character(
            style=_make_style(post=["Keep posts brief."]),
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Keep posts brief." in result.text

    async def test_empty_fields_no_crash(self) -> None:
        character = _make_character()
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "# Agent: Sakuya" in result.text

    async def test_lore_string(self) -> None:
        character = _make_character()
        character.lore = "Has a mysterious past."
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Has a mysterious past." in result.text

    async def test_lore_list(self) -> None:
        character = _make_character()
        character.lore = ["Arrived at the mansion.", "Never aged."]
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Arrived at the mansion." in result.text
        assert "Never aged." in result.text

    async def test_no_placeholder_passes_through(self) -> None:
        character = _make_character(
            bio=["A helpful assistant."],
            adjectives=["calm"],
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "A helpful assistant." in result.text
        assert "calm" in result.text
