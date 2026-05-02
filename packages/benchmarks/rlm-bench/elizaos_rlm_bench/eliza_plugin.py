"""Eliza Benchmark Plugin for RLM Bench.

This plugin provides canonical Eliza integration for RLM benchmarking:
- RLMBenchProvider: Injects benchmark context + question into agent state
- RLMBenchEvaluatorPlugin: Assesses answer quality after agent responds

The plugin is designed to work WITH bootstrap (basicCapabilities enabled),
using the canonical agent flow:
1. RLMBenchProvider injects the benchmark context
2. Agent processes message through MESSAGE_HANDLER_TEMPLATE
3. Agent decides to REPLY (bootstrap action)
4. RLMBenchEvaluatorPlugin captures and scores the response

Usage:
    from elizaos.runtime import AgentRuntime
    from elizaos_rlm_bench.eliza_plugin import (
        get_rlm_bench_plugin,
        RLMBenchSession,
        run_benchmark_task_through_agent,
    )

    runtime = await setup_benchmark_runtime(model_plugin)
    session = RLMBenchSession()
    result = await run_benchmark_task_through_agent(
        runtime, session,
        task_id="test1",
        context="The secret code is ALPHA-7.",
        question="What is the secret code?",
        expected_answer="ALPHA-7",
    )

"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types.components import (
    Evaluator,
    HandlerOptions,
    Provider,
    ProviderResult,
)
from elizaos.types.memory import Memory
from elizaos.types.plugin import Plugin
from elizaos.types.primitives import Content, string_to_uuid
from elizaos.types.runtime import IAgentRuntime
from elizaos.types.state import State

if TYPE_CHECKING:
    from elizaos.types.components import HandlerCallback


# ============================================================================
# Benchmark Session - Stores task context and collects results
# ============================================================================


@dataclass
class RLMBenchTaskContext:
    """Context for a single RLM benchmark task."""

    task_id: str
    context: str
    question: str
    expected_answer: str
    bench_type: str = ""
    context_length_tokens: int = 0
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class RLMBenchEvaluation:
    """Evaluation results from the RLM benchmark evaluator."""

    task_id: str
    predicted_answer: str
    expected_answer: str
    exact_match: bool
    contains_answer: bool
    semantic_similarity: float
    is_correct: bool
    latency_ms: float
    error: str | None = None


class RLMBenchSession:
    """Session manager for RLM benchmark tasks.

    This class coordinates between the benchmark runner and the Eliza plugin,
    storing task context and collecting evaluation results.
    """

    def __init__(self) -> None:
        """Initialize benchmark session."""
        self._current_task: RLMBenchTaskContext | None = None
        self._evaluation: RLMBenchEvaluation | None = None
        self._start_time: float = 0.0
        self._response_text: str = ""

    def set_task(
        self,
        task_id: str,
        context: str,
        question: str,
        expected_answer: str,
        bench_type: str = "",
        context_length_tokens: int = 0,
        metadata: dict[str, str | int | float | bool] | None = None,
    ) -> None:
        """Set the current benchmark task.

        Args:
            task_id: Unique task identifier.
            context: The haystack context text.
            question: The question to answer.
            expected_answer: The expected answer.
            bench_type: Type of benchmark (s_niah, oolong, etc.).
            context_length_tokens: Approximate token count of context.
            metadata: Additional task metadata.

        """
        self._current_task = RLMBenchTaskContext(
            task_id=task_id,
            context=context,
            question=question,
            expected_answer=expected_answer,
            bench_type=bench_type,
            context_length_tokens=context_length_tokens,
            metadata=metadata or {},
        )
        self._evaluation = None
        self._start_time = time.time()
        self._response_text = ""

    def get_task(self) -> RLMBenchTaskContext | None:
        """Get the current task context.

        Returns:
            Current task context, or None if not set.

        """
        return self._current_task

    def record_response(self, response: str) -> None:
        """Record the agent's response.

        Args:
            response: The agent's response text.

        """
        self._response_text = response

    def get_response(self) -> str:
        """Get the recorded response.

        Returns:
            The agent's response text.

        """
        return self._response_text

    def record_evaluation(self, evaluation: RLMBenchEvaluation) -> None:
        """Record evaluation results.

        Args:
            evaluation: Evaluation results.

        """
        self._evaluation = evaluation

    def get_evaluation(self) -> RLMBenchEvaluation | None:
        """Get evaluation results.

        Returns:
            Evaluation results, or None if not evaluated.

        """
        return self._evaluation

    def get_latency_ms(self) -> float:
        """Get latency since task was set.

        Returns:
            Latency in milliseconds.

        """
        return (time.time() - self._start_time) * 1000

    def clear(self) -> None:
        """Clear current task and evaluation."""
        self._current_task = None
        self._evaluation = None
        self._start_time = 0.0
        self._response_text = ""


# Global session instance
_global_session: RLMBenchSession | None = None


def get_benchmark_session() -> RLMBenchSession:
    """Get the global benchmark session.

    Returns:
        Global benchmark session.

    """
    global _global_session
    if _global_session is None:
        _global_session = RLMBenchSession()
    return _global_session


def set_benchmark_session(session: RLMBenchSession) -> None:
    """Set the global benchmark session.

    Args:
        session: Benchmark session to use.

    """
    global _global_session
    _global_session = session


# ============================================================================
# Provider: Injects benchmark context into agent state
# ============================================================================


async def rlm_bench_provider_get(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State,
) -> ProviderResult:
    """Provider handler that injects RLM benchmark context into state.

    This provider reads the current benchmark task from the session
    and injects the context into the agent's state. The context is
    formatted to be included alongside other providers (CHARACTER,
    RECENT_MESSAGES, etc.) in the canonical flow.

    Args:
        runtime: The Eliza runtime.
        message: The incoming message.
        state: Current agent state.

    Returns:
        Provider result with context text and values.

    """
    _ = runtime  # Unused but required by interface
    _ = message  # Unused but required by interface
    _ = state  # Unused but required by interface

    session = get_benchmark_session()
    task = session.get_task()

    if task is None:
        return ProviderResult(text="", values={}, data=None)

    context_text = f"""# RLM Benchmark Context

