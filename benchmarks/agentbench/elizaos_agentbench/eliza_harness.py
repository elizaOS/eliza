"""
Full ElizaOS Agent Harness for AgentBench.

This module provides a CANONICAL ElizaOS integration that uses the FULL pipeline:
- message_service.handle_message() for processing (NO BYPASS)
- Provider context gathering (compose_state)
- Action selection via MESSAGE_HANDLER_TEMPLATE
- Action execution via runtime.process_actions()
- Evaluator execution via runtime.evaluate()
- Proper Memory objects and conversation history

This is the correct way to integrate with ElizaOS - no shortcuts or bypasses.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Protocol, runtime_checkable

from uuid6 import uuid7

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types import Action, Memory, Provider, ProviderResult
    from elizaos.types.memory import MessageMetadata

from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchResult,
    AgentBenchTask,
    ObservationType,
    StepRecord,
)

logger = logging.getLogger(__name__)

JsonScalar = str | int | float | bool | None
TrajectoryFinalStatus = Literal["completed", "terminated", "error", "timeout"]


@runtime_checkable
class SupportsTrajectoryLogger(Protocol):
    def start_trajectory(
        self,
        agent_id: str,
        *,
        scenario_id: str | None = None,
        episode_id: str | None = None,
        batch_id: str | None = None,
        group_index: int | None = None,
        metadata: dict[str, JsonScalar] | None = None,
    ) -> str: ...

    def start_step(
        self,
        trajectory_id: str,
        *,
        timestamp_ms: int | None = None,
        agent_balance: float = 0.0,
        agent_points: float = 0.0,
        agent_pnl: float = 0.0,
        open_positions: int = 0,
        custom: dict[str, JsonScalar] | None = None,
    ) -> str: ...

    def complete_step(
        self,
        *,
        trajectory_id: str,
        step_id: str,
        action_type: str,
        action_name: str,
        parameters: dict[str, JsonScalar],
        success: bool,
        reward: float | None = None,
        done: bool = False,
        error: str | None = None,
        result: dict[str, JsonScalar] | None = None,
        reasoning: str | None = None,
        llm_call_id: str | None = None,
    ) -> None: ...

    async def end_trajectory(
        self,
        trajectory_id: str,
        status: TrajectoryFinalStatus,
        final_metrics: dict[str, JsonScalar] | None = None,
    ) -> None: ...


def _sanitize_observation_for_trajectory(
    *, observation: ObservationType, environment: str, step_number: int
) -> dict[str, JsonScalar]:
    custom: dict[str, JsonScalar] = {"environment": environment, "stepNumber": step_number}
    for k, v in observation.items():
        if isinstance(v, (str, int, float, bool)) or v is None:
            custom[k] = v
        else:
            # Keep it JSON-ish and bounded
            custom[k] = str(v)[:2000]
    return custom


def _build_agentbench_message_metadata(
    *,
    trajectory_id: str | None,
    step_id: str | None,
    task_id: str,
    environment: str,
) -> "MessageMetadata | None":
    # Only attach metadata when trajectory logging is enabled.
    if not trajectory_id and not step_id:
        return None

    from elizaos import MemoryType, MessageMetadata

    meta = MessageMetadata(type=MemoryType.MESSAGE, source="agentbench")
    # MessageMetadata is pydantic(extra=allow) so these are safe
    setattr(meta, "trajectoryId", trajectory_id)
    setattr(meta, "trajectoryStepId", step_id)
    setattr(meta, "taskId", task_id)
    setattr(meta, "environment", environment)
    return meta


# =============================================================================
# In-Memory Database Adapter for Benchmarks
# =============================================================================


class BenchmarkDatabaseAdapter:
    """
    Minimal in-memory database adapter for benchmark execution.

    This adapter provides the minimum functionality needed for the message
    service to work without requiring a full SQL database setup.

    All data is stored in memory and cleared between tasks.
    """

    def __init__(self) -> None:
        self._memories: dict[str, dict[str, list]] = {}  # table_name -> id -> memory
        self._rooms: dict[str, dict] = {}
        self._entities: dict[str, dict] = {}
        self._participants: dict[str, set[str]] = {}  # room_id -> set of entity_ids
        self._initialized = False

    @property
    def db(self) -> "BenchmarkDatabaseAdapter":
        """Return self for compatibility."""
        return self

    async def initialize(self, config: dict | None = None) -> None:
        """Initialize the adapter."""
        self._initialized = True

    async def init(self) -> None:
        """Initialize schema (no-op for in-memory)."""
        pass

    async def is_ready(self) -> bool:
        """Check if adapter is ready."""
        return self._initialized

    async def close(self) -> None:
        """Close the adapter."""
        self.clear()
        self._initialized = False

    async def get_connection(self) -> "BenchmarkDatabaseAdapter":
        """Return self as connection."""
        return self

    def clear(self) -> None:
        """Clear all stored data."""
        self._memories.clear()
        self._rooms.clear()
        self._entities.clear()
        self._participants.clear()

    # Memory operations
    async def create_memory(self, memory: "Memory", table_name: str, unique: bool = False) -> str:
        """Store a memory."""
        from elizaos.types.primitives import as_uuid

        if table_name not in self._memories:
            self._memories[table_name] = {}

        memory_id = str(memory.id) if memory.id else str(uuid7())
        self._memories[table_name][memory_id] = memory
        return as_uuid(memory_id)

    async def get_memory_by_id(self, memory_id: str) -> dict | None:
        """Get a memory by ID."""
        for table in self._memories.values():
            if str(memory_id) in table:
                return table[str(memory_id)]
        return None

    async def get_memories(self, params: dict) -> list:
        """Get memories matching params."""
        table_name = params.get("tableName", "messages")
        room_id = params.get("room_id")

        if table_name not in self._memories:
            return []

        results = []
        for memory in self._memories[table_name].values():
            if room_id and hasattr(memory, "room_id") and str(memory.room_id) != str(room_id):
                continue
            results.append(memory)

        # Sort by created_at if available
        results.sort(key=lambda m: getattr(m, "created_at", 0) or 0)

        # Apply limit
        limit = params.get("limit")
        if limit:
            results = results[-limit:]

        return results

    async def update_memory(self, memory: "Memory") -> bool:
        """Update a memory."""
        for table in self._memories.values():
            if str(memory.id) in table:
                table[str(memory.id)] = memory
                return True
        return False

    async def delete_memory(self, memory_id: str) -> None:
        """Delete a memory."""
        for table in self._memories.values():
            if str(memory_id) in table:
                del table[str(memory_id)]
                return

    # Room operations
    async def create_rooms(self, rooms: list) -> list[str]:
        """Create rooms."""
        ids = []
        for room in rooms:
            room_id = str(room.id) if hasattr(room, "id") and room.id else str(uuid7())
            self._rooms[room_id] = room
            ids.append(room_id)
        return ids

    async def get_rooms_by_ids(self, room_ids: list) -> list:
        """Get rooms by IDs."""
        return [self._rooms[str(rid)] for rid in room_ids if str(rid) in self._rooms]

    # Entity operations
    async def create_entities(self, entities: list) -> list[str]:
        """Create entities."""
        ids = []
        for entity in entities:
            entity_id = str(entity.id) if hasattr(entity, "id") and entity.id else str(uuid7())
            self._entities[entity_id] = entity
            ids.append(entity_id)
        return ids

    async def get_entities_by_ids(self, entity_ids: list) -> list:
        """Get entities by IDs."""
        return [self._entities[str(eid)] for eid in entity_ids if str(eid) in self._entities]

    # Participant operations
    async def add_participants_room(self, entity_ids: list, room_id: str) -> bool:
        """Add participants to a room."""
        room_key = str(room_id)
        if room_key not in self._participants:
            self._participants[room_key] = set()
        for eid in entity_ids:
            self._participants[room_key].add(str(eid))
        return True

    async def is_room_participant(self, room_id: str, entity_id: str) -> bool:
        """Check if entity is a room participant."""
        room_key = str(room_id)
        return room_key in self._participants and str(entity_id) in self._participants[room_key]

    # World operations (minimal)
    async def create_world(self, world: dict) -> str:
        """Create a world (no-op)."""
        return str(world.get("id", uuid7()))

    async def get_world(self, world_id: str) -> dict | None:
        """Get a world (returns None)."""
        return None

    # Agent operations (minimal)
    async def get_agent(self, agent_id: str) -> dict | None:
        """Get an agent (returns None)."""
        return None

    async def get_agents(self) -> list:
        """Get all agents (returns empty)."""
        return []

    async def create_agent(self, agent: dict) -> str:
        """Create an agent (no-op)."""
        return str(agent.get("id", uuid7()))

    async def update_agent(self, agent_id: str, agent: dict) -> bool:
        """Update an agent (no-op)."""
        return True

    async def delete_agent(self, agent_id: str) -> bool:
        """Delete an agent (no-op)."""
        return True

    # Cache operations (no-op)
    async def get_cache(self, key: str) -> str | None:
        """Get cache value."""
        return None

    async def set_cache(self, key: str, value: str) -> None:
        """Set cache value."""
        pass

    async def delete_cache(self, key: str) -> None:
        """Delete cache value."""
        pass

    # Other no-op operations
    async def ensure_embedding_dimension(self, dimension: int) -> None:
        """Set embedding dimension (no-op)."""
        pass

    async def log(self, params: dict) -> None:
        """Log (no-op)."""
        pass

    async def get_logs(self, params: dict) -> list:
        """Get logs (empty)."""
        return []


# =============================================================================
# Benchmark Context (shared state for current task)
# =============================================================================


@dataclass
class BenchmarkContext:
    """Context for the current benchmark task - shared with provider."""

    task: AgentBenchTask
    environment: AgentBenchEnvironment
    room_id: str = field(default_factory=lambda: str(uuid7()))
    user_id: str = field(default_factory=lambda: str(uuid7()))
    observations: list[ObservationType] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    step_records: list[StepRecord] = field(default_factory=list)
    current_observation: ObservationType = field(default_factory=dict)
    action_space: list[str] = field(default_factory=list)
    total_reward: float = 0.0
    done: bool = False
    error: str | None = None


# Global context for the current benchmark (accessible by provider)
_current_benchmark_context: BenchmarkContext | None = None


def get_current_benchmark_context() -> BenchmarkContext | None:
    """Get the current benchmark context (used by provider)."""
    return _current_benchmark_context


def set_current_benchmark_context(ctx: BenchmarkContext | None) -> None:
    """Set the current benchmark context."""
    global _current_benchmark_context
    _current_benchmark_context = ctx


# =============================================================================
# Benchmark Provider - Provides task context to the agent
# =============================================================================


def create_benchmark_provider() -> "Provider":
    """Create a provider that gives benchmark context to the agent."""
    from elizaos.types import Provider, ProviderResult

    async def get_benchmark_context(
        runtime: "AgentRuntime",
        message: "Memory",
        state: object | None = None,
    ) -> "ProviderResult":
        """Provide benchmark task context to the agent."""
        import json

        ctx = get_current_benchmark_context()
        if not ctx:
            return ProviderResult(
                text="No benchmark task active.",
                values={"hasBenchmark": False},
                data={},
            )

        # Format observation as readable text
        obs_text = ""
        if ctx.current_observation:
            obs = ctx.current_observation

            # Handle different observation types for better readability
            if isinstance(obs, dict):
                # Web shopping: format search results nicely
                if obs.get("page") == "search_results" and "results" in obs:
                    results = obs.get("results", [])
                    obs_text = f"Page: search_results\n"
                    obs_text += f"Query: {obs.get('query', '')}\n"
                    obs_text += f"Found {len(results)} products:\n"
                    for p in results[:5]:  # Show first 5
                        obs_text += f"  - ID: {p['id']}, Name: {p['name']}, Price: {p['price']}\n"
                    obs_text += "\n**Next step: click[PRODUCT_ID] to view product details**"
                elif obs.get("page") == "product_detail" and "product" in obs:
                    product = obs.get("product", {})
                    obs_text = f"Page: product_detail\n"
                    obs_text += f"Product: {product.get('name', 'Unknown')}\n"
                    obs_text += f"Price: {product.get('price', 'Unknown')}\n"
                    obs_text += f"ID: {product.get('id', 'Unknown')}\n"
                    cart = obs.get("cart_count", 0)
                    obs_text += f"Cart items: {cart}\n"
                    if cart == 0:
                        obs_text += "\n**Next step: add_to_cart to add this item**"
                    else:
                        obs_text += "\n**Next step: checkout to complete purchase**"
                elif obs.get("error"):
                    obs_text = f"Error: {obs.get('error')}\n"
                    obs_text += f"Message: {obs.get('message', '')}\n"
                    obs_text += "\n**Go back and try a different action**"
                else:
                    # Generic dict formatting
                    obs_text = json.dumps(obs, indent=2, default=str)
            else:
                obs_text = str(obs)

        # Format action space
        action_space_text = ", ".join(ctx.action_space) if ctx.action_space else "Not specified"

        # Environment-specific workflow hints
        workflow_hint = ""
        if ctx.environment.value == "web_shopping":
            workflow_hint = """
