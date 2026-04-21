"""
MINT Benchmark Plugin for ElizaOS

Provides the EXECUTE_CODE action and MINT_CONTEXT provider for canonical
ElizaOS message handling integration.

Pattern follows benchmarks/tau-bench/elizaos_tau_bench/eliza_agent.py.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from benchmarks.mint.executor import PythonExecutor, ExecutionResult
from benchmarks.mint.types import MINTTask, Turn, TurnType

if TYPE_CHECKING:
    from elizaos.types.components import (
        Action,
        ActionExample,
        ActionParameter,
        ActionParameterSchema,
        ActionResult,
        HandlerCallback,
        HandlerOptions,
        Provider,
        ProviderResult,
    )
    from elizaos.types.memory import Memory
    from elizaos.types.plugin import Plugin
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Try to import ElizaOS — optional dependency
# ---------------------------------------------------------------------------

try:
    from elizaos.runtime import AgentRuntime
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
    logger.warning("ElizaOS not available, MINT plugin will not function")


# ---------------------------------------------------------------------------
# Shared context (set per-task before message processing)
# ---------------------------------------------------------------------------


@dataclass
class MINTContext:
    """Shared context for MINT actions and providers."""

    task: MINTTask | None = None
    executor: PythonExecutor | None = None
    conversation_history: list[dict[str, str]] = field(default_factory=list)
    system_prompt: str = ""
    last_code_result: ExecutionResult | None = None
    last_code_executed: str = ""
    num_tool_uses: int = 0
    # Turns recorded by the agent loop
    tool_turns: list[Turn] = field(default_factory=list)


# Global context (set per-task before message processing)
_mint_context: MINTContext = MINTContext()


def set_mint_context(
    task: MINTTask,
    executor: PythonExecutor,
    *,
    system_prompt: str = "",
    conversation_history: list[dict[str, str]] | None = None,
) -> None:
    """Set the MINT context for the current task."""
    global _mint_context
    _mint_context = MINTContext(
        task=task,
        executor=executor,
        conversation_history=list(conversation_history) if conversation_history else [],
        system_prompt=system_prompt,
        last_code_result=None,
        last_code_executed="",
        num_tool_uses=0,
        tool_turns=[],
    )


def get_mint_context() -> MINTContext:
    """Get the current MINT context."""
    return _mint_context


def update_mint_context_history(history: list[dict[str, str]]) -> None:
    """Update the conversation history stored in the context."""
    _mint_context.conversation_history = list(history)


# ---------------------------------------------------------------------------
# MINT_CONTEXT Provider: Injects problem context into the agent's state
# ---------------------------------------------------------------------------


async def get_mint_context_provider(
    runtime: "IAgentRuntime",
    message: "Memory",
    state: "State | None" = None,
) -> "ProviderResult":
    """Provider that injects MINT task context into the state."""
    ctx = get_mint_context()
    if not ctx.task:
        return ProviderResult(text="", values={}, data={})

    task = ctx.task

    sections: list[str] = []

    # Problem statement
    sections.append(f"# MINT Benchmark Task: {task.id}")
    sections.append(f"## Category: {task.category.value}")
    sections.append(f"## Problem\n{task.description}")
    sections.append(f"## Question\n{task.initial_prompt}")

    # Tool availability
    if "python" in task.tools_allowed:
        sections.append(
            "## Available Tools\n"
            "You can use the EXECUTE_CODE action to run Python code.\n"
            "Wrap code in ```python blocks and use EXECUTE_CODE to verify calculations.\n"
            "Only use code when calculations are complex. For simple problems, reason directly."
        )

    # Format hints based on evaluation metric
    format_hints = {
        "numeric": "Your answer must be a NUMBER ONLY (e.g., 42 or 3.14). No units, no symbols.",
        "exact_match": "Your answer must match exactly. Check spelling and formatting.",
        "partial_match": "Format your answer exactly as requested in the problem.",
        "code_output": "Your answer must be the numeric output of the code.",
    }
    format_hint = format_hints.get(
        task.evaluation_metric, "Provide a clear, concise answer."
    )
    sections.append(
        f"## Answer Format\n{format_hint}\n"
        "End your response with EXACTLY: Final answer: <YOUR_ANSWER>"
    )

    # Last code execution result (if any)
    if ctx.last_code_result is not None:
        result = ctx.last_code_result
        if result.success:
            output_preview = result.output[:500] if result.output else "(no output)"
            sections.append(
                f"## Last Code Execution (SUCCESS)\n```\n{output_preview}\n```"
            )
        else:
            error_preview = result.error[:300] if result.error else "Unknown error"
            sections.append(
                f"## Last Code Execution (ERROR)\n```\n{error_preview}\n```"
            )

    return ProviderResult(
        text="\n\n".join(sections),
        values={
            "mintCategory": task.category.value,
            "mintMetric": task.evaluation_metric,
            "toolsAllowed": ",".join(task.tools_allowed),
            "hasLastResult": ctx.last_code_result is not None,
        },
        data={
            "task": {
                "id": task.id,
                "category": task.category.value,
                "tools_allowed": task.tools_allowed,
                "evaluation_metric": task.evaluation_metric,
            }
        },
    )


# ---------------------------------------------------------------------------
# EXECUTE_CODE Action: Runs Python code through PythonExecutor
# ---------------------------------------------------------------------------


# Patterns to detect code blocks in responses
CODE_BLOCK_PATTERNS = [
    r"```python\s*(.*?)```",
    r"```\s*(.*?)```",
    r"<code>\s*(.*?)</code>",
]


def _extract_code_from_text(text: str) -> str:
    """Extract Python code from a text response containing code blocks."""
    for pattern in CODE_BLOCK_PATTERNS:
        match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
        if match:
            code = match.group(1).strip()
            if code:
                return code
    return ""


@dataclass
class ExecuteCodeAction:
    """Action that executes Python code via PythonExecutor through the canonical action system."""

    name: str = "EXECUTE_CODE"
    similes: list[str] = field(
        default_factory=lambda: ["RUN_CODE", "RUN_PYTHON", "PYTHON_EXEC"]
    )
    description: str = (
        "Execute Python code to solve math/reasoning problems. "
        "Parameters: code (string, required) - Python code to execute. "
        "Alternatively, include a ```python code block in the message. "
        "Example: code='result = 2 + 2\\nprint(result)'"
    )

    async def validate(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
    ) -> bool:
        """Valid if we have a task context with python tools allowed."""
        ctx = get_mint_context()
        return (
            ctx.task is not None
            and ctx.executor is not None
            and "python" in (ctx.task.tools_allowed or [])
        )

    async def handler(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State | None" = None,
        options: "HandlerOptions | None" = None,
        callback: "HandlerCallback | None" = None,
        responses: "list[Memory] | None" = None,
    ) -> "ActionResult":
        """Execute Python code through the PythonExecutor."""
        ctx = get_mint_context()

        if not ctx.task or not ctx.executor:
            return ActionResult(
                text="Error: No MINT task context available",
                values={"success": False},
                success=False,
            )

        # Extract code from parameters or from the response text
        params = options.parameters if options and options.parameters else {}
        code = str(params.get("code", ""))

        # If no explicit code param, try extracting from response messages
        if not code and responses:
            for resp in responses:
                if resp.content and resp.content.text:
                    code = _extract_code_from_text(resp.content.text)
                    if code:
                        break

        # Also try extracting from the message text itself
        if not code and message.content and message.content.text:
            code = _extract_code_from_text(message.content.text)

        if not code:
            return ActionResult(
                text="Error: No code provided to EXECUTE_CODE",
                values={"success": False},
                success=False,
            )

        runtime.logger.info(f"EXECUTE_CODE: executing {len(code)} chars of Python")

        try:
            exec_result = await ctx.executor.execute(code)
            ctx.last_code_result = exec_result
            ctx.last_code_executed = code
            ctx.num_tool_uses += 1

            # Record tool turn
            ctx.tool_turns.append(
                Turn(
                    turn_type=TurnType.TOOL,
                    content=exec_result.output or exec_result.error or "",
                    tool_call=code,
                    tool_result=exec_result.output,
                    tool_success=exec_result.success,
                )
            )

            if exec_result.success:
                output_preview = exec_result.output[:500] if exec_result.output else "(no output)"
                result_text = (
                    f"Code executed successfully. Output:\n```\n{output_preview}\n```"
                )
                return ActionResult(
                    text=result_text,
                    values={
                        "success": True,
                        "output": exec_result.output or "",
                    },
                    data={
                        "actionName": "EXECUTE_CODE",
                        "code": code[:2000],
                        "output": (exec_result.output or "")[:2000],
                    },
                    success=True,
                )
            else:
                error_preview = exec_result.error[:300] if exec_result.error else "Unknown error"
                result_text = f"Code error:\n```\n{error_preview}\n```"
                return ActionResult(
                    text=result_text,
                    values={
                        "success": False,
                        "error": exec_result.error or "",
                    },
                    data={
                        "actionName": "EXECUTE_CODE",
                        "code": code[:2000],
                        "error": (exec_result.error or "")[:2000],
                    },
                    success=False,
                )

        except Exception as e:
            error_msg = f"Code execution error: {e}"
            runtime.logger.error(error_msg)
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
                    content=Content(text="What is 15 factorial?"),
                ),
                ActionExample(
                    name="{{name2}}",
                    content=Content(
                        text="Let me calculate that using Python.\n\n```python\nimport math\nprint(math.factorial(15))\n```",
                        actions=["EXECUTE_CODE"],
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
                name="code",
                description="Python code to execute (e.g., 'result = 2+2\\nprint(result)')",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
        ]


# ---------------------------------------------------------------------------
# Custom message handler template for MINT
# ---------------------------------------------------------------------------

MINT_MESSAGE_TEMPLATE = """<task>You are solving a benchmark task. Use Python code when calculations are complex, then provide your final answer.</task>

