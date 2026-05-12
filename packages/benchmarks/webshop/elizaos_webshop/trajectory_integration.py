"""No-op trajectory compatibility layer for WebShop.

The Python Eliza runtime trajectory path has been removed. Real Eliza runs go
through the TypeScript benchmark bridge, which owns runtime-side logging.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


TRAJECTORY_LOGGER_AVAILABLE = False
ExportFormat = Literal["art", "grpo"]


@dataclass(frozen=True)
class WebShopTrajectoryConfig:
    enabled: bool = True
    export_format: ExportFormat = "art"
    scenario_prefix: str = "webshop"


class WebShopTrajectoryIntegration:
    def __init__(self, config: WebShopTrajectoryConfig | None = None) -> None:
        self.config = config or WebShopTrajectoryConfig()

    @property
    def enabled(self) -> bool:
        return False

    def start_task(self, *args: object, **kwargs: object) -> str | None:
        return None

    def start_turn(self, *args: object, **kwargs: object) -> str | None:
        return None

    def log_provider_access(self, *args: object, **kwargs: object) -> None:
        return None

    def log_action_attempt(self, *args: object, **kwargs: object) -> None:
        return None

    async def end_task(self, *args: object, **kwargs: object) -> None:
        return None

    def export_trajectories(self, *args: object, **kwargs: object) -> None:
        return None

    def wrap_runtime(self, runtime: object) -> None:
        _ = runtime

    def flush_llm_calls_to_step(self, *args: object, **kwargs: object) -> None:
        return None

    def restore_runtime(self) -> None:
        return None
