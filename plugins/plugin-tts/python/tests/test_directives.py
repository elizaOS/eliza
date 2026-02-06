"""Tests for TTS directive parsing — mirrors TypeScript test coverage."""

from __future__ import annotations

import pytest

from elizaos_plugin_tts.directives import (
    get_tts_text,
    has_tts_directive,
    parse_json_voice_directive,
    parse_tts_directive,
    strip_tts_directives,
)
from elizaos_plugin_tts.types import TtsProvider


# =========================================================================
# hasTtsDirective
# =========================================================================


class TestHasTtsDirective:
    def test_detects_tts_directive(self) -> None:
        assert has_tts_directive("Hello [[tts]] world") is True

    def test_detects_tts_with_options(self) -> None:
        assert has_tts_directive("[[tts:provider=elevenlabs]] Hello") is True

    def test_detects_tts_text_blocks(self) -> None:
        assert has_tts_directive("[[tts:text]]Hello[[/tts:text]]") is True

    def test_returns_false_for_plain_text(self) -> None:
        assert has_tts_directive("No directive here") is False

    def test_returns_false_for_similar_but_invalid_patterns(self) -> None:
        assert has_tts_directive("[[not-tts]]") is False
        assert has_tts_directive("[tts]") is False


# =========================================================================
# parseTtsDirective
# =========================================================================


class TestParseTtsDirective:
    def test_returns_none_for_text_without_directives(self) -> None:
        assert parse_tts_directive("Plain text") is None

    def test_parses_simple_tts_directive(self) -> None:
        directive = parse_tts_directive("[[tts]] Hello")
        assert directive is not None

    def test_parses_provider_option(self) -> None:
        directive = parse_tts_directive("[[tts:provider=elevenlabs]]")
        assert directive is not None
        assert directive.provider == TtsProvider.ELEVENLABS

    def test_parses_voice_option(self) -> None:
        directive = parse_tts_directive("[[tts:voice=alloy]]")
        assert directive is not None
        assert directive.voice == "alloy"

    def test_parses_speed_option(self) -> None:
        directive = parse_tts_directive("[[tts:speed=1.5]]")
        assert directive is not None
        assert directive.speed == 1.5

    def test_parses_multiple_options(self) -> None:
        directive = parse_tts_directive(
            "[[tts:provider=openai voice=nova speed=1.2]]"
        )
        assert directive is not None
        assert directive.provider == TtsProvider.OPENAI
        assert directive.voice == "nova"
        assert directive.speed == 1.2

    def test_parses_text_block(self) -> None:
        directive = parse_tts_directive(
            "Before [[tts:text]]Custom TTS text[[/tts:text]] after"
        )
        assert directive is not None
        assert directive.text == "Custom TTS text"

    def test_normalizes_provider_names(self) -> None:
        assert (
            parse_tts_directive("[[tts:provider=eleven]]")
        ).provider == TtsProvider.ELEVENLABS  # type: ignore[union-attr]
        assert (
            parse_tts_directive("[[tts:provider=oai]]")
        ).provider == TtsProvider.OPENAI  # type: ignore[union-attr]
        assert (
            parse_tts_directive("[[tts:provider=microsoft]]")
        ).provider == TtsProvider.EDGE  # type: ignore[union-attr]
        assert (
            parse_tts_directive("[[tts:provider=sam]]")
        ).provider == TtsProvider.SIMPLE_VOICE  # type: ignore[union-attr]


# =========================================================================
# stripTtsDirectives
# =========================================================================


class TestStripTtsDirectives:
    def test_strips_tts_directive(self) -> None:
        assert strip_tts_directives("Hello [[tts]] world") == "Hello world"

    def test_strips_tts_with_options(self) -> None:
        assert strip_tts_directives("[[tts:provider=elevenlabs]] Hello") == "Hello"

    def test_strips_tts_text_blocks(self) -> None:
        assert (
            strip_tts_directives(
                "Before [[tts:text]]TTS text[[/tts:text]] after"
            )
            == "Before after"
        )

    def test_strips_multiple_directives(self) -> None:
        assert (
            strip_tts_directives("[[tts]] Hello [[tts:voice=alloy]] world")
            == "Hello world"
        )


# =========================================================================
# getTtsText
# =========================================================================


class TestGetTtsText:
    def test_returns_directive_text_if_present(self) -> None:
        text = "Message [[tts:text]]Custom[[/tts:text]]"
        directive = parse_tts_directive(text)
        assert get_tts_text(text, directive) == "Custom"

    def test_returns_cleaned_text_if_no_directive_text(self) -> None:
        text = "[[tts]] Message"
        directive = parse_tts_directive(text)
        assert get_tts_text(text, directive) == "Message"

    def test_returns_original_text_if_no_directive(self) -> None:
        assert get_tts_text("Plain message", None) == "Plain message"


# =========================================================================
# parseJsonVoiceDirective
# =========================================================================


class TestParseJsonVoiceDirective:
    def test_returns_none_for_single_line(self) -> None:
        assert parse_json_voice_directive("No newline") is None

    def test_returns_none_for_non_json_first_line(self) -> None:
        assert parse_json_voice_directive("Not JSON\nSecond line") is None

    def test_returns_none_for_json_without_voice_keys(self) -> None:
        assert parse_json_voice_directive('{"unrelated": true}\nText') is None

    def test_parses_voice_directive(self) -> None:
        result = parse_json_voice_directive('{"voice": "abc123"}\nHello world')
        assert result is not None
        assert result.directive.voice == "abc123"
        assert result.cleaned_text == "Hello world"

    def test_parses_model_directive(self) -> None:
        result = parse_json_voice_directive('{"model": "tts-1"}\nHello')
        assert result is not None
        assert result.directive.model == "tts-1"

    def test_parses_speed_directive(self) -> None:
        result = parse_json_voice_directive('{"speed": 1.5}\nHello')
        assert result is not None
        assert result.directive.speed == 1.5

    def test_parses_rate_as_speed(self) -> None:
        result = parse_json_voice_directive('{"rate": 0.8}\nHello')
        assert result is not None
        assert result.directive.speed == 0.8
