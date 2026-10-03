"""Exercises runner transport, result accounting, and fixture handling."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

from elizaos_tau_bench.runner import TauBenchRunner
from elizaos_tau_bench.types import TauBenchConfig
from elizaos_tau_bench.upstream.envs.user import GroundedUserSimulationEnv


def test_grounded_sample_user_does_not_hallucinate_email():
    user = GroundedUserSimulationEnv()
    user.reset(
        "You are Yusuf Rossi in 19122. You received your order #W2378156 "
        "and wish to exchange the mechanical keyboard."
    )

    answer = user.step("Can you give me the email address on your account?")

    assert "@" not in answer
    assert "Yusuf Rossi" in answer
    assert "19122" in answer


def test_sample_cli_defaults_to_grounded_user(tmp_path):
    from elizaos_tau_bench.cli import build_config, parse_args

    cfg = build_config(
        parse_args(
            [
                "--use-sample-tasks",
                "--output-dir",
                str(tmp_path / "out"),
            ]
        )
    )

    assert cfg.user_strategy == "grounded"


def test_sample_runner_defaults_to_grounded_user(monkeypatch):
    from elizaos_tau_bench import runner as runner_mod

    captured = {}

    def fake_get_env(**kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop after env construction args")

    monkeypatch.setattr(runner_mod, "get_env", fake_get_env)
    cfg = TauBenchConfig(domains=["retail"], use_sample_tasks=True, use_mock=False)

    try:
        TauBenchRunner(cfg)._make_env("retail", 0)
    except RuntimeError as exc:
        assert "stop after env construction args" in str(exc)

    assert captured["user_strategy"] == "grounded"


# --- Real-LLM-shaped smoke test (litellm patched) -----------------------------


class _FakeMessage:
    def __init__(self, content: str | None, tool_calls: list[dict] | None = None):
        self.content = content
        self.tool_calls = tool_calls
        self.role = "assistant"

    def model_dump(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "content": self.content,
            "tool_calls": self.tool_calls,
        }


class _FakeChoice:
    def __init__(self, msg: _FakeMessage):
        self.message = msg


class _FakeResponse:
    def __init__(self, msg: _FakeMessage, cost: float = 0.0):
        self.choices = [_FakeChoice(msg)]
        self._hidden_params = {"response_cost": cost}


class _LLMScript:
    """Scripts both the agent LLM and the user-simulator LLM.

    The user simulator emits 3 turns: an initial greeting, a follow-up, then
    ###STOP###. The agent issues one real tool call (find_user_id_by_email
    against a known retail user) and then RESPONDs.
    """

    def __init__(self) -> None:
        self.agent_call_idx = 0
        self.user_call_idx = 0
        self.tool_call_id = "call_test_1"

    def __call__(self, *args, **kwargs):  # litellm.completion signature
        messages = kwargs.get("messages", [])
        tools = kwargs.get("tools")
        # Distinguish agent vs user by presence of tools list
        if tools:
            return self._agent_response()
        return self._user_response(messages)

    def _agent_response(self) -> _FakeResponse:
        self.agent_call_idx += 1
        if self.agent_call_idx == 1:
            # First, call a real env tool
            msg = _FakeMessage(
                content=None,
                tool_calls=[
                    {
                        "id": self.tool_call_id,
                        "type": "function",
                        "function": {
                            "name": "find_user_id_by_email",
                            "arguments": json.dumps(
                                {"email": "yusuf.rossi@example.com"}
                            ),
                        },
                    }
                ],
            )
        else:
            # Then a plain text response to give the user simulator a turn
            msg = _FakeMessage(content="I've looked up the account. Anything else?")
        return _FakeResponse(msg)

    def _user_response(self, messages) -> _FakeResponse:
        self.user_call_idx += 1
        if self.user_call_idx == 1:
            content = "Hi! Please look up my account."
        elif self.user_call_idx == 2:
            content = "Thanks, that's all I needed."
        else:
            content = "###STOP###"
        return _FakeResponse(_FakeMessage(content=content), cost=0.0)


def test_real_llm_shaped_smoke_runs_multi_turn_with_tool_call(tmp_path, monkeypatch):
    """Verify the multi-turn loop with a patched completion adapter.

    Smoke-checks the wiring: the same patched completion function serves both the
    agent (tool-calling) and the user simulator (plain chat). The user simulator
    must emit ``###STOP###`` to end the rollout, proving multiple turns happen.
    """
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("TAU_BENCH_DATA_MODE", "smoke")

    script = _LLMScript()
    # Agent + user simulator both route through the same completion adapter.
    with patch("elizaos_tau_bench.model_client.completion", side_effect=script):
        cfg = TauBenchConfig(
            domains=["retail"],
            task_ids=[0],  # First retail task
            use_mock=False,
            num_trials=1,
            pass_k_values=[1],
            use_llm_judge=False,
            agent_max_turns=6,
            output_dir=str(tmp_path / "out"),
        )
        report = TauBenchRunner(cfg).run()

    assert report.num_tasks == 1
    r = report.results[0]
    # Tool call landed
    assert r.num_tool_calls >= 1, "agent did not execute any env tool"
    # Multi-turn: user simulator was invoked multiple times
    assert script.user_call_idx >= 2, (
        f"expected ≥2 user-simulator turns, got {script.user_call_idx}"
    )
    # pass^k harness completed
    assert 1 in report.pass_k