## Workflow (Web Shopping)
1. search[query] - Find products
2. click[PRODUCT_ID] - View product details (use ID from search results!)
3. add_to_cart - Add the viewed product
4. checkout - Complete purchase
"""

        # Build context text
        text = f"""# Benchmark Task
**Environment:** {ctx.environment.value}
**Task ID:** {ctx.task.id}
**Goal:** {ctx.task.goal}

## Task Description
{ctx.task.description}
{workflow_hint}
## Current State
{obs_text or "(No observation yet)"}

## Available Actions
{action_space_text}

## Progress
- Steps taken: {len(ctx.actions)}
- Total reward: {ctx.total_reward:.2f}
- Done: {ctx.done}

## Instructions
You are executing a benchmark task. Analyze the current state and decide what action to take.
Output your action using the BENCHMARK_ACTION action with the appropriate command.

Your response MUST include:
- <actions>BENCHMARK_ACTION</actions>
- <params><BENCHMARK_ACTION><command>your_action_here</command></BENCHMARK_ACTION></params>
"""

        return ProviderResult(
            text=text,
            values={
                "hasBenchmark": True,
                "taskId": ctx.task.id,
                "environment": ctx.environment.value,
                "stepCount": len(ctx.actions),
                "totalReward": ctx.total_reward,
                "isDone": ctx.done,
            },
            data={
                "task": {
                    "id": ctx.task.id,
                    "description": ctx.task.description,
                    "goal": ctx.task.goal,
                },
                "observation": ctx.current_observation,
                "actionSpace": ctx.action_space,
            },
        )

    return Provider(
        name="BENCHMARK",
        description="Provides benchmark task context, current observation, and available actions",
        get=get_benchmark_context,
        dynamic=True,
        position=-10,  # High priority - appears first
    )


# =============================================================================
# Benchmark Action - Executes environment commands
# =============================================================================


# Global callback for action execution (set by harness)
_action_callback: object | None = None


def set_action_callback(callback: object | None) -> None:
    """Set the callback for benchmark action execution."""
    global _action_callback
    _action_callback = callback


def get_action_callback() -> object | None:
    """Get the current action callback."""
    return _action_callback


def create_benchmark_action() -> "Action":
    """Create the BENCHMARK_ACTION action that executes environment commands."""
    from elizaos.types import Action, ActionParameterSchema, ActionParameter, ActionResult, HandlerOptions

    async def validate(
        runtime: "AgentRuntime",
        message: "Memory",
        state: object | None = None,
    ) -> bool:
        """Always valid when benchmark is active."""
        return get_current_benchmark_context() is not None

    async def handler(
        runtime: "AgentRuntime",
        message: "Memory",
        state: object | None = None,
        options: "HandlerOptions | None" = None,
        callback: object | None = None,
        responses: list | None = None,
    ) -> "ActionResult":
        """Execute the benchmark action command."""
        ctx = get_current_benchmark_context()
        if not ctx:
            return ActionResult(
                text="No benchmark task active",
                success=False,
                error="No benchmark context",
            )

        # Get command from parameters
        command = ""
        if options and options.parameters:
            command = options.parameters.get("command", "")

        if not command:
            return ActionResult(
                text="No command provided",
                success=False,
                error="Missing 'command' parameter",
            )

        # Store the action for later execution by the harness
        ctx.actions.append(command)

        runtime.logger.info(f"[BENCHMARK_ACTION] Queued action: {command}")

        return ActionResult(
            text=f"Queued benchmark action: {command}",
            values={"command": command},
            data={"actionName": "BENCHMARK_ACTION", "command": command},
            success=True,
        )

    return Action(
        name="BENCHMARK_ACTION",
        similes=[
            # Generic
            "EXECUTE", "DO", "ACT", "PERFORM", "RUN", "COMMAND",
            # WebShop-style
            "SEARCH", "CLICK", "ADD_TO_CART", "CHECKOUT", "BUY", "SELECT",
            # Lateral thinking / Q&A
            "ASK", "GUESS", "ANSWER", "QUERY", "THINK",
            # Knowledge graph
            "GET_ENTITY", "FIND_RELATIONS", "GET_RELATION",
            # OS / terminal
            "LS", "CD", "MKDIR", "CAT", "ECHO", "SHELL",
            # Database
            "SQL", "SELECT", "INSERT", "UPDATE", "DELETE",
        ],
        description=(
            "Execute a benchmark environment action. This is the ONLY action for benchmark tasks. "
            "Put your command in the 'command' parameter. Examples: "
            "search[laptop], click[42], ask[Is it alive?], guess[The answer], ls, SELECT * FROM users"
        ),
        validate=validate,
        handler=handler,
        parameters=[
            ActionParameter(
                name="command",
                description="The action command to execute in the benchmark environment",
                required=True,
                schema=ActionParameterSchema(
                    type="string",
                    description="Environment-specific action command",
                ),
            ),
        ],
    )


# =============================================================================
# Benchmark Plugin - Registers provider and action
# =============================================================================


def create_benchmark_plugin() -> "Plugin":
    """Create the benchmark plugin with provider and action."""
    from elizaos.types import Plugin

    benchmark_provider = create_benchmark_provider()
    benchmark_action = create_benchmark_action()

    async def init(config: dict, runtime: "AgentRuntime") -> None:
        """Initialize the benchmark plugin."""
        runtime.logger.info(
            "AgentBench plugin initialized",
            agent_id=runtime.agent_id,
            src="plugin:agentbench",
        )

    return Plugin(
        name="agentbench",
        description="AgentBench benchmark integration - provides task context and action execution",
        providers=[benchmark_provider],
        actions=[benchmark_action],
        init=init,
    )


# =============================================================================
# ElizaOS Agent Harness - Full Canonical Flow
# =============================================================================


class ElizaAgentHarness:
    """
    Full ElizaOS agent harness for running AgentBench evaluations.

    This harness uses the CANONICAL ElizaOS message processing pipeline:
    1. Creates Memory objects for each turn
    2. Calls message_service.handle_message() for FULL processing
    3. Provider context is gathered via compose_state()
    4. Actions are selected by the LLM via MESSAGE_HANDLER_TEMPLATE
    5. Actions are executed via runtime.process_actions()
    6. Evaluators are run via runtime.evaluate()
    7. Message history is preserved
    8. (Optional) Trajectory logging for RL training

    NO BYPASS - This is the real ElizaOS flow.
    """

    def __init__(self, runtime: "AgentRuntime") -> None:
        """
        Initialize the harness with a fully configured ElizaOS runtime.

        Args:
            runtime: Initialized AgentRuntime with plugins loaded.
        """
        self._runtime = runtime
        self._context: BenchmarkContext | None = None

    @property
    def runtime(self) -> "AgentRuntime":
        """Get the ElizaOS runtime."""
        return self._runtime

    def _get_trajectory_logger(self) -> "SupportsTrajectoryLogger | None":
        svc = self._runtime.get_service("trajectory_logger")
        if isinstance(svc, SupportsTrajectoryLogger):
            return svc
        return None

    async def run_task(
        self,
        task: AgentBenchTask,
        adapter: "EnvironmentAdapterProtocol",
    ) -> AgentBenchResult:
        """
        Run a single benchmark task through the FULL ElizaOS pipeline.

        This method:
        1. Resets the environment to get initial observation
        2. Sets up benchmark context (available to BENCHMARK provider)
        3. Creates a Memory with the user's perspective of the task
        4. Calls message_service.handle_message() for FULL canonical processing
        5. The LLM selects BENCHMARK_ACTION with appropriate command
        6. We extract the command and execute it in the environment
        7. Repeats until done or max_steps reached
        8. Evaluates success

        Args:
            task: The benchmark task to run.
            adapter: Environment adapter for the task.

        Returns:
            AgentBenchResult with success status, actions, metrics.
        """
        from elizaos import ChannelType, Content, Memory
        from elizaos.types.primitives import as_uuid

        start_time = time.time()

        # Create benchmark context with unique IDs for this task
        self._context = BenchmarkContext(
            task=task,
            environment=adapter.environment,
            action_space=adapter.get_action_space(),
        )
        set_current_benchmark_context(self._context)

        actions: list[str] = []
        step_records: list[StepRecord] = []
        total_reward = 0.0
        error: str | None = None
        success = False
        trajectory_id: str | None = None

        traj_logger = self._get_trajectory_logger()
        if traj_logger:
            trajectory_id = traj_logger.start_trajectory(
                agent_id=str(self._runtime.agent_id),
                scenario_id=f"agentbench:{adapter.environment.value}",
                episode_id=task.id,
                metadata={
                    "agentName": str(getattr(self._runtime.character, "name", "Agent")),
                    "goalDescription": task.goal,
                    "environment": adapter.environment.value,
                    "taskId": task.id,
                },
            )

        try:
            # Validate task
            if not task.id:
                raise ValueError("Task ID cannot be empty")
            if task.max_steps <= 0:
                raise ValueError(f"max_steps must be positive, got {task.max_steps}")

            # Reset environment to get initial observation
            observation = await adapter.reset(task)
            self._context.current_observation = observation
            self._context.action_space = adapter.get_action_space()

            # Convert room_id and user_id to UUID format
            room_id = as_uuid(self._context.room_id)
            user_id = as_uuid(self._context.user_id)

            done = False
            step_num = 0

            while not done and step_num < task.max_steps:
                step_start = time.time()

                # Clear the runtime's state cache to get fresh provider context
                if hasattr(self._runtime, "_state_cache"):
                    self._runtime._state_cache.clear()

                # Clear previously queued actions
                self._context.actions = []

                # Create a Memory asking the agent to take the next action
                # The BENCHMARK provider will inject the full task context
                user_prompt = f"Continue with the benchmark task. Current step: {step_num + 1}/{task.max_steps}"
                if step_num == 0:
                    user_prompt = f"Start the benchmark task: {task.goal}"

                # Start a trajectory step (if enabled) and attach IDs to message metadata
                step_id: str | None = None
                if traj_logger and trajectory_id:
                    step_id = traj_logger.start_step(
                        trajectory_id,
                        agent_balance=total_reward,
                        agent_points=total_reward,
                        custom=_sanitize_observation_for_trajectory(
                            observation=observation,
                            environment=adapter.environment.value,
                            step_number=step_num,
                        ),
                    )

                message = Memory(
                    entity_id=user_id,
                    room_id=room_id,
                    content=Content(
                        text=user_prompt,
                        source="agentbench",
                        channel_type="API",
                    ),
                    metadata=_build_agentbench_message_metadata(
                        trajectory_id=trajectory_id,
                        step_id=step_id,
                        task_id=task.id,
                        environment=adapter.environment.value,
                    ),
                )

                # =====================================================
                # CANONICAL FLOW: Use message_service.handle_message()
                # This runs the FULL ElizaOS pipeline:
                # - Saves message to memory
                # - Composes state from ALL providers (including BENCHMARK)
                # - Uses MESSAGE_HANDLER_TEMPLATE for LLM response
                # - Parses actions from XML response
                # - Runs process_actions() to execute actions
                # - Runs evaluate() to run evaluators
                # =====================================================
                result = await self._runtime.message_service.handle_message(
                    self._runtime,
                    message,
                )

                # Extract the action command from what was queued by BENCHMARK_ACTION
                action = "think"  # Default if no action was queued
                if self._context.actions:
                    action = self._context.actions[0]
                else:
                    # Try to parse action from response text as fallback
                    if result.response_content and result.response_content.text:
                        parsed_action = adapter.parse_action(result.response_content.text)
                        if parsed_action:
                            action = parsed_action

                actions.append(action)

                # Execute the action in the environment
                observation, reward, done, info = await adapter.step(action)
                total_reward += reward
                self._context.current_observation = observation
                self._context.total_reward = total_reward
                self._context.done = done

                # Record step with sanitized metadata
                step_metadata: dict[str, str | int | float | bool | None] = {}
                for k, v in info.items():
                    if isinstance(v, (str, int, float, bool, type(None))):
                        step_metadata[k] = v
                    else:
                        step_metadata[k] = str(v)

                step_record = StepRecord(
                    step_number=step_num,
                    action=action,
                    observation=str(observation),
                    reward=reward,
                    timestamp_ms=(time.time() - step_start) * 1000,
                    metadata=step_metadata,
                )
                step_records.append(step_record)

                # Complete trajectory step with environment outcome (if enabled)
                if traj_logger and trajectory_id and step_id:
                    traj_logger.complete_step(
                        trajectory_id=trajectory_id,
                        step_id=step_id,
                        action_type="BENCHMARK_ACTION",
                        action_name="BENCHMARK_ACTION",
                        parameters={"command": action},
                        success=True,
                        reward=reward,
                        done=done,
                        result={
                            "done": bool(done),
                            "reward": float(reward),
                            "environment": adapter.environment.value,
                        },
                        reasoning=(result.response_content.thought if result.response_content else None),
                    )

                step_num += 1

                # Check timeout
                elapsed_ms = (time.time() - start_time) * 1000
                if elapsed_ms > task.timeout_ms:
                    error = f"Task timed out after {elapsed_ms:.0f}ms"
                    break

                # Early success check
                if not done:
                    try:
                        if await adapter.evaluate(task, actions):
                            success = True
                            done = True
                            break
                    except Exception as eval_err:
                        error = f"Evaluation error: {eval_err}"
                        break

            # Final evaluation if not already successful
            if not success:
                success = await adapter.evaluate(task, actions)

        except Exception as e:
            error = str(e)
            logger.error(f"[{adapter.environment.value}] Task {task.id} failed: {e}")

        finally:
            # Clean up context
            set_current_benchmark_context(None)
            self._context = None

        duration_ms = (time.time() - start_time) * 1000

        benchmark_result = AgentBenchResult(
            task_id=task.id,
            environment=adapter.environment,
            success=success,
            steps_taken=len(actions),
            actions=actions,
            final_state=step_records[-1].observation if step_records else {},
            duration_ms=duration_ms,
            error=error,
            metrics={
                "planning_time_ms": 0.0,
                "execution_time_ms": duration_ms,
                "tokens_used": 0.0,
                "reward": total_reward,
                "efficiency": total_reward / max(len(actions), 1),
            },
            step_records=step_records,
        )

        # End trajectory (if enabled)
        if traj_logger and trajectory_id:
            status: TrajectoryFinalStatus = "completed" if success else "terminated"
            if benchmark_result.error:
                status = "error"
            if benchmark_result.error and "timed out" in benchmark_result.error.lower():
                status = "timeout"
            await traj_logger.end_trajectory(
                trajectory_id,
                status=status,
                final_metrics={
                    "success": bool(success),
                    "stepsTaken": int(benchmark_result.steps_taken),
                    "durationMs": int(benchmark_result.duration_ms),
                    "totalReward": float(total_reward),
                },
            )

        return benchmark_result

    async def clear_conversation(self) -> None:
        """Clear conversation state for a fresh start."""
        set_current_benchmark_context(None)
        self._context = None
        # Clear the runtime's state cache
        if hasattr(self._runtime, "_state_cache"):
            self._runtime._state_cache.clear()


class EnvironmentAdapterProtocol:
    """Protocol for environment adapters compatible with the harness."""

    environment: AgentBenchEnvironment

    async def reset(self, task: AgentBenchTask) -> ObservationType:
        """Reset environment for a new task."""
        ...

    async def step(
        self, action: str
    ) -> tuple[ObservationType, float, bool, dict[str, str | int | float | bool | None]]:
        """Execute an action and return result."""
        ...

    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool:
        """Evaluate task success."""
        ...

    def format_prompt(self, task: AgentBenchTask, observation: ObservationType) -> str:
        """Format observation into a prompt."""
        ...

    def parse_action(self, response: str) -> str:
        """Parse action from response."""
        ...

    def get_action_space(self) -> list[str]:
        """Get available actions."""
        ...


def create_benchmark_character(name: str = "BenchmarkAgent") -> "Character":
    """
    Create a character optimized for benchmark tasks.

    This character has:
    - A system prompt designed for agentic task execution
    - A custom messageHandlerTemplate that instructs using BENCHMARK_ACTION
    """
    from elizaos import Character

    # Custom message handler template for benchmark execution
    # This guides the model to use BENCHMARK_ACTION instead of conversational actions
    benchmark_handler_template = """<task>Execute the benchmark task for {{agentName}}.</task>