You have been given the following long-context information to answer a question.
Read it carefully and find the relevant information to answer precisely.

---
{task.context}
---

IMPORTANT INSTRUCTIONS:
- Answer the question based ONLY on the context above.
- Be brief and precise.
- Return ONLY the answer with no extra explanation.
- Do not add phrases like "The answer is" or "Based on the context".
"""

    return ProviderResult(
        text=context_text,
        values={
            "benchmark_task_id": task.task_id,
            "benchmark_question": task.question,
            "benchmark_has_context": True,
            "benchmark_type": task.bench_type,
        },
        data={
            "task_id": task.task_id,
            "context_length": len(task.context),
            "context_length_tokens": task.context_length_tokens,
            "question": task.question,
            "bench_type": task.bench_type,
        },
    )


# Create the provider instance
# Position 5 ensures it runs early (after ACTIONS at -1, CHARACTER at 0)
rlm_bench_provider = Provider(
    name="RLM_CONTEXT",
    description="Provides RLM benchmark context for long-context evaluation tasks",
    position=5,
    get=rlm_bench_provider_get,
)


# ============================================================================
# Evaluator: Assesses answer quality after agent responds
# ============================================================================


async def rlm_bench_evaluator_validate(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate if the RLM benchmark evaluator should run.

    Args:
        runtime: The Eliza runtime.
        message: The incoming message.
        state: Current agent state.

    Returns:
        True if evaluator should run (when a benchmark task is active).

    """
    _ = runtime
    _ = message
    _ = state

    session = get_benchmark_session()
    return session.get_task() is not None


async def rlm_bench_evaluator_handler(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: "HandlerCallback | None" = None,
    responses: list[Memory] | None = None,
) -> None:
    """Evaluate the RLM benchmark response.

    This evaluator runs after the agent has responded (via REPLY action).
    It compares the agent's response to the expected answer and records
    the evaluation results in the session.

    Args:
        runtime: The Eliza runtime.
        message: The incoming message.
        state: Current agent state.
        options: Handler options.
        callback: Optional callback.
        responses: Agent responses to evaluate.

    """
    _ = runtime
    _ = message
    _ = state
    _ = options
    _ = callback

    session = get_benchmark_session()
    task = session.get_task()

    if task is None:
        return

    # Prefer the callback-captured response (action output) if present.
    response_text = session.get_response().strip()

    # Otherwise, fall back to the response text from responses (planner output).
    if not response_text and responses:
        for response in responses:
            if response.content and response.content.text:
                response_text = response.content.text
                break

    if not response_text:
        session.record_evaluation(
            RLMBenchEvaluation(
                task_id=task.task_id,
                predicted_answer="",
                expected_answer=task.expected_answer,
                exact_match=False,
                contains_answer=False,
                semantic_similarity=0.0,
                is_correct=False,
                latency_ms=session.get_latency_ms(),
                error="No response generated",
            )
        )
        return

    # Use the RLM bench evaluator for scoring
    from elizaos_rlm_bench.evaluator import (
        compute_exact_match,
        compute_partial_match,
    )

    exact_match = compute_exact_match(response_text, task.expected_answer)
    semantic_similarity = compute_partial_match(response_text, task.expected_answer)
    contains_answer = task.expected_answer.lower() in response_text.lower()
    is_correct = exact_match or contains_answer or semantic_similarity >= 0.8

    session.record_evaluation(
        RLMBenchEvaluation(
            task_id=task.task_id,
            predicted_answer=response_text,
            expected_answer=task.expected_answer,
            exact_match=exact_match,
            contains_answer=contains_answer,
            semantic_similarity=semantic_similarity,
            is_correct=is_correct,
            latency_ms=session.get_latency_ms(),
        )
    )


