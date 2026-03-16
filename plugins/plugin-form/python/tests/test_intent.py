"""Comprehensive tests for the intent module."""

from __future__ import annotations

import pytest

from elizaos_plugin_form.intent import (
    has_data_to_extract,
    is_lifecycle_intent,
    is_ux_intent,
    quick_intent_detect,
)


# ============================================================================
# LIFECYCLE INTENTS
# ============================================================================


class TestRestoreIntent:
    @pytest.mark.parametrize("text", [
        "resume",
        "continue",
        "pick up where I left off",
        "go back to my form",
        "get back to my form",
        "I want to resume",
        "Can I continue?",
    ])
    def test_restore_keywords(self, text):
        assert quick_intent_detect(text) == "restore"


class TestSubmitIntent:
    @pytest.mark.parametrize("text", [
        "submit",
        "done",
        "finish",
        "send it",
        "that's all",
        "thats all",
        "i'm done",
        "im done",
        "complete",
        "all set",
        "I'm done with the form",
    ])
    def test_submit_keywords(self, text):
        assert quick_intent_detect(text) == "submit"


class TestStashIntent:
    @pytest.mark.parametrize("text", [
        "save",
        "stash",
        "later",
        "hold on",
        "pause",
        "save for later",
        "come back",
        "save this",
    ])
    def test_stash_keywords(self, text):
        assert quick_intent_detect(text) == "stash"

    def test_save_and_submit_excluded(self):
        """'save and submit' should NOT trigger stash."""
        result = quick_intent_detect("save and submit")
        assert result != "stash"

    def test_save_and_send_excluded(self):
        result = quick_intent_detect("save and send")
        assert result != "stash"


class TestCancelIntent:
    @pytest.mark.parametrize("text", [
        "cancel",
        "abort",
        "nevermind",
        "never mind",
        "forget it",
        "stop",
        "quit",
        "exit",
    ])
    def test_cancel_keywords(self, text):
        assert quick_intent_detect(text) == "cancel"


# ============================================================================
# UX MAGIC INTENTS
# ============================================================================


class TestUndoIntent:
    @pytest.mark.parametrize("text", [
        "undo",
        "go back",
        "wait no",
        "change that",
        "oops",
        "that's wrong",
        "thats wrong",
        "wrong",
        "not right",
    ])
    def test_undo_keywords(self, text):
        assert quick_intent_detect(text) == "undo"


class TestSkipIntent:
    @pytest.mark.parametrize("text", [
        "skip",
        "pass",
        "don't know",
        "dont know",
        "next one",
        "next",
        "don't have",
        "no idea",
    ])
    def test_skip_keywords(self, text):
        assert quick_intent_detect(text) == "skip"

    def test_skip_to_excluded(self):
        """'skip to' is navigation, not skip."""
        result = quick_intent_detect("skip to the next section")
        assert result != "skip"


class TestExplainIntent:
    @pytest.mark.parametrize("text", [
        "why?",
        "why",
        "what's that for?",
        "explain?",
        "what do you mean?",
        "what is?",
        "purpose?",
        "reason?",
    ])
    def test_explain_keywords(self, text):
        assert quick_intent_detect(text) == "explain"


class TestExampleIntent:
    @pytest.mark.parametrize("text", [
        "example?",
        "like what?",
        "show me?",
        "such as?",
        "for instance?",
        "sample?",
        "example",
        "e.g.?",
        "eg?",
    ])
    def test_example_keywords(self, text):
        assert quick_intent_detect(text) == "example"


class TestProgressIntent:
    @pytest.mark.parametrize("text", [
        "how far",
        "how many left",
        "progress",
        "status",
        "how much more",
        "where are we",
    ])
    def test_progress_keywords(self, text):
        assert quick_intent_detect(text) == "progress"


class TestAutofillIntent:
    @pytest.mark.parametrize("text", [
        "same as last time",
        "use my usual",
        "like before",
        "previous",
        "from before",
    ])
    def test_autofill_keywords(self, text):
        assert quick_intent_detect(text) == "autofill"


# ============================================================================
# EDGE CASES
# ============================================================================


class TestEdgeCases:
    def test_empty_string_returns_none(self):
        assert quick_intent_detect("") is None

    def test_single_char_returns_none(self):
        assert quick_intent_detect("a") is None

    def test_whitespace_only_returns_none(self):
        assert quick_intent_detect("   ") is None

    def test_case_insensitivity(self):
        assert quick_intent_detect("SUBMIT") == "submit"
        assert quick_intent_detect("Cancel") == "cancel"
        assert quick_intent_detect("UNDO") == "undo"

    def test_no_match_returns_none(self):
        assert quick_intent_detect("my email is user@example.com") is None

    def test_leading_trailing_whitespace_trimmed(self):
        assert quick_intent_detect("  submit  ") == "submit"


# ============================================================================
# INTENT HELPERS
# ============================================================================


class TestIsLifecycleIntent:
    @pytest.mark.parametrize("intent", ["submit", "stash", "restore", "cancel"])
    def test_lifecycle_intents(self, intent):
        assert is_lifecycle_intent(intent) is True

    @pytest.mark.parametrize("intent", [
        "fill_form", "undo", "skip", "explain", "example", "progress", "autofill", "other",
    ])
    def test_non_lifecycle_intents(self, intent):
        assert is_lifecycle_intent(intent) is False


class TestIsUXIntent:
    @pytest.mark.parametrize("intent", ["undo", "skip", "explain", "example", "progress", "autofill"])
    def test_ux_intents(self, intent):
        assert is_ux_intent(intent) is True

    @pytest.mark.parametrize("intent", [
        "fill_form", "submit", "stash", "restore", "cancel", "other",
    ])
    def test_non_ux_intents(self, intent):
        assert is_ux_intent(intent) is False


class TestHasDataToExtract:
    def test_fill_form_has_data(self):
        assert has_data_to_extract("fill_form") is True

    def test_other_has_data(self):
        assert has_data_to_extract("other") is True

    @pytest.mark.parametrize("intent", [
        "submit", "stash", "restore", "cancel",
        "undo", "skip", "explain", "example", "progress", "autofill",
    ])
    def test_no_data_intents(self, intent):
        assert has_data_to_extract(intent) is False
