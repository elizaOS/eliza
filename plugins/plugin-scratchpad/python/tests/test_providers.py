"""Tests for the scratchpad provider."""

from __future__ import annotations

import pytest

from elizaos_plugin_scratchpad.config import ScratchpadConfig
from elizaos_plugin_scratchpad.service import ScratchpadService
from elizaos_plugin_scratchpad.types import ScratchpadWriteOptions


@pytest.mark.asyncio
async def test_provider_with_no_entries(service: ScratchpadService):
    """Test provider summary when no entries exist."""
    summary = await service.get_summary()
    assert summary == "No scratchpad entries found."


@pytest.mark.asyncio
async def test_provider_with_entries(service: ScratchpadService):
    """Test provider generates correct summary with entries."""
    await service.write("First Note", "Content of first note")
    await service.write(
        "Second Note",
        "Content of second note",
        ScratchpadWriteOptions(tags=["important"]),
    )

    entries = await service.list()
    assert len(entries) == 2

    summary = await service.get_summary()
    assert "Scratchpad Summary" in summary
    assert "2 entries" in summary
    assert "First Note" in summary
    assert "Second Note" in summary


@pytest.mark.asyncio
async def test_provider_limits_to_ten_entries(tmp_path):
    """Test provider only shows first 10 entries in summary."""
    config = ScratchpadConfig(base_path=str(tmp_path / "scratch"))
    svc = ScratchpadService(config=config)

    for i in range(15):
        await svc.write(f"Note Number {i}", f"Content of note {i}")

    summary = await svc.get_summary()
    assert "15 entries" in summary
    assert "...and 5 more entries" in summary


@pytest.mark.asyncio
async def test_provider_preview_strips_frontmatter(service: ScratchpadService):
    """Test that summary previews don't include frontmatter."""
    await service.write("Preview Test", "Actual body content here")

    summary = await service.get_summary()
    # The preview should show body content, not frontmatter markers
    assert "Actual body content here" in summary


@pytest.mark.asyncio
async def test_provider_get_base_path(service: ScratchpadService, config: ScratchpadConfig):
    """Test that get_base_path returns the configured path."""
    assert service.get_base_path() == config.base_path
