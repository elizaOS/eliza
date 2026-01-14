"""
Dataset loader for Tau-bench.
"""

import json
import logging
from pathlib import Path
from typing import Any, Optional

from elizaos_tau_bench.types import (
    TauBenchTask,
    TauDomain,
    TaskDifficulty,
    ToolDefinition,
    ToolCall,
    PolicyConstraint,
)

logger = logging.getLogger(__name__)


class DataValidationError(Exception):
    """Raised when task data fails validation."""
    pass


class TauBenchDataset:
    """Loads and manages Tau-bench tasks."""

    def __init__(self, data_path: str) -> None:
        self.data_path = Path(data_path)
        self.tasks: list[TauBenchTask] = []
        self._loaded = False

    async def load(self) -> None:
        """Load Tau-bench tasks from JSON files."""
        if self._loaded:
            return

        self.tasks = []

        # Try to load from domain-specific directories
        for domain in TauDomain:
            domain_path = self.data_path / domain.value
            if domain_path.exists():
                await self._load_domain_tasks(domain_path, domain)

        # Also try to load from a single tasks.json file
        tasks_file = self.data_path / "tasks.json"
        if tasks_file.exists():
            await self._load_tasks_file(tasks_file)

        self._loaded = True
        logger.info(f"[TauBenchDataset] Loaded {len(self.tasks)} tasks")

    async def _load_domain_tasks(self, domain_path: Path, domain: TauDomain) -> None:
        """Load tasks from a domain directory."""
        for file_path in domain_path.glob("*.json"):
            try:
                with open(file_path) as f:
                    data = json.load(f)

                # Handle both single task and list of tasks
                if isinstance(data, list):
                    for task_data in data:
                        task = self._parse_task(task_data, domain)
                        self.tasks.append(task)
                else:
                    task = self._parse_task(data, domain)
                    self.tasks.append(task)

            except Exception as e:
                logger.warning(f"[TauBenchDataset] Failed to load {file_path}: {e}")

    async def _load_tasks_file(self, file_path: Path) -> None:
        """Load tasks from a single tasks.json file."""
        try:
            with open(file_path) as f:
                data = json.load(f)

            tasks_list = data.get("tasks", data) if isinstance(data, dict) else data

            for task_data in tasks_list:
                domain_str = task_data.get("domain", "retail")
                domain = TauDomain(domain_str)
                task = self._parse_task(task_data, domain)
                self.tasks.append(task)

        except Exception as e:
            logger.warning(f"[TauBenchDataset] Failed to load {file_path}: {e}")

    def _validate_task_data(self, data: dict[str, Any]) -> None:
        """Validate that task data has required fields."""
        # Check for task_id (required)
        task_id = data.get("task_id") or data.get("id")
        if not task_id:
            raise DataValidationError("Task must have 'task_id' or 'id' field")
        
        # Check for user_instruction (required)
        instruction = data.get("user_instruction") or data.get("instruction")
        if not instruction:
            raise DataValidationError(f"Task {task_id} must have 'user_instruction' field")
        
        # Validate tool definitions if present
        for i, tool in enumerate(data.get("available_tools", [])):
            if not isinstance(tool, dict):
                raise DataValidationError(f"Task {task_id}: tool {i} must be a dict")
            if "name" not in tool:
                raise DataValidationError(f"Task {task_id}: tool {i} must have 'name' field")
        
        # Validate expected_tool_calls if present
        for i, call in enumerate(data.get("expected_tool_calls", [])):
            if not isinstance(call, dict):
                raise DataValidationError(f"Task {task_id}: expected_tool_call {i} must be a dict")
            tool_name = call.get("tool_name") or call.get("name")
            if not tool_name:
                raise DataValidationError(
                    f"Task {task_id}: expected_tool_call {i} must have 'tool_name' or 'name'"
                )

    def _parse_task(self, data: dict[str, Any], domain: TauDomain) -> TauBenchTask:
        """Parse a task from JSON data."""
        # Validate required fields
        self._validate_task_data(data)
        
        # Parse tools
        tools: list[ToolDefinition] = []
        for t in data.get("available_tools", []):
            if not isinstance(t, dict):
                continue
            tools.append(
                ToolDefinition(
                    name=str(t.get("name", "")),
                    description=str(t.get("description", "")),
                    parameters=t.get("parameters", {}) if isinstance(t.get("parameters"), dict) else {},
                    returns=t.get("returns", {}) if isinstance(t.get("returns"), dict) else {},
                )
            )

        # Parse expected tool calls
        expected_calls: list[ToolCall] = []
        for c in data.get("expected_tool_calls", []):
            if not isinstance(c, dict):
                continue
            tool_name = c.get("tool_name") or c.get("name", "")
            arguments = c.get("arguments", {}) if isinstance(c.get("arguments"), dict) else {}
            expected_calls.append(
                ToolCall(
                    tool_name=str(tool_name),
                    arguments=arguments,
                )
            )

        # Parse policy constraints
        constraints: list[PolicyConstraint] = []
        for p in data.get("policy_constraints", []):
            if not isinstance(p, dict):
                continue
            constraints.append(
                PolicyConstraint(
                    policy_id=str(p.get("policy_id") or p.get("id", "")),
                    description=str(p.get("description", "")),
                    check_function=str(p.get("check_function", "")),
                    severity=str(p.get("severity", "error")),
                )
            )

        # Parse difficulty
        difficulty_str = data.get("difficulty", "medium")
        try:
            difficulty = TaskDifficulty(difficulty_str)
        except ValueError:
            difficulty = TaskDifficulty.MEDIUM

        # Get conversation history with validation
        conv_history = data.get("conversation_history", [])
        if not isinstance(conv_history, list):
            conv_history = []
        validated_history: list[dict[str, str]] = []
        for msg in conv_history:
            if isinstance(msg, dict) and "role" in msg and "content" in msg:
                validated_history.append({
                    "role": str(msg["role"]),
                    "content": str(msg["content"])
                })

        # Get success criteria with validation
        success_criteria = data.get("success_criteria", [])
        if not isinstance(success_criteria, list):
            success_criteria = []
        validated_criteria = [str(c) for c in success_criteria if c]

        # Get initialization data with validation
        init_data = data.get("initialization_data") or data.get("init_data", {})
        if not isinstance(init_data, dict):
            init_data = {}

        # Get metadata with validation
        metadata = data.get("metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}

        return TauBenchTask(
            task_id=str(data.get("task_id") or data.get("id", "")),
            domain=domain,
            user_instruction=str(data.get("user_instruction") or data.get("instruction", "")),
            user_profile=str(data.get("user_profile", "")),
            user_goal=str(data.get("user_goal") or data.get("goal", "")),
            conversation_history=validated_history,
            available_tools=tools,
            expected_tool_calls=expected_calls,
            policy_constraints=constraints,
            ground_truth_response=str(data.get("ground_truth_response") or data.get("expected_response", "")),
            success_criteria=validated_criteria,
            initialization_data=init_data,
            difficulty=difficulty,
            max_turns=int(data.get("max_turns", 15)),
            timeout_ms=int(data.get("timeout_ms", 120000)),
            metadata=metadata,
        )

    def get_tasks(
        self,
        domain: Optional[TauDomain] = None,
        difficulty: Optional[TaskDifficulty] = None,
        limit: Optional[int] = None,
    ) -> list[TauBenchTask]:
        """Get tasks with optional filtering."""
        filtered = self.tasks

        if domain:
            filtered = [t for t in filtered if t.domain == domain]

        if difficulty:
            filtered = [t for t in filtered if t.difficulty == difficulty]

        if limit:
            filtered = filtered[:limit]

        return filtered

    def get_tasks_by_domain(self) -> dict[TauDomain, list[TauBenchTask]]:
        """Get tasks grouped by domain."""
        result: dict[TauDomain, list[TauBenchTask]] = {}
        for domain in TauDomain:
            result[domain] = [t for t in self.tasks if t.domain == domain]
        return result

    def create_sample_tasks(self) -> list[TauBenchTask]:
        """Create sample tasks for testing without external data."""
        from elizaos_tau_bench.environments.retail import RetailEnvironment
        from elizaos_tau_bench.environments.airline import AirlineEnvironment

        tasks = []

        # Retail task 1: Order return
        tasks.append(
            TauBenchTask(
                task_id="retail_001",
                domain=TauDomain.RETAIL,
                user_instruction="I want to return my order #ORD-12345. The headphones don't fit well.",
                user_profile="Customer: John Smith, Gold member since 2022",
                user_goal="Successfully initiate a return for the order",
                conversation_history=[],
                available_tools=RetailEnvironment.default_tools(),
                expected_tool_calls=[
                    ToolCall(tool_name="get_order_details", arguments={"order_id": "ORD-12345"}),
                    ToolCall(tool_name="initiate_return", arguments={"order_id": "ORD-12345", "reason": "headphones don't fit well"}),
                ],
                policy_constraints=[
                    PolicyConstraint(
                        policy_id="RETURN_WINDOW",
                        description="Returns must be initiated within 30 days of delivery",
                        check_function="check_return_window",
                    ),
                ],
                ground_truth_response="I've initiated the return for your order ORD-12345. You'll receive a return label via email. Please ship the items within 14 days.",
                success_criteria=["return_initiated"],
                initialization_data={},
                difficulty=TaskDifficulty.EASY,
            )
        )

        # Retail task 2: Cancel order
        tasks.append(
            TauBenchTask(
                task_id="retail_002",
                domain=TauDomain.RETAIL,
                user_instruction="Can you cancel my order ORD-12346? I found a better deal elsewhere.",
                user_profile="Customer: John Smith, Gold member",
                user_goal="Successfully cancel the processing order",
                conversation_history=[],
                available_tools=RetailEnvironment.default_tools(),
                expected_tool_calls=[
                    ToolCall(tool_name="get_order_details", arguments={"order_id": "ORD-12346"}),
                    ToolCall(tool_name="cancel_order", arguments={"order_id": "ORD-12346", "reason": "Customer found better deal"}),
                ],
                policy_constraints=[
                    PolicyConstraint(
                        policy_id="ORDER_MODIFY",
                        description="Only pending/processing orders can be modified or cancelled",
                        check_function="check_order_modifiable",
                    ),
                ],
                ground_truth_response="I've cancelled your order ORD-12346. A full refund will be processed within 5 business days.",
                success_criteria=["order_cancelled"],
                initialization_data={},
                difficulty=TaskDifficulty.EASY,
            )
        )

        # Airline task 1: Change flight
        tasks.append(
            TauBenchTask(
                task_id="airline_001",
                domain=TauDomain.AIRLINE,
                user_instruction="I need to change my flight BK-123456 to a later departure. What options do I have?",
                user_profile="Passenger: Jane Smith, Gold frequent flyer",
                user_goal="Find alternative flights and estimate change fees",
                conversation_history=[],
                available_tools=AirlineEnvironment.default_tools(),
                expected_tool_calls=[
                    ToolCall(tool_name="get_booking_details", arguments={"booking_id": "BK-123456"}),
                    ToolCall(
                        tool_name="search_flights",
                        arguments={"origin": "JFK", "destination": "LAX", "cabin_class": "economy"},
                    ),
                    ToolCall(
                        tool_name="calculate_change_fee",
                        arguments={"booking_id": "BK-123456", "new_flight_id": "FL-AA101"},
                    ),
                ],
                policy_constraints=[
                    PolicyConstraint(
                        policy_id="CHANGE_FEE",
                        description="Change fees apply based on cabin class",
                        check_function="check_change_fee",
                    ),
                ],
                ground_truth_response="I found alternative flights for you. There's a $75 change fee plus any fare difference.",
                success_criteria=["flights_searched", "change_fee_calculated"],
                initialization_data={},
                difficulty=TaskDifficulty.MEDIUM,
            )
        )

        # Airline task 2: Cancel booking
        tasks.append(
            TauBenchTask(
                task_id="airline_002",
                domain=TauDomain.AIRLINE,
                user_instruction="Please cancel my booking BK-123457 to Miami. I can't make the trip anymore.",
                user_profile="Passenger: Jane Smith, Gold frequent flyer",
                user_goal="Successfully cancel the booking with appropriate refund",
                conversation_history=[],
                available_tools=AirlineEnvironment.default_tools(),
                expected_tool_calls=[
                    ToolCall(tool_name="get_booking_details", arguments={"booking_id": "BK-123457"}),
                    ToolCall(tool_name="cancel_booking", arguments={"booking_id": "BK-123457", "reason": "Customer cancelled trip"}),
                ],
                policy_constraints=[
                    PolicyConstraint(
                        policy_id="FREE_CANCEL",
                        description="Free cancellation within 24 hours of booking",
                        check_function="check_free_cancellation",
                    ),
                ],
                ground_truth_response="I've cancelled your booking BK-123457. Your refund of $892.00 will be processed within 7-10 business days.",
                success_criteria=["booking_cancelled"],
                initialization_data={},
                difficulty=TaskDifficulty.EASY,
            )
        )

        return tasks
