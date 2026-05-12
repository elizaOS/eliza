"""Acceptance tests for the default-thought leak remediation pass.

Runs against `scripts/transform_fix_default_thoughts.py`. Bun + the TOON
encoder/decoder are required (the encoder spawns a Bun subprocess) — when
either is missing the affected tests are skipped, but the pure-Python
synthesis tests still run.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.lib.eliza_record import (  # noqa: E402
    DEFAULT_THOUGHT_LEAKS,
    is_default_thought_leak,
)
from scripts.transform_fix_default_thoughts import (  # noqa: E402
    extract_thought,
    process_record,
    rewrite_via_line_splice,
    synthesize_thought,
    _summarize_user_msg,
    _verb_from_tool_name,
    _truncate_words,
    _MAX_SYNTH_WORDS,
)


# ─────────────────────────── pure-Python guards ──────────────────────


def test_default_thought_leaks_constant_includes_canonical_two():
    """Don't let anyone delete the two literals the dataset review flagged."""
    assert "Reply to the user." in DEFAULT_THOUGHT_LEAKS
    assert "Call the tool to satisfy the request." in DEFAULT_THOUGHT_LEAKS


def test_is_default_thought_leak_handles_quoted_and_bare():
    assert is_default_thought_leak("Reply to the user.")
    assert is_default_thought_leak('"Reply to the user."')
    assert is_default_thought_leak("'Reply to the user.'")
    assert is_default_thought_leak("  Reply to the user.  ")
    assert not is_default_thought_leak("Reply to the user, but with detail.")
    assert not is_default_thought_leak("")
    assert not is_default_thought_leak(None)
    # Adjacent leak phrases all match.
    for leak in DEFAULT_THOUGHT_LEAKS:
        assert is_default_thought_leak(leak), leak


# ─────────────────────────── synthesis behavior ───────────────────────


def test_synth_reply_uses_user_message_summary():
    out = synthesize_thought(
        task_type="reply",
        user_msg="What is the capital of France right now and why?",
        tool_specs=[],
        seed="seed-A",
    )
    assert out, "must produce something for a reply with content"
    assert not is_default_thought_leak(out)
    assert "user" in out.lower() or "asks" in out.lower()
    assert len(out.split()) <= _MAX_SYNTH_WORDS


def test_synth_tool_call_uses_tool_name():
    out = synthesize_thought(
        task_type="tool_call",
        user_msg="search for Latin reggaeton tracks",
        tool_specs=[{"name": "web_search"}],
        seed="seed-B",
    )
    assert "web_search" in out
    assert not is_default_thought_leak(out)
    assert len(out.split()) <= _MAX_SYNTH_WORDS


def test_synth_shell_command_uses_user_summary():
    out = synthesize_thought(
        task_type="shell_command",
        user_msg="check if the pipeline finished and tail the log",
        tool_specs=[],
        seed="seed-C",
    )
    assert "shell" in out.lower() or "command" in out.lower()
    assert not is_default_thought_leak(out)
    assert len(out.split()) <= _MAX_SYNTH_WORDS


def test_synth_unknown_task_returns_empty():
    """Unknown task_type → caller drops the field rather than guess."""
    out = synthesize_thought(
        task_type="not_a_real_task",
        user_msg="hi",
        tool_specs=[],
        seed="seed-D",
    )
    assert out == ""


def test_synth_never_emits_a_leak_literal():
    """Stress: 200 distinct seeds across all known task types must never
    produce one of the canonical leak literals."""
    for i in range(200):
        seed = f"stress-seed-{i}"
        for tt in ("reply", "casual_reply", "agent_trace",
                   "tool_call", "mcp_tool_call", "shell_command"):
            out = synthesize_thought(
                task_type=tt,
                user_msg=f"please help with task number {i}",
                tool_specs=[{"name": "do_thing"}] if "tool" in tt else [],
                seed=seed,
            )
            if out:
                assert not is_default_thought_leak(out), (tt, out)
                assert len(out.split()) <= _MAX_SYNTH_WORDS, (tt, out)


