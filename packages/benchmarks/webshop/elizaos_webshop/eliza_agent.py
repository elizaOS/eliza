"""WebShop local agents without the Python Eliza runtime.

Bridge-backed Eliza runs are implemented in ``eliza_adapter.webshop``. This
module keeps the deterministic mock agent and a few compatibility helpers for
the Python harness, but intentionally does not import ``elizaos``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

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
    """Reset the global WebShop task context."""
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
    """Return the current WebShop context."""
    return _global_context


async def get_webshop_context_provider(*_args: object, **_kwargs: object) -> object:
    """Compatibility stub for the removed Python Eliza provider."""
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
    """Simple deterministic agent for smoke tests and harness validation."""

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

        query = " ".join(task.instruction.split()[:6]).strip() or "product"
        out = take_step(f"search[{query}]")
        if out is not None and out.observation.results:
            pid = out.observation.results[0].product_id
            out2 = take_step(f"click[{pid}]")
            if out2 is not None and out2.observation.product is not None:
                for opt, vals in out2.observation.product.options.items():
                    if not vals:
                        continue
                    preferred = task.goal_attributes.get(f"{opt}_option")
                    if preferred not in vals:
                        preferred = task.goal_attributes.get(opt)
                    value = preferred if preferred in vals else vals[0]
                    out3 = take_step(f"select_option[{opt}, {value}]")
                    if out3 is None or out3.done:
                        break
                if not ctx.done:
                    take_step("buy")

        ctx.final_response = (
            f"Purchased {self.env.purchased_product_id or 'nothing'} with reward {self.env.final_reward:.2f}"
            if ctx.done
            else f"Stopped after {len(ctx.steps)} turns with reward {ctx.reward:.2f}"
        )
        return list(ctx.steps), ctx.final_response, ctx.last_observation

    async def close(self) -> None:
        return None


def get_model_provider_plugin(_provider: str | None = None) -> None:
    """Compatibility stub for the removed Python Eliza model plugin path."""
    return None


def create_webshop_actions() -> list[object]:
    """Compatibility stub for the removed Python Eliza actions."""
    return []


def get_webshop_plugin() -> None:
    """Compatibility stub for the removed Python Eliza plugin."""
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
