"""
ElizaOS-integrated agent for Tau-bench.

This module provides proper integration with ElizaOS runtime using the FULL
canonical agent flow:
- Messages processed through runtime.message_service.handle_message()
- Actions registered and executed via process_actions()
- Providers inject task context into the state
- Uses MESSAGE_HANDLER_TEMPLATE for LLM responses

Currently supported provider (Python): OpenAI.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional
from uuid import uuid4

from elizaos_tau_bench.types import (
    TauBenchTask,
    ToolCall,
    ToolDefinition,
    ConversationTurn,
)
from elizaos_tau_bench.executor import ToolExecutor
from elizaos_tau_bench.trajectory_integration import TauBenchTrajectoryIntegration

if TYPE_CHECKING:
    from elizaos.types import (
        Action,
        ActionResult,
        HandlerCallback,
        HandlerOptions,
        IAgentRuntime,
        Memory,
        State,
    )

logger = logging.getLogger(__name__)


# Try to import ElizaOS - optional dependency
try:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.plugin import Plugin
    from elizaos.types.primitives import Content, as_uuid
    from elizaos.types.memory import Memory
    from elizaos.types.state import State
    from elizaos.types.components import (
        Action,
        ActionResult,
        ActionExample,
        ActionParameter,
        ActionParameterSchema,
        Provider,
        ProviderResult,
        HandlerOptions,
    )
    from elizaos.types.model import ModelType

    ELIZAOS_AVAILABLE = True
except ImportError:
    AgentRuntime = None  # type: ignore[misc, assignment]
    Character = None  # type: ignore[misc, assignment]
    Plugin = None  # type: ignore[misc, assignment]
    Memory = None  # type: ignore[misc, assignment]
    Content = None  # type: ignore[misc, assignment]
    State = None  # type: ignore[misc, assignment]
    Action = None  # type: ignore[misc, assignment]
    ActionResult = None  # type: ignore[misc, assignment]
    ActionExample = None  # type: ignore[misc, assignment]
    ActionParameter = None  # type: ignore[misc, assignment]
    ActionParameterSchema = None  # type: ignore[misc, assignment]
    Provider = None  # type: ignore[misc, assignment]
    ProviderResult = None  # type: ignore[misc, assignment]
    HandlerOptions = None  # type: ignore[misc, assignment]
    ModelType = None  # type: ignore[misc, assignment]
    as_uuid = None  # type: ignore[misc, assignment]
    ELIZAOS_AVAILABLE = False
    logger.warning("ElizaOS not available, agent will use mock mode")


def get_model_provider_plugin(provider: Optional[str] = None) -> Optional["Plugin"]:
    """
    Get an LLM model provider plugin based on available API keys.

    Checks environment for API keys and returns the appropriate plugin.
    Priority: OpenAI

    Returns:
        Plugin configured for the available model provider, or None if none available.
    """
    if not ELIZAOS_AVAILABLE:
        return None

    requested = provider.lower().strip() if provider else ""
    if requested and requested != "openai":
        logger.warning(
            f"Requested provider '{provider}' is not supported in Python yet; falling back to auto-detect"
        )
        requested = ""

    # OpenAI
    if (not requested or requested == "openai") and os.environ.get("OPENAI_API_KEY"):
        try:
            from elizaos_plugin_openai import get_openai_plugin

            logger.info("Using OpenAI model provider")
            return get_openai_plugin()
        except ImportError:
            logger.warning("OpenAI API key found but plugin not installed")

    logger.warning(
        "No model provider available. "
        "Set OPENAI_API_KEY and install the OpenAI plugin (elizaos-plugin-openai)."
    )
    return None


# ---------------------------------------------------------------------------
# TauBench Plugin: Actions and Providers for canonical ElizaOS integration
# ---------------------------------------------------------------------------


@dataclass
class TauBenchContext:
    """Shared context for tau-bench actions and providers."""

    task: TauBenchTask | None = None
    executor: ToolExecutor | None = None
    tool_calls_made: list[ToolCall] = field(default_factory=list)
    conversation: list[ConversationTurn] = field(default_factory=list)
    # Tool results can be dict/list/str/None (see ToolResult in types.py). Keep as object here.
    last_tool_result: object | None = None
    final_response: str = ""
    # Trajectory logging context
    trajectory: TauBenchTrajectoryIntegration | None = None
    trajectory_id: str | None = None
    step_id: str | None = None
    trial_number: int = 1


# Global context (set per-task before message processing)
_tau_context: TauBenchContext = TauBenchContext()


def set_tau_context(
    task: TauBenchTask,
    executor: ToolExecutor,
    *,
    trajectory: TauBenchTrajectoryIntegration | None = None,
    trial_number: int = 1,
) -> None:
    """Set the tau-bench context for the current task."""
    global _tau_context
    _tau_context = TauBenchContext(
        task=task,
        executor=executor,
        tool_calls_made=[],
        conversation=[],
        last_tool_result=None,
        final_response="",
        trajectory=trajectory,
        trajectory_id=None,
        step_id=None,
        trial_number=trial_number,
    )


def get_tau_context() -> TauBenchContext:
    """Get the current tau-bench context."""
    return _tau_context


def _format_tool_definitions(tools: list[ToolDefinition]) -> str:
    """Format tool definitions for the LLM prompt."""
    lines: list[str] = []
    for tool in tools:
        params_str = json.dumps(tool.parameters, indent=2)
        lines.append(f"- **{tool.name}**: {tool.description}")
        lines.append(f"  Parameters: {params_str}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# TAU_BENCH_CONTEXT Provider: Injects task details into the agent's state
# ---------------------------------------------------------------------------


async def get_tau_bench_context(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: "State | None" = None,
) -> "ProviderResult":
    """Provider that injects tau-bench task context into the state."""
    ctx = get_tau_context()
    if not ctx.task:
        return ProviderResult(text="", values={}, data={})

    task = ctx.task

    # Format available tools
    tools_text = _format_tool_definitions(task.available_tools)

    # Format policy constraints
    policies_text = "\n".join(
        [f"- {p.policy_id}: {p.description}" for p in task.policy_constraints]
    )

    # Build context sections
    sections: list[str] = []

    sections.append(f"# Customer Service Task - {task.domain.value.upper()} Domain")

    if task.user_profile:
        sections.append(f"## Customer Profile\n{task.user_profile}")

    if task.user_goal:
        sections.append(f"## Task Goal\n{task.user_goal}")

    if task.success_criteria:
        criteria_hints: dict[str, str] = {
            "flights_searched": "Use EXECUTE_TOOL with search_flights",
            "change_fee_calculated": "Use EXECUTE_TOOL with calculate_change_fee",
            "flight_changed": "Use EXECUTE_TOOL with change_flight",
            "booking_cancelled": "Use EXECUTE_TOOL with cancel_booking",
            "return_initiated": "Use EXECUTE_TOOL with initiate_return",
            "order_cancelled": "Use EXECUTE_TOOL with cancel_order",
            "refund_processed": "Use EXECUTE_TOOL with process_refund",
        }
        criteria_lines = []
        for c in task.success_criteria:
            hint = criteria_hints.get(c, "")
            criteria_lines.append(f"- {c}: {hint}" if hint else f"- {c}")
        sections.append(
            "## Success Criteria (complete before final response)\n"
            + "\n".join(criteria_lines)
        )

    sections.append(f"## Available Tools (use with EXECUTE_TOOL action)\n{tools_text}")

    if policies_text:
        sections.append(f"## Policy Constraints\n{policies_text}")

    # Add last tool result if any
    if ctx.last_tool_result:
        sections.append(
            f"## Last Tool Result\n```json\n{json.dumps(ctx.last_tool_result, indent=2, default=str)}\n```"
        )

    # Trajectory logging: record provider access for this step (if active)
    if ctx.trajectory and ctx.step_id:
        ctx.trajectory.log_provider_access(
            step_id=ctx.step_id,
            provider_name="TAU_BENCH_CONTEXT",
            purpose="task_context",
            data={
                "domain": task.domain.value,
                "task_id": task.task_id,
                "goal": task.user_goal or task.user_instruction,
                "tool_count": len(task.available_tools),
                "policy_count": len(task.policy_constraints),
                "has_last_tool_result": ctx.last_tool_result is not None,
            },
            query={
                "message": (message.content.text or "") if message.content else "",
            },
        )

    return ProviderResult(
        text="\n\n".join(sections),
        values={
            "tauDomain": task.domain.value,
            "toolCount": len(task.available_tools),
            "policyCount": len(task.policy_constraints),
        },
        data={
            "task": {
                "domain": task.domain.value,
                "user_goal": task.user_goal,
                "tools": [t.name for t in task.available_tools],
                "policies": [p.policy_id for p in task.policy_constraints],
            }
        },
    )


# ---------------------------------------------------------------------------
# EXECUTE_TOOL Action: Executes benchmark tools through the canonical flow
# ---------------------------------------------------------------------------


@dataclass
class ExecuteToolAction:
    """Action that executes tau-bench tools via the canonical action system."""

    name: str = "EXECUTE_TOOL"
    similes: list[str] = field(
        default_factory=lambda: ["CALL_TOOL", "USE_TOOL", "TOOL_CALL", "RUN_TOOL"]
    )
    description: str = (
        "Execute a customer service tool. "
        "Parameters: tool_name (string, required) - name of the tool to call; "
        "arguments (object, required) - JSON object with tool parameters. "
        "Example: tool_name='get_order_details', arguments={'order_id': 'ORD-123'}"
    )

    async def validate(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
    ) -> bool:
        """Always valid if we have a task context with tools."""
        ctx = get_tau_context()
        return ctx.task is not None and len(ctx.task.available_tools) > 0

    async def handler(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
        options: "HandlerOptions | None" = None,
        callback: "HandlerCallback | None" = None,
        responses: "list[Memory] | None" = None,
    ) -> "ActionResult":
        """Execute the requested tool through the ToolExecutor."""
        ctx = get_tau_context()

        if not ctx.task or not ctx.executor:
            return ActionResult(
                text="Error: No task context available",
                values={"success": False},
                success=False,
            )

        # Extract tool call from parameters
        params = options.parameters if options and options.parameters else {}
        tool_name = str(params.get("tool_name", ""))
        arguments_raw = params.get("arguments", {})

        # Handle arguments - could be string or dict
        if isinstance(arguments_raw, str):
            try:
                arguments = json.loads(arguments_raw)
            except json.JSONDecodeError:
                arguments = {}
        else:
            arguments = dict(arguments_raw) if arguments_raw else {}

        if not tool_name:
            return ActionResult(
                text="Error: No tool_name provided in EXECUTE_TOOL params",
                values={"success": False},
                success=False,
            )

        runtime.logger.info(f"EXECUTE_TOOL: {tool_name} with args {arguments}")

        # Create and execute tool call
        tool_call = ToolCall(tool_name=tool_name, arguments=arguments)

        try:
            executed_call = await ctx.executor.execute(tool_call)
            ctx.tool_calls_made.append(executed_call)
            ctx.last_tool_result = executed_call.result

            # Add to conversation
            ctx.conversation.append(
                ConversationTurn(
                    role="assistant",
                    content=f"Executing tool: {tool_name}",
                    tool_call=executed_call,
                )
            )
            ctx.conversation.append(
                ConversationTurn(
                    role="tool",
                    content=json.dumps(executed_call.result, default=str),
                )
            )

            result_text = json.dumps(executed_call.result, default=str, indent=2)

            # Trajectory logging: complete the current step with this tool action
            if ctx.trajectory and ctx.trajectory_id and ctx.step_id:
                ctx.trajectory.log_action_attempt(
                    trajectory_id=ctx.trajectory_id,
                    step_id=ctx.step_id,
                    action_type="EXECUTE_TOOL",
                    action_name=tool_name,
                    parameters={"arguments": arguments},
                    success=True,
                    reward=0.0,
                    result={
                        "tool_name": tool_name,
                        "result": executed_call.result if executed_call.result is not None else None,
                        "status": executed_call.status.value,
                    },
                    reasoning=None,
                    llm_call_id=None,
                )

            return ActionResult(
                text=f"Tool {tool_name} result: {result_text}",
                values={
                    "success": True,
                    "tool_name": tool_name,
                    "tool_result": executed_call.result,
                },
                data={
                    "actionName": "EXECUTE_TOOL",
                    "toolName": tool_name,
                    "toolArguments": arguments,
                    "toolResult": executed_call.result,
                },
                success=True,
            )

        except Exception as e:
            error_msg = f"Tool execution error: {e}"
            runtime.logger.error(error_msg)

            if ctx.trajectory and ctx.trajectory_id and ctx.step_id:
                ctx.trajectory.log_action_attempt(
                    trajectory_id=ctx.trajectory_id,
                    step_id=ctx.step_id,
                    action_type="EXECUTE_TOOL",
                    action_name=tool_name,
                    parameters={"arguments": arguments},
                    success=False,
                    reward=0.0,
                    result=None,
                    error=str(e),
                    reasoning=None,
                    llm_call_id=None,
                )
            return ActionResult(
                text=error_msg,
                values={"success": False, "error": str(e)},
                success=False,
            )

    @property
    def examples(self) -> list[list["ActionExample"]]:
        if not ELIZAOS_AVAILABLE:
            return []
        return [
            [
                ActionExample(
                    name="{{name1}}",
                    content=Content(text="I need to return order ORD-12345"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="Let me look up your order details.",
                        actions=["EXECUTE_TOOL"],
                    ),
                ),
            ],
        ]

    @property
    def parameters(self) -> list["ActionParameter"]:
        if not ELIZAOS_AVAILABLE:
            return []
        return [
            ActionParameter(
                name="tool_name",
                description="Name of the tool to execute (e.g., get_order_details, cancel_order)",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
            ActionParameter(
                name="arguments",
                description="JSON string with tool parameters (e.g., '{\"order_id\": \"ORD-123\"}')",
                required=True,
                schema=ActionParameterSchema(type="string"),  # String because XML parser reads JSON as string
            ),
        ]


def create_tau_bench_plugin(executor: ToolExecutor) -> "Plugin":
    """
    Create the tau-bench plugin with actions and providers.

    This plugin provides:
    - TAU_BENCH_CONTEXT provider: Injects task details, tools, policies into state
    - EXECUTE_TOOL action: Executes benchmark tools through canonical action system
    """
    if not ELIZAOS_AVAILABLE:
        raise RuntimeError("ElizaOS is required for tau-bench plugin")

    # Create action instance
    execute_tool = ExecuteToolAction()

    # Build Action object
    execute_tool_action = Action(
        name=execute_tool.name,
        similes=execute_tool.similes,
        description=execute_tool.description,
        validate=execute_tool.validate,
        handler=execute_tool.handler,
        examples=execute_tool.examples,
        parameters=execute_tool.parameters,
    )

    # Build Provider
    tau_context_provider = Provider(
        name="TAU_BENCH_CONTEXT",
        description="Tau-bench task context including tools, policies, and goals",
        get=get_tau_bench_context,
        position=-10,  # High priority - inject early
    )

    return Plugin(
        name="tau-bench",
        description="Tau-bench benchmark plugin for tool-agent evaluation",
        actions=[execute_tool_action],
        providers=[tau_context_provider],
    )


# ---------------------------------------------------------------------------
# Custom message handler template for tau-bench
# ---------------------------------------------------------------------------

TAU_BENCH_MESSAGE_TEMPLATE = """<task>You are a customer service agent. Help the customer using the available tools, then provide a final response.</task>