# Create the evaluator instance
rlm_bench_evaluator = Evaluator(
    name="RLM_BENCH_EVALUATOR",
    description="Evaluates RLM benchmark answer accuracy after agent responds",
    similes=["assess answer", "check response", "grade answer"],
    examples=[],
    always_run=True,
    validate=rlm_bench_evaluator_validate,
    handler=rlm_bench_evaluator_handler,
)


# ============================================================================
# Plugin Definition
# ============================================================================


def get_rlm_bench_plugin() -> Plugin:
    """Get the RLM bench plugin.

    This plugin provides:
    - RLM_CONTEXT provider: Injects benchmark context into agent state
    - RLM_BENCH_EVALUATOR: Evaluates response accuracy

    The plugin is designed to work WITH bootstrap (basicCapabilities enabled),
    using the canonical agent flow. The agent uses REPLY (from bootstrap)
    to respond to benchmark questions.

    Returns:
        Plugin instance with provider and evaluator.

    """
    return Plugin(
        name="rlmBench",
        description="RLM benchmarking plugin for evaluating long-context retrieval via Eliza runtime",
        providers=[rlm_bench_provider],
        actions=[],  # No custom actions - use bootstrap's REPLY
        evaluators=[rlm_bench_evaluator],
    )


# ============================================================================
# High-level API for running benchmarks through the full agent loop
# ============================================================================


async def run_benchmark_task_through_agent(
    runtime: "IAgentRuntime",
    session: RLMBenchSession,
    task_id: str,
    context: str,
    question: str,
    expected_answer: str,
    bench_type: str = "",
    context_length_tokens: int = 0,
) -> RLMBenchEvaluation:
    """Run a single RLM benchmark task through the full Eliza agent loop.

    This function exercises the CANONICAL Eliza flow:
    1. Sets up the benchmark session with task context
    2. Creates a message with the question
    3. Processes through message_service.handle_message() which:
       - Composes state from providers (including RLM_CONTEXT)
       - Generates response via MESSAGE_HANDLER_TEMPLATE
       - Parses actions (agent chooses REPLY)
       - Executes REPLY action (bootstrap)
       - Runs evaluators (including RLM_BENCH_EVALUATOR)
    4. Returns evaluation results

    Args:
        runtime: Initialized Eliza runtime with RLM bench plugin.
        session: RLMBenchSession to use for this task.
        task_id: Unique task identifier.
        context: The haystack context text.
        question: The question to answer.
        expected_answer: The expected answer.
        bench_type: Type of benchmark (s_niah, oolong, etc.).
        context_length_tokens: Approximate token count.

    Returns:
        Evaluation results.

    """
    set_benchmark_session(session)

    session.set_task(
        task_id=task_id,
        context=context,
        question=question,
        expected_answer=expected_answer,
        bench_type=bench_type,
        context_length_tokens=context_length_tokens,
    )

    # Clear state cache to ensure fresh state for each benchmark task
    runtime.state_cache.clear()

    # Create a message for the question
    room_id = string_to_uuid(f"rlm-bench-room-{task_id}")
    entity_id = string_to_uuid("rlm-bench-user")
    message_id = string_to_uuid(str(uuid.uuid4()))

    message = Memory(
        id=message_id,
        agent_id=runtime.agent_id,
        entity_id=entity_id,
        room_id=room_id,
        content=Content(text=question),
    )

    message_service = runtime.message_service
    if message_service is None:
        raise RuntimeError("Runtime has no message_service configured")

    try:

        async def capture_callback(content: Content) -> list[Memory]:
            if content.text:
                session.record_response(str(content.text))
            return []

        result = await message_service.handle_message(
            runtime,
            message,
            capture_callback,
        )

        # The evaluator should have recorded the evaluation
        evaluation = session.get_evaluation()

        if evaluation is None:
            # Fallback: create evaluation from result
            response_text = ""
            if result.response_content and result.response_content.text:
                response_text = result.response_content.text

            from elizaos_rlm_bench.evaluator import (
                compute_exact_match,
                compute_partial_match,
            )

            exact_match = compute_exact_match(response_text, expected_answer)
            semantic_similarity = compute_partial_match(
                response_text, expected_answer
            )
            contains_answer = expected_answer.lower() in response_text.lower()
            is_correct = (
                exact_match or contains_answer or semantic_similarity >= 0.8
            )

            evaluation = RLMBenchEvaluation(
                task_id=task_id,
                predicted_answer=response_text,
                expected_answer=expected_answer,
                exact_match=exact_match,
                contains_answer=contains_answer,
                semantic_similarity=semantic_similarity,
                is_correct=is_correct,
                latency_ms=session.get_latency_ms(),
            )

        return evaluation

    except Exception as e:
        return RLMBenchEvaluation(
            task_id=task_id,
            predicted_answer="",
            expected_answer=expected_answer,
            exact_match=False,
            contains_answer=False,
            semantic_similarity=0.0,
            is_correct=False,
            latency_ms=session.get_latency_ms(),
            error=str(e),
        )


