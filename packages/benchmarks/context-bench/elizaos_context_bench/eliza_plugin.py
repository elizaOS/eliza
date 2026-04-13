"""Eliza Benchmark Plugin for Context Bench.

This plugin provides canonical Eliza integration for benchmarking:
- ContextBenchProvider: Injects benchmark context into agent state
- BenchmarkEvaluator: Assesses answer quality after agent responds

The plugin is designed to work WITH bootstrap (basicCapabilities enabled),
using the canonical agent flow:
1. ContextBenchProvider injects the benchmark context
2. Agent processes message through MESSAGE_HANDLER_TEMPLATE
3. Agent decides to REPLY (bootstrap action)
4. BenchmarkEvaluator captures and scores the response

Usage:
    from elizaos.runtime import AgentRuntime
    from elizaos_plugin_openai import get_openai_plugin
    from elizaos_context_bench.eliza_plugin import (
        get_context_bench_plugin,
        BenchmarkSession,
        run_benchmark_task_through_agent,
    )

    # Create runtime with model plugin (bootstrap is loaded by default)
    runtime = AgentRuntime(plugins=[get_openai_plugin()])
    await runtime.initialize()

    # Register benchmark plugin
    plugin = get_context_bench_plugin()
    await runtime.register_plugin(plugin)

    # Run a benchmark task through the full agent loop
    session = BenchmarkSession()
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
from elizaos.types.primitives import UUID, Content, string_to_uuid
from elizaos.types.state import State

if TYPE_CHECKING:
    from collections.abc import Awaitable

    from elizaos.types.components import HandlerCallback
    from elizaos.types.runtime import IAgentRuntime
    from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService
    from elizaos_plugin_trajectory_logger.types import Trajectory


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

    def get_response(self) -> str:
        """Get the recorded response.

        Returns:
            The agent's response text.

        """
        return self._response_text

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


# Global session instance (thread-local would be better for concurrency)
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
        # No benchmark task set - return empty result
        return ProviderResult(text="", values={}, data=None)

    # Inject benchmark context into state
    # This context will be included in the prompt alongside CHARACTER, etc.
    context_text = f"""# Benchmark Context

You have been given the following information to answer a question.
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
        },
        data={
            "task_id": task.task_id,
            "context_length": len(task.context),
            "question": task.question,
        },
    )


# Create the provider instance
# Position 5 ensures it runs early (after ACTIONS at -1, CHARACTER at 0)
context_bench_provider = Provider(
    name="CONTEXT_BENCH",
    description="Provides benchmark context for context-bench evaluation tasks",
    position=5,
    get=context_bench_provider_get,
)


