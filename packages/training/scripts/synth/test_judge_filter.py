"""Tests for the synth LLM-judge pre-training filter (M7 / W1-S3).

CPU-only. The default `compute_reward_components` runs end-to-end against a
fixture set so we exercise the real format/content scorers — no live AI judge
call (gated off by `ELIZA_REWARD_USE_AI_JUDGE`, default 0). A second test
suite drives `filter_stream` with a mocked judge function to assert routing
math, since the real scorer's output for some bucket+response pairs depends
on TOON parser details that are tested elsewhere.

Run:
    cd packages/training && pytest -xvs scripts/synth/test_judge_filter.py
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]  # packages/training/scripts/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_reward_fn import RewardComponents  # noqa: E402
from synth.judge_filter import (  # noqa: E402
    ExtractedRecord,
    extract_record,
    filter_stream,
    judge_record,
    main as cli_main,
    tag_kept,
    tag_rejected,
)


# ───────────────────────────── extraction ─────────────────────────────


def test_extract_nubilio_messages_shape() -> None:
    rec = {
        "messages": [
            {"role": "system", "content": "you are eliza"},
            {"role": "user", "content": "hi there"},
            {"role": "model", "content": "thought: greet\ntext: hi"},
        ],
        "task_id": "abc",
        "task_type": "reply",
    }
    extracted = extract_record(rec)
    assert extracted.prompt == "hi there"
    assert extracted.response == "thought: greet\ntext: hi"
    assert extracted.task_type == "reply"
    assert extracted.ground_truth is None


def test_extract_assistant_role_accepted() -> None:
    rec = {
        "messages": [
            {"role": "user", "content": "ping"},
            {"role": "assistant", "content": "thought: ack\ntext: pong"},
        ],
        "task_type": "reply",
    }
    extracted = extract_record(rec)
    assert extracted.response == "thought: ack\ntext: pong"


def test_extract_raw_eliza_shape_uses_expected_response() -> None:
    rec = {
        "currentMessage": {"content": "please finalize"},
        "expectedResponse": (
            "thought: finalize\n"
            "actions[1]:\n"
            "  - name: FINALIZE_WORKSPACE\n"
            "providers: \"\"\n"
            "text: done"
        ),
        "metadata": {"task_type": "message_handler"},
    }
    extracted = extract_record(rec)
    assert extracted.prompt == "please finalize"
    assert "FINALIZE_WORKSPACE" in extracted.response
    assert extracted.task_type == "message_handler"
    # expectedResponse also becomes ground_truth so the verifiable check has
    # something to compare against.
    assert extracted.ground_truth is not None
    assert extracted.ground_truth["task_type"] == "message_handler"
    assert "FINALIZE_WORKSPACE" in extracted.ground_truth["expected"]


def test_extract_top_level_prompt_response() -> None:
    rec = {
        "prompt": "hey",
        "response": "thought: hi\ntext: hello",
        "task_type": "reply",
    }
    extracted = extract_record(rec)
    assert extracted.prompt == "hey"
    assert extracted.response == "thought: hi\ntext: hello"


def test_extract_task_type_from_benchmark_prefix() -> None:
    rec = {
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "model", "content": "thought: hi\ntext: hi"},
        ],
        "benchmark": "synth-reply",
    }
    extracted = extract_record(rec)
    assert extracted.task_type == "reply"


def test_extract_ground_truth_block_normalizes_task_type() -> None:
    rec = {
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "model", "content": "thought: hi\ntext: hi"},
        ],
        "task_type": "reply",
        "ground_truth": {"expected": "thought: hi\ntext: hi"},
    }
    extracted = extract_record(rec)
    assert extracted.ground_truth is not None
    assert extracted.ground_truth["task_type"] == "reply"
    assert extracted.ground_truth["expected"].startswith("thought:")


def test_extract_missing_data_returns_empty_response() -> None:
    rec: dict = {"random": "garbage"}
    extracted = extract_record(rec)
    assert extracted.response == ""


# ───────────────────────────── mocked judge routing ─────────────────────────────


def _components(final: float, fmt: float = 1.0, content: float = 1.0) -> RewardComponents:
    return RewardComponents(
        format_ok=fmt,
        content_ok=content,
        length_score=0.0,
        ai_judge_score=None,
        weighted_sum=final,
        final=final,
        notes=[],
    )


def _make_record(response: str, prompt: str = "ping") -> dict:
    return {
        "messages": [
            {"role": "user", "content": prompt},
            {"role": "model", "content": response},
        ],
        "task_type": "reply",
        "task_id": "fixture",
    }


def test_judge_record_keep_above_threshold() -> None:
    fake_judge = lambda p, r, gt: _components(0.9)  # noqa: E731
    outcome = judge_record(
        _make_record("thought: hi\ntext: hi"),
        threshold=0.5,
        judge_fn=fake_judge,
    )
    assert outcome.keep is True
    assert outcome.score == pytest.approx(0.9)
    assert outcome.reason == ""


def test_judge_record_reject_below_threshold_has_reason() -> None:
    fake_judge = lambda p, r, gt: _components(0.2)  # noqa: E731
    outcome = judge_record(
        _make_record("thought: hi\ntext: hi"),
        threshold=0.5,
        judge_fn=fake_judge,
    )
    assert outcome.keep is False
    assert outcome.reason.startswith("below_threshold:")
    assert "0.2" in outcome.reason


def test_judge_record_keep_exactly_at_threshold() -> None:
    # `>= threshold` is the contract; exactly-at-threshold should keep.
    fake_judge = lambda p, r, gt: _components(0.5)  # noqa: E731
    outcome = judge_record(
        _make_record("thought: hi\ntext: hi"),
        threshold=0.5,
        judge_fn=fake_judge,
    )
    assert outcome.keep is True


def test_judge_record_no_response_hard_reject() -> None:
    fake_judge = lambda *a, **kw: pytest.fail("judge should not be invoked")  # noqa: E731
    outcome = judge_record(
        {"messages": [{"role": "user", "content": "ping"}], "task_type": "reply"},
        threshold=0.5,
        judge_fn=fake_judge,
    )
    assert outcome.keep is False
    assert outcome.reason == "no_model_response"


def test_judge_record_no_prompt_hard_reject() -> None:
    fake_judge = lambda *a, **kw: pytest.fail("judge should not be invoked")  # noqa: E731
    rec = {
        "messages": [{"role": "model", "content": "thought: hi\ntext: hi"}],
        "task_type": "reply",
    }
    outcome = judge_record(rec, threshold=0.5, judge_fn=fake_judge)
    assert outcome.keep is False
    assert outcome.reason == "no_user_prompt"


def test_judge_record_scorer_exception_routes_to_reject() -> None:
    def boom(p: str, r: str, gt) -> RewardComponents:  # noqa: ARG001
        raise RuntimeError("scorer blew up")

    outcome = judge_record(
        _make_record("thought: hi\ntext: hi"),
        threshold=0.5,
        judge_fn=boom,
    )
    assert outcome.keep is False
    assert outcome.reason.startswith("scoring_failed:RuntimeError")
    assert "scorer blew up" in outcome.reason


# ───────────────────────────── tagging ─────────────────────────────


def test_tag_kept_adds_score_and_mirrors_metadata() -> None:
    rec = {"task_id": "x", "metadata": {"task_type": "reply"}, "messages": []}
    outcome = judge_record(  # need a real outcome for components
        _make_record("thought: hi\ntext: hi"),
        threshold=0.5,
        judge_fn=lambda *a, **kw: _components(0.77),
    )
    tagged = tag_kept(rec, outcome)
    assert tagged["judge_score"] == pytest.approx(0.77)
    assert tagged["judge_components"]["final"] == pytest.approx(0.77)
    assert tagged["metadata"]["judge_score"] == pytest.approx(0.77)
    # original dict isn't mutated.
    assert "judge_score" not in rec
    assert "judge_score" not in rec["metadata"]


def test_tag_rejected_serializes_inf_score_as_unscored() -> None:
    outcome = judge_record(
        {"messages": [{"role": "user", "content": "ping"}], "task_type": "reply"},
        threshold=0.5,
        judge_fn=lambda *a, **kw: pytest.fail("not called"),
    )
    tagged = tag_rejected({"task_id": "y"}, outcome)
    assert tagged["judge_reject_reason"] == "no_model_response"
    assert tagged["judge_score"] == "unscored"
    # Must be JSON-round-trippable.
    json.dumps(tagged)


# ───────────────────────────── filter_stream end-to-end ─────────────────────────────


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")


def test_filter_stream_routes_keep_and_reject(tmp_path: Path) -> None:
    # Three keepers, two rejects (one below threshold, one unparseable), one
    # missing-response hard reject. The mocked judge returns score == record's
    # `mock_score` field so we can assert routing exactly.
    good_a = {**_make_record("thought: a\ntext: a"), "task_id": "a", "mock_score": 0.9}
    good_b = {**_make_record("thought: b\ntext: b"), "task_id": "b", "mock_score": 0.6}
    bad_low = {**_make_record("thought: c\ntext: c"), "task_id": "c", "mock_score": 0.1}
    bad_no_resp = {
        "messages": [{"role": "user", "content": "no resp"}],
        "task_type": "reply",
        "task_id": "d",
    }
    rows = [good_a, good_b, bad_low, bad_no_resp]
    in_path = tmp_path / "in.jsonl"
    _write_jsonl(in_path, rows)
    # Append an unparseable line to exercise the parse_failed path.
    with in_path.open("a", encoding="utf-8") as f:
        f.write("{ this is not json\n")

    keep_path = tmp_path / "keep.jsonl"
    reject_path = tmp_path / "reject.jsonl"

    def fake_judge(prompt: str, response: str, gt):  # noqa: ARG001
        # The driver re-extracts; we need to find the score via the record. We
        # don't get the record here, but the prompt/response uniquely identifies
        # each fixture, so we map back.
        for r in (good_a, good_b, bad_low):
            r_messages = r["messages"]
            if r_messages[1]["content"] == response:
                return _components(r["mock_score"])
        return _components(0.0)

    stats = filter_stream(
        in_path, keep_path, reject_path, threshold=0.5, judge_fn=fake_judge,
    )

    kept_records = [json.loads(line) for line in keep_path.read_text().splitlines() if line]
    reject_records = [json.loads(line) for line in reject_path.read_text().splitlines() if line]

    kept_ids = sorted(r.get("task_id") for r in kept_records)
    assert kept_ids == ["a", "b"]
    # Each kept record has judge_score >= threshold.
    for r in kept_records:
        assert r["judge_score"] >= 0.5
        assert "judge_components" in r
    # Reject file has the below_threshold record, the no-response record, AND
    # the unparseable line — none are silently dropped.
    assert len(reject_records) == 3
    reasons = sorted(r.get("judge_reject_reason", "") for r in reject_records)
    assert any(r.startswith("below_threshold:") for r in reasons)
    assert any(r == "no_model_response" for r in reasons)
    assert any(r.startswith("parse_failed:") for r in reasons)

    # Stats reflect the same picture.
    assert stats.seen == 5
    assert stats.kept == 2
    assert stats.rejected == 3
    assert stats.parse_failed == 1
    assert stats.score_sum_kept == pytest.approx(0.9 + 0.6)


def test_filter_stream_skips_blank_lines(tmp_path: Path) -> None:
    in_path = tmp_path / "in.jsonl"
    in_path.write_text("\n\n" + json.dumps(_make_record("thought: hi\ntext: hi")) + "\n\n\n")
    keep = tmp_path / "k.jsonl"
    reject = tmp_path / "r.jsonl"
    stats = filter_stream(
        in_path, keep, reject, threshold=0.0,
        judge_fn=lambda *a, **kw: _components(0.5),
    )
    assert stats.seen == 1
    assert stats.kept == 1


# ───────────────────────────── CLI ─────────────────────────────


def test_cli_invocation_writes_files_and_summary(tmp_path: Path) -> None:
    # End-to-end: invoke the same `main()` the `python -m synth.judge_filter`
    # entrypoint runs, with a real reward function (no AI judge — env var
    # default is off). Verifies the CLI plumbing more than the score itself.
    rec = {
        "messages": [
            {"role": "user", "content": "please finalize workspace"},
            {
                "role": "model",
                "content": (
                    "thought: finalize\n"
                    "actions[1]:\n"
                    "  - name: FINALIZE_WORKSPACE\n"
                    "providers: \"\"\n"
                    "text: done"
                ),
            },
        ],
        "task_id": "cli",
        "task_type": "message_handler",
        "ground_truth": {
            "expected": (
                "thought: finalize\n"
                "actions[1]:\n"
                "  - name: FINALIZE_WORKSPACE\n"
                "providers: \"\"\n"
                "text: done"
            ),
        },
    }
    in_path = tmp_path / "in.jsonl"
    in_path.write_text(json.dumps(rec) + "\n")
    keep = tmp_path / "keep.jsonl"
    reject = tmp_path / "reject.jsonl"
    summary = tmp_path / "summary.json"

    rc = cli_main([
        "--input", str(in_path),
        "--output-keep", str(keep),
        "--output-reject", str(reject),
        "--threshold", "-1.0",  # accept everything to test CLI plumbing
        "--summary", str(summary),
    ])
    assert rc == 0
    # The single record must land in exactly one file.
    kept_lines = [line for line in keep.read_text().splitlines() if line]
    reject_lines = [line for line in reject.read_text().splitlines() if line]
    assert len(kept_lines) + len(reject_lines) == 1
    s = json.loads(summary.read_text())
    assert s["seen"] == 1
    assert s["kept"] + s["rejected"] == 1


def test_cli_rejects_threshold_outside_range(tmp_path: Path) -> None:
    in_path = tmp_path / "in.jsonl"
    in_path.write_text("")
    rc = cli_main([
        "--input", str(in_path),
        "--output-keep", str(tmp_path / "k.jsonl"),
        "--output-reject", str(tmp_path / "r.jsonl"),
        "--threshold", "2.0",
    ])
    assert rc == 2


def test_cli_rejects_missing_input(tmp_path: Path) -> None:
    rc = cli_main([
        "--input", str(tmp_path / "does-not-exist.jsonl"),
        "--output-keep", str(tmp_path / "k.jsonl"),
        "--output-reject", str(tmp_path / "r.jsonl"),
    ])
    assert rc == 2