<providers>
{{providers}}
</providers>

<instructions>
CRITICAL RULES:
1. If you need to compute something → use EXECUTE_CODE with Python code
2. If you already have the result or can reason directly → use REPLY with your final answer
3. NEVER repeat the same code execution

WHEN TO USE REPLY (final answer):
- After code execution gives you the answer → REPLY with "Final answer: X"
- For simple problems you can solve by reasoning → REPLY with "Final answer: X"
- If you see code output in the context → REPLY with "Final answer: X"

WHEN TO USE EXECUTE_CODE (run code):
- When you need to perform complex calculations
- When you need to verify your reasoning with code
</instructions>

<output>
For code execution:
<response>
    <thought>I need to calculate this using Python</thought>
    <actions>EXECUTE_CODE</actions>
    <providers>MINT_CONTEXT</providers>
    <text>Let me solve this with Python.

```python
# your code here
print(result)
```</text>
    <params>
        <EXECUTE_CODE>
            <code>result = 2 + 2
print(result)</code>
        </EXECUTE_CODE>
    </params>
</response>

For final answer (AFTER computation or direct reasoning):
<response>
    <thought>I have the answer from computation/reasoning</thought>
    <actions>REPLY</actions>
    <providers></providers>
    <text>Based on my analysis, the result is X.