async def setup_benchmark_runtime(
    model_plugin: Plugin | None = None,
) -> "IAgentRuntime":
    """Set up an Eliza runtime configured for RLM benchmarking.

    This creates a runtime with:
    - basicCapabilities enabled (default) - loads bootstrap plugin
    - RLM plugin registered (provides model handlers for TEXT_LARGE, etc.)
    - Model plugin registered if provided (e.g., OpenAI as fallback)
    - RLM bench plugin registered (provider + evaluator)
    - Custom messageHandlerTemplate optimized for long-context Q&A

    Args:
        model_plugin: Optional fallback model plugin (e.g., OpenAI plugin).

    Returns:
        Configured runtime ready for benchmarking.

    """
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character

    # Custom message handler template optimized for RLM benchmark Q&A
    benchmark_message_handler_template = """<task>Plan the next action for {{agentName}} to answer the user's question about long-context content.</task>

<providers>
{{providers}}
</providers>

<instructions>
You are {{agentName}}, a precise assistant that answers questions based ONLY on the provided context.

CRITICAL RULES:
1. Do NOT answer directly in this step.
2. Select the correct action(s) to produce the final answer.
3. You MUST include the provider RLM_CONTEXT so the REPLY action has the benchmark context.
4. Use the REPLY action to produce the final user-visible answer.

If you cannot find the answer in the context, say "Information not found in context."
</instructions>

<output>
Respond using XML format like this:
<response>
    <thought>What information is being asked for and which provider(s) are needed</thought>
    <actions>REPLY</actions>
    <providers>RLM_CONTEXT</providers>
    <text></text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.
</output>"""

    # Custom reply template optimized for long-context benchmark Q&A
    benchmark_reply_template = """# Task: Answer the benchmark question for the character {{agentName}}.

{{providers}}

# Benchmark Question:
{{benchmark_question}}

# Instructions:
- Answer based ONLY on the RLM Benchmark Context above.
- Return ONLY the answer (no extra words).
- Search the context carefully for the relevant information.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Where I found the answer</thought>
    <text>Your answer here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""

    # Create a benchmark-focused character with custom templates
    character = Character(
        name="RLMBenchAgent",
        username="rlm_bench",
        bio="A long-context reasoning agent powered by RLM for benchmark evaluation.",
        system=(
            "You are an expert at answering questions given long contexts. "
            "Read the context carefully and provide precise, brief answers. "
            "Do not add extra explanation - just return the answer."
        ),
        templates={
            "messageHandlerTemplate": benchmark_message_handler_template,
            "replyTemplate": benchmark_reply_template,
        },
    )

    # Collect plugins - RLM plugin first, then optional model plugin
    plugins: list[Plugin] = []

    # Register the RLM plugin which provides model handlers for TEXT_LARGE
    try:
        from elizaos_plugin_rlm import plugin as rlm_plugin

        plugins.append(rlm_plugin)
    except ImportError:
        pass  # RLM plugin not installed; proceed with model_plugin fallback

    if model_plugin is not None:
        plugins.append(model_plugin)

    # Create runtime with benchmark character
    runtime = AgentRuntime(
        character=character,
        plugins=plugins,
    )

    # Initialize runtime (this loads bootstrap + model plugins)
    await runtime.initialize()

    # Register the RLM bench plugin (provider + evaluator)
    bench_plugin = get_rlm_bench_plugin()
    await runtime.register_plugin(bench_plugin)

    return runtime