<providers>
{{providers}}
</providers>

<critical_instructions>
You are {{agentName}}, an AI agent executing a benchmark task.

STEP 1: Find the "# Benchmark Task" section in the providers above. Read:
- The task goal
- Current state/observation
- Available actions (e.g., search[query], click[id], ask[question], guess[answer])

STEP 2: Choose ONE action from the available actions list.

STEP 3: Use EXACTLY this response format - NO EXCEPTIONS:

<response>
<thought>I will [action] because [reason]</thought>
<actions>BENCHMARK_ACTION</actions>
<text>[Brief status message]</text>
<params>
<BENCHMARK_ACTION>
<command>[YOUR CHOSEN ACTION HERE - e.g., search[laptop], click[42], ask[Is it alive?]]</command>
</BENCHMARK_ACTION>
</params>
</response>

FORBIDDEN - NEVER DO THIS:
❌ <actions>search[laptop]</actions> - WRONG! search is not an action name
❌ <actions>click[42]</actions> - WRONG! click is not an action name
❌ <actions>ASK[question]</actions> - WRONG! ASK is not an action name
❌ <actions>ADD_TO_CART</actions> - WRONG! ADD_TO_CART is not an action name
❌ <actions>REPLY</actions> - WRONG! REPLY is not for benchmarks
❌ <actions>REPLY,BENCHMARK_ACTION</actions> - WRONG! Only BENCHMARK_ACTION