# ============================================================================
# Evaluator: Assesses answer quality after agent responds
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
        True if evaluator should run (when a benchmark task is active).

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
    options: HandlerOptions | None = None,
    callback: "HandlerCallback | None" = None,
    responses: list[Memory] | None = None,
) -> None:
    """Evaluate the benchmark response.

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
    _ = runtime  # Unused
    _ = message  # Unused
    _ = state  # Unused
    _ = options  # Unused
    _ = callback  # Unused

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
    name="CONTEXT_BENCH_EVALUATOR",
    description="Evaluates benchmark answer accuracy after agent responds",
    similes=["assess answer", "check response", "grade answer"],
    examples=[],
    always_run=True,  # Always run after response for benchmarking
    validate=benchmark_evaluator_validate,
    handler=benchmark_evaluator_handler,
)


# ============================================================================
# Plugin Definition
# ============================================================================


def get_context_bench_plugin() -> Plugin:
    """Get the context bench plugin.

    This plugin provides:
    - CONTEXT_BENCH provider: Injects benchmark context into agent state
    - CONTEXT_BENCH_EVALUATOR: Evaluates response accuracy

    The plugin is designed to work WITH bootstrap (basicCapabilities enabled),
    using the canonical agent flow. The agent uses REPLY (from bootstrap)
    to respond to benchmark questions.

    Returns:
        Plugin instance with provider and evaluator.

    """
    return Plugin(
        name="contextBench",
        description="Context benchmarking plugin for evaluating LLM retrieval capabilities",
        providers=[context_bench_provider],
        actions=[],  # No custom actions - use bootstrap's REPLY
        evaluators=[benchmark_evaluator],
    )


# ============================================================================
# High-level API for running benchmarks through the full agent loop
# ============================================================================


async def run_benchmark_task_through_agent(
    runtime: "IAgentRuntime",
    session: BenchmarkSession,
    task_id: str,
    context: str,
    question: str,
    expected_answer: str,
    needle: str = "",
    *,
    trajectory_logger: "TrajectoryLoggerService | None" = None,
    trajectory_collector: "list[Trajectory] | None" = None,
) -> BenchmarkEvaluation:
    """Run a single benchmark task through the full Eliza agent loop.

    This function exercises the CANONICAL Eliza flow:
    1. Sets up the benchmark session with task context
    2. Creates a message with the question
    3. Processes through message_service.handle_message() which:
       - Composes state from providers (including CONTEXT_BENCH)
       - Generates response via MESSAGE_HANDLER_TEMPLATE
       - Parses actions (agent chooses REPLY)
       - Executes REPLY action (bootstrap)
       - Runs evaluators (including CONTEXT_BENCH_EVALUATOR)
    4. Returns evaluation results

    Args:
        runtime: Initialized Eliza runtime with context bench plugin.
        session: BenchmarkSession to use for this task.
        task_id: Unique task identifier.
        context: The haystack context text.
        question: The question to answer.
        expected_answer: The expected answer.
        needle: The needle text embedded in context.

    Returns:
        Evaluation results.

    """
    # Set up the global session for this task
    set_benchmark_session(session)

    # Configure the task
    session.set_task(
        task_id=task_id,
        context=context,
        question=question,
        expected_answer=expected_answer,
        needle=needle,
    )

    # Clear state cache to ensure fresh state for each benchmark task
    # The state cache is keyed by room_id, so we need to clear it
    runtime.state_cache.clear()

    # Create a message for the question
    # Use unique room_id per task to avoid any caching issues
    room_id = string_to_uuid(f"benchmark-room-{task_id}")
    entity_id = string_to_uuid("benchmark-user")
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

    # Optional trajectory logging (end-to-end capture)
    traj_id: str | None = None
    step_id: str | None = None

    try:
        async def capture_callback(content: Content) -> list[Memory]:
            # Capture the final user-visible response (typically from REPLY action).
            if content.text:
                session.record_response(str(content.text))
            return []

        # Prefer runtime-integrated trajectory logger service (plugin-trajectory-logger).
        # This enables end-to-end capture from `compose_state` and `DefaultMessageService`
        # without monkeypatching.
        traj_svc = runtime.get_service("trajectory_logger")
        traj_id: str | None = None
        step_id: str | None = None

        if traj_svc is not None and hasattr(traj_svc, "start_trajectory") and hasattr(traj_svc, "start_step"):
            try:
                traj_id = traj_svc.start_trajectory(  # type: ignore[call-arg]
                    agent_id=str(runtime.agent_id),
                    scenario_id=str(task_id),
                    metadata={
                        "benchmark": "context-bench",
                        "taskId": task_id,
                        "question": question,
                        "expected": expected_answer,
                        "contextLengthChars": len(context),
                    },
                )
                step_id = traj_svc.start_step(  # type: ignore[call-arg]
                    trajectory_id=traj_id,
                    env_state={
                        "timestamp": int(time.time() * 1000),
                        "taskId": task_id,
                    },
                )

                # Attach step id to message metadata so runtime/message service can log.
                from elizaos.types.memory import CustomMetadata, MemoryType

                message.metadata = CustomMetadata(type=MemoryType.MESSAGE.value, trajectoryStepId=step_id)
            except Exception:
                traj_id = None
                step_id = None

        result = await message_service.handle_message(
            runtime,
            message,
            capture_callback,
        )

        # Process through the message service (FULL CANONICAL AGENT LOOP)
        # This calls:
        # 1. compose_state() -> runs all providers including CONTEXT_BENCH
        # 2. use_model() with MESSAGE_HANDLER_TEMPLATE
        # 3. process_actions() -> executes REPLY (or other actions agent chooses)
        # 4. evaluate() -> runs all evaluators including CONTEXT_BENCH_EVALUATOR
        message_service = runtime.message_service
        if message_service is None:
            raise RuntimeError("Runtime has no message_service configured")

        # The evaluator should have recorded the evaluation
        evaluation = session.get_evaluation()

        if evaluation is None:
            # Fallback: create evaluation from result
            response_text = ""
            if result.response_content and result.response_content.text:
                response_text = result.response_content.text

            # Import evaluator and evaluate manually
            from elizaos_context_bench.evaluators.retrieval import RetrievalEvaluator

            evaluator = RetrievalEvaluator()
            eval_results = evaluator.evaluate(
                predicted=response_text,
                expected=expected_answer,
                needle=needle if needle else None,
            )

            evaluation = BenchmarkEvaluation(
                task_id=task_id,
                predicted_answer=response_text,
                expected_answer=expected_answer,
                exact_match=bool(eval_results.get("exact_match", False)),
                contains_answer=bool(eval_results.get("contains_answer", False)),
                semantic_similarity=float(eval_results.get("semantic_similarity", 0.0)),
                retrieval_success=bool(eval_results.get("retrieval_success", False)),
                latency_ms=session.get_latency_ms(),
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
        # Finalize trajectory if the runtime service exists
        try:
            if traj_svc is not None and traj_id is not None and step_id is not None:
                ev = session.get_evaluation()
                # Mark the step as completed with a summary action
                if hasattr(traj_svc, "complete_step"):
                    traj_svc.complete_step(  # type: ignore[call-arg]
                        trajectory_id=traj_id,
                        step_id=step_id,
                        action_type="reply",
                        action_name="REPLY",
                        parameters={},
                        success=bool(ev.retrieval_success) if ev else False,
                        reward=1.0 if ev and ev.retrieval_success else 0.0,
                        error=ev.error if ev else None,
                    )
                if hasattr(traj_svc, "end_trajectory"):
                    await traj_svc.end_trajectory(  # type: ignore[call-arg]
                        trajectory_id=traj_id,
                        status="completed" if ev and ev.retrieval_success else "error",
                        final_metrics={
                            "retrievalSuccess": bool(ev.retrieval_success),
                            "exactMatch": bool(ev.exact_match),
                            "semanticSimilarity": float(ev.semantic_similarity),
                        }
                        if ev
                        else None,
                    )
                if trajectory_collector is not None and hasattr(traj_svc, "get_active_trajectory"):
                    traj = traj_svc.get_active_trajectory(traj_id)  # type: ignore[call-arg]
                    if traj is not None:
                        trajectory_collector.append(traj)
        except Exception:
            pass


async def setup_benchmark_runtime(
    model_plugin: Plugin | None = None,
) -> "IAgentRuntime":
    """Set up an Eliza runtime configured for benchmarking.

    This creates a runtime with:
    - basicCapabilities enabled (default) - loads bootstrap plugin
    - Model plugin registered (e.g., OpenAI)
    - Database adapter (localdb for in-memory storage)
    - Context bench plugin registered
    - Custom messageHandlerTemplate optimized for Q&A retrieval

    Args:
        model_plugin: Optional model plugin (e.g., OpenAI plugin).

    Returns:
        Configured runtime ready for benchmarking.

    """
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character

    # Custom message handler template optimized for benchmark Q&A
    # This focuses on answering questions from context rather than conversation
    benchmark_message_handler_template = """<task>Plan the next action for {{agentName}} to answer the user's question.</task>

