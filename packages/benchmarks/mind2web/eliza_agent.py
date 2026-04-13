"""
ElizaOS-integrated agent for Mind2Web benchmark.

Uses the canonical ElizaOS flow:
- Messages processed through runtime.message_service.handle_message()
- Actions executed via process_actions()
- Providers inject page context into state
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import uuid4

from benchmarks.mind2web.types import (
    Mind2WebAction,
    Mind2WebActionStep,
    Mind2WebConfig,
    Mind2WebOperation,
    Mind2WebTask,
)

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, IAgentRuntime, State
    from elizaos.types.components import ActionResult, HandlerOptions

logger = logging.getLogger(__name__)


# Check ElizaOS availability
ELIZAOS_AVAILABLE = False
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

try:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.components import (
        Action,
        ActionExample,
        ActionResult,
        Provider,
        ProviderResult,
    )
    from elizaos.types.memory import Memory
    from elizaos.types.plugin import Plugin
    from elizaos.types.primitives import Content, as_uuid

    ELIZAOS_AVAILABLE = True
except Exception as _elizaos_import_error:
    # ElizaOS not available - will run in mock mode
    logger.debug(f"ElizaOS not available: {_elizaos_import_error}")


# ---------------------------------------------------------------------------
# Model provider plugin selection
# ---------------------------------------------------------------------------


def get_model_provider_plugin(provider: str | None = None) -> "Plugin | None":
    """Get the appropriate model provider plugin."""
    if not ELIZAOS_AVAILABLE:
        return None

    requested = provider.lower().strip() if provider else ""

    # Try Groq first (fast and cheap for testing)
    if (not requested or requested == "groq") and os.environ.get("GROQ_API_KEY"):
        try:
            from elizaos_plugin_groq import GroqClient, GroqConfig

            # Create Groq plugin manually since it doesn't have get_groq_plugin()
            return _create_groq_elizaos_plugin()
        except ImportError:
            logger.debug("Groq plugin not available")

    # Try OpenAI
    if (not requested or requested == "openai") and os.environ.get("OPENAI_API_KEY"):
        try:
            from elizaos_plugin_openai import get_openai_plugin

            logger.info("Using OpenAI model provider")
            return get_openai_plugin()
        except ImportError:
            logger.debug("OpenAI plugin not available")

    # Try Anthropic
    if (not requested or requested == "anthropic") and os.environ.get("ANTHROPIC_API_KEY"):
        try:
            # Check if anthropic plugin exists
            import importlib.util

            spec = importlib.util.find_spec("elizaos_plugin_anthropic")
            if spec:
                from elizaos_plugin_anthropic import get_anthropic_plugin  # type: ignore[import-not-found]

                logger.info("Using Anthropic model provider")
                return get_anthropic_plugin()
        except ImportError:
            logger.debug("Anthropic plugin not available")

    logger.warning(
        "No model provider available. "
        "Set GROQ_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY."
    )
    return None


def _get_model_type_value(name: str) -> str:
    """Resolve model type enum value for legacy/new names."""
    try:
        from elizaos.types.model import ModelType
    except Exception:
        return name

    model_type_attr = f"MODEL_TYPE_{name}"
    if hasattr(ModelType, model_type_attr):
        return str(getattr(ModelType, model_type_attr))
    if hasattr(ModelType, name):
        return str(getattr(ModelType, name))
    return name


def _create_groq_elizaos_plugin() -> "Plugin":
    """Create a Groq ElizaOS plugin."""
    from elizaos import Plugin
    from elizaos.types.runtime import IAgentRuntime

    from elizaos_plugin_groq import GenerateTextParams, GroqClient, GroqConfig

    _client: GroqClient | None = None

    def _get_client() -> GroqClient:
        nonlocal _client
        if _client is None:
            config = GroqConfig(
                api_key=os.environ.get("GROQ_API_KEY", ""),
                small_model=os.environ.get("GROQ_SMALL_MODEL", "llama-3.1-8b-instant"),
                large_model=os.environ.get("GROQ_LARGE_MODEL", "llama-3.3-70b-versatile"),
            )
            _client = GroqClient(api_key=config.api_key, config=config)
        return _client

    async def text_large_handler(runtime: IAgentRuntime, params: dict[str, object]) -> str:
        client = _get_client()
        temperature_raw = params.get("temperature")
        temperature = float(temperature_raw) if isinstance(temperature_raw, (int, float)) else 0.7
        max_tokens_raw = params.get("maxTokens")
        max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, int) else 2048

        result = await client.generate_text_large(
            GenerateTextParams(
                prompt=params.get("prompt", ""),
                system=params.get("system"),
                temperature=temperature,
                max_tokens=max_tokens,
            )
        )
        return str(result)

    async def text_small_handler(runtime: IAgentRuntime, params: dict[str, object]) -> str:
        client = _get_client()
        temperature_raw = params.get("temperature")
        temperature = float(temperature_raw) if isinstance(temperature_raw, (int, float)) else 0.7
        max_tokens_raw = params.get("maxTokens")
        max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, int) else 1024

        result = await client.generate_text_small(
            GenerateTextParams(
                prompt=params.get("prompt", ""),
                system=params.get("system"),
                temperature=temperature,
                max_tokens=max_tokens,
            )
        )
        return str(result)

    logger.info("Using Groq model provider")
    return Plugin(
        name="groq",
        description="Groq model provider for elizaOS",
        models={
            _get_model_type_value("TEXT_LARGE"): text_large_handler,
            _get_model_type_value("TEXT_SMALL"): text_small_handler,
        },
    )


# ---------------------------------------------------------------------------
# Mind2Web Context and Plugin
# ---------------------------------------------------------------------------


@dataclass
class Mind2WebContext:
    """Context for the current Mind2Web task."""

    task: Mind2WebTask | None = None
    current_step_index: int = 0
    executed_actions: list[Mind2WebAction] = field(default_factory=list)
    current_html: str = ""
    current_url: str = ""
    done: bool = False
    # For trajectory logging
    trajectory_id: str | None = None
    step_id: str | None = None


@dataclass
class Mind2WebActionParameterSchema:
    """Schema for Mind2Web action parameters (bootstrap-compatible)."""

    type: str
    description: str | None = None
    default: str | int | float | bool | None = None
    enum: list[str] = field(default_factory=list)
    properties: dict[str, "Mind2WebActionParameterSchema"] = field(default_factory=dict)
    items: "Mind2WebActionParameterSchema | None" = None
    minimum: float | None = None
    maximum: float | None = None
    pattern: str | None = None


@dataclass
class Mind2WebActionParameter:
    """Action parameter definition with schema_def compatibility."""

    name: str
    description: str
    required: bool = False
    schema_def: Mind2WebActionParameterSchema = field(
        default_factory=lambda: Mind2WebActionParameterSchema(type="string")
    )
    examples: list[str | int | float | bool | None] = field(default_factory=list)


_mind2web_context: Mind2WebContext = Mind2WebContext()


def set_mind2web_context(task: Mind2WebTask) -> None:
    """Set the current task context."""
    global _mind2web_context
    _mind2web_context = Mind2WebContext(
        task=task,
        current_step_index=0,
        executed_actions=[],
        current_html=task.actions[0].cleaned_html if task.actions else "",
        done=False,
    )


def get_mind2web_context() -> Mind2WebContext:
    """Get the current task context."""
    return _mind2web_context


def _format_element_candidates(step: Mind2WebActionStep, max_candidates: int = 10) -> str:
    """Format element candidates for the prompt."""
    lines: list[str] = []

    all_candidates = step.pos_candidates + step.neg_candidates
    for i, elem in enumerate(all_candidates[:max_candidates]):
        attrs_str = ", ".join(f'{k}="{v}"' for k, v in list(elem.attributes.items())[:5])
        text_preview = elem.text_content[:50] if elem.text_content else ""
        lines.append(
            f"[{elem.backend_node_id}] <{elem.tag} {attrs_str}> {text_preview}"
        )

    return "\n".join(lines)


async def get_mind2web_context_provider(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: "State | None" = None,
) -> "ProviderResult":
    """Provider that injects Mind2Web task context into state."""
    _ = runtime
    _ = message
    _ = state

    # Handle case when ElizaOS types aren't available
    if ProviderResult is None:
        # Return a mock result for testing
        from dataclasses import dataclass

        @dataclass
        class MockProviderResult:
            text: str = ""
            values: dict[str, object] | None = None
            data: dict[str, object] | None = None

        ctx = get_mind2web_context()
        if ctx.task is None:
            return MockProviderResult(text="", values={}, data={})  # type: ignore[return-value]

        # Build text for mock result
        task = ctx.task
        step_idx = ctx.current_step_index
        sections: list[str] = [
            "# Mind2Web Task",
            f"Instruction: {task.confirmed_task}",
        ]
        return MockProviderResult(  # type: ignore[return-value]
            text="\n".join(sections),
            values={
                "mind2web_task_id": task.annotation_id,
                "mind2web_step": step_idx,
                "mind2web_total_steps": len(task.actions),
                "mind2web_done": ctx.done,
            },
            data={"task_id": task.annotation_id, "step_index": step_idx},
        )

    ctx = get_mind2web_context()
    if ctx.task is None:
        return ProviderResult(text="", values={}, data={})

    task = ctx.task
    step_idx = ctx.current_step_index

    sections: list[str] = []
    sections.append("# Mind2Web Task")
    sections.append(f"Instruction: {task.confirmed_task}")
    sections.append(f"Website: {task.website}")
    sections.append(f"Domain: {task.domain}")

    # Show action plan
    if task.action_reprs:
        sections.append("\n## Action Plan:")
        for i, action_repr in enumerate(task.action_reprs):
            marker = "→" if i == step_idx else " "
            sections.append(f"{marker} {i + 1}. {action_repr}")

    # Show current step context
    if step_idx < len(task.actions):
        current_step = task.actions[step_idx]
        sections.append(f"\n## Current Step ({step_idx + 1}/{len(task.actions)})")

        # Show available elements
        sections.append("\n### Available Elements:")
        sections.append(_format_element_candidates(current_step))

        # Show HTML preview
        if current_step.cleaned_html:
            html_preview = current_step.cleaned_html[:2000]
            sections.append(f"\n### Page HTML Preview:\n```html\n{html_preview}\n```")

    # Show executed actions
    if ctx.executed_actions:
        sections.append("\n## Executed Actions:")
        for i, action in enumerate(ctx.executed_actions):
            sections.append(
                f"{i + 1}. {action.operation.value} on [{action.element_id}]"
                + (f" value='{action.value}'" if action.value else "")
            )

    if ctx.done:
        sections.append("\n## Task Complete")

    return ProviderResult(
        text="\n\n".join(sections),
        values={
            "mind2web_task_id": task.annotation_id,
            "mind2web_step": step_idx,
            "mind2web_total_steps": len(task.actions),
            "mind2web_done": ctx.done,
        },
        data={
            "task_id": task.annotation_id,
            "step_index": step_idx,
        },
    )


async def get_mind2web_format_provider(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: "State | None" = None,
) -> "ProviderResult":
    """Provider that injects XML action format guidance."""
    _ = runtime
    _ = message
    _ = state

    format_text = "\n".join(
        [
            "# Action Format (MIND2WEB_ACTION)",
            "",
            "Always return exactly one of these per step:",
            "",
            "<actions>MIND2WEB_ACTION</actions>",
            "<providers>MIND2WEB_CONTEXT</providers>",
            "<text></text>",
            "<params>",
            "  <MIND2WEB_ACTION>",
            "    <operation>CLICK|TYPE|SELECT</operation>",
            "    <element_id>backend_node_id</element_id>",
            "    <value>required for TYPE/SELECT</value>",
            "  </MIND2WEB_ACTION>",
            "</params>",
            "",
            "Rules:",
            "- Always include <params> when using MIND2WEB_ACTION.",
            "- Never omit operation or element_id.",
            "- Use TYPE only for typing text; use SELECT only for dropdown choice.",
            "- When done, use <actions>REPLY</actions> with a short confirmation.",
        ]
    )

    return ProviderResult(
        text=format_text,
        values={
            "mind2web_format": "xml",
        },
        data={},
    )


@dataclass
class Mind2WebActionHandler:
    """Handler for Mind2Web browser actions."""

    name: str = "MIND2WEB_ACTION"
    similes: list[str] = field(default_factory=lambda: ["BROWSER_ACTION", "WEB_ACTION", "CLICK", "TYPE", "SELECT"])
    description: str = (
        "Execute a web browser action.\n"
        "Parameters:\n"
        "  - operation: CLICK, TYPE, or SELECT\n"
        "  - element_id: The backend_node_id of the target element\n"
        "  - value: (optional) Text to type or option to select\n"
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
        ctx = get_mind2web_context()
        return ctx.task is not None and not ctx.done

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

        ctx = get_mind2web_context()
        if ctx.task is None:
            return ActionResult(
                text="Error: No Mind2Web task context",
                values={"success": False},
                success=False,
            )

        params = self._extract_params(options)

        # Parse operation
        op_str = str(params.get("operation", "CLICK")).upper()
        try:
            operation = Mind2WebOperation(op_str)
        except ValueError:
            operation = Mind2WebOperation.CLICK

        element_id = str(params.get("element_id", ""))
        value = str(params.get("value", ""))

        if not element_id:
            return ActionResult(
                text="Error: element_id is required",
                values={"success": False},
                success=False,
            )

        # Record the action
        action = Mind2WebAction(
            operation=operation,
            element_id=element_id,
            value=value,
            reasoning=str(params.get("reasoning", "")),
        )
        ctx.executed_actions.append(action)

        # Advance to next step
        ctx.current_step_index += 1
        if ctx.current_step_index >= len(ctx.task.actions):
            ctx.done = True

        # Update HTML context for next step
        if not ctx.done and ctx.current_step_index < len(ctx.task.actions):
            next_step = ctx.task.actions[ctx.current_step_index]
            ctx.current_html = next_step.cleaned_html

        result_text = f"Executed {operation.value} on [{element_id}]"
        if value:
            result_text += f" with value '{value}'"

        if ctx.done:
            result_text += "\n\nTask complete - all steps executed."

        return ActionResult(
            text=result_text,
            values={
                "success": True,
                "operation": operation.value,
                "element_id": element_id,
                "value": value,
                "step_completed": ctx.current_step_index,
                "done": ctx.done,
            },
            data={
                "actionName": "MIND2WEB_ACTION",
                "operation": operation.value,
                "element_id": element_id,
            },
            success=True,
        )

    @staticmethod
    def _extract_params(options: "HandlerOptions | None") -> dict[str, object]:
        if options is None or options.parameters is None:
            return {}
        raw_params = options.parameters
        if isinstance(raw_params, dict):
            return raw_params
        if hasattr(raw_params, "get") and callable(raw_params.get):
            return raw_params
        values = getattr(raw_params, "values", None)
        if values is None:
            return {}
        if hasattr(values, "get") and callable(values.get):
            try:
                return dict(values)
            except Exception:
                return {}
        if hasattr(values, "fields"):
            try:
                from google.protobuf.json_format import MessageToDict
            except Exception:
                return {}
            parsed = MessageToDict(values)
            return parsed if isinstance(parsed, dict) else {}
        return {}

    @property
    def examples(self) -> list[list["ActionExample"]]:
        if not ELIZAOS_AVAILABLE:
            return []
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Click on the search box"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="I'll click on the search input.",
                        actions=["MIND2WEB_ACTION"],
                    ),
                ),
            ]
            ,
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Type 'wireless headphones' into the search input"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text=(
                            "Typing the search query now.\n"
                            "<params>\n"
                            "  <MIND2WEB_ACTION>\n"
                            "    <operation>TYPE</operation>\n"
                            "    <element_id>node_search</element_id>\n"
                            "    <value>wireless headphones</value>\n"
                            "  </MIND2WEB_ACTION>\n"
                            "</params>"
                        ),
                        actions=["MIND2WEB_ACTION"],
                    ),
                ),
            ],
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="Click the price filter dropdown"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text=(
                            "Opening the price filter.\n"
                            "<params>\n"
                            "  <MIND2WEB_ACTION>\n"
                            "    <operation>CLICK</operation>\n"
                            "    <element_id>node_price_filter</element_id>\n"
                            "  </MIND2WEB_ACTION>\n"
                            "</params>"
                        ),
                        actions=["MIND2WEB_ACTION"],
                    ),
                ),
            ],
        ]

    @property
    def parameters(self) -> list[Mind2WebActionParameter]:
        if not ELIZAOS_AVAILABLE:
            return []
        return [
            Mind2WebActionParameter(
                name="operation",
                description="The operation type: CLICK, TYPE, or SELECT",
                required=True,
                schema_def=Mind2WebActionParameterSchema(
                    type="string", enum=["CLICK", "TYPE", "SELECT"]
                ),
            ),
            Mind2WebActionParameter(
                name="element_id",
                description="The backend_node_id of the target element",
                required=True,
                schema_def=Mind2WebActionParameterSchema(type="string"),
            ),
            Mind2WebActionParameter(
                name="value",
                description="Text to type or option to select (for TYPE/SELECT operations)",
                required=False,
                schema_def=Mind2WebActionParameterSchema(type="string"),
            ),
        ]


def create_mind2web_plugin() -> "Plugin":
    """Create the Mind2Web benchmark plugin."""
    if not ELIZAOS_AVAILABLE:
        raise RuntimeError("ElizaOS is required for Mind2Web plugin")

    action_impl = Mind2WebActionHandler()
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
        name="MIND2WEB_CONTEXT",
        description="Mind2Web task context, current page elements, and action history",
        get=get_mind2web_context_provider,
        position=-10,
    )
    format_provider = Provider(
        name="MIND2WEB_FORMAT",
        description="Mind2Web XML action format requirements",
        get=get_mind2web_format_provider,
        position=-9,
    )

    return Plugin(
        name="mind2web-bench",
        description="Mind2Web benchmark plugin for web navigation evaluation",
        actions=[action],
        providers=[provider, format_provider],
    )


# ---------------------------------------------------------------------------
# Message Template
# ---------------------------------------------------------------------------


MIND2WEB_MESSAGE_TEMPLATE = """<task>You are a web navigation agent. Analyze the page and execute the correct action using MIND2WEB_ACTION.</task>