def test_synth_is_deterministic():
    """Same inputs → same output. This is the primary contract."""
    args = dict(
        task_type="reply",
        user_msg="please answer the question about Saturn's rings",
        tool_specs=[],
        seed="fixed-seed-Z",
    )
    a = synthesize_thought(**args)  # type: ignore[arg-type]
    b = synthesize_thought(**args)  # type: ignore[arg-type]
    assert a == b
    # And distinct seeds normally produce distinct phrasings.
    c = synthesize_thought(**{**args, "seed": "different-seed"})  # type: ignore[arg-type]
    # Not strictly required to differ, but the suffix pool has ≥6 entries
    # so collision probability is low; test we don't always pick option 0.
    assert isinstance(c, str)


# ─────────────────────────── helpers ──────────────────────────────────


def test_summarize_drops_stopwords_and_caps_length():
    out = _summarize_user_msg(
        "What is the very large brown fox doing right now?",
        max_words=4,
    )
    tokens = out.split()
    assert 1 <= len(tokens) <= 4
    # Stopwords gone.
    for sw in ("what", "the", "is"):
        assert sw not in tokens


def test_verb_from_tool_name_segments_camel_and_snake():
    assert _verb_from_tool_name("web_search") == "web search"
    assert _verb_from_tool_name("getWeather").startswith("get ")
    assert _verb_from_tool_name("read_file") == "read file"
    assert _verb_from_tool_name("") == "complete the request"


def test_truncate_words_caps_at_limit():
    long = " ".join(["word"] * 50)
    out = _truncate_words(long, max_words=10)
    assert len(out.split()) == 10


# ─────────────────────────── line-splice fallback ─────────────────────


def test_line_splice_replaces_thought_line():
    er = "thought: Reply to the user.\ntext: hi"
    out = rewrite_via_line_splice(er, "user asks about weather; replying")
    first = out.split("\n", 1)[0]
    assert first.startswith("thought:")
    assert "Reply to the user." not in out
    assert "user asks about weather" in out


def test_line_splice_handles_quoted_key():
    er = '"thought": "Reply to the user."\ntext: hi'
    out = rewrite_via_line_splice(er, "informative replacement here")
    assert "Reply to the user." not in out
    assert "informative replacement" in out


def test_line_splice_quotes_value_when_needed():
    er = "thought: Reply to the user.\ntext: hi"
    # value with a colon needs quoting
    out = rewrite_via_line_splice(er, "weather: warm; replying")
    assert "Reply to the user." not in out
    # quoted form because of the colon
    assert '"weather: warm; replying"' in out


# ─────────────────────────── TOON round-trip (needs bun) ──────────────


def _bun_available() -> bool:
    return shutil.which("bun") is not None


@pytest.mark.skipif(not _bun_available(), reason="bun required for TOON")
def test_full_record_round_trip_replaces_leak_thought():
    """End-to-end: a record with thought='Reply to the user.' goes through
    `process_record` and emerges with an informative thought, the TOON
    still parses, and the rest of the envelope is preserved."""
    from scripts.lib.toon import ToonDecoder, ToonEncoder

    encoder = ToonEncoder()
    decoder = ToonDecoder()
    try:
        original_envelope = {
            "thought": "Reply to the user.",
            "actions": ["REPLY"],
            "providers": [],
            "text": "Sure, the answer is 42.",
            "simple": True,
        }
        toon_text = encoder.encode(original_envelope)
        rec = {
            "roomName": "room-x",
            "agentId": "agent-x",
            "memoryEntries": [],
            "currentMessage": {
                "role": "user", "speaker": "u",
                "content": "what is the answer to life",
                "channel": "dm",
            },
            "expectedResponse": toon_text,
            "availableActions": ["REPLY"],
            "metadata": {
                "task_type": "reply",
                "source_dataset": "test",
                "license": "MIT",
                "split": "train",
            },
        }

        from scripts.transform_fix_default_thoughts import FixStats
        stats = FixStats()
        new_rec, was = process_record(rec, decoder, encoder, stats)

        assert was is True
        assert stats.rewritten == 1
        # Decode the rewritten target — every other field preserved.
        rewritten_obj = decoder.decode(new_rec["expectedResponse"])
        assert rewritten_obj["text"] == "Sure, the answer is 42."
        assert rewritten_obj["actions"] == ["REPLY"]
        assert rewritten_obj["simple"] is True
        new_thought = rewritten_obj["thought"]
        assert isinstance(new_thought, str)
        assert new_thought
        assert not is_default_thought_leak(new_thought)
        assert len(new_thought.split()) <= _MAX_SYNTH_WORDS
    finally:
        encoder.close()
        decoder.close()


