"""
ElizaOS-integrated agent for WebShop.

This follows the canonical ElizaOS flow (like tau-bench):
- Messages processed through runtime.message_service.handle_message()
- Actions executed via process_actions()
- Providers inject environment/task context into state
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import uuid4

from elizaos_webshop.environment import StepOutcome, WebShopEnvironment
from elizaos_webshop.trajectory_integration import WebShopTrajectoryIntegration
from elizaos_webshop.types import EpisodeStep, PageObservation, WebShopTask

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, IAgentRuntime, State
    from elizaos.types.components import ActionResult, HandlerOptions

logger = logging.getLogger(__name__)


try:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.components import (
        Action,
        ActionResult,
        ActionExample,
        ActionParameter,
        ActionParameterSchema,
        Provider,
        ProviderResult,
    )
    from elizaos.types.memory import Memory
    from elizaos.types.plugin import Plugin
    from elizaos.types.primitives import Content, as_uuid

    ELIZAOS_AVAILABLE = True
except ImportError:
    AgentRuntime = None  # type: ignore[misc,assignment]
    Character = None  # type: ignore[misc,assignment]
    Plugin = None  # type: ignore[misc,assignment]
    Action = None  # type: ignore[misc,assignment]
    ActionResult = None  # type: ignore[misc,assignment]
    Provider = None  # type: ignore[misc,assignment]
    ProviderResult = None  # type: ignore[misc,assignment]
    Memory = None  # type: ignore[misc,assignment]
    Content = None  # type: ignore[misc,assignment]
    as_uuid = None  # type: ignore[misc,assignment]
    ActionExample = None  # type: ignore[misc,assignment]
    ActionParameter = None  # type: ignore[misc,assignment]
    ActionParameterSchema = None  # type: ignore[misc,assignment]
    ELIZAOS_AVAILABLE = False


# ---------------------------------------------------------------------------
# Model provider plugin selection (OpenAI only for Python today)
# ---------------------------------------------------------------------------


def get_model_provider_plugin(provider: str | None = None) -> "Plugin | None":
    if not ELIZAOS_AVAILABLE:
        return None

    requested = provider.lower().strip() if provider else ""
    if requested and requested != "openai":
        logger.warning(
            f"Requested provider '{provider}' is not supported in Python yet; falling back to auto-detect"
        )
        requested = ""

    if (not requested or requested == "openai") and os.environ.get("OPENAI_API_KEY"):
        try:
            from elizaos_plugin_openai import get_openai_plugin

            logger.info("Using OpenAI model provider")
            return get_openai_plugin()
        except Exception:
            logger.warning("OpenAI API key found but plugin not installed")

    logger.warning(
        "No model provider available. "
        "Set OPENAI_API_KEY and install the OpenAI plugin (elizaos-plugin-openai)."
    )
    return None


def get_localdb_plugin() -> "Plugin | None":
    """
    Return a proper ElizaOS Plugin for LocalDB.

    The localdb package ships a dict-shaped plugin for JS parity, but AgentRuntime
    expects the Pydantic Plugin model. We wrap init_localdb to match that API.
    """

    if not ELIZAOS_AVAILABLE:
        return None

    try:
        from elizaos.types.plugin import Plugin as ElizaPlugin
        from elizaos.types.runtime import IAgentRuntime
        from elizaos_plugin_localdb.plugin import init_localdb
    except Exception:
        return None

    async def _init_localdb(
        _config: dict[str, str | int | float | bool | None],
        runtime: "IAgentRuntime",
    ) -> None:
        await init_localdb(runtime)

    return ElizaPlugin(
        name="localdb",
        description="Local JSON database adapter (elizaos-plugin-localdb)",
        init=_init_localdb,
    )


def get_trajectory_logger_plugin() -> "Plugin | None":
    if not ELIZAOS_AVAILABLE:
        return None
    try:
        from elizaos_plugin_trajectory_logger import get_trajectory_logger_plugin

        return get_trajectory_logger_plugin()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# WebShop plugin (provider + action)
# ---------------------------------------------------------------------------


@dataclass
class WebShopContext:
    task: WebShopTask | None = None
    env: WebShopEnvironment | None = None
    steps: list[EpisodeStep] = field(default_factory=list)
    last_observation: PageObservation | None = None
    last_outcome: StepOutcome | None = None
    final_response: str = ""
    done: bool = False
    reward: float = 0.0
    # Trajectory logging
    trajectory: WebShopTrajectoryIntegration | None = None
    trajectory_id: str | None = None
    step_id: str | None = None
    trial_number: int = 1


_webshop_context: WebShopContext = WebShopContext()


def set_webshop_context(
    task: WebShopTask,
    env: WebShopEnvironment,
    *,
    trajectory: WebShopTrajectoryIntegration | None = None,
    trial_number: int = 1,
) -> None:
    global _webshop_context
    _webshop_context = WebShopContext(
        task=task,
        env=env,
        steps=[],
        last_observation=env.reset(task),
        last_outcome=None,
        final_response="",
        done=False,
        reward=0.0,
        trajectory=trajectory,
        trajectory_id=None,
        step_id=None,
        trial_number=trial_number,
    )


def get_webshop_context() -> WebShopContext:
    return _webshop_context


def _format_observation(obs: PageObservation) -> str:
    lines: list[str] = [f"## Page: {obs.page_type.value}", obs.message]
    if obs.page_type.value == "results" and obs.results:
        lines.append("\n### Results (top 10):")
        for r in obs.results:
            lines.append(
                f"- [{r.product_id}] {r.name} | ${r.price:.2f} | ★{r.rating:.1f} | {r.category}"
            )
    if obs.page_type.value == "product" and obs.product is not None:
        p = obs.product
        lines.append("\n### Product:")
        lines.append(f"- id: {p.product_id}")
        lines.append(f"- name: {p.name}")
        lines.append(f"- price: ${p.price:.2f}")
        lines.append(f"- rating: ★{p.rating:.1f}")
        if p.features:
            lines.append(f"- features: {', '.join(p.features[:12])}")
        if p.options:
            lines.append("- options:")
            for k, vals in p.options.items():
                selected = obs.selected_options.get(k, "not selected")
                lines.append(f"  - {k}: {vals} (selected: {selected})")
    if obs.available_actions:
        lines.append("\n### Available Actions:")
        for a in obs.available_actions[:20]:
            lines.append(f"- {a}")
    return "\n".join(lines)


async def get_webshop_context_provider(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: "State | None" = None,
) -> "ProviderResult":
    _ = runtime
    _ = message
    _ = state

    ctx = get_webshop_context()
    if ctx.task is None or ctx.env is None or ctx.last_observation is None:
        return ProviderResult(text="", values={}, data={})

    task = ctx.task
    obs = ctx.last_observation

    sections: list[str] = []
    sections.append("# WebShop Task")
    sections.append(f"Instruction: {task.instruction}")
    if task.budget is not None:
        sections.append(f"Budget: under ${task.budget:.2f}")
    if task.goal_attributes:
        sections.append(f"Goal attributes: {json.dumps(task.goal_attributes, indent=2)}")
    sections.append(f"Target product ids: {', '.join(task.target_product_ids)}")
    sections.append("\n# Current Observation\n" + _format_observation(obs))

    if ctx.done:
        sections.append(f"\n# Episode Done\nreward={ctx.reward:.2f}")

    # Trajectory logging: provider access
    if ctx.trajectory and ctx.step_id:
        ctx.trajectory.log_provider_access(
            step_id=ctx.step_id,
            provider_name="WEBSHOP_CONTEXT",
            purpose="task_and_observation",
            data={
                "task_id": task.task_id,
                "done": ctx.done,
                "reward": float(ctx.reward),
                "steps": len(ctx.steps),
                "page": obs.page_type.value,
            },
            query={"message": (message.content.text or "") if message.content else ""},
        )

    return ProviderResult(
        text="\n\n".join(sections),
        values={
            "webshop_task_id": task.task_id,
            "webshop_done": ctx.done,
            "webshop_steps": len(ctx.steps),
        },
        data={
            "task_id": task.task_id,
            "page": obs.page_type.value,
        },
    )


@dataclass
class WebShopAction:
    name: str = "WEBSHOP_ACTION"
    similes: list[str] = field(default_factory=lambda: ["SHOP_ACTION", "BROWSE", "CLICK", "SEARCH"])
    description: str = (
        "Perform one WebShop environment action.\n"
        "Parameter: action (string) - one of:\n"
        "  search[query]\n"
        "  click[product_id]\n"
        "  select_option[option_name, value]\n"
        "  back\n"
        "  buy\n"
        "Return: observation and (if done) reward."
    )

    async def validate(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
    ) -> bool:
        _ = runtime
        _ = message
        _ = state
        ctx = get_webshop_context()
        return ctx.task is not None and ctx.env is not None and not ctx.done

    async def handler(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
        options: "HandlerOptions | None" = None,
        callback: "HandlerCallback | None" = None,
        responses: "list[Memory] | None" = None,
    ) -> "ActionResult":
        _ = state
        _ = callback
        _ = responses
        ctx = get_webshop_context()
        if ctx.task is None or ctx.env is None or ctx.last_observation is None:
            return ActionResult(text="Error: No WebShop context", values={"success": False}, success=False)

        params = options.parameters if options and options.parameters else {}
        action_line_obj = params.get("action")
        action_line = action_line_obj.strip() if isinstance(action_line_obj, str) else ""

        if not action_line:
            return ActionResult(text="Error: Missing action parameter", values={"success": False}, success=False)

        try:
            outcome = ctx.env.step(action_line)
            ctx.last_outcome = outcome
            ctx.last_observation = outcome.observation
            ctx.done = outcome.done
            if outcome.done:
                ctx.reward = float(outcome.reward)

            step = EpisodeStep(
                action=action_line,
                observation=outcome.observation,
                reward=float(outcome.reward),
                done=bool(outcome.done),
                info=dict(outcome.info),
            )
            ctx.steps.append(step)

            # Trajectory logging: action attempt
            if ctx.trajectory and ctx.trajectory_id and ctx.step_id:
                ctx.trajectory.log_action_attempt(
                    trajectory_id=ctx.trajectory_id,
                    step_id=ctx.step_id,
                    action_type="WEBSHOP_ACTION",
                    action_name="WEBSHOP_ACTION",
                    parameters={"action": action_line},
                    success=True,
                    reward=float(outcome.reward) if outcome.done else 0.0,
                    result={
                        "done": bool(outcome.done),
                        "reward": float(outcome.reward),
                        "page": outcome.observation.page_type.value,
                        "message": outcome.observation.message[:500],
                    },
                )

            return ActionResult(
                text=_format_observation(outcome.observation),
                values={
                    "success": True,
                    "done": bool(outcome.done),
                    "reward": float(outcome.reward),
                },
                data={
                    "actionName": "WEBSHOP_ACTION",
                    "action": action_line,
                    "done": bool(outcome.done),
                    "reward": float(outcome.reward),
                },
                success=True,
            )
        except Exception as e:
            runtime.logger.error(f"WebShop action failed: {e}")
            if ctx.trajectory and ctx.trajectory_id and ctx.step_id:
                ctx.trajectory.log_action_attempt(
                    trajectory_id=ctx.trajectory_id,
                    step_id=ctx.step_id,
                    action_type="WEBSHOP_ACTION",
                    action_name="WEBSHOP_ACTION",
                    parameters={"action": action_line},
                    success=False,
                    reward=0.0,
                    result=None,
                    error=str(e),
                )
            return ActionResult(text=f"Error: {e}", values={"success": False}, success=False)

    @property
    def examples(self) -> list[list["ActionExample"]]:
        if not ELIZAOS_AVAILABLE:
            return []
        return [
            [
                ActionExample(name="{{name1}}", content=Content(text="Find a water bottle under $30")),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll search for relevant products.",
                        actions=["WEBSHOP_ACTION"],
                    ),
                ),
            ]
        ]

    @property
    def parameters(self) -> list["ActionParameter"]:
        if not ELIZAOS_AVAILABLE:
            return []
        return [
            ActionParameter(
                name="action",
                description="A single WebShop action line (e.g., search[water bottle], click[P004], select_option[size, 750ml], buy)",
                required=True,
                schema=ActionParameterSchema(type="string"),
            )
        ]


def create_webshop_plugin() -> "Plugin":
    if not ELIZAOS_AVAILABLE:
        raise RuntimeError("ElizaOS is required for webshop plugin")

    action_impl = WebShopAction()
    action = Action(
        name=action_impl.name,
        similes=action_impl.similes,
        description=action_impl.description,
        validate=action_impl.validate,
        handler=action_impl.handler,
        examples=action_impl.examples,
        parameters=action_impl.parameters,
    )
    provider = Provider(
        name="WEBSHOP_CONTEXT",
        description="WebShop task + current observation + available actions",
        get=get_webshop_context_provider,
        position=-10,
    )
    return Plugin(
        name="webshop-bench",
        description="WebShop benchmark plugin for navigation/action evaluation",
        actions=[action],
        providers=[provider],
    )


WEBSHOP_MESSAGE_TEMPLATE = """<task>You are a shopping agent. Use WEBSHOP_ACTION to navigate and buy the correct product. When done, use REPLY.</task>

