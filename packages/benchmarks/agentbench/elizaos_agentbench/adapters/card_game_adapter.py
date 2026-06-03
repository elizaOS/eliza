"""
Card Game environment adapter for AgentBench.

The upstream Card Game environment is a multi-agent Avalon-style social
deduction game implemented in ``upstream/src/server/tasks/card_game``.
It depends on:

- a prebuilt native AI SDK (Linux/macOS ``.so``, see
  ``upstream/src/server/tasks/card_game/AI/sdk``) - NOT vendored here.
- a Flask-style server (``server.py``) that orchestrates the game.

Running the full benchmark requires both the SDK and an upstream
``card_game.server`` bridge. To keep this package importable on Windows/CI we
expose an adapter that:

- Loads upstream's task index (game seeds 0..N) via
  ``upstream_loader.load_card_game_tasks``.
- Skips execution and records an "unsupported" result with the exact external
  dependency status.
"""

from __future__ import annotations

import logging
import os

from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    AgentRuntimeProtocol,
    EnvironmentConfig,
    ObservationType,
)

logger = logging.getLogger(__name__)

StepInfoType = dict[str, str | int | float | bool | None]

_BIN_ENV = "AGENTBENCH_CARD_GAME_BIN"


class CardGameAdapter(EnvironmentAdapter):
    """Card Game adapter (skip mode until the upstream server bridge is available)."""

    environment = AgentBenchEnvironment.CARD_GAME

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        super().__init__(runtime, config)
        self._sdk_path: str | None = None
        self._skipped_reason: str | None = None

    async def initialize(self) -> None:
        if self._initialized:
            return
        sdk_path = os.environ.get(_BIN_ENV, "").strip()
        self._sdk_path = sdk_path if sdk_path and os.path.exists(sdk_path) else None
        sdk_status = (
            f"found SDK binary at {self._sdk_path}"
            if self._sdk_path
            else f"set {_BIN_ENV} to a built upstream SDK binary"
        )
        self._skipped_reason = (
            "Card Game tasks require the upstream Avalon card_game.server bridge "
            f"and SDK ({sdk_status}). Skipping this environment."
        )
        logger.warning(f"[CardGame] {self._skipped_reason}")
        self._initialized = True

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        return {
            "skipped": True,
            "reason": self._skipped_reason
            or "Card Game upstream server bridge unavailable",
            "task_description": task.description,
            "game_index": task.initial_state.get("game_index", 0)
            if isinstance(task.initial_state, dict)
            else 0,
        }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        return (
            {"skipped": True, "reason": self._skipped_reason or "", "action": action},
            0.0,
            True,
            {"action": action, "skipped": True},
        )

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        return False

    async def cleanup(self) -> None:
        self._initialized = False
        self._sdk_path = None

    def get_action_space(self) -> list[str]:
        return ["propose[team]", "vote[approve|reject]", "mission[success|fail]", "speak[message]"]

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        if observation.get("skipped"):
            return (
                "[Card Game adapter is skipped because the upstream SDK is "
                "not configured. Reply with 'skip'.]"
            )
        return f"You are playing AgentBench Card Game. Game seed: {observation.get('game_index')}. Take your next action."

    def parse_action(self, response: str) -> str:
        return response.strip().splitlines()[0] if response.strip() else "skip"