<providers>
{{providers}}
</providers>

<instructions>
CRITICAL RULES:
1. If you need information or must perform an action → use EXECUTE_TOOL
2. If you already have the tool result and the task is complete → use REPLY to respond to customer
3. NEVER repeat the same tool call - if you already called a tool, use REPLY with the result

WHEN TO USE REPLY (final response):
- After get_order_details → REPLY with the order information
- After initiate_return succeeds → REPLY confirming the return
- After cancel_order succeeds → REPLY confirming cancellation
- After any successful action → REPLY with confirmation
- If you see "Tool result:" in the message → the tool already ran, use REPLY

WHEN TO USE EXECUTE_TOOL (call a tool):
- When you first need to look up information (order, booking, etc.)
- When you need to perform an action (return, cancel, etc.)
</instructions>

<output>
For tool calls:
<response>
    <thought>I need to call a tool</thought>
    <actions>EXECUTE_TOOL</actions>
    <providers>TAU_BENCH_CONTEXT</providers>
    <text>Let me help you with that.</text>
    <params>
        <EXECUTE_TOOL>
            <tool_name>tool_name</tool_name>
            <arguments>{"param": "value"}</arguments>
        </EXECUTE_TOOL>
    </params>
</response>

For final response (AFTER tool results are available):
<response>
    <thought>I have the information/completed the action, providing response</thought>
    <actions>REPLY</actions>
    <providers></providers>
    <text>Here is the complete response to the customer...</text>
