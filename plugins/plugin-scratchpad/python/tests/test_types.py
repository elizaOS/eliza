"""Tests for scratchpad type definitions."""

from datetime import datetime, timezone

from elizaos_plugin_scratchpad.types import (
    ScratchpadEntry,
    ScratchpadReadOptions,
    ScratchpadSearchOptions,
    ScratchpadSearchResult,
    ScratchpadWriteOptions,
)


def test_scratchpad_entry_creation():
    """Test creating a ScratchpadEntry with all fields."""
    now = datetime.now(tz=timezone.utc)
    entry = ScratchpadEntry(
        id="test-note",
        path="/tmp/test-note.md",
        title="Test Note",
        content="Hello world",
        created_at=now,
        modified_at=now,
        tags=["tag1", "tag2"],
    )
    assert entry.id == "test-note"
    assert entry.title == "Test Note"
    assert entry.content == "Hello world"
    assert entry.tags == ["tag1", "tag2"]
    assert entry.created_at == now
    assert entry.modified_at == now


def test_scratchpad_entry_default_tags():
    """Test that tags default to an empty list."""
    now = datetime.now(tz=timezone.utc)
    entry = ScratchpadEntry(
        id="no-tags",
        path="/tmp/no-tags.md",
        title="No Tags",
        content="Content",
        created_at=now,
        modified_at=now,
    )
    assert entry.tags == []


def test_scratchpad_search_result():
    """Test creating a ScratchpadSearchResult."""
    result = ScratchpadSearchResult(
        path="/tmp/test.md",
        start_line=1,
        end_line=5,
        score=0.85,
        snippet="matching text here",
        entry_id="test",
    )
    assert result.score == 0.85
    assert result.start_line == 1
    assert result.end_line == 5
    assert result.entry_id == "test"


def test_scratchpad_read_options_defaults():
    """Test ScratchpadReadOptions with default values."""
    opts = ScratchpadReadOptions()
    assert opts.from_line is None
    assert opts.lines is None


def test_scratchpad_read_options_with_values():
    """Test ScratchpadReadOptions with explicit values."""
    opts = ScratchpadReadOptions(from_line=5, lines=10)
    assert opts.from_line == 5
    assert opts.lines == 10


def test_scratchpad_write_options_defaults():
    """Test ScratchpadWriteOptions with default values."""
    opts = ScratchpadWriteOptions()
    assert opts.tags is None
    assert opts.append is False


def test_scratchpad_write_options_with_values():
    """Test ScratchpadWriteOptions with explicit values."""
    opts = ScratchpadWriteOptions(tags=["python", "test"], append=True)
    assert opts.tags == ["python", "test"]
    assert opts.append is True


def test_scratchpad_search_options_defaults():
    """Test ScratchpadSearchOptions with default values."""
    opts = ScratchpadSearchOptions()
    assert opts.max_results == 10
    assert opts.min_score == 0.1


def test_scratchpad_search_options_with_values():
    """Test ScratchpadSearchOptions with explicit values."""
    opts = ScratchpadSearchOptions(max_results=5, min_score=0.5)
    assert opts.max_results == 5
    assert opts.min_score == 0.5
