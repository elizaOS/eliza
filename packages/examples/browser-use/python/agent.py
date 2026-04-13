"""
Browser Use Agent for Mind2Web

This module provides a high-level interface to the ElizaOS browser agent
for the Mind2Web benchmark.

Example:
    from agent import create_browser_agent, BrowserAgentConfig

    config = BrowserAgentConfig(
        provider="groq",
        temperature=0.0,
    )

    agent = await create_browser_agent(config)

    # Process a task
    result = await agent.process_task(task)

    await agent.close()
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

# Add repo paths for imports
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "packages" / "python"))
sys.path.insert(0, str(REPO_ROOT / "benchmarks"))

if TYPE_CHECKING:
    from benchmarks.mind2web.types import Mind2WebAction, Mind2WebTask


@dataclass
class BrowserAgentConfig:
    """Configuration for the browser agent."""

    provider: str = "auto"  # groq, openai, anthropic, auto
    model_name: str | None = None
    temperature: float = 0.0
    max_steps: int = 20
    verbose: bool = False


async def create_browser_agent(config: BrowserAgentConfig) -> "BrowserAgent":
    """Create and initialize a browser agent.

    Args:
        config: Agent configuration

    Returns:
        Initialized BrowserAgent
    """
    agent = BrowserAgent(config)
    await agent.initialize()
    return agent


class BrowserAgent:
    """Browser agent for web navigation tasks.

    Uses ElizaOS runtime with the Mind2Web benchmark plugin.
    """

    def __init__(self, config: BrowserAgentConfig) -> None:
        self.config = config
        self._agent: "ElizaOSMind2WebAgent | None" = None
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the agent."""
        if self._initialized:
            return

        from benchmarks.mind2web.eliza_agent import ElizaOSMind2WebAgent
        from benchmarks.mind2web.types import Mind2WebConfig

        # Create Mind2Web config
        mind2web_config = Mind2WebConfig(
            model_provider=self.config.provider if self.config.provider != "auto" else None,
            temperature=self.config.temperature,
            max_steps_per_task=self.config.max_steps,
            verbose=self.config.verbose,
            use_mock=False,
        )

        # Create the underlying agent
        self._agent = ElizaOSMind2WebAgent(mind2web_config)
        await self._agent.initialize()
        self._initialized = True

    async def process_task(self, task: "Mind2WebTask") -> list["Mind2WebAction"]:
        """Process a web navigation task.

        Args:
            task: The Mind2Web task to process

        Returns:
            List of predicted browser actions
        """
        if not self._initialized or self._agent is None:
            raise RuntimeError("Agent not initialized. Call initialize() first.")

        return await self._agent.process_task(task)

    async def close(self) -> None:
        """Clean up resources."""
        if self._agent:
            await self._agent.close()
        self._initialized = False


# Convenience functions for quick usage


async def run_single_task(
    instruction: str,
    *,
    provider: str = "auto",
    verbose: bool = False,
) -> list["Mind2WebAction"]:
    """Run a single web navigation task.

    Args:
        instruction: Natural language instruction (e.g., "Search for headphones on Amazon")
        provider: Model provider (groq, openai, anthropic, auto)
        verbose: Enable verbose logging

    Returns:
        List of browser actions to execute

    Example:
        actions = await run_single_task(
            "Search for 'wireless headphones' on Amazon",
            provider="groq",
        )
        for action in actions:
            print(f"{action.operation}: {action.element_id}")
    """
    from benchmarks.mind2web.types import Mind2WebTask

    # Create a simple task
    task = Mind2WebTask(
        annotation_id="adhoc_001",
        confirmed_task=instruction,
        website="unknown",
        domain="unknown",
    )

    config = BrowserAgentConfig(
        provider=provider,
        verbose=verbose,
    )

    agent = await create_browser_agent(config)
    try:
        return await agent.process_task(task)
    finally:
        await agent.close()


if __name__ == "__main__":
    # Quick test
    import asyncio

    async def _test() -> None:
        print("Testing browser agent...")

        actions = await run_single_task(
            "Search for wireless headphones on Amazon and filter by price under $50",
            provider="groq",
            verbose=True,
        )

        print(f"\nPredicted {len(actions)} actions:")
        for i, action in enumerate(actions, 1):
            print(f"  {i}. {action.operation.value} -> {action.element_id}")
            if action.value:
                print(f"      value: {action.value}")

    asyncio.run(_test())
