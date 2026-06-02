"""Pytest suite for the native Eliza reward function.

CPU-only: no GPU, no model load, no network unless the optional AI judge env
flag is explicitly enabled.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from eliza_reward_fn import compute_reward, compute_reward_components  # noqa: E402


def _tool_call(name: str, arguments: dict) -> str:
    return json.dumps({"toolCalls": [{"name": name, "arguments": arguments}]})


def _tool_calls(*calls: tuple[str, dict]) -> str:
    return json.dumps(
        {"toolCalls": [{"name": name, "arguments": args} for name, args in calls]}
    )


def test_tool_call_correct_high_reward() -> None:
    expected = {"expectedToolCalls": [{"name": "FINALIZE_WORKSPACE", "arguments": {"path": "/tmp/x"}}]}
    response = _tool_call("FINALIZE_WORKSPACE", {"path": "/tmp/x"})
    reward = compute_reward("please finalize workspace", response, expected)
    assert reward > 0.5


def test_tool_call_wrong_action_low_reward() -> None:
    expected = {"expectedToolCalls": [{"name": "FINALIZE_WORKSPACE", "arguments": {"path": "/tmp/x"}}]}
    response = _tool_call("COMPLETELY_WRONG_ACTION", {"path": "/tmp/x"})
    reward = compute_reward("please finalize workspace", response, expected)
    assert reward < 0.5


def test_tool_call_wrong_argument_low_reward() -> None:
    expected = {"expectedToolCalls": [{"name": "SEND_EMAIL", "arguments": {"to": "a@example.com"}}]}
    response = _tool_call("SEND_EMAIL", {"to": "b@example.com"})
    reward = compute_reward("email a@example.com", response, expected)
    assert reward < 0.5


def test_extra_tool_call_penalized() -> None:
    # The model emits the expected SEND_EMAIL plus a spurious extra call. It must
    # not get full content credit, and must score strictly below the clean
    # single-call response — otherwise RL could learn to append extra calls.
    expected = {"expectedToolCalls": [{"name": "SEND_EMAIL", "arguments": {"to": "a@example.com"}}]}
    clean = _tool_call("SEND_EMAIL", {"to": "a@example.com"})
    extra = _tool_calls(
        ("SEND_EMAIL", {"to": "a@example.com"}),
        ("DELETE_ALL_FILES", {}),
    )
    clean_comps = compute_reward_components("email a@example.com", clean, expected)
    extra_comps = compute_reward_components("email a@example.com", extra, expected)
    assert clean_comps.content_ok == 1.0
    assert extra_comps.content_ok == 0.0
    assert "too_many_tool_calls" in extra_comps.notes
    assert extra_comps.final < clean_comps.final


def test_exact_tool_calls_full_credit() -> None:
    # An exact-length match of all expected calls still earns full content credit.
    expected = {
        "expectedToolCalls": [
            {"name": "SEND_EMAIL", "arguments": {"to": "a@example.com"}},
            {"name": "ARCHIVE", "arguments": {"id": "1"}},
        ]
    }
    response = _tool_calls(
        ("SEND_EMAIL", {"to": "a@example.com"}),
        ("ARCHIVE", {"id": "1"}),
    )
    comps = compute_reward_components("email then archive", response, expected)
    assert comps.content_ok == 1.0
    assert "too_many_tool_calls" not in comps.notes


def test_json_response_correct_high_reward() -> None:
    expected = {"expected": json.dumps({"messageHandler": {"action": "RESPOND", "contexts": ["simple"]}})}
    response = json.dumps({"messageHandler": {"action": "RESPOND", "contexts": ["simple"], "reply": "ok"}})
    reward = compute_reward("hi", response, expected)
    assert reward > 0.5


def test_direct_reply_similarity_high_reward() -> None:
    expected = {"expected": "Got it, I will handle that now."}
    response = "Got it, I will handle that now."
    reward = compute_reward("can you confirm?", response, expected)
    assert reward > 0.5


def test_unstructured_response_for_tool_call_low_reward() -> None:
    expected = {"expectedToolCalls": [{"name": "LOOKUP", "arguments": {"query": "invoice"}}]}
    response = "I would look up the invoice."
    reward = compute_reward("find invoice", response, expected)
    assert reward < 0


def test_components_breakdown_present() -> None:
    expected = {"expected": json.dumps({"action": "RESPOND"})}
    comps = compute_reward_components("hi", json.dumps({"action": "RESPOND"}), expected)
    data = comps.to_dict()
    for key in ("format_ok", "content_ok", "length_score", "weighted_sum", "final"):
        assert key in data
    assert -1.0 <= data["final"] <= 1.0


def test_reward_clamped_to_unit_interval() -> None:
    response = "yes " * 1000
    reward = compute_reward("ok", response, {"expected": response})
    assert -1.0 <= reward <= 1.0
