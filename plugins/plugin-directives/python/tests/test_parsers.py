"""Tests for directive parsers - at least 15 real test cases."""

from __future__ import annotations

from elizaos_plugin_directives import (
    DirectiveState,
    ExecConfig,
    ModelConfig,
    apply_directives,
    extract_elevated_directive,
    extract_exec_directive,
    extract_model_directive,
    extract_reasoning_directive,
    extract_status_directive,
    extract_think_directive,
    extract_verbose_directive,
    format_directive_state,
    normalize_elevated_level,
    normalize_exec,
    normalize_reasoning_level,
    normalize_think_level,
    normalize_verbose_level,
    parse_all_directives,
    strip_directives,
)


# ============================================================================
# Normalizer tests
# ============================================================================


def test_normalize_think_level() -> None:
    assert normalize_think_level("off") == "off"
    assert normalize_think_level("disabled") == "off"
    assert normalize_think_level("on") == "concise"
    assert normalize_think_level("concise") == "concise"
    assert normalize_think_level("minimal") == "concise"
    assert normalize_think_level("low") == "concise"
    assert normalize_think_level("verbose") == "verbose"
    assert normalize_think_level("high") == "verbose"
    assert normalize_think_level("ultra") == "verbose"
    assert normalize_think_level("max") == "verbose"
    assert normalize_think_level("xhigh") == "verbose"
    assert normalize_think_level("garbage") is None


def test_normalize_verbose_level() -> None:
    assert normalize_verbose_level("off") == "off"
    assert normalize_verbose_level("false") == "off"
    assert normalize_verbose_level("on") == "on"
    assert normalize_verbose_level("true") == "on"
    assert normalize_verbose_level("full") == "on"
    assert normalize_verbose_level("nope") is None


def test_normalize_reasoning_level() -> None:
    assert normalize_reasoning_level("off") == "off"
    assert normalize_reasoning_level("hide") == "off"
    assert normalize_reasoning_level("on") == "brief"
    assert normalize_reasoning_level("show") == "brief"
    assert normalize_reasoning_level("brief") == "brief"
    assert normalize_reasoning_level("detailed") == "detailed"
    assert normalize_reasoning_level("stream") == "detailed"
    assert normalize_reasoning_level("live") == "detailed"
    assert normalize_reasoning_level("xyz") is None


def test_normalize_elevated_level() -> None:
    assert normalize_elevated_level("off") == "off"
    assert normalize_elevated_level("false") == "off"
    assert normalize_elevated_level("on") == "on"
    assert normalize_elevated_level("true") == "on"
    assert normalize_elevated_level("full") == "on"
    assert normalize_elevated_level("ask") == "on"
    assert normalize_elevated_level("bad") is None


def test_normalize_exec() -> None:
    assert normalize_exec("off") == ExecConfig(enabled=False, auto_approve=False)
    assert normalize_exec("on") == ExecConfig(enabled=True, auto_approve=False)
    assert normalize_exec("auto-approve") == ExecConfig(enabled=True, auto_approve=True)
    assert normalize_exec("approve") == ExecConfig(enabled=True, auto_approve=True)
    assert normalize_exec("whatever") is None


# ============================================================================
# Individual extractor tests
# ============================================================================


def test_extract_think_high() -> None:
    assert extract_think_directive("/think:high hello") == "verbose"


def test_extract_think_concise() -> None:
    assert extract_think_directive("/think:concise explain this") == "concise"


def test_extract_think_off() -> None:
    assert extract_think_directive("/t off quick reply") == "off"


def test_extract_think_shorthand() -> None:
    assert extract_think_directive("/t medium world") == "verbose"


def test_extract_think_missing() -> None:
    assert extract_think_directive("hello world no directives") is None


def test_extract_verbose_on() -> None:
    assert extract_verbose_directive("/verbose:on test") == "on"


def test_extract_verbose_shorthand() -> None:
    assert extract_verbose_directive("/v on message") == "on"


def test_extract_reasoning_brief() -> None:
    assert extract_reasoning_directive("/reasoning:on test") == "brief"


def test_extract_reasoning_detailed() -> None:
    assert extract_reasoning_directive("/reason:stream show me") == "detailed"


def test_extract_elevated_on() -> None:
    assert extract_elevated_directive("/elevated:on do it") == "on"


def test_extract_elevated_off() -> None:
    assert extract_elevated_directive("/elev off stop") == "off"


def test_extract_exec_bare() -> None:
    result = extract_exec_directive("/exec do something")
    assert result is not None
    assert result.enabled is True
    assert result.auto_approve is False