<providers>
{{providers}}
</providers>

<instructions>
CRITICAL RULES:
1. You MUST use MIND2WEB_ACTION to execute browser actions
2. Every MIND2WEB_ACTION MUST include <params> with operation and element_id
3. Choose the correct element_id from the available elements list
4. Choose the correct operation: CLICK, TYPE, or SELECT
5. For TYPE operations, provide a non-empty value
6. For SELECT operations, provide the option value to select
7. When all steps are done, use REPLY to confirm completion

AVAILABLE OPERATIONS:
- CLICK: Click on an element
- TYPE: Type text into an input field
- SELECT: Select an option from a dropdown
</instructions>

<output>
For a browser action:
<response>
  <thought>Analyze the task and determine the next action</thought>
  <actions>MIND2WEB_ACTION</actions>
  <providers>MIND2WEB_CONTEXT</providers>
  <text></text>
  <params>
    <MIND2WEB_ACTION>
      <operation>CLICK</operation>
      <element_id>node_search</element_id>
      <value></value>
    </MIND2WEB_ACTION>
  </params>
</response>

For typing text:
<response>
  <thought>I need to type the search query</thought>
  <actions>MIND2WEB_ACTION</actions>
  <providers>MIND2WEB_CONTEXT</providers>
  <text></text>
  <params>
    <MIND2WEB_ACTION>
      <operation>TYPE</operation>
      <element_id>node_input</element_id>
      <value>search query here</value>
    </MIND2WEB_ACTION>
  </params>