CORRECT - ALWAYS DO THIS:
✅ <actions>BENCHMARK_ACTION</actions>
✅ <command>search[laptop]</command> in the params block
✅ <command>click[42]</command> in the params block
✅ <command>ask[Is it alive?]</command> in the params block
</critical_instructions>"""

    return Character(
        name=name,
        username=name.lower().replace(" ", "_"),
        bio=[
            "An expert AI agent specialized in solving complex tasks.",
            "Excels at following instructions precisely and executing actions step by step.",
        ],
        system="You are an AI agent. When given a benchmark task, analyze the state and execute the appropriate action using BENCHMARK_ACTION.",
        templates={
            "messageHandlerTemplate": benchmark_handler_template,
        },
        settings={
            "checkShouldRespond": False,  # Always respond in benchmark mode
        },
    )


async def create_benchmark_runtime(
    character: "Character | None" = None,
    plugins: "list | None" = None,
) -> "AgentRuntime":
    """
    Create and initialize an ElizaOS runtime for benchmarking.

    This sets up the runtime with:
    - Bootstrap plugin for basic capabilities (providers, actions, evaluators)
    - OpenAI plugin (or provided plugins) for model access
    - AgentBench plugin for benchmark-specific provider and action
    - Benchmark-optimized character
    - In-memory database adapter for message storage

    Args:
        character: Optional custom character. Defaults to benchmark character.
        plugins: Optional list of plugins. Defaults to [bootstrap, openai, agentbench].

    Returns:
        Initialized AgentRuntime ready for benchmark execution.
    """
    import os

    from elizaos.runtime import AgentRuntime
    from elizaos.bootstrap import bootstrap_plugin

    if character is None:
        character = create_benchmark_character()

    if plugins is None:
        plugins = [bootstrap_plugin]

        # Add OpenAI plugin if API key is available
        if os.environ.get("OPENAI_API_KEY"):
            try:
                from elizaos_plugin_openai import get_openai_plugin

                plugins.append(get_openai_plugin())
            except ImportError:
                logger.warning("OpenAI plugin not available")

    # Always add benchmark plugin
    plugins.append(create_benchmark_plugin())

    runtime = AgentRuntime(character=character, plugins=plugins)

    # Register in-memory database adapter for benchmarks
    db_adapter = BenchmarkDatabaseAdapter()
    await db_adapter.initialize()
    runtime.register_database_adapter(db_adapter)  # type: ignore[arg-type]

    await runtime.initialize()

    return runtime
