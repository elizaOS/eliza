"""Eliza Benchmark Plugin for Context Bench.

This plugin provides the canonical Eliza integration for benchmarking:
- ContextBenchProvider: Injects benchmark context into agent state
- AnswerQuestionAction: Handles answering benchmark questions
- BenchmarkEvaluator: Assesses answer quality

Usage:
    from elizaos.runtime import AgentRuntime
    from elizaos_context_bench.eliza_plugin import (
        get_context_bench_plugin,
        BenchmarkSession,
    )

    runtime = AgentRuntime()
    plugin = get_context_bench_plugin()
    await runtime.register_plugin(plugin)

    # Create a benchmark session
    session = BenchmarkSession()
    session.set_task(context="...", question="...", expected_answer="...")

    # Process through full agent loop
    result = await runtime.message_service.handle_message(runtime, message)

    # Get evaluation results
    eval_result = session.get_evaluation()
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types.components import (
    Action,
    ActionResult,
    Evaluator,
    HandlerOptions,
    Provider,
    ProviderResult,
)
from elizaos.types.memory import Memory
from elizaos.types.plugin import Plugin
from elizaos.types.primitives import UUID, Content, string_to_uuid
from elizaos.types.state import State

if TYPE_CHECKING:
    from collections.abc import Awaitable

    from elizaos.types.components import HandlerCallback
    from elizaos.types.runtime import IAgentRuntime


# ============================================================================
# Benchmark Session - Stores task context and collects results
# ============================================================================


@dataclass
class BenchmarkTaskContext:
    """Context for a single benchmark task."""

    task_id: str
    context: str
    question: str
    expected_answer: str
    needle: str = ""
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class BenchmarkEvaluation:
    """Evaluation results from the benchmark evaluator."""

    task_id: str
    predicted_answer: str
    expected_answer: str
    exact_match: bool
    contains_answer: bool
    semantic_similarity: float
    retrieval_success: bool
    latency_ms: float
    error: str | None = None


class BenchmarkSession:
    """Session manager for benchmark tasks.

    This class coordinates between the benchmark runner and the Eliza plugin,
    storing task context and collecting evaluation results.
    """

    def __init__(self) -> None:
        """Initialize benchmark session."""
        self._current_task: BenchmarkTaskContext | None = None
        self._evaluation: BenchmarkEvaluation | None = None
        self._start_time: float = 0.0
        self._response_text: str = ""

    def set_task(
        self,
        task_id: str,
        context: str,
        question: str,
        expected_answer: str,
        needle: str = "",
        metadata: dict[str, str | int | float | bool] | None = None,
    ) -> None:
        """Set the current benchmark task.

        Args:
            task_id: Unique task identifier.
            context: The haystack context text.
            question: The question to answer.
            expected_answer: The expected answer.
            needle: The needle text embedded in context.
            metadata: Additional task metadata.

        """
        self._current_task = BenchmarkTaskContext(
            task_id=task_id,
            context=context,
            question=question,
            expected_answer=expected_answer,
            needle=needle,
            metadata=metadata or {},
        )
        self._evaluation = None
        self._start_time = time.time()
        self._response_text = ""

    def get_task(self) -> BenchmarkTaskContext | None:
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

    def record_evaluation(self, evaluation: BenchmarkEvaluation) -> None:
        """Record evaluation results.

        Args:
            evaluation: Evaluation results.

        """
        self._evaluation = evaluation

    def get_evaluation(self) -> BenchmarkEvaluation | None:
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


# Global session instance (can be replaced per-runtime)
_global_session: BenchmarkSession | None = None


def get_benchmark_session() -> BenchmarkSession:
    """Get the global benchmark session.

    Returns:
        Global benchmark session.

    """
    global _global_session
    if _global_session is None:
        _global_session = BenchmarkSession()
    return _global_session


def set_benchmark_session(session: BenchmarkSession) -> None:
    """Set the global benchmark session.

    Args:
        session: Benchmark session to use.

    """
    global _global_session
    _global_session = session


# ============================================================================
# Provider: Injects benchmark context into agent state
# ============================================================================


async def context_bench_provider_get(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State,
) -> ProviderResult:
    """Provider handler that injects benchmark context into state.

    This provider reads the current benchmark task from the session
    and injects the context and question into the agent's state.

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
        # No benchmark task set - return empty result
        return ProviderResult(text="", values={}, data=None)

    # Inject benchmark context into state
    context_text = f"""# Benchmark Context

The following text contains information you need to answer a question.
Read it carefully and find the relevant information.

---
{task.context}
---

IMPORTANT: Answer the question based ONLY on the context above.
Be brief and precise. Return ONLY the answer with no extra words.
"""

    return ProviderResult(
        text=context_text,
        values={
            "benchmark_task_id": task.task_id,
            "benchmark_question": task.question,
            "benchmark_has_context": True,
        },
        data={
            "task_id": task.task_id,
            "context_length": len(task.context),
            "question": task.question,
        },
    )


