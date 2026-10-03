"""WebShop local agents.

Bridge-backed Eliza runs are implemented in ``eliza_adapter.webshop``. This
module keeps the deterministic mock agent (now driving the **real** upstream
``WebAgentTextEnv``) and a few compatibility helpers for the Python harness,
but intentionally does not import ``elizaos``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from elizaos_webshop.environment import StepOutcome, WebShopEnvironment
from elizaos_webshop.trajectory_integration import WebShopTrajectoryIntegration
from elizaos_webshop.types import EpisodeStep, PageObservation, WebShopTask

logger = logging.getLogger(__name__)

# Compatibility flag for callers that used to probe Python Eliza availability.
ELIZAOS_AVAILABLE = False


@dataclass
class WebShopContext:
    """Mutable per-task context for the local mock agent."""

    task: WebShopTask | None = None
    env: WebShopEnvironment | None = None
    steps: list[EpisodeStep] = field(default_factory=list)
    done: bool = False
    reward: float = 0.0
    final_response: str = ""
    last_observation: PageObservation | None = None
    trajectory: WebShopTrajectoryIntegration | None = None
    trajectory_id: str | None = None
    step_id: str | None = None
    trial_number: int = 1


_global_context = WebShopContext()


def set_webshop_context(
    task: WebShopTask | None,
    env: WebShopEnvironment | None,
    *,
    trajectory: WebShopTrajectoryIntegration | None = None,
    trial_number: int = 1,
) -> None:
    _global_context.task = task
    _global_context.env = env
    _global_context.steps.clear()
    _global_context.done = False
    _global_context.reward = 0.0
    _global_context.final_response = ""
    _global_context.last_observation = None
    _global_context.trajectory = trajectory
    _global_context.trajectory_id = None
    _global_context.step_id = None
    _global_context.trial_number = trial_number


def get_webshop_context() -> WebShopContext:
    return _global_context


async def get_webshop_context_provider(*_args: object, **_kwargs: object) -> object:
    ctx = get_webshop_context()
    task = ctx.task
    if task is None:
        return {"text": "", "values": {}, "data": {}}
    obs = ctx.last_observation
    return {
        "text": (
            f"Instruction: {task.instruction}\n"
            f"Current page: {obs.page_type.value if obs else 'unknown'}\n"
            f"Steps taken: {len(ctx.steps)}"
        ),
        "values": {"webshop_done": ctx.done, "webshop_reward": ctx.reward},
        "data": {"task_id": task.task_id, "steps": len(ctx.steps)},
    }


class MockWebShopAgent:
    """Deterministic agent that drives the real upstream env.

    Strategy: use structural task metadata from upstream WebShop goals when it
    is available, search, click the target product, select requested option
    values, then buy. Used for smoke tests and harness validation, *not* as a
    baseline.
    """

    def __init__(self, env: WebShopEnvironment, *, max_turns: int = 20) -> None:
        self.env = env
        self.max_turns = max_turns

    async def initialize(self) -> None:
        return None

    async def process_task(
        self, task: WebShopTask
    ) -> tuple[list[EpisodeStep], str, PageObservation | None]:
        set_webshop_context(task, self.env, trajectory=None, trial_number=1)
        ctx = get_webshop_context()
        obs = self.env.reset(task)
        ctx.last_observation = obs

        def take_step(action: str) -> StepOutcome | None:
            if len(ctx.steps) >= self.max_turns:
                return None
            outcome = self.env.step(action)
            ctx.steps.append(
                EpisodeStep(
                    action=action,
                    observation=outcome.observation,
                    reward=outcome.reward,
                    done=outcome.done,
                    info=dict(outcome.info),
                )
            )
            ctx.done = bool(outcome.done)
            ctx.reward = float(outcome.reward)
            ctx.last_observation = outcome.observation
            return outcome

        goal = self._goal_payload(task)

        # Prefer upstream's query field when present. It avoids polluting the
        # search string with option and budget text from human instructions.
        query = str(goal.get("query") or "").strip()
        if not query:
            query = " ".join(task.instruction.split()[:8]).strip() or "product"
        take_step(f"search[{query}]")
        if ctx.done:
            ctx.final_response = self._final_message()
            return list(ctx.steps), ctx.final_response, ctx.last_observation

        target_asins = [asin.lower() for asin in task.target_product_ids if asin]
        avail = self.env.available_actions
        product_click = self._first_matching_click(avail, target_asins)
        if product_click is None:
            product_click = next(
                (a for a in avail if a.startswith("click[") and "next >" not in a.lower()
                 and "< prev" not in a.lower() and "back to search" not in a.lower()
                 and "buy now" not in a.lower()),
                None,
            )
        if product_click is not None:
            take_step(product_click)

        # Select only the option values requested by the upstream goal. Clicking
        # every option overwrites earlier selections and turns smoke tests into
        # guaranteed partial rewards.
        if not ctx.done:
            option_values = [
                str(value).strip().lower()
                for value in self._goal_options(goal).values()
                if str(value).strip()
            ]
            for option_value in option_values:
                avail = self.env.available_actions
                option_click = self._first_matching_click(avail, [option_value])
                if option_click is None:
                    continue
                take_step(option_click)
                if ctx.done:
                    break

        if not ctx.done:
            take_step("click[Buy Now]")

        ctx.final_response = self._final_message()
        return list(ctx.steps), ctx.final_response, ctx.last_observation

    def _final_message(self) -> str:
        if self.env.done:
            return (
                f"Purchased {self.env.purchased_product_id or 'nothing'} "
                f"with reward {self.env.final_reward:.2f}"
            )
        return (
            f"Stopped after {len(get_webshop_context().steps)} turns "
            f"with reward {get_webshop_context().reward:.2f}"
        )

    async def close(self) -> None:
        return None

    @staticmethod
    def _click_value(action: str) -> str:
        if action.lower().startswith("click[") and action.endswith("]"):
            return action[6:-1].strip().lower()
        return ""

    @classmethod
    def _first_matching_click(cls, actions: list[str], values: list[str]) -> str | None:
        wanted = {value.lower() for value in values if value}
        if not wanted:
            return None
        for action in actions:
            if cls._click_value(action) in wanted:
                return action
        return None

    @staticmethod
    def _goal_payload(task: WebShopTask) -> dict[str, Any]:
        raw = task.metadata.get("upstream_goal_json")
        if not isinstance(raw, str) or not raw.strip():
            return {}
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _goal_options(goal: dict[str, Any]) -> dict[str, Any]:
        options = goal.get("goal_options")
        return options if isinstance(options, dict) else {}


def get_model_provider_plugin(_provider: str | None = None) -> None:
    return None


def create_webshop_actions() -> list[object]:
    return []


def get_webshop_plugin() -> None:
    return None


def create_webshop_agent(
    env: WebShopEnvironment,
    *,
    max_turns: int = 20,
    use_mock: bool = False,
    model_provider: str | None = None,
    temperature: float = 0.0,
    trajectory: WebShopTrajectoryIntegration | None = None,
) -> MockWebShopAgent:
    """Create the local WebShop agent.

    Non-mock Eliza execution is bridge-only and is selected by
    ``WebShopRunner`` before this factory is called.
    """
    _ = use_mock, model_provider, temperature, trajectory
    return MockWebShopAgent(env=env, max_turns=max_turns)


__all__ = [
    "ELIZAOS_AVAILABLE",
    "MockWebShopAgent",
    "WebShopContext",
    "create_webshop_actions",
    "create_webshop_agent",
    "get_model_provider_plugin",
    "get_webshop_context",
    "get_webshop_context_provider",
    "get_webshop_plugin",
    "set_webshop_context",
]