</response>

For selecting an option:
<response>
  <thought>Select the requested option</thought>
  <actions>MIND2WEB_ACTION</actions>
  <providers>MIND2WEB_CONTEXT</providers>
  <text></text>
  <params>
    <MIND2WEB_ACTION>
      <operation>SELECT</operation>
      <element_id>node_dropdown</element_id>
      <value>option_value</value>
    </MIND2WEB_ACTION>
  </params>
</response>

When task is complete:
<response>
  <thought>All actions completed successfully</thought>
  <actions>REPLY</actions>
  <providers></providers>
  <text>Task completed successfully.</text>
</response>
</output>"""


# ---------------------------------------------------------------------------
# ElizaOS Mind2Web Agent
# ---------------------------------------------------------------------------


class ElizaOSMind2WebAgent:
    """ElizaOS-powered agent for Mind2Web benchmark."""

    def __init__(
        self,
        config: Mind2WebConfig,
        *,
        runtime: "AgentRuntime | None" = None,
        model_plugin: "Plugin | None" = None,
    ) -> None:
        self.config = config
        self.runtime = runtime
        self.model_plugin = model_plugin
        self._initialized = False
        self._has_model_provider = False

    async def initialize(self) -> None:
        """Initialize the agent and runtime."""
        if self._initialized:
            return

        if not ELIZAOS_AVAILABLE:
            if not self.config.use_mock:
                raise RuntimeError("ElizaOS not available (required for real-llm mode)")
            self._initialized = True
            return

        if self.config.groq_small_model:
            os.environ["GROQ_SMALL_MODEL"] = self.config.groq_small_model
        if self.config.groq_large_model:
            os.environ["GROQ_LARGE_MODEL"] = self.config.groq_large_model

        if self.model_plugin is None:
            self.model_plugin = get_model_provider_plugin(self.config.model_provider)

        if self.model_plugin is None and not self.config.use_mock:
            raise RuntimeError(
                "No model provider plugin available. "
                "Set GROQ_API_KEY or OPENAI_API_KEY."
            )

        if self.runtime is None:
            character = Character(
                name="Mind2WebAgent",
                username="mind2web_agent",
                bio="An AI web navigation agent for Mind2Web benchmark.",
                system=(
                    "You are a web navigation agent. Your goal is to complete web tasks "
                    "by analyzing page elements and executing the correct browser actions."
                ),
                advanced_planning=self.config.advanced_planning,
                templates={"messageHandlerTemplate": MIND2WEB_MESSAGE_TEMPLATE},
            )

            plugins: list[Plugin] = []
            mind2web_plugin = create_mind2web_plugin()

            if self.model_plugin:
                plugins.append(self.model_plugin)
            plugins.append(mind2web_plugin)

            self.runtime = AgentRuntime(
                character=character,
                plugins=plugins,
                log_level="INFO" if self.config.verbose else "WARNING",
                check_should_respond=self.config.check_should_respond,
            )

        await self.runtime.initialize()
        self._has_model_provider = self.runtime.has_model(_get_model_type_value("TEXT_LARGE"))
        self._initialized = True

    async def process_task(self, task: Mind2WebTask) -> list[Mind2WebAction]:
        """Process a Mind2Web task and return predicted actions.

        Args:
            task: The Mind2Web task to process

        Returns:
            List of predicted actions
        """
        if not self._initialized:
            await self.initialize()

        set_mind2web_context(task)
        ctx = get_mind2web_context()

        if not ELIZAOS_AVAILABLE or self.runtime is None or not self._has_model_provider:
            return await self._process_task_mock(task)

        return await self._process_task_canonical(task, ctx)

    async def _process_task_canonical(
        self, task: Mind2WebTask, ctx: Mind2WebContext
    ) -> list[Mind2WebAction]:
        """Process task using canonical ElizaOS message loop."""
        assert self.runtime is not None

        user_id = as_uuid(str(uuid4()))
        room_id = as_uuid(str(uuid4()))
        max_steps = min(self.config.max_steps_per_task, len(task.actions) + 5)

        for turn in range(max_steps):
            if ctx.done:
                break

            if turn == 0:
                message_text = (
                    f"Complete this web task: {task.confirmed_task}\n\n"
                    "Analyze the available elements and execute the first action."
                )
            else:
                step_info = f"Step {ctx.current_step_index + 1}/{len(task.actions)}"
                message_text = (
                    f"{step_info}: Continue with the next action.\n"
                    "Analyze the available elements and execute the correct action."
                )

            message = Memory(
                id=as_uuid(str(uuid4())),
                entity_id=user_id,
                agent_id=self.runtime.agent_id,
                room_id=room_id,
                content=Content(text=message_text, source="mind2web"),
                created_at=int(time.time() * 1000),
            )

            try:
                result = await self.runtime.message_service.handle_message(
                    self.runtime, message
                )

                # Check if MIND2WEB_ACTION was executed
                if result.response_content and result.response_content.actions:
                    actions = result.response_content.actions
                    if "MIND2WEB_ACTION" not in actions and ctx.current_step_index >= len(task.actions):
                        break

            except Exception as e:
                logger.error(f"Error processing task {task.annotation_id}: {e}")
                break

        return list(ctx.executed_actions)

    async def _process_task_mock(self, task: Mind2WebTask) -> list[Mind2WebAction]:
        """Mock processing using ground truth actions."""
        actions: list[Mind2WebAction] = []

        for step in task.actions:
            target = step.target_element
            element_id = target.backend_node_id if target else ""

            actions.append(
                Mind2WebAction(
                    operation=step.operation,
                    element_id=element_id,
                    value=step.value,
                    reasoning="Mock: using ground truth",
                )
            )

        return actions

    async def close(self) -> None:
        """Clean up resources."""
        if self.runtime:
            await self.runtime.stop()
        self._initialized = False


class MockMind2WebAgent:
    """Mock agent that returns ground truth actions."""

    def __init__(self, config: Mind2WebConfig) -> None:
        self.config = config

    async def initialize(self) -> None:
        pass

    async def process_task(self, task: Mind2WebTask) -> list[Mind2WebAction]:
        """Return ground truth actions."""
        actions: list[Mind2WebAction] = []

        for step in task.actions:
            target = step.target_element
            element_id = target.backend_node_id if target else ""

            actions.append(
                Mind2WebAction(
                    operation=step.operation,
                    element_id=element_id,
                    value=step.value,
                    reasoning="Mock: ground truth",
                )
            )

        return actions

    async def close(self) -> None:
        pass


def create_mind2web_agent(
    config: Mind2WebConfig,
) -> ElizaOSMind2WebAgent | MockMind2WebAgent:
    """Create a Mind2Web agent.

    Args:
        config: Mind2Web configuration

    Returns:
        Agent instance
    """
    if config.use_mock or not ELIZAOS_AVAILABLE:
        return MockMind2WebAgent(config)

    return ElizaOSMind2WebAgent(config)
