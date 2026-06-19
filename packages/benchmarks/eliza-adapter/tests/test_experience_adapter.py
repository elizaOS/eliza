from __future__ import annotations

import asyncio
from types import SimpleNamespace

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
            num_background_experiences=25,
            seed=1,
        ),
        client=client,  # type: ignore[arg-type]
    )

    result = asyncio.run(runner.run())

    assert "Retrieved past experiences from ExperienceService" in client.retrieval_prompt
    assert "learned:" in client.retrieval_prompt
    agent = result["eliza_agent"]
    assert isinstance(agent, dict)
    assert agent["agent_keyword_incorporation_rate"] == 1.0