<providers>
{{providers}}
</providers>

<instructions>
CRITICAL RULES:
1. Choose exactly ONE of: WEBSHOP_ACTION or REPLY
2. If the correct product has not been purchased yet → use WEBSHOP_ACTION
3. If you already purchased (or the episode is done) → use REPLY with a concise confirmation
4. Output MUST be valid XML using the format below

Action format:
- search[query]
- click[product_id]
- select_option[option_name, value]
- back
- buy
</instructions>

<output>
For an environment action:
<response>
  <thought>Decide the next action</thought>
  <actions>WEBSHOP_ACTION</actions>
  <providers>WEBSHOP_CONTEXT</providers>
  <text></text>
  <params>
    <WEBSHOP_ACTION>
      <action>search[wireless bluetooth headphones under $100]</action>
    </WEBSHOP_ACTION>
  </params>
</response>

For final response (after buy):
<response>
  <thought>Task complete</thought>
  <actions>REPLY</actions>
  <providers></providers>
  <text>Purchase completed.</text>
</response>
</output>"""


class ElizaOSWebShopAgent:
    def __init__(
        self,
        env: WebShopEnvironment,
        *,
        max_turns: int = 20,
        runtime: AgentRuntime | None = None,
        model_plugin: "Plugin | None" = None,
        model_provider: str | None = None,
        temperature: float = 0.0,
        trajectory: WebShopTrajectoryIntegration | None = None,
        require_real_llm: bool = False,
        require_localdb: bool = False,
    ) -> None:
        self.env = env
        self.max_turns = max_turns
        self.runtime = runtime
        self.model_plugin = model_plugin
        self.model_provider = model_provider
        self.temperature = temperature
        self._trajectory = trajectory
        self._require_real_llm = require_real_llm
        self._require_localdb = require_localdb
        self._initialized = False
        self._has_model_provider = False

    async def initialize(self) -> None:
        if self._initialized:
            return
        if not ELIZAOS_AVAILABLE:
            if self._require_real_llm:
                raise RuntimeError("ElizaOS is not installed/available (required for real-llm mode)")
            self._initialized = True
            return

        if self.model_plugin is None:
            self.model_plugin = get_model_provider_plugin(self.model_provider)

        if self.model_plugin is None:
            if self._require_real_llm:
                raise RuntimeError(
                    "No model provider plugin available. "
                    "Ensure OPENAI_API_KEY is set (via .env) and install plugins/plugin-openai/python."
                )
            logger.warning("No model provider plugin available; agent will run in mock mode.")
            self._initialized = True
            return

        webshop_plugin = create_webshop_plugin()

        if self.runtime is None:
            character = Character(
                name="WebShopAgent",
                username="webshop_agent",
                bio="An AI shopping agent being evaluated on WebShop.",
                system="You are a helpful shopping assistant. Use actions to navigate and buy the correct product.",
                templates={"messageHandlerTemplate": WEBSHOP_MESSAGE_TEMPLATE},
            )

            plugins: list[Plugin] = []
            traj_plugin = get_trajectory_logger_plugin()
            localdb = get_localdb_plugin()
            if localdb is None and self._require_localdb:
                raise RuntimeError(
                    "LocalDB plugin required but not available. "
                    "Install plugins/plugin-localdb/python."
                )
            if localdb is not None:
                plugins.append(localdb)
            if traj_plugin is not None:
                plugins.append(traj_plugin)

            plugins.extend([self.model_plugin, webshop_plugin])

            self.runtime = AgentRuntime(
                character=character,
                plugins=plugins,
                log_level="INFO",
            )

        await self.runtime.initialize()
        self._has_model_provider = self.runtime.has_model("TEXT_LARGE")
        if self._require_real_llm and not self._has_model_provider:
            raise RuntimeError("ElizaOS runtime initialized but no TEXT_LARGE model is available")
        self._initialized = True

    async def process_task(
        self, task: WebShopTask
    ) -> tuple[list[EpisodeStep], str, PageObservation | None]:
        if not self._initialized:
            await self.initialize()

        trial_number_obj = task.metadata.get("trial_number")
        trial_number = trial_number_obj if isinstance(trial_number_obj, int) else 1

        set_webshop_context(task, self.env, trajectory=self._trajectory, trial_number=trial_number)
        ctx = get_webshop_context()

        if not ELIZAOS_AVAILABLE or self.runtime is None or not self._has_model_provider:
            return await self._process_task_mock(task, ctx)

        return await self._process_task_canonical(task, ctx)

    async def _process_task_canonical(
        self, task: WebShopTask, ctx: WebShopContext
    ) -> tuple[list[EpisodeStep], str, PageObservation | None]:
        assert self.runtime is not None
        user_id = as_uuid(str(uuid4()))

        if ctx.trajectory and self.runtime:
            ctx.trajectory.wrap_runtime(self.runtime)
            ctx.trajectory_id = ctx.trajectory.start_task(
                task,
                agent_id=str(self.runtime.agent_id),
                trial_number=ctx.trial_number,
            )

        final_response = ""
        for turn in range(self.max_turns):
            # new room_id each turn to bypass caching (providers reflect latest obs)
            room_id = as_uuid(str(uuid4()))

            if turn == 0:
                message_text = task.instruction
            else:
                obs_str = _format_observation(ctx.last_observation) if ctx.last_observation else ""
                message_text = (
                    f"Observation:\n{obs_str}\n\n"
                    "Decide next action. If purchased and done, use REPLY."
                )

            message = Memory(
                id=as_uuid(str(uuid4())),
                entity_id=user_id,
                agent_id=self.runtime.agent_id,
                room_id=room_id,
                content=Content(text=message_text, source="webshop"),
                created_at=int(time.time() * 1000),
            )

            try:
                if ctx.trajectory and ctx.trajectory_id:
                    ctx.step_id = ctx.trajectory.start_turn(
                        turn_index=turn,
                        message_text=message_text,
                        observation=ctx.last_observation,
                        steps_made=len(ctx.steps),
                    )

                result = await self.runtime.message_service.handle_message(self.runtime, message)

                if ctx.trajectory and ctx.step_id:
                    ctx.trajectory.flush_llm_calls_to_step(
                        step_id=ctx.step_id,
                        system_prompt=self.runtime.character.system or "",
                    )

                if result.response_content:
                    response_text = result.response_content.text or ""
                    actions = result.response_content.actions or []

                    if "WEBSHOP_ACTION" in actions:
                        # Action already executed by canonical flow.
                        if ctx.done:
                            # Next turn should REPLY; let loop continue once to prompt it.
                            continue
                        continue

                    # No webshop action -> final
                    final_response = response_text
                    ctx.final_response = final_response

                    if ctx.trajectory and ctx.trajectory_id and ctx.step_id:
                        ctx.trajectory.log_action_attempt(
                            trajectory_id=ctx.trajectory_id,
                            step_id=ctx.step_id,
                            action_type="REPLY",
                            action_name="REPLY",
                            parameters={},
                            success=True,
                            reward=float(ctx.reward) if ctx.done else 0.0,
                            result={"final_response": final_response[:2000]},
                        )
                    break

            except Exception as e:
                logger.error(f"[WebShop canonical] Error: {e}")
                final_response = f"Error processing request: {e}"
                ctx.final_response = final_response
                break

        return list(ctx.steps), ctx.final_response, ctx.last_observation

    async def _process_task_mock(
        self, task: WebShopTask, ctx: WebShopContext
    ) -> tuple[list[EpisodeStep], str, PageObservation | None]:
        # Simple heuristic baseline (no LLM): search -> click first result -> pick obvious options -> buy
        obs = ctx.last_observation
        if obs is None:
            obs = self.env.reset(task)
            ctx.last_observation = obs

        # Search with a short query derived from instruction keywords.
        query = " ".join(task.instruction.split()[:6])
        out = self.env.step(f"search[{query}]")
        ctx.steps.append(
            EpisodeStep(action=f"search[{query}]", observation=out.observation, reward=out.reward, done=out.done, info=dict(out.info))
        )
        if out.observation.results:
            pid = out.observation.results[0].product_id
            out2 = self.env.step(f"click[{pid}]")
            ctx.steps.append(
                EpisodeStep(action=f"click[{pid}]", observation=out2.observation, reward=out2.reward, done=out2.done, info=dict(out2.info))
            )
            # If there are options, pick the first value for each option.
            if out2.observation.product is not None:
                for opt, vals in out2.observation.product.options.items():
                    if vals:
                        v = vals[0]
                        out3 = self.env.step(f"select_option[{opt}, {v}]")
                        ctx.steps.append(
                            EpisodeStep(action=f"select_option[{opt}, {v}]", observation=out3.observation, reward=out3.reward, done=out3.done, info=dict(out3.info))
                        )

            out4 = self.env.step("buy")
            ctx.steps.append(
                EpisodeStep(action="buy", observation=out4.observation, reward=out4.reward, done=out4.done, info=dict(out4.info))
            )

            ctx.done = out4.done
            ctx.reward = float(out4.reward)
            ctx.last_observation = out4.observation

        ctx.final_response = (
            f"Purchased {self.env.purchased_product_id or 'nothing'} with reward {self.env.final_reward:.2f}"
        )
        return list(ctx.steps), ctx.final_response, ctx.last_observation

    async def close(self) -> None:
        if self.runtime:
            await self.runtime.stop()
        self._initialized = False


class MockWebShopAgent:
    def __init__(self, env: WebShopEnvironment, *, max_turns: int = 20) -> None:
        self.env = env
        self.max_turns = max_turns
        self._initialized = True

    async def initialize(self) -> None:
        return

    async def process_task(
        self, task: WebShopTask
    ) -> tuple[list[EpisodeStep], str, PageObservation | None]:
        # Run the same simple heuristic loop used by ElizaOSWebShopAgent mock mode.
        set_webshop_context(task, self.env, trajectory=None, trial_number=1)
        ctx = get_webshop_context()
        return await ElizaOSWebShopAgent(self.env, max_turns=self.max_turns)._process_task_mock(
            task, ctx
        )

    async def close(self) -> None:
        return


def create_webshop_agent(
    env: WebShopEnvironment,
    *,
    max_turns: int = 20,
    use_mock: bool = False,
    model_provider: str | None = None,
    temperature: float = 0.0,
    trajectory: WebShopTrajectoryIntegration | None = None,
) -> ElizaOSWebShopAgent | MockWebShopAgent:
    if use_mock or not ELIZAOS_AVAILABLE:
        return MockWebShopAgent(env=env, max_turns=max_turns)
    return ElizaOSWebShopAgent(
        env=env,
        max_turns=max_turns,
        model_provider=model_provider,
        temperature=temperature,
        trajectory=trajectory,
        require_real_llm=True,
        require_localdb=True,
    )