</response>

IMPORTANT: Start with <response> immediately. If you see tool results in the conversation, use REPLY not EXECUTE_TOOL.
</output>"""


# ---------------------------------------------------------------------------
# ElizaOS Agent Implementation using canonical message_service.handle_message()
# ---------------------------------------------------------------------------


class ElizaOSTauAgent:
    """
    Agent that processes Tau-bench tasks using the FULL ElizaOS runtime.

    This agent uses the canonical ElizaOS flow:
    - Messages processed through runtime.message_service.handle_message()
    - Actions (EXECUTE_TOOL) registered via plugin and executed via process_actions()
    - Providers (TAU_BENCH_CONTEXT) inject context into the state
    - Uses custom messageHandlerTemplate for tau-bench specific prompting
    """

    def __init__(
        self,
        executor: ToolExecutor,
        max_turns: int = 15,
        runtime: Optional["AgentRuntime"] = None,
        model_plugin: Optional["Plugin"] = None,
        model_provider: Optional[str] = None,
        temperature: float = 0.0,
        trajectory: TauBenchTrajectoryIntegration | None = None,
    ) -> None:
        self.executor = executor
        self.max_turns = max_turns
        self.runtime = runtime
        self.model_plugin = model_plugin
        self.model_provider = model_provider
        self.temperature = temperature
        self.conversation: list[ConversationTurn] = []
        self._initialized = False
        self._has_model_provider = False
        self._tau_plugin: Optional["Plugin"] = None
        self._trajectory = trajectory

    async def initialize(self) -> None:
        """Initialize the ElizaOS runtime with model providers and tau-bench plugin."""
        if self._initialized:
            return

        if not ELIZAOS_AVAILABLE:
            logger.warning("ElizaOS not available, running in mock mode")
            self._initialized = True
            return

        # Auto-detect model plugin if not provided
        if self.model_plugin is None:
            self.model_plugin = get_model_provider_plugin(self.model_provider)

        if self.model_plugin is None:
            logger.warning(
                "No model provider plugin available. Agent will run in mock mode."
            )
            self._initialized = True
            return

        # Create tau-bench plugin
        self._tau_plugin = create_tau_bench_plugin(self.executor)

        if self.runtime is None:
            # Create character with custom message handler template
            character = Character(
                name="TauBenchAgent",
                username="tau_bench_agent",
                bio="An AI customer service agent being evaluated on Tau-bench.",
                system="You are a helpful customer service agent. Use tools to help customers.",
                templates={
                    "messageHandlerTemplate": TAU_BENCH_MESSAGE_TEMPLATE,
                },
            )

            # Create runtime with plugins:
            # - bootstrap plugin (default, provides REPLY, IGNORE, NONE)
            # - model provider plugin (OpenAI)
            # - tau-bench plugin (EXECUTE_TOOL action + TAU_BENCH_CONTEXT provider)
            self.runtime = AgentRuntime(
                character=character,
                plugins=[
                    self.model_plugin,
                    self._tau_plugin,
                ],
                log_level="INFO",
            )

        await self.runtime.initialize()
        self._has_model_provider = self.runtime.has_model("TEXT_LARGE")

        if self._has_model_provider:
            logger.info("Tau-bench agent initialized with CANONICAL ElizaOS flow")
            logger.info(f"  - Actions: {[a.name for a in self.runtime.actions]}")
            logger.info(f"  - Providers: {[p.name for p in self.runtime.providers]}")
        else:
            logger.warning(
                "Tau-bench agent initialized but no TEXT_LARGE model available"
            )

        self._initialized = True

    async def process_task(
        self, task: TauBenchTask
    ) -> tuple[list[ToolCall], str, list[ConversationTurn]]:
        """
        Process a Tau-bench task using the FULL ElizaOS message pipeline.

        Uses runtime.message_service.handle_message() for canonical flow.

        Returns:
        - List of tool calls made
        - Final response text
        - Full conversation history
        """
        if not self._initialized:
            await self.initialize()

        # Pull trial number from metadata if provided by runner
        trial_number_obj = task.metadata.get("trial_number") if task.metadata else None
        trial_number = trial_number_obj if isinstance(trial_number_obj, int) else 1

        # Set the global tau context for this task (shared with providers/actions)
        set_tau_context(
            task,
            self.executor,
            trajectory=self._trajectory,
            trial_number=trial_number,
        )
        ctx = get_tau_context()

        # Initialize conversation from history
        for msg in task.conversation_history:
            ctx.conversation.append(
                ConversationTurn(role=msg["role"], content=msg["content"])
            )

        # Add user instruction
        ctx.conversation.append(
            ConversationTurn(role="user", content=task.user_instruction)
        )

        # Check if we can use full ElizaOS pipeline
        if not ELIZAOS_AVAILABLE or not self.runtime or not self._has_model_provider:
            logger.debug("Using mock mode for task processing")
            return await self._process_task_mock(task, ctx)

        # Use CANONICAL ElizaOS pipeline via message_service.handle_message()
        return await self._process_task_canonical(task, ctx)

    async def _process_task_canonical(
        self, task: TauBenchTask, ctx: TauBenchContext
    ) -> tuple[list[ToolCall], str, list[ConversationTurn]]:
        """Process task through the CANONICAL ElizaOS message service pipeline."""
        assert self.runtime is not None
        user_id = as_uuid(str(uuid4()))

        final_response = ""

        # Trajectory logging: wrap runtime model calls and start the trajectory
        if ctx.trajectory and self.runtime:
            ctx.trajectory.wrap_runtime(self.runtime)
            ctx.trajectory_id = ctx.trajectory.start_task(
                task,
                agent_id=str(self.runtime.agent_id),
                trial_number=ctx.trial_number,
            )

        for turn in range(self.max_turns):
            logger.debug(f"[Canonical Flow] Turn {turn + 1}/{self.max_turns}")

            # Use a NEW room_id for each turn to bypass state caching
            # This ensures compose_state() re-runs providers with fresh ctx.last_tool_result
            room_id = as_uuid(str(uuid4()))

            # Build message content based on turn
            if turn == 0:
                message_text = task.user_instruction
            else:
                # For follow-up turns, include tool result in the message text
                # so the LLM sees what happened
                if ctx.last_tool_result:
                    result_str = json.dumps(ctx.last_tool_result, default=str)[:1000]
                    message_text = f"Tool result: {result_str}\n\nBased on this result, either call another tool if needed, or use REPLY action to provide the final response to the customer."
                else:
                    message_text = "Continue helping the customer."

            # Create Memory object for the message
            message = Memory(
                id=as_uuid(str(uuid4())),
                entity_id=user_id,
                agent_id=self.runtime.agent_id,
                room_id=room_id,
                content=Content(text=message_text, source="tau-bench"),
                created_at=int(time.time() * 1000),
            )

            try:
                # Start a trajectory step for this turn (before handle_message triggers providers/actions)
                if ctx.trajectory and ctx.trajectory_id:
                    ctx.step_id = ctx.trajectory.start_turn(
                        turn_index=turn,
                        message_text=message_text,
                        last_tool_result=ctx.last_tool_result,
                        tool_calls_made=len(ctx.tool_calls_made),
                    )

                # ============================================================
                # CANONICAL FLOW: Use message_service.handle_message()
                # This is the correct way to process messages in ElizaOS:
                # 1. Saves message to memory (if adapter available)
                # 2. Composes state from ALL registered providers
                # 3. Uses MESSAGE_HANDLER_TEMPLATE (or custom template)
                # 4. Calls use_model() internally
                # 5. Parses XML response for actions
                # 6. Calls process_actions() to execute registered actions
                # 7. Runs evaluators
                # ============================================================
                result = await self.runtime.message_service.handle_message(
                    self.runtime, message
                )

                if result.response_content:
                    response_text = result.response_content.text or ""
                    actions = result.response_content.actions or []

                    logger.debug(f"Response actions: {actions}, text_len: {len(response_text)}")

                    # Attach buffered LLM calls (if any) to the current step
                    if ctx.trajectory and ctx.step_id and self.runtime:
                        ctx.trajectory.flush_llm_calls_to_step(
                            step_id=ctx.step_id,
                            system_prompt=self.runtime.character.system or "",
                        )

                    # Check if EXECUTE_TOOL was called
                    # The action handler already executed the tool and stored results in ctx
                    if "EXECUTE_TOOL" in actions:
                        # Tool was executed via process_actions()
                        # ctx.last_tool_result was set by action handler
                        # Continue loop - next turn will see the result via TAU_BENCH_CONTEXT provider
                        logger.debug(f"Tool executed, last_result={ctx.last_tool_result is not None}")
                        continue

                    # No EXECUTE_TOOL - this is a final response
                    final_response = response_text
                    ctx.final_response = final_response
                    ctx.conversation.append(
                        ConversationTurn(role="assistant", content=final_response)
                    )

                    # Trajectory logging: complete final step with REPLY
                    if ctx.trajectory and ctx.trajectory_id and ctx.step_id:
                        ctx.trajectory.log_action_attempt(
                            trajectory_id=ctx.trajectory_id,
                            step_id=ctx.step_id,
                            action_type="REPLY",
                            action_name="REPLY",
                            parameters={},
                            success=True,
                            reward=0.0,
                            result={"final_response": final_response[:2000]},
                            reasoning=None,
                            llm_call_id=None,
                        )
                    break

            except Exception as e:
                logger.error(f"[Canonical Flow] Error: {e}")
                final_response = f"Error processing request: {e}"
                ctx.final_response = final_response
                break

        return ctx.tool_calls_made, ctx.final_response, ctx.conversation

    async def _process_task_mock(
        self, task: TauBenchTask, ctx: TauBenchContext
    ) -> tuple[list[ToolCall], str, list[ConversationTurn]]:
        """Process task using mock responses (for testing without LLM)."""
        # Execute expected tool calls
        for expected_call in task.expected_tool_calls:
            tool_call = ToolCall(
                tool_name=expected_call.tool_name,
                arguments=expected_call.arguments,
            )
            executed = await self.executor.execute(tool_call)
            ctx.tool_calls_made.append(executed)

            ctx.conversation.append(
                ConversationTurn(
                    role="assistant",
                    content=f"Calling {tool_call.tool_name}...",
                    tool_call=executed,
                )
            )
            ctx.conversation.append(
                ConversationTurn(
                    role="tool",
                    content=json.dumps(executed.result, default=str),
                )
            )

        # Final response
        ctx.final_response = (
            task.ground_truth_response
            or "I've completed the requested action. Is there anything else I can help you with?"
        )
        ctx.conversation.append(
            ConversationTurn(role="assistant", content=ctx.final_response)
        )

        return ctx.tool_calls_made, ctx.final_response, ctx.conversation

    async def close(self) -> None:
        """Clean up agent resources."""
        if self.runtime:
            await self.runtime.stop()
        self._initialized = False
        logger.info("Tau-bench agent closed")


class MockTauAgent:
    """
    Mock agent for testing benchmark infrastructure without ElizaOS.

    This agent returns expected tool calls to verify benchmark correctness.
    """

    def __init__(
        self,
        executor: ToolExecutor,
        max_turns: int = 15,
    ) -> None:
        self.executor = executor
        self.max_turns = max_turns
        self.conversation: list[ConversationTurn] = []

    async def initialize(self) -> None:
        """No-op initialization."""
        pass

    async def process_task(
        self, task: TauBenchTask
    ) -> tuple[list[ToolCall], str, list[ConversationTurn]]:
        """Process task using mock responses based on expected calls."""
        tool_calls_made: list[ToolCall] = []
        self.conversation = []

        # Add user instruction
        self.conversation.append(
            ConversationTurn(role="user", content=task.user_instruction)
        )

        # Execute expected tool calls
        for expected_call in task.expected_tool_calls:
            tool_call = ToolCall(
                tool_name=expected_call.tool_name,
                arguments=expected_call.arguments,
            )

            executed_call = await self.executor.execute(tool_call)
            tool_calls_made.append(executed_call)

            self.conversation.append(
                ConversationTurn(
                    role="assistant",
                    content=f"Calling {tool_call.tool_name}...",
                    tool_call=executed_call,
                )
            )

            self.conversation.append(
                ConversationTurn(
                    role="tool",
                    content=json.dumps(executed_call.result, default=str),
                )
            )

        # Final response
        final_response = (
            task.ground_truth_response
            or "I've completed the requested action. Is there anything else I can help you with?"
        )

        self.conversation.append(
            ConversationTurn(role="assistant", content=final_response)
        )

        return tool_calls_made, final_response, self.conversation

    async def close(self) -> None:
        """No-op cleanup."""
        pass


def create_tau_agent(
    executor: ToolExecutor,
    max_turns: int = 15,
    use_mock: bool = False,
    runtime: Optional["AgentRuntime"] = None,
    model_plugin: Optional["Plugin"] = None,
    model_provider: Optional[str] = None,
    temperature: float = 0.0,
    trajectory: TauBenchTrajectoryIntegration | None = None,
) -> ElizaOSTauAgent | MockTauAgent:
    """
    Factory function to create the appropriate agent.

    Args:
        executor: Tool executor for the environment
        max_turns: Maximum conversation turns
        use_mock: Force mock mode even if ElizaOS is available
        runtime: Optional pre-configured runtime
        model_plugin: Optional model provider plugin
        model_provider: Provider name (e.g., "openai")
        temperature: LLM temperature setting

    Returns:
        ElizaOSTauAgent if ElizaOS is available and not in mock mode,
        otherwise MockTauAgent.
    """
    if use_mock or not ELIZAOS_AVAILABLE:
        return MockTauAgent(executor=executor, max_turns=max_turns)

    return ElizaOSTauAgent(
        executor=executor,
        max_turns=max_turns,
        runtime=runtime,
        model_plugin=model_plugin,
        model_provider=model_provider,
        temperature=temperature,
        trajectory=trajectory,
    )