# Create the provider instance
context_bench_provider = Provider(
    name="contextBench",
    description="Provides benchmark context for context-bench evaluation",
    position=5,  # Run early to inject context
    get=context_bench_provider_get,
)


# ============================================================================
# Action: Handles answering benchmark questions
# ============================================================================


async def answer_question_validate(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate if the ANSWER_QUESTION action should run.

    Args:
        runtime: The Eliza runtime.
        message: The incoming message.
        state: Current agent state.

    Returns:
        True if action should run.

    """
    _ = runtime  # Unused
    _ = state  # Unused

    session = get_benchmark_session()
    task = session.get_task()

    if task is None:
        return False

    # Check if the message is asking a question
    text = message.content.text or ""
    return len(text.strip()) > 0


async def answer_question_handler(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None,
    options: HandlerOptions,
    callback: "HandlerCallback | None" = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    """Handle the ANSWER_QUESTION action.

    This action uses the LLM to answer the benchmark question
    based on the injected context.

    Args:
        runtime: The Eliza runtime.
        message: The incoming message.
        state: Current agent state.
        options: Handler options.
        callback: Optional callback for streaming.
        responses: Previous responses.

    Returns:
        Action result with the answer.

    """
    _ = options  # Unused
    _ = callback  # Unused
    _ = responses  # Unused

    session = get_benchmark_session()
    task = session.get_task()

    if task is None:
        return ActionResult(
            success=False,
            error="No benchmark task set",
        )

    # Get the question from message or task
    question = message.content.text or task.question

    # Build prompt with context from state
    context_text = ""
    if state and state.text:
        context_text = state.text

    from elizaos.types.model import ModelType

    # Use the LLM to answer
    try:
        prompt = f"""{context_text}

Question: {question}

Answer (be brief and precise, return ONLY the answer):"""

        result = await runtime.use_model(
            ModelType.TEXT_LARGE,
            {
                "prompt": prompt,
                "system": (
                    "You are a precise assistant that answers questions based ONLY "
                    "on the provided context. Return ONLY the answer, no extra words."
                ),
                "maxTokens": 256,
                "temperature": 0.0,
            },
        )

        answer = str(result).strip()
        session.record_response(answer)

        return ActionResult(
            success=True,
            text=answer,
            values={"answer": answer},
            data={"task_id": task.task_id, "answer": answer},
        )

    except Exception as e:
        error_msg = f"Failed to generate answer: {e}"
        return ActionResult(
            success=False,
            error=error_msg,
        )


# Create the action instance
answer_question_action = Action(
    name="ANSWER_QUESTION",
    description="Answer a question based on the benchmark context",
    similes=["respond to question", "find answer", "retrieve information"],
    examples=[
        [
            {
                "name": "user",
                "content": {"text": "What is the secret code?"},
            },
            {
                "name": "agent",
                "content": {"text": "ALPHA123", "actions": ["ANSWER_QUESTION"]},
            },
        ]
    ],
    validate=answer_question_validate,
    handler=answer_question_handler,
)


# ============================================================================
# Evaluator: Assesses answer quality
# ============================================================================


async def benchmark_evaluator_validate(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate if the benchmark evaluator should run.

    Args:
        runtime: The Eliza runtime.
        message: The incoming message.
        state: Current agent state.

    Returns:
        True if evaluator should run.

    """
    _ = runtime  # Unused
    _ = message  # Unused
    _ = state  # Unused

    session = get_benchmark_session()
    return session.get_task() is not None


async def benchmark_evaluator_handler(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None,
    options: HandlerOptions,
    callback: "HandlerCallback | None" = None,
    responses: list[Memory] | None = None,
) -> None:
    """Evaluate the benchmark response.

    This evaluator compares the agent's response to the expected answer
    and records the evaluation results.

    Args:
        runtime: The Eliza runtime.
        message: The incoming message.
        state: Current agent state.
        options: Handler options.
        callback: Optional callback.
        responses: Agent responses to evaluate.

    """
    _ = runtime  # Unused
    _ = message  # Unused
    _ = state  # Unused
    _ = options  # Unused
    _ = callback  # Unused

    session = get_benchmark_session()
    task = session.get_task()

    if task is None:
        return

    # Get the response text
    response_text = ""
    if responses:
        for response in responses:
            if response.content.text:
                response_text = response.content.text
                break

    # If no response from responses, check session
    if not response_text:
        response_text = session._response_text

    if not response_text:
        # No response to evaluate
        session.record_evaluation(
            BenchmarkEvaluation(
                task_id=task.task_id,
                predicted_answer="",
                expected_answer=task.expected_answer,
                exact_match=False,
                contains_answer=False,
                semantic_similarity=0.0,
                retrieval_success=False,
                latency_ms=session.get_latency_ms(),
                error="No response generated",
            )
        )
        return

    # Evaluate using the retrieval evaluator
    from elizaos_context_bench.evaluators.retrieval import RetrievalEvaluator

    evaluator = RetrievalEvaluator()
    eval_results = evaluator.evaluate(
        predicted=response_text,
        expected=task.expected_answer,
        needle=task.needle if task.needle else None,
    )

    # Record evaluation
    session.record_evaluation(
        BenchmarkEvaluation(
            task_id=task.task_id,
            predicted_answer=response_text,
            expected_answer=task.expected_answer,
            exact_match=bool(eval_results.get("exact_match", False)),
            contains_answer=bool(eval_results.get("contains_answer", False)),
            semantic_similarity=float(eval_results.get("semantic_similarity", 0.0)),
            retrieval_success=bool(eval_results.get("retrieval_success", False)),
            latency_ms=session.get_latency_ms(),
        )
    )


# Create the evaluator instance
benchmark_evaluator = Evaluator(
    name="contextBenchEvaluator",
    description="Evaluates benchmark answer accuracy",
    similes=["assess answer", "check response", "grade answer"],
    examples=[],
    always_run=True,  # Always run after response for benchmarking
    validate_fn=benchmark_evaluator_validate,
    handler=benchmark_evaluator_handler,
)


# ============================================================================
# Plugin Definition
# ============================================================================


def get_context_bench_plugin() -> Plugin:
    """Get the context bench plugin.

    Returns:
        Plugin instance with provider, action, and evaluator.

    """
    return Plugin(
        name="contextBench",
        description="Context benchmarking plugin for evaluating LLM retrieval capabilities",
        providers=[context_bench_provider],
        actions=[answer_question_action],
        evaluators=[benchmark_evaluator],
    )


# ============================================================================
# High-level API for running benchmarks through the full agent loop
# ============================================================================


async def run_benchmark_task_through_agent(
    runtime: "IAgentRuntime",
    task_id: str,
    context: str,
    question: str,
    expected_answer: str,
    needle: str = "",
) -> BenchmarkEvaluation:
    """Run a single benchmark task through the full Eliza agent loop.

    This function:
    1. Sets up the benchmark session with task context
    2. Creates a message with the question
    3. Processes through the full agent loop (providers -> model -> actions -> evaluators)
    4. Returns evaluation results

    Args:
        runtime: Initialized Eliza runtime with context bench plugin.
        task_id: Unique task identifier.
        context: The haystack context text.
        question: The question to answer.
        expected_answer: The expected answer.
        needle: The needle text embedded in context.

    Returns:
        Evaluation results.

    """
    session = get_benchmark_session()

    # Set up the task
    session.set_task(
        task_id=task_id,
        context=context,
        question=question,
        expected_answer=expected_answer,
        needle=needle,
    )

    # Create a message for the question
    room_id = string_to_uuid("benchmark-room")
    entity_id = string_to_uuid("benchmark-user")
    message_id = string_to_uuid(str(uuid.uuid4()))

    message = Memory(
        id=message_id,
        agent_id=runtime.agent_id,
        entity_id=entity_id,
        room_id=room_id,
        content=Content(text=question),
    )

    try:
        # Process through the message service (full agent loop)
        _ = await runtime.message_service.handle_message(
            runtime,
            message,
        )

        # Get evaluation results
        evaluation = session.get_evaluation()
        if evaluation is None:
            # Create error evaluation if none recorded
            evaluation = BenchmarkEvaluation(
                task_id=task_id,
                predicted_answer="",
                expected_answer=expected_answer,
                exact_match=False,
                contains_answer=False,
                semantic_similarity=0.0,
                retrieval_success=False,
                latency_ms=session.get_latency_ms(),
                error="No evaluation recorded",
            )

        return evaluation

    except Exception as e:
        return BenchmarkEvaluation(
            task_id=task_id,
            predicted_answer="",
            expected_answer=expected_answer,
            exact_match=False,
            contains_answer=False,
            semantic_similarity=0.0,
            retrieval_success=False,
            latency_ms=session.get_latency_ms(),
            error=str(e),
        )
    finally:
        # Clear session for next task
        session.clear()


async def setup_benchmark_runtime(
    model_plugin: Plugin | None = None,
) -> "IAgentRuntime":
    """Set up an Eliza runtime configured for benchmarking.

    Args:
        model_plugin: Optional model plugin (e.g., OpenAI plugin).

    Returns:
        Configured runtime ready for benchmarking.

    """
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character

    # Create a benchmark-focused character
    character = Character(
        name="ContextBenchAgent",
        bio="An agent specialized in information retrieval and question answering.",
        system=(
            "You are a precise assistant that answers questions based ONLY on "
            "provided context. Always give brief, accurate answers."
        ),
    )

    # Create runtime with benchmark character
    runtime = AgentRuntime(
        character=character,
        disable_basic_capabilities=True,  # Don't load default bootstrap
    )

    # Initialize runtime
    await runtime.initialize()

    # Register model plugin if provided
    if model_plugin is not None:
        # Register models from the plugin
        if model_plugin.models:
            for model_type, handler in model_plugin.models.items():
                runtime.register_model(model_type, handler, provider=model_plugin.name)

    # Register the context bench plugin
    bench_plugin = get_context_bench_plugin()
    await runtime.register_plugin(bench_plugin)

    return runtime
