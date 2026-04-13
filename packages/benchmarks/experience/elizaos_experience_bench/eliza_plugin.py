"""Eliza Benchmark Plugin for Experience Bench.

This plugin provides canonical Eliza integration for benchmarking
the experience learning and retrieval pipeline:
- EXPERIENCE_CONTEXT provider: Injects relevant past experiences into agent state
- RECORD_EXPERIENCE action: Records a new experience from the current interaction
- QUERY_EXPERIENCE action: Explicitly queries past experiences

The plugin is designed to work WITH bootstrap (basicCapabilities enabled),
using the canonical agent flow:
1. EXPERIENCE_CONTEXT provider injects past experiences
2. Agent processes message through MESSAGE_HANDLER_TEMPLATE
3. Agent decides to REPLY (bootstrap action) or RECORD_EXPERIENCE
4. BenchmarkExperienceEvaluator captures and scores the response

Usage:
    from elizaos.runtime import AgentRuntime
    from elizaos_plugin_openai import get_openai_plugin
    from elizaos_experience_bench.eliza_plugin import (
        get_experience_bench_plugin,
        ExperienceBenchSession,
        run_experience_task_through_agent,
    )

    runtime = AgentRuntime(plugins=[get_openai_plugin()])
    await runtime.initialize()

    plugin = get_experience_bench_plugin()
    await runtime.register_plugin(plugin)

    session = ExperienceBenchSession()
    result = await run_experience_task_through_agent(runtime, session, ...)
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
from elizaos.types.primitives import Content, string_to_uuid
from elizaos.types.state import State

if TYPE_CHECKING:
    from elizaos.types.components import HandlerCallback
    from elizaos.types.runtime import IAgentRuntime

import sys
from pathlib import Path

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[3] / "plugins" / "plugin-experience" / "python"),
)

from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import ExperienceQuery


# ============================================================================
# Benchmark Session - Stores task context and collects results
# ============================================================================


class ExperiencePhase:
    """Phase of the experience benchmark."""

    LEARNING = "learning"
    RETRIEVAL = "retrieval"


@dataclass
class ExperienceTaskContext:
    """Context for a single experience benchmark task."""

    task_id: str
    phase: str  # ExperiencePhase.LEARNING or ExperiencePhase.RETRIEVAL
    message_text: str
    # For learning phase: the experience to record
    expected_domain: str = ""
    expected_learning: str = ""
    # For retrieval phase: what experiences should be recalled
    expected_experience_keywords: list[str] = field(default_factory=list)
    metadata: dict[str, str | int | float | bool] = field(default_factory=dict)


@dataclass
class ExperienceEvaluation:
    """Evaluation results from the experience benchmark evaluator."""

    task_id: str
    phase: str
    response_text: str
    # Learning phase metrics
    experience_recorded: bool = False
    recorded_domain: str = ""
    recorded_learning: str = ""
    # Retrieval phase metrics
    experiences_retrieved: int = 0
    relevant_experience_found: bool = False
    keywords_in_response: bool = False
    # Timing
    latency_ms: float = 0.0
    error: str | None = None


class ExperienceBenchSession:
    """Session manager for experience benchmark tasks.

    Coordinates between the benchmark runner and the Eliza plugin,
    storing task context and collecting evaluation results.
    """

    def __init__(self) -> None:
        """Initialize experience benchmark session."""
        self._current_task: ExperienceTaskContext | None = None
        self._evaluation: ExperienceEvaluation | None = None
        self._start_time: float = 0.0
        self._response_text: str = ""
        self._experience_service: ExperienceService = ExperienceService()
        self._recorded_ids: list[str] = []

    @property
    def experience_service(self) -> ExperienceService:
        """Get the experience service backing this session."""
        return self._experience_service

    @property
    def recorded_ids(self) -> list[str]:
        """Get IDs of experiences recorded during this session."""
        return list(self._recorded_ids)

    def add_recorded_id(self, exp_id: str) -> None:
        """Track a recorded experience ID."""
        self._recorded_ids.append(exp_id)

    def set_task(
        self,
        task_id: str,
        phase: str,
        message_text: str,
        expected_domain: str = "",
        expected_learning: str = "",
        expected_experience_keywords: list[str] | None = None,
        metadata: dict[str, str | int | float | bool] | None = None,
    ) -> None:
        """Set the current benchmark task."""
        self._current_task = ExperienceTaskContext(
            task_id=task_id,
            phase=phase,
            message_text=message_text,
            expected_domain=expected_domain,
            expected_learning=expected_learning,
            expected_experience_keywords=expected_experience_keywords or [],
            metadata=metadata or {},
        )
        self._evaluation = None
        self._start_time = time.time()
        self._response_text = ""

    def get_task(self) -> ExperienceTaskContext | None:
        """Get the current task context."""
        return self._current_task

    def record_response(self, response: str) -> None:
        """Record the agent's response."""
        self._response_text = response

    def get_response(self) -> str:
        """Get the recorded response."""
        return self._response_text

    def record_evaluation(self, evaluation: ExperienceEvaluation) -> None:
        """Record evaluation results."""
        self._evaluation = evaluation

    def get_evaluation(self) -> ExperienceEvaluation | None:
        """Get evaluation results."""
        return self._evaluation

    def get_latency_ms(self) -> float:
        """Get latency since task was set."""
        return (time.time() - self._start_time) * 1000

    def clear_task(self) -> None:
        """Clear current task and evaluation (but NOT the experience service)."""
        self._current_task = None
        self._evaluation = None
        self._start_time = 0.0
        self._response_text = ""


