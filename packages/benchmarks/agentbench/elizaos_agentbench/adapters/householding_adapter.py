"""
Householding (ALFWorld) environment adapter for AgentBench.

ALFWorld is a TextWorld-style household environment. The upstream
config (``upstream/configs/tasks/alfworld.yaml``) points at thousands
of pre-generated PDDL games under ``json_2.1.1/valid_unseen/`` - these
are hundreds of megabytes and are NOT vendored here.

This adapter:

- Loads the task manifest via ``upstream_loader.load_householding_tasks``
  (game file paths grouped by category).
- Lazy-imports ``alfworld`` if installed; otherwise records a
  "missing dep" skip result with instructions.
- When ``alfworld`` is available, runs the standard interactive loop
  (admissible commands, partial reward, done-on-success).

Install for full evaluation::

    pip install alfworld
    export ALFWORLD_DATA=/path/to/alfworld/data
    alfworld-download  # downloads game files (~400MB)
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
from pathlib import Path

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

_ALFWORLD_SETUP_CACHE: tuple[bool, str | None] | None = None


def _default_alfworld_data_dir() -> Path:
    return Path.home() / ".cache" / "elizaos" / "alfworld"


def _alfworld_data_is_populated(data_dir: str | Path) -> bool:
    path = Path(data_dir)
    return (path / "json_2.1.1").exists() or any(path.glob("**/*.tw-pddl"))


def _reset_alfworld_setup_for_tests() -> None:
    global _ALFWORLD_SETUP_CACHE
    _ALFWORLD_SETUP_CACHE = None


def ensure_alfworld_data() -> tuple[bool, str | None]:
    """Best-effort explicit setup check for ALFWorld data."""
    global _ALFWORLD_SETUP_CACHE
    if _ALFWORLD_SETUP_CACHE is not None:
        return _ALFWORLD_SETUP_CACHE

    if "ALFWORLD_DATA" not in os.environ:
        os.environ["ALFWORLD_DATA"] = str(_default_alfworld_data_dir())
    data_dir = Path(os.environ["ALFWORLD_DATA"])

    try:
        import alfworld  # noqa: F401  # type: ignore
    except Exception:
        _ALFWORLD_SETUP_CACHE = (False, "alfworld package not installed")
        return _ALFWORLD_SETUP_CACHE

    if _alfworld_data_is_populated(data_dir):
        _ALFWORLD_SETUP_CACHE = (True, None)
        return _ALFWORLD_SETUP_CACHE

    if os.environ.get("AGENTBENCH_NO_AUTOFETCH") == "1":
        _ALFWORLD_SETUP_CACHE = (
            False,
            "AGENTBENCH_NO_AUTOFETCH is set and ALFWorld data is missing",
        )
        return _ALFWORLD_SETUP_CACHE

    cli = shutil.which("alfworld-download")
    cmd = [cli] if cli else ["python", "-m", "alfworld.download"]
    result = subprocess.run(
        cmd,
        env=os.environ.copy(),
        check=False,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if result.returncode != 0:
        _ALFWORLD_SETUP_CACHE = (
            False,
            f"alfworld-download failed: {result.stderr or result.stdout}",
        )
        return _ALFWORLD_SETUP_CACHE

    _ALFWORLD_SETUP_CACHE = (
        _alfworld_data_is_populated(data_dir),
        None if _alfworld_data_is_populated(data_dir) else "ALFWorld data still missing after download",
    )
    return _ALFWORLD_SETUP_CACHE


class HouseholdingEnvironmentAdapter(EnvironmentAdapter):
    """ALFWorld adapter (lazy ``alfworld`` import)."""

    environment = AgentBenchEnvironment.HOUSEHOLDING

    def __init__(
        self,
        runtime: AgentRuntimeProtocol | None = None,
        config: EnvironmentConfig | None = None,
    ) -> None:
        super().__init__(runtime, config)
        self._env = None
        self._available = False
        self._missing_reason: str | None = None
        self._last_observation: str = ""
        self._last_reward: float = 0.0
        self._done: bool = False
        self._success: bool = False

    async def initialize(self) -> None:
        if self._initialized:
            return
        try:
            # alfworld imports a lot at module load; we only check for
            # availability here, the per-task env is created in reset().
            import alfworld.agents.environment as alf_env  # noqa: F401  # type: ignore

            self._available = True
            logger.info("[ALFWorld] Detected alfworld package; full evaluation enabled")
        except Exception as e:
            self._available = False
            self._missing_reason = (
                f"alfworld package not available: {type(e).__name__}: {e}. "
                "Install with `pip install alfworld` and run `alfworld-download`."
            )
            logger.warning(f"[ALFWorld] {self._missing_reason}")
        self._initialized = True

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        self._last_observation = ""
        self._last_reward = 0.0
        self._done = False
        self._success = False

        if not self._available:
            return {
                "skipped": True,
                "reason": self._missing_reason or "alfworld unavailable",
                "task_description": task.description,
            }

        game_file = task.initial_state.get("game_file") if isinstance(task.initial_state, dict) else None
        if not isinstance(game_file, str):
            return {
                "error": "task.initial_state.game_file missing",
                "task_description": task.description,
            }

        alfworld_data = os.environ.get("ALFWORLD_DATA", "")
        full_path = os.path.join(alfworld_data, game_file) if alfworld_data else game_file
        if not os.path.exists(full_path):
            return {
                "skipped": True,
                "reason": (
                    f"ALFWorld game file not found at {full_path}; run "
                    "`alfworld-download` and set ALFWORLD_DATA."
                ),
                "task_description": task.description,
            }

        try:
            import textworld  # type: ignore
            from textworld import EnvInfos  # type: ignore

            infos = EnvInfos(
                admissible_commands=True, won=True, lost=True, max_score=True, score=True,
            )
            self._env = textworld.start(full_path, infos=infos)
            obs, infos_d = self._env.reset()
            self._last_observation = obs
            return {
                "observation": obs,
                "admissible_commands": infos_d.get("admissible_commands", []),
                "task_description": task.description,
            }
        except Exception as e:
            logger.error(f"[ALFWorld] failed to load game: {e}")
            return {
                "error": str(e),
                "task_description": task.description,
            }

    async def step(self, action: str) -> tuple[ObservationType, float, bool, StepInfoType]:
        if not self._available or self._env is None:
            return (
                {"skipped": True, "reason": self._missing_reason or "env not initialized"},
                0.0,
                True,
                {"skipped": True},
            )
        try:
            obs, score, done, infos = self._env.step(action)
            self._last_observation = obs
            self._last_reward = float(score)
            self._done = bool(done)
            self._success = bool(infos.get("won", False))
            return (
                {"observation": obs, "score": score, "admissible_commands": infos.get("admissible_commands", [])},
                float(score),
                bool(done),
                {"won": bool(infos.get("won", False))},
            )
        except Exception as e:
            return (
                {"error": str(e)},
                -0.1,
                True,
                {"exception": str(e)},
            )

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        return self._success

    async def cleanup(self) -> None:
        if self._env is not None:
            try:
                self._env.close()
            except Exception:
                pass
            self._env = None
        self._initialized = False

    def get_action_space(self) -> list[str]:
        return ["go to <recep>", "take <obj> from <recep>", "put <obj> in <recep>", "open <recep>", "close <recep>", "use <obj>", "look", "inventory"]

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        if observation.get("skipped"):
            return f"[ALFWorld skipped: {observation.get('reason', '')}]"
        obs = observation.get("observation", "")
        cmds = observation.get("admissible_commands", [])
        return (
            f"You are an ALFWorld agent.\n"
            f"Task: {task.description}\n\n"
            f"Current observation:\n{obs}\n\n"
            f"Admissible commands: {cmds[:20] if isinstance(cmds, list) else 'unknown'}\n\n"
            f"Reply with the next single command on its own line."
        )

    def parse_action(self, response: str) -> str:
        line = response.strip().splitlines()[0] if response.strip() else "look"
        return line[:200]