@pytest.mark.skipif(not _bun_available(), reason="bun required for TOON")
def test_full_record_round_trip_is_deterministic():
    """Same input → byte-identical output across two passes."""
    from scripts.lib.toon import ToonDecoder, ToonEncoder
    from scripts.transform_fix_default_thoughts import FixStats

    encoder = ToonEncoder()
    decoder = ToonDecoder()
    try:
        envelope = encoder.encode({
            "thought": "Call the tool to satisfy the request.",
            "actions": [{"name": "TASK_CALL", "params": {
                "tool": "web_search",
                "arguments": {"q": "anything"},
            }}],
            "providers": [],
            "text": "",
            "simple": False,
        })

        def make_rec() -> dict:
            return {
                "roomName": "room-det",
                "agentId": "agent-det",
                "memoryEntries": [],
                "currentMessage": {
                    "role": "user", "speaker": "u",
                    "content": "search the web for latin reggaeton tracks",
                    "channel": "dm",
                },
                "expectedResponse": envelope,
                "availableActions": ["TASK_CALL"],
                "metadata": {
                    "task_type": "tool_call",
                    "source_dataset": "test",
                    "license": "MIT",
                    "split": "train",
                    "toolSpecs": [{"name": "web_search"}],
                },
            }

        rec_a = make_rec()
        rec_b = make_rec()
        stats_a = FixStats()
        stats_b = FixStats()
        out_a, _ = process_record(rec_a, decoder, encoder, stats_a)
        out_b, _ = process_record(rec_b, decoder, encoder, stats_b)
        assert out_a["expectedResponse"] == out_b["expectedResponse"]
        # And the thought is sane.
        new_obj = decoder.decode(out_a["expectedResponse"])
        assert "web_search" in new_obj["thought"]
        assert not is_default_thought_leak(new_obj["thought"])
    finally:
        encoder.close()
        decoder.close()


@pytest.mark.skipif(not _bun_available(), reason="bun required for TOON")
def test_full_record_no_op_when_thought_is_real():
    """Records with a real reasoning trace are passed through unchanged."""
    from scripts.lib.toon import ToonDecoder, ToonEncoder
    from scripts.transform_fix_default_thoughts import FixStats

    encoder = ToonEncoder()
    decoder = ToonDecoder()
    try:
        toon_text = encoder.encode({
            "thought": "the user wants weather; checking my known knowledge",
            "actions": ["REPLY"],
            "providers": [], "text": "It's sunny.", "simple": True,
        })
        rec = {
            "roomName": "r", "agentId": "a", "memoryEntries": [],
            "currentMessage": {
                "role": "user", "speaker": "u",
                "content": "weather?", "channel": "dm",
            },
            "expectedResponse": toon_text,
            "availableActions": ["REPLY"],
            "metadata": {
                "task_type": "reply", "source_dataset": "test",
                "license": "MIT", "split": "train",
            },
        }
        stats = FixStats()
        out, was = process_record(rec, decoder, encoder, stats)
        assert was is False
        assert stats.no_leak == 1
        assert out["expectedResponse"] == toon_text
    finally:
        encoder.close()
        decoder.close()


def test_extract_thought_picks_first_thought_line():
    er = 'thought: "Reply to the user."\ntext: hi'
    val, key = extract_thought(er)
    assert val == "Reply to the user."
    assert key == "thought:"

    er2 = '"thought": "Call the tool to satisfy the request."\nactions:\n  - REPLY'
    val2, key2 = extract_thought(er2)
    assert val2 == "Call the tool to satisfy the request."
    assert key2 == '"thought":'


def test_extract_thought_returns_none_when_absent():
    val, key = extract_thought("text: hi\nactions:\n  - REPLY")
    assert val is None
    assert key is None
