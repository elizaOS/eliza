"""Exercises bridge-side recording and retrieval completion invariants."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from eliza_adapter.experience import ElizaBridgeExperienceRunner, ElizaExperienceConfig


class _Client:
    def __init__(self) -> None:
        self.retrieval_prompt = ""

    def wait_until_ready(self, timeout: int = 120) -> None:
        pass

    def reset(self, *, task_id: str, benchmark: str) -> None:
        pass

    def send_message(self, text: str, context: dict[str, object]) -> SimpleNamespace:
        if context.get("phase") == "learning":
            return SimpleNamespace(
                text="RECORD_EXPERIENCE: saved",
                actions=["RECORD_EXPERIENCE"],
                params={},
            )
        self.retrieval_prompt = text
        return SimpleNamespace(
            text=(
                "Use the recorded learning: memory limits docker containers. "
                "Set explicit memory limits for Docker containers."
            ),
            actions=[],
            params={},
        )


def test_experience_bridge_supplies_retrieved_memories_to_retrieval_prompt() -> None:
    client = _Client()
    runner = ElizaBridgeExperienceRunner(
        config=ElizaExperienceConfig(
            num_learning_scenarios=1,
            num_retrieval_queries=3,
            num_background_experiences=25,
            seed=1,
        ),
        client=client,  # type: ignore[arg-type]
    )

    result = asyncio.run(runner.run())

    assert (
        "Retrieved past experiences from ExperienceService" in client.retrieval_prompt
    )
    assert "learned:" in client.retrieval_prompt
    agent = result["eliza_agent"]
    assert isinstance(agent, dict)
    assert agent["agent_keyword_incorporation_rate"] == 1.0
    assert result["complete"] is True
    assert result["schema_version"] == 2
    assert result["harness"] == "eliza"
    assert result["publishable_three_harness"] is False
    assert isinstance(result["workload_sha256"], str)
    assert len(result["workload_sha256"]) == 64
    config = result["config"]
    assert isinstance(config, dict)
    assert config["num_background_experiences"] == 25
    assert result["completed_learning_scenarios"] == 1
    assert result["attempted_learning_scenarios"] == 1
    assert result["completed_retrieval_queries"] == 3
    assert result["attempted_retrieval_queries"] == 3


def test_experience_bridge_does_not_turn_generic_acknowledgement_into_write() -> None:
    class AckClient(_Client):
        def send_message(
            self, text: str, context: dict[str, object]
        ) -> SimpleNamespace:
            return SimpleNamespace(text="Thanks, noted.", actions=[], params={})

    runner = ElizaBridgeExperienceRunner(
        config=ElizaExperienceConfig(
            num_learning_scenarios=1,
            num_retrieval_queries=1,
            num_background_experiences=0,
            seed=1,
        ),
        client=AckClient(),  # type: ignore[arg-type]
    )

    result = asyncio.run(runner.run())

    agent = result["eliza_agent"]
    assert isinstance(agent, dict)
    assert agent["learning_success_rate"] == 0.0
    assert agent["total_experiences_recorded"] == 0
    assert result["total_experiences"] == 0


def test_experience_bridge_fails_when_session_reset_fails() -> None:
    class ResetFailureClient(_Client):
        def reset(self, *, task_id: str, benchmark: str) -> None:
            raise RuntimeError("reset failed")

    runner = ElizaBridgeExperienceRunner(
        config=ElizaExperienceConfig(
            num_learning_scenarios=1,
            num_retrieval_queries=1,
            num_background_experiences=0,
            seed=1,
        ),
        client=ResetFailureClient(),  # type: ignore[arg-type]
    )

    with pytest.raises(RuntimeError, match="reset failed"):
        asyncio.run(runner.run())