Final answer: X</text>
</response>

IMPORTANT: Start with <response> immediately. Always end your final response with "Final answer: X".
</output>"""


# ---------------------------------------------------------------------------
# Plugin factory
# ---------------------------------------------------------------------------


def create_mint_plugin(executor: PythonExecutor) -> "Plugin":
    """
    Create the MINT benchmark plugin with actions and providers.

    This plugin provides:
    - MINT_CONTEXT provider: Injects problem statement, history, and tool feedback
    - EXECUTE_CODE action: Executes Python code through PythonExecutor

    Args:
        executor: The PythonExecutor instance for code execution.

    Returns:
        An ElizaOS Plugin configured for the MINT benchmark.
    """
    if not ELIZAOS_AVAILABLE:
        raise RuntimeError("ElizaOS is required for the MINT benchmark plugin")

    # Create action instance
    execute_code = ExecuteCodeAction()

    # Build Action object
    execute_code_action = Action(
        name=execute_code.name,
        similes=execute_code.similes,
        description=execute_code.description,
        validate=execute_code.validate,
        handler=execute_code.handler,
        examples=execute_code.examples,
        parameters=execute_code.parameters,
    )

    # Build Provider
    mint_context_provider = Provider(
        name="MINT_CONTEXT",
        description="MINT benchmark problem context, history, and tool feedback",
        get=get_mint_context_provider,
        position=-10,  # High priority — inject early
    )

    return Plugin(
        name="mint-bench",
        description="MINT benchmark plugin for multi-turn task evaluation",
        actions=[execute_code_action],
        providers=[mint_context_provider],
    )
