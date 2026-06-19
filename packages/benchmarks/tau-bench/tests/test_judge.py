"""LLM judge tests — verify substring fallback and structured-LLM parsing."""

from unittest.mock import patch

from elizaos_tau_bench.judge import judge_outputs_satisfied


def test_no_outputs_required_returns_satisfied():
    r = judge_outputs_satisfied([], ["anything"], use_llm=False)
    assert r.satisfied is True
    assert r.per_output == {}


def test_substring_fallback_positive():
    r = judge_outputs_satisfied(
        outputs=["$125.00", "refund processed"],
        agent_messages=["Your refund of $125.00 has been refund processed via card 0000."],
        use_llm=False,
    )
    assert r.satisfied is True
    assert r.per_output["$125.00"] is True
    assert r.per_output["refund processed"] is True


def test_substring_fallback_missing_output():
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

    with patch.dict("os.environ", {"OPENAI_API_KEY": "sk-test"}), \
         patch("elizaos_tau_bench.model_client.completion", return_value=fake):
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


def test_llm_judge_falls_back_when_missing_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    r = judge_outputs_satisfied(
        outputs=["needle"],
        agent_messages=["needle is here"],
        use_llm=True,
    )
    assert r.satisfied is True
    assert "fallback" in r.explanation.lower()