def test_extract_exec_auto_approve() -> None:
    result = extract_exec_directive("/exec auto-approve")
    assert result is not None
    assert result.enabled is True
    assert result.auto_approve is True


def test_extract_model_with_provider() -> None:
    result = extract_model_directive("/model anthropic/claude-3-opus test")
    assert result is not None
    assert result.provider == "anthropic"
    assert result.model == "claude-3-opus"


def test_extract_model_without_provider() -> None:
    result = extract_model_directive("/model gpt-4o hello")
    assert result is not None
    assert result.provider is None
    assert result.model == "gpt-4o"


def test_extract_status() -> None:
    assert extract_status_directive("/status hello") is True
    assert extract_status_directive("hello no status") is False


# ============================================================================
# parse_all_directives tests
# ============================================================================


def test_parse_all_single_directive() -> None:
    result = parse_all_directives("/think:high hello world")
    assert result.has_think is True
    assert result.think == "verbose"
    assert result.cleaned_text == "hello world"
    assert result.directives_only is False


def test_parse_all_multiple_directives() -> None:
    result = parse_all_directives("/think:concise /v on /elevated on hello")
    assert result.has_think is True
    assert result.think == "concise"
    assert result.has_verbose is True
    assert result.verbose == "on"
    assert result.has_elevated is True
    assert result.elevated == "on"
    assert result.cleaned_text == "hello"
    assert result.directives_only is False


def test_parse_all_directives_only() -> None:
    result = parse_all_directives("/think:high /verbose on")
    assert result.directives_only is True
    assert result.cleaned_text == ""


def test_parse_all_no_directives() -> None:
    result = parse_all_directives("just a normal message")
    assert result.has_think is False
    assert result.has_verbose is False
    assert result.has_reasoning is False
    assert result.has_elevated is False
    assert result.has_exec is False
    assert result.has_model is False
    assert result.has_status is False
    assert result.directives_only is False
    assert result.cleaned_text == "just a normal message"


def test_parse_all_with_model() -> None:
    result = parse_all_directives("/model openai/gpt-4o what is 2+2")
    assert result.has_model is True
    assert result.model is not None
    assert result.model.provider == "openai"
    assert result.model.model == "gpt-4o"
    assert result.cleaned_text == "what is 2+2"


def test_parse_all_with_status() -> None:
    result = parse_all_directives("/status check in")
    assert result.has_status is True


# ============================================================================
# strip_directives tests
# ============================================================================


def test_strip_removes_all_markers() -> None:
    cleaned = strip_directives("/think:high /verbose on hello world")
    assert cleaned == "hello world"


def test_strip_preserves_text_without_directives() -> None:
    cleaned = strip_directives("nothing special here")
    assert cleaned == "nothing special here"


# ============================================================================
# Edge cases
# ============================================================================


def test_empty_text() -> None:
    result = parse_all_directives("")
    assert result.has_think is False
    assert result.cleaned_text == ""
    assert result.directives_only is False


def test_invalid_directive_value() -> None:
    result = parse_all_directives("/think:banana hello")
    assert result.has_think is True
    assert result.think is None  # invalid value → None


def test_directive_not_matched_inside_word() -> None:
    result = parse_all_directives("check /thinkpad specs")
    assert result.has_think is False
    assert result.cleaned_text == "check /thinkpad specs"


def test_case_insensitive_directives() -> None:
    result = parse_all_directives("/THINK:HIGH /Verbose ON hello")
    assert result.has_think is True
    assert result.think == "verbose"
    assert result.has_verbose is True
    assert result.verbose == "on"


def test_colon_separated_and_space_separated() -> None:
    colon = extract_think_directive("/think:high test")
    space = extract_think_directive("/think high test")
    assert colon == space == "verbose"


# ============================================================================
# apply_directives & format tests
# ============================================================================


def test_apply_directives() -> None:
    base = DirectiveState()
    directives = parse_all_directives("/think:high /verbose on")
    updated = apply_directives(base, directives)
    assert updated.thinking == "verbose"
    assert updated.verbose == "on"
    assert updated.reasoning == "off"  # unchanged


def test_apply_preserves_existing_state() -> None:
    state = DirectiveState(thinking="verbose")
    directives = parse_all_directives("/verbose on")
    updated = apply_directives(state, directives)
    assert updated.thinking == "verbose"  # preserved
    assert updated.verbose == "on"  # updated


def test_format_directive_state() -> None:
    state = DirectiveState(
        thinking="concise",
        verbose="on",
        model=ModelConfig(provider="openai", model="gpt-4o"),
    )
    text = format_directive_state(state)
    assert "Thinking: concise" in text
    assert "Verbose: on" in text
    assert "Model: openai/gpt-4o" in text
