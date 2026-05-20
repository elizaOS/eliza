"""Tests for generate_reasoning_traces.py — verifies entropy, format, and idempotency."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent / "scripts"

_SCRIPT = SCRIPTS_DIR / "generate_reasoning_traces.py"
if not _SCRIPT.exists():
    pytest.skip(f"script not found: {_SCRIPT.name}", allow_module_level=True)

sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(TESTS_DIR.parent))

spec = importlib.util.spec_from_file_location(
    "generate_reasoning_traces",
    _SCRIPT,
)
assert spec and spec.loader
gen = importlib.util.module_from_spec(spec)
sys.modules["generate_reasoning_traces"] = gen
spec.loader.exec_module(gen)


def _attack_row(category: str = "prompt-injection", action: str = "refuse") -> dict:
    return {
        "record_id": f"test-{category}-{action}",
        "category": category,
        "chosen_action": action,
        "is_attack": "true",
        "channel": "dm",
    }


def _legit_row() -> dict:
    return {
        "record_id": "test-legit-1",
        "category": "legitimate",
        "chosen_action": "accept",
        "is_attack": "false",
        "channel": "group-chat",
    }


# ── Format ───────────────────────────────────────────────────────────────────


def test_trace_is_wrapped_in_think_tags():
    trace = gen.generate_trace(_attack_row())
    assert trace.startswith("<think>")
    assert trace.endswith("</think>")


def test_trace_has_substantial_content():
    trace = gen.generate_trace(_attack_row())
    # Strip tags
    inner = trace.replace("<think>", "").replace("</think>", "").strip()
    assert len(inner) > 50, f"Trace too short: {inner!r}"


def test_legitimate_trace_has_no_attack_language():
    trace = gen.generate_trace(_legit_row())
    inner = trace.lower()
    assert "scam" not in inner
    assert "attack" not in inner
    assert "malicious" not in inner


# ── Entropy ──────────────────────────────────────────────────────────────────


def test_different_records_produce_different_traces():
    """No two records with different IDs should produce identical traces."""
    traces = set()
    for i in range(100):
        row = {**_attack_row(), "record_id": f"entropy-test-{i}"}
        traces.add(gen.generate_trace(row))
    # Allow at most 2 collisions out of 100
    assert len(traces) >= 98, f"Only {len(traces)} unique traces out of 100"


def test_different_categories_produce_different_content():
    """Traces for different threat categories should use category-specific language."""
    injection_trace = gen.generate_trace(_attack_row("prompt-injection", "refuse"))
    secret_trace = gen.generate_trace(_attack_row("secret-exfiltration", "refuse"))
    social_trace = gen.generate_trace(_attack_row("social-engineering", "escalate"))

    # They should all be different
    assert injection_trace != secret_trace
    assert secret_trace != social_trace

    # Category-specific content should appear
    assert any(
        kw in injection_trace.lower()
        for kw in ["instruction", "inject", "override", "prompt", "jailbreak", "system"]
    ), f"Injection trace missing category terms: {injection_trace}"

    assert any(
        kw in secret_trace.lower()
        for kw in ["key", "secret", "credential", "seed", "password", "exfiltrat"]
    ), f"Secret trace missing category terms: {secret_trace}"


def test_all_categories_produce_valid_traces():
    """Every known category should produce a non-empty trace."""
    categories = [
        "prompt-injection",
        "secret-exfiltration",
        "social-engineering",
        "admin-override",
        "research-assisted",
        "cli-execution",
        "environment-tampering",
        "malicious-tool",
        "phishing-link",
        "legitimate",
        "benign",
    ]
    for cat in categories:
        row = {
            "record_id": f"category-test-{cat}",
            "category": cat,
            "chosen_action": "comply" if cat in ("legitimate", "benign") else "refuse",
            "is_attack": "false" if cat in ("legitimate", "benign") else "true",
        }
        trace = gen.generate_trace(row)
        assert trace.startswith("<think>"), f"Bad trace for {cat}: {trace[:50]}"
        inner = trace.replace("<think>", "").replace("</think>", "").strip()
        assert len(inner) > 30, f"Empty trace for {cat}"


# ── Idempotency ──────────────────────────────────────────────────────────────


def test_same_seed_produces_same_trace():
    row = _attack_row()
    trace1 = gen.generate_trace(row, global_seed=42)
    trace2 = gen.generate_trace(row, global_seed=42)
    assert trace1 == trace2


def test_different_seed_produces_different_trace():
    row = _attack_row()
    trace1 = gen.generate_trace(row, global_seed=42)
    trace2 = gen.generate_trace(row, global_seed=99)
    assert trace1 != trace2


# ── Integration ──────────────────────────────────────────────────────────────


def test_inject_trace_into_assistant_content():
    trace = "<think>\nThis is suspicious.\n</think>"
    original = '{"chosenAction": "refuse"}'

    result = gen.inject_trace_into_assistant_content(original, trace)
    assert result.startswith("<think>")
    assert '{"chosenAction": "refuse"}' in result


def test_inject_trace_replaces_existing_think_block():
    trace = "<think>\nNew reasoning.\n</think>"
    content_with_old_trace = '<think>\nOld reasoning.\n</think>\n{"chosenAction": "refuse"}'

    result = gen.inject_trace_into_assistant_content(content_with_old_trace, trace)
    assert "Old reasoning" not in result
    assert "New reasoning" in result
    assert '{"chosenAction": "refuse"}' in result


def test_batch_generation_produces_index(tmp_path: Path):
    rows = [
        _attack_row("prompt-injection", "refuse"),
        _attack_row("secret-exfiltration", "escalate"),
        _legit_row(),
    ]
    traces = gen.generate_traces_for_dataset(rows, global_seed=42)
    assert len(traces) == 3
    assert all(t["reasoning_trace"].startswith("<think>") for t in traces)

    # Write and reload
    out = tmp_path / "traces.jsonl"
    gen.write_traces(traces, out)
    index = gen.load_trace_index(out)
    assert len(index) == 3
    assert all(v.startswith("<think>") for v in index.values())
