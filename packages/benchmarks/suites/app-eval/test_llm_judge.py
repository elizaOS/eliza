"""Unit tests for the opt-in app-eval LLM judge (#9475).

The judge augments — never replaces — the deterministic scorer. These tests
pin: the default is a no-op (deterministic preserved), the prompt/parse/blend
helpers are correct, scale normalization works, and a fake judge call blends as
expected. No network or API key required.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llm_judge  # noqa: E402

TASK = {
    "id": "t1",
    "prompt": "Write a function",
    "evaluation": {"scoring": {"max_score": 10}, "criteria": [{"name": "correctness", "weight": 1}]},
}


def test_apply_judge_is_noop_when_disabled(monkeypatch) -> None:
    monkeypatch.delenv("APP_EVAL_LLM_JUDGE", raising=False)
    result = {"task_id": "t1", "score": 6.0, "max_score": 10, "pass": True}
    out = llm_judge.apply_judge(result, TASK, "resp", call=lambda _p: "SCORE: 10/10")
    assert out == result  # unchanged — deterministic default preserved
    assert "judge_score" not in out


def test_apply_judge_blends_when_enabled(monkeypatch) -> None:
    monkeypatch.setenv("APP_EVAL_LLM_JUDGE", "1")
    monkeypatch.delenv("APP_EVAL_LLM_JUDGE_WEIGHT", raising=False)
    result = {"task_id": "t1", "score": 6.0, "max_score": 10, "pass": True}
    out = llm_judge.apply_judge(result, TASK, "resp", call=lambda _p: "SCORE: 10/10\nGreat.")
    assert out["judged"] is True
    assert out["deterministic_score"] == 6.0
    assert out["judge_score"] == 10.0
    # default weight 0.5 → (6 + 10) / 2 = 8.0
    assert out["score"] == 8.0


def test_apply_judge_respects_weight_env(monkeypatch) -> None:
    monkeypatch.setenv("APP_EVAL_LLM_JUDGE", "1")
    monkeypatch.setenv("APP_EVAL_LLM_JUDGE_WEIGHT", "0.25")
    result = {"score": 6.0}
    out = llm_judge.apply_judge(result, TASK, "resp", call=lambda _p: "SCORE: 10/10")
    # 0.75*6 + 0.25*10 = 7.0
    assert out["score"] == 7.0


def test_apply_judge_noop_when_call_unparseable(monkeypatch) -> None:
    monkeypatch.setenv("APP_EVAL_LLM_JUDGE", "1")
    result = {"score": 6.0}
    out = llm_judge.apply_judge(result, TASK, "resp", call=lambda _p: "no score here")
    assert out == result


def test_apply_judge_noop_when_call_raises(monkeypatch) -> None:
    monkeypatch.setenv("APP_EVAL_LLM_JUDGE", "1")

    def _boom(_p: str) -> str:
        raise RuntimeError("judge down")

    result = {"score": 6.0}
    out = llm_judge.apply_judge(result, TASK, "resp", call=_boom)
    assert out == result


def test_parse_judge_score_forms() -> None:
    assert llm_judge.parse_judge_score("SCORE: 7/10\nok", 10) == 7.0
    assert llm_judge.parse_judge_score("SCORE: 8", 10) == 8.0
    assert llm_judge.parse_judge_score("I'd say 6 / 10", 10) == 6.0
    # /5 scale normalizes to /10
    assert llm_judge.parse_judge_score("SCORE: 4/5", 10) == 8.0
    # clamp
    assert llm_judge.parse_judge_score("SCORE: 99/10", 10) == 10.0
    assert llm_judge.parse_judge_score("garbage", 10) is None


def test_blend_scores_endpoints() -> None:
    assert llm_judge.blend_scores(6, 10, weight=0.0) == 6.0
    assert llm_judge.blend_scores(6, 10, weight=1.0) == 10.0
    assert llm_judge.blend_scores(6, 10, weight=0.5) == 8.0


def test_default_judge_call_none_without_key(monkeypatch) -> None:
    monkeypatch.delenv("APP_EVAL_JUDGE_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert llm_judge.default_judge_call() is None


def test_build_judge_prompt_includes_task_and_response() -> None:
    prompt = llm_judge.build_judge_prompt(TASK, "my answer")
    assert "Write a function" in prompt
    assert "my answer" in prompt
    assert "SCORE:" in prompt
    assert "/10" in prompt
