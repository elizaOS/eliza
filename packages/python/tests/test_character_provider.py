"""Tests for the CHARACTER provider's ``{{name}}`` placeholder resolution.

The character provider replaces ``{{name}}`` in bio, system, topics,
adjectives, and style entries with the character's actual name so
character template files stay name-agnostic.

Note: We import the provider module carefully to avoid the circular import
between ``elizaos.basic_capabilities`` and ``elizaos.bootstrap``.
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
        # Remove any partially-loaded module left by the failed first import
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
        _resolve_name,
        _resolve_name_list,
        get_character_context,
    )
except ImportError:
    _mod = _import_character_provider()
    _resolve_name = _mod._resolve_name
    _resolve_name_list = _mod._resolve_name_list
    get_character_context = _mod.get_character_context


# ---------------------------------------------------------------------------
# Unit tests for the helper functions
# ---------------------------------------------------------------------------


class TestResolveName:
    def test_replaces_single_placeholder(self) -> None:
        assert _resolve_name("Hello {{name}}!", "Sakuya") == "Hello Sakuya!"

    def test_replaces_multiple_placeholders(self) -> None:
        result = _resolve_name("{{name}} is {{name}}", "Reimu")
        assert result == "Reimu is Reimu"

    def test_no_placeholder_returns_unchanged(self) -> None:
        assert _resolve_name("No placeholders here.", "Marisa") == "No placeholders here."

    def test_empty_string(self) -> None:
        assert _resolve_name("", "Sakuya") == ""

    def test_placeholder_only(self) -> None:
        assert _resolve_name("{{name}}", "Patchouli") == "Patchouli"


class TestResolveNameList:
    def test_resolves_all_items(self) -> None:
        items = ["{{name}} is great.", "I am {{name}}."]
        result = _resolve_name_list(items, "Sakuya")
        assert result == ["Sakuya is great.", "I am Sakuya."]

    def test_empty_list(self) -> None:
        assert _resolve_name_list([], "Sakuya") == []

    def test_mixed_items(self) -> None:
        items = ["{{name}} rocks", "no placeholder"]
        result = _resolve_name_list(items, "Remilia")
        assert result == ["Remilia rocks", "no placeholder"]


# ---------------------------------------------------------------------------
# Integration tests for the full provider
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


@pytest.mark.asyncio
class TestCharacterProviderNameResolution:
    async def test_resolves_name_in_bio_list(self) -> None:
        character = _make_character(
            bio=["{{name}} is a time-stopping maid.", "{{name}} works at the mansion."],
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Sakuya is a time-stopping maid." in result.text
        assert "Sakuya works at the mansion." in result.text
        assert "{{name}}" not in result.text

    async def test_resolves_name_in_bio_string(self) -> None:
        character = _make_character(bio="{{name}} is an elegant maid.")
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Sakuya is an elegant maid." in result.text
        assert "{{name}}" not in result.text

    async def test_resolves_name_in_adjectives(self) -> None:
        character = _make_character(
            adjectives=["{{name}}-like elegance", "precise"],
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Sakuya-like elegance" in result.text
        assert "{{name}}" not in result.text

    async def test_resolves_name_in_topics(self) -> None:
        character = _make_character(
            topics=["{{name}}'s knives", "time manipulation"],
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Sakuya's knives" in result.text
        assert "{{name}}" not in result.text

    async def test_resolves_name_in_style_all(self) -> None:
        character = _make_character(
            style=_make_style(all_=["Speak as {{name}} would."]),
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Speak as Sakuya would." in result.text
        assert "{{name}}" not in result.text

    async def test_resolves_name_in_style_chat(self) -> None:
        character = _make_character(
            style=_make_style(chat=["In chat, {{name}} is direct."]),
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "In chat, Sakuya is direct." in result.text
        assert "{{name}}" not in result.text

    async def test_resolves_name_in_style_post(self) -> None:
        character = _make_character(
            style=_make_style(post=["When posting, {{name}} is brief."]),
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "When posting, Sakuya is brief." in result.text
        assert "{{name}}" not in result.text

    async def test_no_placeholder_passes_through(self) -> None:
        character = _make_character(
            bio=["A helpful assistant."],
            adjectives=["calm"],
        )
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "A helpful assistant." in result.text
        assert "calm" in result.text

    async def test_empty_fields_no_crash(self) -> None:
        character = _make_character()
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "# Agent: Sakuya" in result.text

    async def test_lore_resolves_name(self) -> None:
        character = _make_character()
        character.lore = "{{name}} has a mysterious past."
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Sakuya has a mysterious past." in result.text
        assert "{{name}}" not in result.text

    async def test_lore_list_resolves_name(self) -> None:
        character = _make_character()
        character.lore = ["{{name}} arrived at the mansion.", "{{name}} never aged."]
        result = await get_character_context(_make_runtime(character), AsyncMock(), None)
        assert "Sakuya arrived at the mansion." in result.text
        assert "Sakuya never aged." in result.text
        assert "{{name}}" not in result.text
