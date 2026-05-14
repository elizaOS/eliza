"""
Card Game environment adapter for AgentBench.

The upstream Card Game environment is a multi-agent Avalon-style social
deduction game implemented in ``upstream/src/server/tasks/card_game``.
It depends on:

- a prebuilt native AI SDK (Linux/macOS ``.so``, see
  ``upstream/src/server/tasks/card_game/AI/sdk``) - NOT vendored here.
- a Flask-style server (``server.py``) that orchestrates the game.

Running the full benchmark therefore requires building the SDK on a
Linux box. To keep this package importable on Windows/CI we expose a
minimal adapter that:

- Loads upstream's task index (game seeds 0..N) via
  ``upstream_loader.load_card_game_tasks``.
- Skips execution and records an "unsupported" result *unless* the
  ``AGENTBENCH_CARD_GAME_BIN`` environment variable points at a
  compatible upstream binary.
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
    """Card Game adapter (skip mode unless the upstream SDK is available)."""

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
        if sdk_path and os.path.exists(sdk_path):
            self._sdk_path = sdk_path
            logger.info(f"[CardGame] Using upstream SDK at {sdk_path}")
        else:
            self._skipped_reason = (
                "Card Game tasks need the upstream Avalon AI SDK "
                f"(set {_BIN_ENV} to a built binary). Skipping."
            )
            logger.warning(f"[CardGame] {self._skipped_reason}")
        self._initialized = True

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        if self._sdk_path is None:
            return {
                "skipped": True,
                "reason": self._skipped_reason or "Card Game SDK unavailable",
                "task_description": task.description,
            }
        # Real reset would launch upstream's CardGame `Task` via subprocess
        # / IPC. We document the contract here; not implementing because
        # the binary isn't part of this package.
        return {
            "skipped": False,
            "task_description": task.description,
            "game_index": task.initial_state.get("game_index", 0)
            if isinstance(task.initial_state, dict)
            else 0,
        }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        if self._sdk_path is None:
            return (
                {"skipped": True, "reason": self._skipped_reason or ""},
                0.0,
                True,
                {"action": action, "skipped": True},
            )
        # TODO: bridge to upstream `card_game.server` once the SDK is built.
        return (
            {"error": "card_game server bridge not implemented", "action": action},
            0.0,
            True,
            {"action": action, "implemented": False},
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
