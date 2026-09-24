"""LLM judge tests — structured-LLM parsing, fail-fast on judge failure, and the
opt-in (explicitly marked) heuristic degrade. The substring path is exercised as
an explicit configuration, never as a silent stand-in for a broken judge."""

from unittest.mock import patch

import pytest

from elizaos_tau_bench.judge import (
    JudgeUnavailableError,
    judge_outputs_satisfied,
)


def test_no_outputs_required_returns_satisfied():
    r = judge_outputs_satisfied([], ["anything"], use_llm=False)
    assert r.satisfied is True
    assert r.per_output == {}
    assert r.mode == "none-required"
    assert r.degraded is False


def test_substring_check_positive_when_llm_judge_disabled():
    r = judge_outputs_satisfied(
        outputs=["$125.00", "refund processed"],
        agent_messages=["Your refund of $125.00 has been refund processed via card 0000."],
        use_llm=False,
    )
    assert r.satisfied is True
    assert r.per_output["$125.00"] is True
    assert r.per_output["refund processed"] is True
    assert r.mode == "substring"
    assert r.degraded is False


def test_substring_check_missing_output():
    r = judge_outputs_satisfied(
        outputs=["$200.00"],
        agent_messages=["Cancelled."],
        use_llm=False,
    )
    assert r.satisfied is False
    assert r.per_output["$200.00"] is False


def test_llm_judge_parses_structured_response():
    fake = type("R", (), {})()
    fake.choices = [type("C", (), {"message": type("M", (), {"content": '{"per_output": {"foo": true, "bar": false}, "explanation": "ok"}'})()})]

    with patch("elizaos_tau_bench.model_client.completion", return_value=fake):
        r = judge_outputs_satisfied(
            outputs=["foo", "bar"],
            agent_messages=["..."],
            model="gpt-4o-mini",
            provider="openai",
            use_llm=True,
        )
    assert r.per_output == {"foo": True, "bar": False}
    assert r.satisfied is False
    assert r.explanation == "ok"
    assert r.mode == "llm"
    assert r.degraded is False


def test_llm_judge_failure_raises_instead_of_substituting_heuristic():
    boom = RuntimeError("proxy unreachable")
    with patch("elizaos_tau_bench.model_client.completion", side_effect=boom):
        with pytest.raises(JudgeUnavailableError, match="judge LLM call failed") as exc:
            judge_outputs_satisfied(
                outputs=["needle"],
                agent_messages=["needle is here"],
                use_llm=True,
            )
    assert exc.value.__cause__ is boom


def test_llm_judge_unparseable_response_raises():
    fake = type("R", (), {})()
    fake.choices = [type("C", (), {"message": type("M", (), {"content": "sure, everything looks fine!"})()})]
    with patch("elizaos_tau_bench.model_client.completion", return_value=fake):
        with pytest.raises(JudgeUnavailableError, match="unparseable"):
            judge_outputs_satisfied(
                outputs=["needle"],
                agent_messages=["needle is here"],
                use_llm=True,
            )


def test_llm_judge_missing_credentials_raises(monkeypatch):
    # Real path, no mocks of the unit under test: with no key and no endpoint
    # configured, the completion backend fails and the judge must surface that
    # failure — a transcript that would substring-pass must NOT score.
    for var in (
        "OPENAI_API_KEY",
        "TAU_BENCH_OPENAI_API_KEY",
        "TAU_BENCH_OPENAI_BASE_URL",
        "BENCHMARK_BASE_URL",
        "OPENAI_BASE_URL",
        "CEREBRAS_BASE_URL",
        "CEREBRAS_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(JudgeUnavailableError):
        judge_outputs_satisfied(
            outputs=["needle"],
            agent_messages=["needle is here"],
            use_llm=True,
        )


def test_opt_in_degrade_marks_result_degraded():
    with patch(
        "elizaos_tau_bench.model_client.completion",
        side_effect=RuntimeError("proxy unreachable"),
    ):
        r = judge_outputs_satisfied(
            outputs=["needle", "$42.00"],
            agent_messages=["needle costs $42.00"],
            use_llm=True,
            allow_heuristic_fallback=True,
        )
    assert r.satisfied is True  # substring heuristic verdict
    assert r.degraded is True
    assert r.mode == "substring"
    assert "DEGRADED" in r.explanation
    assert "proxy unreachable" in r.explanation


def test_opt_in_degrade_still_reports_missing_outputs():
    with patch(
        "elizaos_tau_bench.model_client.completion",
        side_effect=RuntimeError("boom"),
    ):
        r = judge_outputs_satisfied(
            outputs=["$999.99"],
            agent_messages=["No numbers here."],
            use_llm=True,
            allow_heuristic_fallback=True,
        )
    assert r.satisfied is False
    assert r.degraded is True
