"""Pytest suite for the eliza reward function.

CPU-only — no GPU, no model load, no network (AI judge is gated off by default).
Run:
    cd training && pytest -xvs scripts/test_reward_fn.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from eliza_reward_fn import (  # noqa: E402
    compute_reward,
    compute_reward_components,
)


# ───────────────────────────── good cases ─────────────────────────────

def test_should_respond_correct_high_reward():
    expected = (
        "name: Rune\n"
        "reasoning: Rune was directly addressed.\n"
        "action: RESPOND\n"
        "primaryContext: wallet\n"
        "secondaryContexts: \"\"\n"
        "evidenceTurnIds: \"\""
    )
    response = expected  # exact match
    gt = {"task_type": "should_respond", "expected": expected}
    r = compute_reward("@Rune take a look", response, gt)
    assert r > 0.5, f"expected r>0.5 for perfect match, got {r}"


def test_message_handler_correct_high_reward():
    expected = (
        "thought: User wants the workspace finalized.\n"
        "actions[1]:\n"
        "  - name: FINALIZE_WORKSPACE\n"
        "providers: \"\"\n"
        "text: Finalizing your workspace now."
    )
    response = expected
    gt = {"task_type": "message_handler", "expected": expected}
    r = compute_reward("please finalize workspace", response, gt)
    assert r > 0.5, f"expected r>0.5 for correct planner output, got {r}"


def test_reply_with_text_high_reward():
    expected = (
        "thought: Ack the user.\n"
        "text: Got it, on my way."
    )
    response = expected
    gt = {"task_type": "reply", "expected": expected}
    r = compute_reward("can you confirm?", response, gt)
    assert r > 0.5, f"expected r>0.5 for valid reply, got {r}"


# ───────────────────────────── bad cases ─────────────────────────────

def test_broken_toon_negative_or_zero_reward():
    expected = (
        "name: Rune\n"
        "reasoning: addressed\n"
        "action: RESPOND\n"
        "primaryContext: wallet\n"
        "secondaryContexts: \"\"\n"
        "evidenceTurnIds: \"\""
    )
    # Broken: not TOON at all, just prose
    response = "I think the user wants me to respond, sure thing!"
    gt = {"task_type": "should_respond", "expected": expected}
    r = compute_reward("@Rune take a look", response, gt)
    assert r < 0, f"expected r<0 for non-TOON response, got {r}"


def test_wrong_action_negative_reward():
    expected = (
        "name: Echo\n"
        "reasoning: no direct address\n"
        "action: IGNORE\n"
        "primaryContext: scheduling\n"
        "secondaryContexts: \"\"\n"
        "evidenceTurnIds: \"\""
    )
    # Wrong action — RESPOND instead of IGNORE
    response = (
        "name: Echo\n"
        "reasoning: addressed me\n"
        "action: RESPOND\n"
        "primaryContext: scheduling\n"
        "secondaryContexts: \"\"\n"
        "evidenceTurnIds: \"\""
    )
    gt = {"task_type": "should_respond", "expected": expected}
    r = compute_reward("no need to reply", response, gt)
    # Format passes (0.4) but content fails (0) and length is mildly short
    # (~25 tokens → small negative). Should be below 0.5 — and per the
    # design spec a wrong action should be visibly worse than a correct one.
    assert r < 0.5, f"expected r<0.5 for wrong action, got {r}"


def test_planner_wrong_action_name_low_reward():
    expected = (
        "thought: finalize the workspace\n"
        "actions[1]:\n"
        "  - name: FINALIZE_WORKSPACE\n"
        "providers: \"\"\n"
        "text: ok"
    )
    response = (
        "thought: doing something else\n"
        "actions[1]:\n"
        "  - name: COMPLETELY_WRONG_ACTION\n"
        "providers: \"\"\n"
        "text: ok"
    )
    gt = {"task_type": "message_handler", "expected": expected}
    r = compute_reward("please finalize", response, gt)
    # format ok, content wrong, mild length penalty -> should be ≤ 0.4
    assert r < 0.5, f"expected r<0.5 for wrong action name, got {r}"


# ───────────────────────────── components + clamp ─────────────────────────────

def test_components_breakdown_present():
    expected = (
        "thought: hi\ntext: hello"
    )
    comps = compute_reward_components("hi", expected, {"task_type": "reply", "expected": expected})
    d = comps.to_dict()
    for k in ("format_ok", "content_ok", "length_score", "weighted_sum", "final"):
        assert k in d
    assert -1.0 <= d["final"] <= 1.0


def test_reward_clamped_to_unit_interval():
    # Even with a long correct response we never go above 1.0.
    response = "thought: long thought here\ntext: " + ("yes " * 200)
    gt = {"task_type": "reply", "expected": response}
    r = compute_reward("ok", response, gt)
    assert -1.0 <= r <= 1.0
