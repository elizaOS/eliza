"""Tests for TTS text processor — mirrors TypeScript test coverage."""

from __future__ import annotations

import pytest

from elizaos_plugin_tts.text_processor import (
    clean_text_for_tts,
    process_text_for_tts,
    truncate_text,
)


# =========================================================================
# cleanTextForTts
# =========================================================================


class TestCleanTextForTts:
    def test_removes_code_blocks(self) -> None:
        text = "Hello\n```js\ncode\n```\nworld"
        assert clean_text_for_tts(text) == "Hello\n[code block]\nworld"

    def test_removes_inline_code(self) -> None:
        assert clean_text_for_tts("Use `const` here") == "Use [code] here"

    def test_removes_urls(self) -> None:
        assert clean_text_for_tts("Visit https://example.com now") == "Visit [link] now"

    def test_removes_markdown_bold(self) -> None:
        assert clean_text_for_tts("This is **bold** text") == "This is bold text"

    def test_removes_markdown_italic(self) -> None:
        assert clean_text_for_tts("This is *italic* text") == "This is italic text"

    def test_removes_markdown_headers(self) -> None:
        assert clean_text_for_tts("# Header\nText") == "Header\nText"

    def test_removes_markdown_links(self) -> None:
        assert clean_text_for_tts("[click here](https://example.com)") == "click here"

    def test_removes_html_tags(self) -> None:
        assert clean_text_for_tts("<b>bold</b> text") == "bold text"

    def test_combined_cleaning(self) -> None:
        text = "**Bold** and `code` with https://example.com"
        assert clean_text_for_tts(text) == "Bold and [code] with [link]"

    def test_multiple_newlines_collapsed(self) -> None:
        assert clean_text_for_tts("Line1\n\n\nLine2") == "Line1\nLine2"

    def test_strips_leading_trailing_whitespace(self) -> None:
        assert clean_text_for_tts("  Hello  ") == "Hello"


# =========================================================================
# truncateText
# =========================================================================


class TestTruncateText:
    def test_returns_original_if_under_limit(self) -> None:
        assert truncate_text("Short text", 100) == "Short text"

    def test_truncates_at_sentence_boundary(self) -> None:
        text = "First sentence. Second sentence. Third sentence."
        truncated = truncate_text(text, 20)
        assert truncated == "First sentence."

    def test_adds_ellipsis_when_truncating_mid_sentence(self) -> None:
        text = "This is a very long sentence without any breaks"
        truncated = truncate_text(text, 20)
        assert truncated.endswith("...")
        assert len(truncated) <= 23  # +3 for "..."

    def test_truncates_at_word_boundary(self) -> None:
        text = "Word1 Word2 Word3 Word4 Word5"
        truncated = truncate_text(text, 15)
        assert "Word3" not in truncated


# =========================================================================
# processTextForTts (async)
# =========================================================================


class TestProcessTextForTts:
    @pytest.mark.asyncio
    async def test_returns_none_for_short_text(self) -> None:
        result = await process_text_for_tts(None, "Hi", max_length=1500, summarize=False)
        assert result is None

    @pytest.mark.asyncio
    async def test_cleans_and_returns_text(self) -> None:
        result = await process_text_for_tts(
            None,
            "**Bold** text with `code`",
            max_length=1500,
            summarize=False,
        )
        assert result == "Bold text with [code]"

    @pytest.mark.asyncio
    async def test_truncates_long_text(self) -> None:
        long_text = "Word " * 500
        result = await process_text_for_tts(
            None,
            long_text,
            max_length=50,
            summarize=False,
        )
        assert result is not None
        assert len(result) <= 53  # max_length + "..."
