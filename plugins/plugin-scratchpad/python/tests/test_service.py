"""Tests for ScratchpadService - file CRUD, frontmatter, and TF-IDF search."""

from __future__ import annotations

import os

import pytest

from elizaos_plugin_scratchpad.config import ScratchpadConfig
from elizaos_plugin_scratchpad.error import FileSizeError, NotFoundError
from elizaos_plugin_scratchpad.service import ScratchpadService, create_scratchpad_service
from elizaos_plugin_scratchpad.types import (
    ScratchpadReadOptions,
    ScratchpadSearchOptions,
    ScratchpadWriteOptions,
)


@pytest.mark.asyncio
async def test_write_creates_file(service: ScratchpadService, config: ScratchpadConfig):
    """Test that write creates a markdown file on disk."""
    entry = await service.write("My Test Note", "Hello, world!")
    assert entry.id == "my-test-note"
    assert entry.title == "My Test Note"
    assert "Hello, world!" in entry.content
    assert os.path.isfile(os.path.join(config.base_path, "my-test-note.md"))


@pytest.mark.asyncio
async def test_write_with_tags(service: ScratchpadService):
    """Test writing with tags generates correct frontmatter."""
    entry = await service.write(
        "Tagged Note",
        "Some content",
        ScratchpadWriteOptions(tags=["python", "test"]),
    )
    assert entry.tags == ["python", "test"]
    assert "tags: [python, test]" in entry.content


@pytest.mark.asyncio
async def test_write_sanitizes_filename(service: ScratchpadService):
    """Test that special characters are stripped from filenames."""
    entry = await service.write("Hello, World! (Test)", "Content")
    assert entry.id == "hello-world-test"


@pytest.mark.asyncio
async def test_write_truncates_long_titles(service: ScratchpadService):
    """Test that filenames are truncated to 100 chars max."""
    long_title = "a" * 200
    entry = await service.write(long_title, "Content")
    assert len(entry.id) <= 100


@pytest.mark.asyncio
async def test_write_append_mode(service: ScratchpadService):
    """Test appending content to an existing entry."""
    await service.write("Append Test", "First part")
    entry = await service.write(
        "Append Test",
        "Second part",
        ScratchpadWriteOptions(append=True),
    )
    assert "First part" in entry.content
    assert "Second part" in entry.content
    assert "---\n\nSecond part" in entry.content


@pytest.mark.asyncio
async def test_write_file_size_limit(tmp_path):
    """Test that writing content exceeding max size raises FileSizeError."""
    config = ScratchpadConfig(base_path=str(tmp_path / "scratch"), max_file_size=100)
    svc = ScratchpadService(config=config)
    with pytest.raises(FileSizeError):
        await svc.write("Big Note", "x" * 200)


@pytest.mark.asyncio
async def test_read_existing_entry(service: ScratchpadService):
    """Test reading an entry that exists."""
    await service.write("Read Me", "This is content")
    entry = await service.read("read-me")
    assert entry.title == "Read Me"
    assert "This is content" in entry.content


@pytest.mark.asyncio
async def test_read_not_found(service: ScratchpadService):
    """Test reading a nonexistent entry raises NotFoundError."""
    with pytest.raises(NotFoundError):
        await service.read("nonexistent-entry")


@pytest.mark.asyncio
async def test_read_with_line_range(service: ScratchpadService):
    """Test reading with line range options."""
    lines = "\n".join(f"Line {i}" for i in range(1, 21))
    await service.write("Lines Note", lines)
    entry = await service.read(
        "lines-note",
        ScratchpadReadOptions(from_line=5, lines=3),
    )
    # from_line is 1-indexed, so line 5 is the 5th line of the file content
    content_lines = entry.content.split("\n")
    assert len(content_lines) == 3


@pytest.mark.asyncio
async def test_read_parses_frontmatter(service: ScratchpadService):
    """Test that frontmatter is parsed for title, tags, and created_at."""
    await service.write(
        "Frontmatter Test",
        "Body content",
        ScratchpadWriteOptions(tags=["alpha", "beta"]),
    )
    entry = await service.read("frontmatter-test")
    assert entry.title == "Frontmatter Test"
    assert entry.tags == ["alpha", "beta"]
    assert entry.created_at is not None


@pytest.mark.asyncio
async def test_exists_true(service: ScratchpadService):
    """Test exists returns True for an existing entry."""
    await service.write("Exists Test", "Content")
    assert await service.exists("exists-test") is True


@pytest.mark.asyncio
async def test_exists_false(service: ScratchpadService):
    """Test exists returns False for a nonexistent entry."""
    assert await service.exists("does-not-exist") is False


@pytest.mark.asyncio
async def test_list_empty(service: ScratchpadService):
    """Test listing returns empty list when no entries exist."""
    entries = await service.list()
    assert entries == []