# Global session instance
_global_session: ExperienceBenchSession | None = None


def get_experience_bench_session() -> ExperienceBenchSession:
    """Get the global experience benchmark session."""
    global _global_session  # noqa: PLW0603
    if _global_session is None:
        _global_session = ExperienceBenchSession()
    return _global_session


def set_experience_bench_session(session: ExperienceBenchSession) -> None:
    """Set the global experience benchmark session."""
    global _global_session  # noqa: PLW0603
    _global_session = session


# ============================================================================
# Provider: Injects relevant past experiences into agent state
# ============================================================================


async def experience_context_provider_get(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State,
) -> ProviderResult:
    """Provider that injects relevant past experiences into the agent's state.

    Queries the ExperienceService for experiences relevant to the current
    message and formats them for the agent's context.
    """
    _ = runtime
    _ = state

    session = get_experience_bench_session()
    task = session.get_task()

    if task is None:
        return ProviderResult(text="", values={}, data=None)

    # Get the message text to search for relevant experiences
    message_text = ""
    if message.content and message.content.text:
        message_text = str(message.content.text)
    if not message_text:
        message_text = task.message_text

    svc = session.experience_service

    if svc.experience_count == 0:
        return ProviderResult(
            text="# Past Experiences\nNo past experiences recorded yet.\n",
            values={"experience_count": 0},
            data={"experience_count": 0},
        )

    # Query for relevant experiences
    experiences = svc.query_experiences(
        ExperienceQuery(
            query=message_text,
            limit=5,
        )
    )

    if not experiences:
        return ProviderResult(
            text="# Past Experiences\nNo relevant past experiences found for this context.\n",
            values={"experience_count": svc.experience_count, "relevant_count": 0},
            data={"experience_count": svc.experience_count, "relevant_count": 0},
        )

    # Format experiences for the agent
    lines: list[str] = []
    for idx, exp in enumerate(experiences, start=1):
        lines.append(
            f"Experience {idx} ({exp.domain}):\n"
            f"  Context: {exp.context}\n"
            f"  Action: {exp.action}\n"
            f"  Result: {exp.result}\n"
            f"  Learning: {exp.learning}\n"
            f"  Confidence: {exp.confidence:.2f}"
        )

    context_text = (
        "# Relevant Past Experiences\n\n"
        "Use these past experiences to inform your response. "
        "Reference specific learnings when they are relevant.\n\n"
        + "\n\n".join(lines)
        + "\n"
    )

    return ProviderResult(
        text=context_text,
        values={
            "experience_count": svc.experience_count,
            "relevant_count": len(experiences),
            "benchmark_phase": task.phase,
        },
        data={
            "experience_count": svc.experience_count,
            "relevant_count": len(experiences),
            "experience_ids": [e.id for e in experiences],
        },
    )


experience_context_provider = Provider(
    name="EXPERIENCE_CONTEXT",
    description="Provides relevant past experiences from the ExperienceService",
    position=5,
    get=experience_context_provider_get,
)


# ============================================================================
# Action: Record Experience
# ============================================================================