<providers>
{{providers}}
</providers>

<instructions>
You are {{agentName}}, a precise assistant that answers questions based ONLY on the provided context.

CRITICAL RULES:
1. Do NOT answer directly in this step.
2. Select the correct action(s) to produce the final answer.
3. You MUST include the provider CONTEXT_BENCH so the REPLY action has the benchmark context.
4. Use the REPLY action to produce the final user-visible answer.

If you cannot find the answer in the context, say "Information not found in context."
</instructions>

<output>
Respond using XML format like this:
<response>
    <thought>What information is being asked for and which provider(s) are needed</thought>
    <actions>REPLY</actions>
    <providers>CONTEXT_BENCH</providers>
    <text></text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.
</output>"""

    # Custom reply template optimized for benchmark Q&A.
    # This is used by the bootstrap REPLY action and MUST include the question.
    benchmark_reply_template = """# Task: Answer the benchmark question for the character {{agentName}}.

{{providers}}

# Benchmark Question:
{{benchmark_question}}

# Instructions:
- Answer based ONLY on the Benchmark Context above.
- Return ONLY the answer (no extra words).

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

Respond using XML format like this:
<response>
    <thought>Where I found the answer</thought>
    <text>Your answer here</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above."""

    # Create a benchmark-focused character with custom template
    # NOTE: We do NOT set disable_basic_capabilities - bootstrap loads by default
    character = Character(
        name="BenchmarkAgent",
        bio="An agent specialized in precise information retrieval and question answering.",
        system=(
            "You are a precise assistant that answers questions based ONLY on "
            "provided context. Always give brief, accurate answers. "
            "Do not add extra explanation - just return the answer."
        ),
        templates={
            "messageHandlerTemplate": benchmark_message_handler_template,
            "replyTemplate": benchmark_reply_template,
        },
    )

    # Collect plugins - model plugin first, then others
    plugins: list[Plugin] = []
    if model_plugin is not None:
        plugins.append(model_plugin)
    # Trajectory logger plugin (for end-to-end capture + ART export)
    try:
        from elizaos_plugin_trajectory_logger import get_trajectory_logger_plugin

        plugins.append(get_trajectory_logger_plugin())
    except Exception:
        # Never fail benchmark runtime setup if logger isn't available
        pass

    # Create runtime with benchmark character
    # basicCapabilities is enabled by default (loads bootstrap with REPLY, etc.)
    runtime = AgentRuntime(
        character=character,
        plugins=plugins,
        # No adapter required; message persistence is skipped in benchmark mode.
        # DO NOT set disable_basic_capabilities=True
        # We want the full bootstrap: REPLY action, CHARACTER provider, etc.
    )

    # Initialize runtime (this loads bootstrap + model plugins)
    await runtime.initialize()

    # Register the context bench plugin
    bench_plugin = get_context_bench_plugin()
    await runtime.register_plugin(bench_plugin)

    return runtime