@pytest.mark.asyncio
async def test_list_multiple_entries(service: ScratchpadService):
    """Test listing returns all entries sorted by modified date."""
    await service.write("First Entry", "Content A")
    await service.write("Second Entry", "Content B")
    await service.write("Third Entry", "Content C")

    entries = await service.list()
    assert len(entries) == 3
    # Most recently modified first
    assert entries[0].id == "third-entry"


@pytest.mark.asyncio
async def test_list_filters_by_extension(service: ScratchpadService, config: ScratchpadConfig):
    """Test that list only includes files with allowed extensions."""
    await service.write("Valid Note", "Content")
    # Create a file with disallowed extension
    with open(os.path.join(config.base_path, "not-a-note.json"), "w") as f:
        f.write("{}")

    entries = await service.list()
    assert len(entries) == 1
    assert entries[0].id == "valid-note"


@pytest.mark.asyncio
async def test_search_finds_matching_entries(service: ScratchpadService):
    """Test TF-IDF search finds entries containing query terms."""
    await service.write("Python Guide", "Learn about Python programming language")
    await service.write("Rust Notes", "Rust is a systems programming language")
    await service.write("Shopping List", "Buy milk and eggs")

    results = await service.search("programming language")
    assert len(results) >= 2
    entry_ids = {r.entry_id for r in results}
    assert "python-guide" in entry_ids
    assert "rust-notes" in entry_ids


@pytest.mark.asyncio
async def test_search_no_results(service: ScratchpadService):
    """Test search returns empty when no entries match."""
    await service.write("Random Note", "Nothing related here")
    results = await service.search("quantum physics simulation")
    assert results == []


@pytest.mark.asyncio
async def test_search_max_results(service: ScratchpadService):
    """Test search respects max_results limit."""
    for i in range(10):
        await service.write(f"Note {i}", f"Contains the keyword searchable item {i}")

    results = await service.search(
        "keyword searchable", ScratchpadSearchOptions(max_results=3)
    )
    assert len(results) <= 3


@pytest.mark.asyncio
async def test_search_min_score(service: ScratchpadService):
    """Test search respects min_score threshold."""
    await service.write("Match", "exact exact exact match term")
    await service.write("Weak", "only one mention of exact")

    results = await service.search(
        "exact match term",
        ScratchpadSearchOptions(min_score=0.5),
    )
    # Only the strong match should survive the high threshold
    assert all(r.score >= 0.5 for r in results)


@pytest.mark.asyncio
async def test_search_scores_are_bounded(service: ScratchpadService):
    """Test that search scores are between 0 and 1."""
    await service.write("Score Test", "term " * 100)
    results = await service.search("term")
    for r in results:
        assert 0.0 <= r.score <= 1.0


@pytest.mark.asyncio
async def test_search_snippet_context(service: ScratchpadService):
    """Test that snippets include surrounding context lines."""
    content = "\n".join(
        [
            "Line 1: Introduction",
            "Line 2: Background",
            "Line 3: The keyword appears here",
            "Line 4: More context",
            "Line 5: Conclusion",
        ]
    )
    await service.write("Snippet Test", content)
    results = await service.search("keyword")
    assert len(results) == 1
    assert "keyword" in results[0].snippet


@pytest.mark.asyncio
async def test_search_ignores_short_terms(service: ScratchpadService):
    """Test that query terms with 2 or fewer chars are ignored."""
    await service.write("Short Term Test", "This is a test")
    # "is" and "a" should be ignored, leaving no valid terms
    results = await service.search("is a")
    assert results == []


@pytest.mark.asyncio
async def test_delete_existing_entry(service: ScratchpadService):
    """Test deleting an existing entry returns True."""
    await service.write("Delete Me", "Content")
    assert await service.exists("delete-me") is True

    result = await service.delete("delete-me")
    assert result is True
    assert await service.exists("delete-me") is False


@pytest.mark.asyncio
async def test_delete_nonexistent_entry(service: ScratchpadService):
    """Test deleting a nonexistent entry returns False."""
    result = await service.delete("nonexistent")
    assert result is False


@pytest.mark.asyncio
async def test_get_summary_empty(service: ScratchpadService):
    """Test summary when no entries exist."""
    summary = await service.get_summary()
    assert summary == "No scratchpad entries found."


@pytest.mark.asyncio
async def test_get_summary_with_entries(service: ScratchpadService):
    """Test summary includes entry titles and previews."""
    await service.write("Summary Test", "Preview content here")
    summary = await service.get_summary()
    assert "Scratchpad Summary" in summary
    assert "Summary Test" in summary
    assert "Preview content here" in summary


@pytest.mark.asyncio
async def test_get_base_path(service: ScratchpadService, config: ScratchpadConfig):
    """Test get_base_path returns the configured path."""
    assert service.get_base_path() == config.base_path


@pytest.mark.asyncio
async def test_create_scratchpad_service_factory():
    """Test the factory function creates a valid service."""
    svc = create_scratchpad_service()
    assert isinstance(svc, ScratchpadService)