async def record_experience_validate(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate whether the RECORD_EXPERIENCE action should run."""
    _ = runtime
    _ = state

    session = get_experience_bench_session()
    task = session.get_task()

    if task is None:
        return False

    # Allow recording during learning phase
    if task.phase == ExperiencePhase.LEARNING:
        return True

    # Also allow if message text suggests recording
    if message.content and message.content.text:
        text = str(message.content.text).lower()
        return "remember" in text or "record" in text or "learn" in text

    return False


async def record_experience_handler(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: "HandlerCallback | None" = None,
    responses: list[Memory] | None = None,
) -> ActionResult | None:
    """Handle the RECORD_EXPERIENCE action.

    Records the current interaction as an experience in the ExperienceService.
    """
    _ = state
    _ = options
    _ = responses

    session = get_experience_bench_session()
    task = session.get_task()

    if task is None:
        return ActionResult(success=False, error="No active benchmark task")

    message_text = ""
    if message.content and message.content.text:
        message_text = str(message.content.text)
    if not message_text:
        message_text = task.message_text

    svc = session.experience_service
    agent_id = str(runtime.agent_id)

    # Extract experience components from the message
    # In the learning phase, we use the task context to guide recording
    recorded = svc.record_experience(
        agent_id=agent_id,
        context=task.message_text,
        action="agent_interaction",
        result=message_text,
        learning=task.expected_learning if task.expected_learning else message_text,
        domain=task.expected_domain if task.expected_domain else "general",
        tags=[task.phase, task.expected_domain] if task.expected_domain else [task.phase],
        confidence=0.85,
        importance=0.8,
    )

    session.add_recorded_id(recorded.id)

    response_text = (
        f"I've recorded this experience. Learning: {recorded.learning} "
        f"(domain: {recorded.domain}, confidence: {recorded.confidence:.2f})"
    )

    if callback is not None:
        await callback(Content(text=response_text))

    return ActionResult(success=True, data={"experience_id": recorded.id})


record_experience_action = Action(
    name="RECORD_EXPERIENCE",
    description=(
        "Records a new learning experience from the current interaction. "
        "Use this when you learn something new or encounter a notable outcome."
    ),
    handler=record_experience_handler,
    validate=record_experience_validate,
    similes=["REMEMBER", "SAVE_EXPERIENCE", "NOTE_LEARNING"],
    examples=[],
)


# ============================================================================
# Action: Query Experience
# ============================================================================


async def query_experience_validate(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate whether the QUERY_EXPERIENCE action should run."""
    _ = runtime
    _ = state

    session = get_experience_bench_session()
    task = session.get_task()

    if task is None:
        return False

    # Allow querying during retrieval phase
    if task.phase == ExperiencePhase.RETRIEVAL:
        return True

    # Also allow if the message asks about past experience
    if message.content and message.content.text:
        text = str(message.content.text).lower()
        return (
            "recall" in text
            or "past experience" in text
            or "what did you learn" in text
            or "remember" in text
        )

    return False


async def query_experience_handler(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: "HandlerCallback | None" = None,
    responses: list[Memory] | None = None,
) -> ActionResult | None:
    """Handle the QUERY_EXPERIENCE action.

    Queries past experiences and returns the most relevant ones.
    """
    _ = state
    _ = options
    _ = responses

    session = get_experience_bench_session()
    task = session.get_task()

    if task is None:
        return ActionResult(success=False, error="No active benchmark task")

    message_text = ""
    if message.content and message.content.text:
        message_text = str(message.content.text)
    if not message_text:
        message_text = task.message_text

    svc = session.experience_service

    experiences = svc.query_experiences(
        ExperienceQuery(
            query=message_text,
            limit=5,
        )
    )

    if not experiences:
        response_text = "I don't have any relevant past experiences for this topic."
        if callback is not None:
            await callback(Content(text=response_text))
        return ActionResult(
            success=True,
            data={"retrieved_count": 0},
        )

    lines: list[str] = []
    for idx, exp in enumerate(experiences, start=1):
        lines.append(
            f"{idx}. [{exp.domain}] When {exp.context}, I learned: {exp.learning}"
        )

    response_text = (
        "Based on my past experiences, here's what I know:\n\n"
        + "\n".join(lines)
    )

    if callback is not None:
        await callback(Content(text=response_text))

    return ActionResult(
        success=True,
        data={
            "retrieved_count": len(experiences),
            "experience_ids": [e.id for e in experiences],
        },
    )


query_experience_action = Action(
    name="QUERY_EXPERIENCE",
    description=(
        "Queries past experiences to recall relevant learnings. "
        "Use this when asked about past experiences or when context suggests "
        "recalling prior knowledge would be helpful."
    ),
    handler=query_experience_handler,
    validate=query_experience_validate,
    similes=["RECALL_EXPERIENCE", "REMEMBER_PAST", "CHECK_EXPERIENCE"],
    examples=[],
)


# ============================================================================
# Evaluator: Assesses experience recording/retrieval after agent responds
# ============================================================================


async def experience_evaluator_validate(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None = None,
) -> bool:
    """Validate if the experience evaluator should run."""
    _ = runtime
    _ = message
    _ = state

    session = get_experience_bench_session()
    return session.get_task() is not None


async def experience_evaluator_handler(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None,
    options: HandlerOptions | None = None,
    callback: "HandlerCallback | None" = None,
    responses: list[Memory] | None = None,
) -> None:
    """Evaluate the experience benchmark response.

    Checks whether:
    - Learning phase: an experience was properly recorded
    - Retrieval phase: relevant experiences were found and referenced
    """
    _ = runtime
    _ = message
    _ = state
    _ = options
    _ = callback

    session = get_experience_bench_session()
    task = session.get_task()

    if task is None:
        return

    response_text = session.get_response().strip()

    if not response_text and responses:
        for response in responses:
            if response.content and response.content.text:
                response_text = str(response.content.text)
                break

    if task.phase == ExperiencePhase.LEARNING:
        # Check if an experience was recorded
        new_ids = session.recorded_ids
        experience_recorded = len(new_ids) > 0

        recorded_domain = ""
        recorded_learning = ""
        if experience_recorded:
            svc = session.experience_service
            # Get the most recently recorded experience
            for exp_id in reversed(new_ids):
                exp_data = svc._experiences.get(exp_id)
                if exp_data is not None:
                    recorded_domain = exp_data.domain
                    recorded_learning = exp_data.learning
                    break

        session.record_evaluation(
            ExperienceEvaluation(
                task_id=task.task_id,
                phase=task.phase,
                response_text=response_text,
                experience_recorded=experience_recorded,
                recorded_domain=recorded_domain,
                recorded_learning=recorded_learning,
                latency_ms=session.get_latency_ms(),
            )
        )

    elif task.phase == ExperiencePhase.RETRIEVAL:
        # Check if relevant experiences were found
        svc = session.experience_service
        query_results = svc.query_experiences(
            ExperienceQuery(query=task.message_text, limit=5)
        )
        experiences_retrieved = len(query_results)

        # Check if the response references expected keywords
        response_lower = response_text.lower()
        keywords_found = all(
            kw.lower() in response_lower for kw in task.expected_experience_keywords
        ) if task.expected_experience_keywords else False

        # Check if any relevant experience was retrieved
        relevant_found = False
        if task.expected_experience_keywords and query_results:
            for exp in query_results:
                exp_text = f"{exp.context} {exp.learning}".lower()
                if any(kw.lower() in exp_text for kw in task.expected_experience_keywords):
                    relevant_found = True
                    break

        session.record_evaluation(
            ExperienceEvaluation(
                task_id=task.task_id,
                phase=task.phase,
                response_text=response_text,
                experiences_retrieved=experiences_retrieved,
                relevant_experience_found=relevant_found,
                keywords_in_response=keywords_found,
                latency_ms=session.get_latency_ms(),
            )
        )


experience_evaluator = Evaluator(
    name="EXPERIENCE_BENCH_EVALUATOR",
    description="Evaluates experience recording and retrieval quality after agent responds",
    handler=experience_evaluator_handler,
    validate=experience_evaluator_validate,
    similes=["assess experience", "check experience recall"],
    always_run=True,
)


# ============================================================================
# Plugin Definition
# ============================================================================


def get_experience_bench_plugin() -> Plugin:
    """Get the experience benchmark plugin.

    Provides:
    - EXPERIENCE_CONTEXT provider: Injects relevant past experiences
    - RECORD_EXPERIENCE action: Records new experiences
    - QUERY_EXPERIENCE action: Queries past experiences
    - EXPERIENCE_BENCH_EVALUATOR: Evaluates response quality
    """
    return Plugin(
        name="experienceBench",
        description="Experience benchmarking plugin for evaluating experience learning and retrieval",
        providers=[experience_context_provider],
        actions=[record_experience_action, query_experience_action],
        evaluators=[experience_evaluator],
    )


# ============================================================================
# Message handler template for experience benchmark
# ============================================================================

EXPERIENCE_MESSAGE_TEMPLATE = """<task>Plan the next action for {{agentName}} based on the conversation and past experiences.</task>

<providers>
{{providers}}
</providers>

<instructions>
You are {{agentName}}, an agent that learns from experience and improves over time.

When receiving new information or encountering outcomes:
- Use RECORD_EXPERIENCE to save important learnings
- Always note what worked, what failed, and why

When asked questions or facing familiar problems:
- Use QUERY_EXPERIENCE or reference the Past Experiences provided above
- Apply relevant past learnings to inform your response
- Use the REPLY action to respond to the user

CRITICAL RULES:
1. During learning interactions: use RECORD_EXPERIENCE to save the learning, then REPLY.
2. During retrieval interactions: reference the Past Experiences context and REPLY.
3. Always include relevant past experience in your response when available.
</instructions>

<output>
Respond using XML format like this:
<response>
    <thought>What I know from past experience and what action to take</thought>
    <actions>RECORD_EXPERIENCE,REPLY</actions>
    <providers>EXPERIENCE_CONTEXT</providers>
    <text>Your response incorporating past experience</text>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above.
</output>"""


# ============================================================================
# High-level API for running benchmarks through the full agent loop
# ============================================================================


async def run_experience_task_through_agent(
    runtime: "IAgentRuntime",
    session: ExperienceBenchSession,
    task_id: str,
    phase: str,
    message_text: str,
    expected_domain: str = "",
    expected_learning: str = "",
    expected_experience_keywords: list[str] | None = None,
) -> ExperienceEvaluation:
    """Run a single experience benchmark task through the full Eliza agent loop.

    Exercises the CANONICAL Eliza flow:
    1. Sets up the benchmark session with task context
    2. Creates a message
    3. Processes through message_service.handle_message()
    4. Returns evaluation results
    """
    set_experience_bench_session(session)

    session.set_task(
        task_id=task_id,
        phase=phase,
        message_text=message_text,
        expected_domain=expected_domain,
        expected_learning=expected_learning,
        expected_experience_keywords=expected_experience_keywords,
    )

    # Clear state cache for fresh state per task
    runtime.state_cache.clear()

    room_id = string_to_uuid(f"experience-bench-room-{task_id}")
    entity_id = string_to_uuid("experience-bench-user")
    message_id = string_to_uuid(str(uuid.uuid4()))

    message = Memory(
        id=message_id,
        agent_id=runtime.agent_id,
        entity_id=entity_id,
        room_id=room_id,
        content=Content(text=message_text),
    )

    message_service = runtime.message_service
    if message_service is None:
        raise RuntimeError("Runtime has no message_service configured")

    try:

        async def capture_callback(content: Content) -> list[Memory]:
            if content.text:
                session.record_response(str(content.text))
            return []

        await message_service.handle_message(
            runtime,
            message,
            capture_callback,
        )

        evaluation = session.get_evaluation()

        if evaluation is None:
            # Fallback: create basic evaluation from response
            response_text = session.get_response()
            evaluation = ExperienceEvaluation(
                task_id=task_id,
                phase=phase,
                response_text=response_text,
                latency_ms=session.get_latency_ms(),
            )

        return evaluation

    except Exception as e:
        return ExperienceEvaluation(
            task_id=task_id,
            phase=phase,
            response_text="",
            latency_ms=session.get_latency_ms(),
            error=str(e),
        )


async def setup_experience_benchmark_runtime(
    model_plugin: Plugin | None = None,
) -> "IAgentRuntime":
    """Set up an Eliza runtime configured for experience benchmarking.

    Creates a runtime with:
    - basicCapabilities enabled (default) - loads bootstrap plugin
    - Model plugin registered (e.g., OpenAI)
    - Experience bench plugin registered
    - Custom messageHandlerTemplate for experience learning
    """
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character

    character = Character(
        name="ExperienceAgent",
        username="experience_agent",
        bio="An agent that learns from experience and improves over time",
        system=(
            "You are an agent that learns from past experiences. "
            "When asked questions, recall relevant past experiences and use them "
            "to inform your answers. When encountering new information or outcomes, "
            "record them as experiences for future reference."
        ),
        templates={
            "messageHandlerTemplate": EXPERIENCE_MESSAGE_TEMPLATE,
        },
    )

    plugins: list[Plugin] = []
    if model_plugin is not None:
        plugins.append(model_plugin)

    runtime = AgentRuntime(
        character=character,
        plugins=plugins,
    )

    await runtime.initialize()

    bench_plugin = get_experience_bench_plugin()
    await runtime.register_plugin(bench_plugin)

    return runtime
