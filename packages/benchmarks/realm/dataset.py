"""
REALM-Bench Dataset Loader

Loads and manages REALM benchmark tasks from various sources.
"""

import json
import logging
from pathlib import Path
from typing import Optional

from benchmarks.realm.types import (
    REALMCategory,
    REALMTask,
    REALMTestCase,
)

logger = logging.getLogger(__name__)


class REALMDataset:
    """Dataset loader for REALM benchmark tasks."""

    def __init__(self, data_path: str = "./data/realm"):
        self.data_path = Path(data_path)
        self.tasks: list[REALMTask] = []
        self.test_cases: list[REALMTestCase] = []
        self._loaded = False

    async def load(self) -> None:
        """Load REALM benchmark tasks from data files or generate built-in tasks."""
        if self._loaded:
            return

        logger.info(f"[REALMDataset] Loading tasks from {self.data_path}")

        # Try to load from files first
        if self.data_path.exists():
            await self._load_from_files()

        # If no tasks loaded, generate built-in tasks
        if not self.tasks:
            logger.info("[REALMDataset] No external data found, generating built-in tasks")
            await self._generate_builtin_tasks()

        self._loaded = True
        logger.info(f"[REALMDataset] Loaded {len(self.tasks)} tasks")

    async def _load_from_files(self) -> None:
        """Load tasks from JSON files in the data directory."""
        json_files = list(self.data_path.glob("*.json"))

        for file_path in json_files:
            try:
                with open(file_path) as f:
                    data = json.load(f)

                if "tasks" in data:
                    for task_data in data["tasks"]:
                        task = self._parse_task(task_data)
                        if task:
                            self.tasks.append(task)
                            self.test_cases.append(self._create_test_case(task, task_data))
            except Exception as e:
                logger.warning(f"[REALMDataset] Error loading {file_path}: {e}")

    def _parse_task(self, data: dict[str, object]) -> Optional[REALMTask]:
        """Parse a task from JSON data with validation."""
        try:
            # Validate required fields
            required_fields = ["id", "name", "description", "goal"]
            for field in required_fields:
                if field not in data:
                    logger.warning(f"[REALMDataset] Missing required field: {field}")
                    return None

            # Validate and extract ID
            task_id = data.get("id")
            if not isinstance(task_id, str) or not task_id.strip():
                logger.warning("[REALMDataset] Invalid task id")
                return None

            # Validate and extract name
            name = data.get("name")
            if not isinstance(name, str) or not name.strip():
                logger.warning("[REALMDataset] Invalid task name")
                return None

            # Validate and extract description
            description = data.get("description")
            if not isinstance(description, str):
                logger.warning("[REALMDataset] Invalid task description")
                return None

            # Validate and extract goal
            goal = data.get("goal")
            if not isinstance(goal, str) or not goal.strip():
                logger.warning("[REALMDataset] Invalid task goal")
                return None

            # Parse category
            category_raw = data.get("category", "")
            category_str = str(category_raw).lower() if category_raw else ""
            try:
                category = REALMCategory(category_str) if category_str else REALMCategory.SEQUENTIAL
            except ValueError:
                logger.warning(f"[REALMDataset] Unknown category: {category_str}, defaulting to sequential")
                category = REALMCategory.SEQUENTIAL

            # Validate requirements (list of strings)
            requirements_raw = data.get("requirements", [])
            requirements: list[str] = []
            if isinstance(requirements_raw, list):
                requirements = [str(r) for r in requirements_raw if r is not None]

            # Validate constraints (dict)
            constraints_raw = data.get("constraints", {})
            constraints: dict[str, str | int | float | bool] = {}
            if isinstance(constraints_raw, dict):
                for k, v in constraints_raw.items():
                    if isinstance(v, (str, int, float, bool)):
                        constraints[str(k)] = v

            # Validate available_tools (list of strings)
            tools_raw = data.get("available_tools", [])
            available_tools: list[str] = []
            if isinstance(tools_raw, list):
                available_tools = [str(t) for t in tools_raw if t is not None]

            # Validate expected_outcome
            expected_outcome = str(data.get("expected_outcome", ""))

            # Validate numeric fields
            timeout_raw = data.get("timeout_ms", 60000)
            timeout_ms = int(timeout_raw) if isinstance(timeout_raw, (int, float)) else 60000

            max_steps_raw = data.get("max_steps", 10)
            max_steps = int(max_steps_raw) if isinstance(max_steps_raw, (int, float)) else 10

            # Validate difficulty
            difficulty_raw = data.get("difficulty", "medium")
            difficulty = str(difficulty_raw) if difficulty_raw else "medium"
            if difficulty not in ("easy", "medium", "hard"):
                difficulty = "medium"

            # Validate metadata (dict)
            metadata_raw = data.get("metadata", {})
            metadata: dict[str, str | int | float | bool] = {}
            if isinstance(metadata_raw, dict):
                for k, v in metadata_raw.items():
                    if isinstance(v, (str, int, float, bool)):
                        metadata[str(k)] = v

            return REALMTask(
                id=task_id,
                name=name,
                description=description,
                goal=goal,
                category=category,
                requirements=requirements,
                constraints=constraints,
                expected_outcome=expected_outcome,
                available_tools=available_tools,
                timeout_ms=timeout_ms,
                max_steps=max_steps,
                difficulty=difficulty,
                metadata=metadata,
            )
        except Exception as e:
            logger.warning(f"[REALMDataset] Error parsing task: {e}")
            return None

    def _create_test_case(self, task: REALMTask, data: dict[str, object]) -> REALMTestCase:
        """Create a test case from a task and raw data with validation."""
        # Parse input data
        input_raw = data.get("input", {})
        input_data: dict[str, str | dict[str, str]] = {}
        
        if isinstance(input_raw, dict):
            message = input_raw.get("message")
            input_data["message"] = str(message) if message else task.goal
            
            context_raw = input_raw.get("context", {})
            if isinstance(context_raw, dict):
                context: dict[str, str] = {}
                for k, v in context_raw.items():
                    context[str(k)] = str(v) if v is not None else ""
                input_data["context"] = context
            else:
                input_data["context"] = {}
        else:
            input_data = {"message": task.goal, "context": {}}

        # Parse expected data
        expected_raw = data.get("expected", {})
        expected: dict[str, list[str] | str | dict[str, int | list[str]]] = {}
        
        if isinstance(expected_raw, dict):
            # Actions
            actions_raw = expected_raw.get("actions", task.available_tools[:3])
            expected_actions: list[str]
            if isinstance(actions_raw, list):
                expected_actions = [str(a) for a in actions_raw]
            else:
                expected_actions = task.available_tools[:3]
            expected["actions"] = expected_actions
            
            # Outcome
            outcome_raw = expected_raw.get("outcome", task.expected_outcome)
            expected["outcome"] = str(outcome_raw) if outcome_raw else task.expected_outcome
            
            # Metrics
            metrics_raw = expected_raw.get("metrics", {})
            if isinstance(metrics_raw, dict):
                metrics: dict[str, int | list[str]] = {
                    "max_duration": task.timeout_ms,
                    "max_steps": task.max_steps,
                    # Default required actions should match the expected action set (not all tools)
                    "required_actions": expected_actions,
                }
                if "max_duration" in metrics_raw:
                    val = metrics_raw["max_duration"]
                    metrics["max_duration"] = int(val) if isinstance(val, (int, float)) else task.timeout_ms
                if "max_steps" in metrics_raw:
                    val = metrics_raw["max_steps"]
                    metrics["max_steps"] = int(val) if isinstance(val, (int, float)) else task.max_steps
                if "required_actions" in metrics_raw:
                    val = metrics_raw["required_actions"]
                    if isinstance(val, list):
                        metrics["required_actions"] = [str(a) for a in val]
                    else:
                        metrics["required_actions"] = expected_actions
                expected["metrics"] = metrics
            else:
                expected["metrics"] = {
                    "max_duration": task.timeout_ms,
                    "max_steps": task.max_steps,
                    "required_actions": expected_actions,
                }
        else:
            fallback_actions = task.available_tools[:3]
            expected = {
                "actions": fallback_actions,
                "outcome": task.expected_outcome,
                "metrics": {
                    "max_duration": task.timeout_ms,
                    "max_steps": task.max_steps,
                    "required_actions": fallback_actions,
                },
            }

        return REALMTestCase(task=task, input=input_data, expected=expected)

    async def _generate_builtin_tasks(self) -> None:
        """Generate built-in benchmark tasks."""
        # Sequential Planning Tasks
        sequential_tasks = [
            {
                "id": "seq-001",
                "name": "Mathematical Chain",
                "description": "Execute a chain of mathematical operations",
                "goal": "Calculate the sum of 1234 and 5678, multiply by 5, then compute logarithm",
                "category": "sequential",
                "requirements": ["mathematical calculation", "step sequencing"],
                "constraints": {"max_time": 30000, "max_steps": 5},
                "expected_outcome": "Final logarithm result of approximately 10.45",
                "available_tools": ["sum_two_elements", "multiply_two_elements", "compute_log"],
                "timeout_ms": 30000,
                "max_steps": 5,
                "difficulty": "easy",
                "input": {
                    "message": "Calculate sum of 1234 and 5678, multiply result by 5, take logarithm",
                    "context": {},
                },
                "expected": {
                    "actions": ["sum_two_elements", "multiply_two_elements", "compute_log"],
                    "outcome": "log(34560) ≈ 10.45",
                    "metrics": {"max_duration": 30000, "max_steps": 5},
                },
            },
            {
                "id": "seq-002",
                "name": "Data Pipeline",
                "description": "Process data through a sequential pipeline",
                "goal": "Fetch user data, filter by active status, sort by date, export to CSV",
                "category": "sequential",
                "requirements": ["data retrieval", "filtering", "sorting", "export"],
                "constraints": {"max_time": 45000, "max_steps": 6},
                "expected_outcome": "CSV file with filtered and sorted user data",
                "available_tools": ["fetch_data", "filter_data", "sort_data", "export_data"],
                "timeout_ms": 45000,
                "max_steps": 6,
                "difficulty": "medium",
                "input": {
                    "message": "Fetch user data, filter active users, sort by date, export to CSV",
                    "context": {},
                },
                "expected": {
                    "actions": ["fetch_data", "filter_data", "sort_data", "export_data"],
                    "outcome": "CSV export of filtered users",
                    "metrics": {"max_duration": 45000, "max_steps": 6},
                },
            },
            {
                "id": "seq-003",
                "name": "Document Processing",
                "description": "Process document through transformation stages",
                "goal": "Read document, extract key points, summarize, generate report",
                "category": "sequential",
                "requirements": ["document reading", "extraction", "summarization"],
                "constraints": {"max_time": 60000, "max_steps": 8},
                "expected_outcome": "Executive summary report",
                "available_tools": ["read_document", "extract_key_points", "summarize_text", "generate_report"],
                "timeout_ms": 60000,
                "max_steps": 8,
                "difficulty": "medium",
                "input": {
                    "message": "Read quarterly report, extract metrics, summarize findings, generate executive summary",
                    "context": {},
                },
                "expected": {
                    "actions": ["read_document", "extract_key_points", "summarize_text", "generate_report"],
                    "outcome": "Executive summary report",
                    "metrics": {"max_duration": 60000, "max_steps": 8},
                },
            },
        ]

        # Reactive Planning Tasks
        reactive_tasks = [
            {
                "id": "react-001",
                "name": "System Monitoring",
                "description": "Monitor system and react to conditions",
                "goal": "Monitor CPU usage and scale resources when threshold exceeded",
                "category": "reactive",
                "requirements": ["condition monitoring", "threshold detection", "scaling"],
                "constraints": {"max_time": 45000, "max_steps": 6},
                "expected_outcome": "System scaled when CPU > 80%",
                "available_tools": ["check_condition", "adapt_plan", "scale_resources", "monitor_status"],
                "timeout_ms": 45000,
                "max_steps": 6,
                "difficulty": "medium",
                "input": {
                    "message": "Monitor system, scale resources if CPU exceeds 80%",
                    "context": {},
                },
                "expected": {
                    "actions": ["monitor_status", "check_condition", "scale_resources"],
                    "outcome": "Resources scaled based on condition",
                    "metrics": {"max_duration": 45000, "max_steps": 6},
                },
            },
            {
                "id": "react-002",
                "name": "Deployment with Rollback",
                "description": "Deploy application with error handling and rollback",
                "goal": "Deploy application, rollback if failed, notify team",
                "category": "reactive",
                "requirements": ["deployment", "error detection", "rollback", "notification"],
                "constraints": {"max_time": 60000, "max_steps": 8},
                "expected_outcome": "Successful deployment or clean rollback",
                "available_tools": ["deploy_application", "check_health", "rollback_deployment", "send_notification"],
                "timeout_ms": 60000,
                "max_steps": 8,
                "difficulty": "hard",
                "input": {
                    "message": "Deploy to production, rollback if health checks fail, notify ops team",
                    "context": {},
                },
                "expected": {
                    "actions": ["deploy_application", "check_health", "send_notification"],
                    "outcome": "Deployment with error handling",
                    "metrics": {"max_duration": 60000, "max_steps": 8},
                },
            },
        ]

        # Complex Planning Tasks
        complex_tasks = [
            {
                "id": "complex-001",
                "name": "Project Planning",
                "description": "Create comprehensive project plan with constraints",
                "goal": "Plan mobile app project with 3 developers, 2-month deadline, $50K budget",
                "category": "complex",
                "requirements": ["resource allocation", "timeline management", "dependencies"],
                "constraints": {"max_time": 90000, "max_steps": 12, "developers": 3, "budget": 50000},
                "expected_outcome": "Complete project plan with resource allocation",
                "available_tools": ["allocate_resource", "schedule_task", "coordinate_execution", "validate_constraints"],
                "timeout_ms": 90000,
                "max_steps": 12,
                "difficulty": "hard",
                "input": {
                    "message": "Create project plan for mobile app: 3 devs, 2 months, $50K budget",
                    "context": {},
                },
                "expected": {
                    "actions": ["allocate_resource", "schedule_task", "coordinate_execution"],
                    "outcome": "Project plan with milestones",
                    "metrics": {"max_duration": 90000, "max_steps": 12},
                },
            },
            {
                "id": "complex-002",
                "name": "CI/CD Pipeline",
                "description": "Set up CI/CD with parallel testing and deployment",
                "goal": "Configure parallel tests and conditional deployment",
                "category": "complex",
                "requirements": ["parallel execution", "test orchestration", "deployment"],
                "constraints": {"max_time": 60000, "max_steps": 10},
                "expected_outcome": "CI/CD pipeline with parallel tests",
                "available_tools": ["configure_pipeline", "run_tests_parallel", "gate_deployment", "deploy_staging"],
                "timeout_ms": 60000,
                "max_steps": 10,
                "difficulty": "hard",
                "input": {
                    "message": "Set up CI/CD: parallel unit/integration/e2e tests, deploy if all pass",
                    "context": {},
                },
                "expected": {
                    "actions": ["configure_pipeline", "run_tests_parallel", "gate_deployment"],
                    "outcome": "CI/CD pipeline configured",
                    "metrics": {"max_duration": 60000, "max_steps": 10},
                },
            },
        ]

        # Multi-Agent Tasks
        multi_agent_tasks = [
            {
                "id": "multi-001",
                "name": "Research Collaboration",
                "description": "Coordinate multiple agents for comprehensive research",
                "goal": "Gather and synthesize information from multiple sources",
                "category": "multi_agent",
                "requirements": ["task delegation", "parallel research", "synthesis"],
                "constraints": {"max_time": 90000, "max_steps": 12, "agents": 3},
                "expected_outcome": "Synthesized research report",
                "available_tools": ["delegate_task", "search_academic", "search_industry", "aggregate_results"],
                "timeout_ms": 90000,
                "max_steps": 12,
                "difficulty": "hard",
                "input": {
                    "message": "Research AI trends: academic papers, industry reports, social media",
                    "context": {},
                },
                "expected": {
                    "actions": ["delegate_task", "aggregate_results"],
                    "outcome": "Synthesized research report",
                    "metrics": {"max_duration": 90000, "max_steps": 12},
                },
            },
            {
                "id": "multi-002",
                "name": "Collaborative Debugging",
                "description": "Debug production issue with specialized agents",
                "goal": "Identify and resolve production issue through collaboration",
                "category": "multi_agent",
                "requirements": ["log analysis", "metrics analysis", "code review"],
                "constraints": {"max_time": 75000, "max_steps": 10, "agents": 3},
                "expected_outcome": "Root cause analysis and resolution",
                "available_tools": ["analyze_logs", "check_metrics", "review_code_changes", "correlate_findings"],
                "timeout_ms": 75000,
                "max_steps": 10,
                "difficulty": "hard",
                "input": {
                    "message": "Debug production issue: analyze logs, check metrics, review code changes",
                    "context": {},
                },
                "expected": {
                    "actions": ["analyze_logs", "check_metrics", "correlate_findings"],
                    "outcome": "Root cause identified",
                    "metrics": {"max_duration": 75000, "max_steps": 10},
                },
            },
        ]

        # Tool Use Tasks
        tool_use_tasks = [
            {
                "id": "tool-001",
                "name": "API Chain",
                "description": "Plan sequence of API calls with data dependencies",
                "goal": "Get user profile, extract email, send welcome message",
                "category": "tool_use",
                "requirements": ["API calls", "data extraction", "sequencing"],
                "constraints": {"max_time": 30000, "max_steps": 5},
                "expected_outcome": "Welcome email sent",
                "available_tools": ["call_api", "parse_json", "send_email"],
                "timeout_ms": 30000,
                "max_steps": 5,
                "difficulty": "easy",
                "input": {
                    "message": "Get user profile from API, extract email, send welcome message",
                    "context": {},
                },
                "expected": {
                    "actions": ["call_api", "parse_json", "send_email"],
                    "outcome": "Welcome email sent",
                    "metrics": {"max_duration": 30000, "max_steps": 5},
                },
            },
            {
                "id": "tool-002",
                "name": "File Operations",
                "description": "Plan file read, transform, and write operations",
                "goal": "Read config.json, update database URL, save changes",
                "category": "tool_use",
                "requirements": ["file I/O", "JSON parsing", "modification"],
                "constraints": {"max_time": 30000, "max_steps": 5},
                "expected_outcome": "Config file updated",
                "available_tools": ["read_file", "parse_json", "modify_json", "write_file"],
                "timeout_ms": 30000,
                "max_steps": 5,
                "difficulty": "easy",
                "input": {
                    "message": "Read config.json, update database URL, save changes",
                    "context": {},
                },
                "expected": {
                    "actions": ["read_file", "parse_json", "modify_json", "write_file"],
                    "outcome": "Config updated",
                    "metrics": {"max_duration": 30000, "max_steps": 5},
                },
            },
        ]

        # Reasoning Tasks
        reasoning_tasks = [
            {
                "id": "reason-001",
                "name": "Decision Under Uncertainty",
                "description": "Make decision with incomplete information",
                "goal": "Recommend launch decision with 70% user feedback and volatile market",
                "category": "reasoning",
                "requirements": ["risk assessment", "decision making", "contingency planning"],
                "constraints": {"max_time": 45000, "max_steps": 6},
                "expected_outcome": "Launch recommendation with reasoning",
                "available_tools": ["gather_information", "evaluate_options", "estimate_probability", "make_decision"],
                "timeout_ms": 45000,
                "max_steps": 6,
                "difficulty": "hard",
                "input": {
                    "message": "Recommend launch decision: 70% feedback, volatile market",
                    "context": {},
                },
                "expected": {
                    "actions": ["gather_information", "evaluate_options", "make_decision"],
                    "outcome": "Launch recommendation",
                    "metrics": {"max_duration": 45000, "max_steps": 6},
                },
            },
            {
                "id": "reason-002",
                "name": "Fallback Planning",
                "description": "Create plan with alternative paths",
                "goal": "Book flight to NYC, fallback to connecting flight, then train",
                "category": "reasoning",
                "requirements": ["primary planning", "fallback options", "prioritization"],
                "constraints": {"max_time": 45000, "max_steps": 8},
                "expected_outcome": "Travel booking with fallbacks",
                "available_tools": ["search_direct_flights", "search_connections", "search_trains", "book_travel"],
                "timeout_ms": 45000,
                "max_steps": 8,
                "difficulty": "medium",
                "input": {
                    "message": "Book flight to NYC. If unavailable, try connections, then train",
                    "context": {},
                },
                "expected": {
                    "actions": ["search_direct_flights", "search_connections", "book_travel"],
                    "outcome": "Travel booked with fallbacks",
                    "metrics": {"max_duration": 45000, "max_steps": 8},
                },
            },
        ]

        # Combine all tasks
        all_tasks = (
            sequential_tasks
            + reactive_tasks
            + complex_tasks
            + multi_agent_tasks
            + tool_use_tasks
            + reasoning_tasks
        )

        for task_data in all_tasks:
            task = self._parse_task(task_data)
            if task:
                self.tasks.append(task)
                self.test_cases.append(self._create_test_case(task, task_data))

    def get_tasks(
        self,
        categories: Optional[list[REALMCategory]] = None,
        limit: Optional[int] = None,
    ) -> list[REALMTask]:
        """Get tasks, optionally filtered by category."""
        if categories:
            filtered = [t for t in self.tasks if t.category in categories]
        else:
            filtered = self.tasks

        return filtered[:limit] if limit else filtered

    def get_test_cases(
        self,
        categories: Optional[list[REALMCategory]] = None,
        limit: Optional[int] = None,
    ) -> list[REALMTestCase]:
        """
        Get test cases, optionally filtered by category.

        Note: If `limit` is provided, it is interpreted as **limit per category**
        (aligned with `REALMConfig.max_tasks_per_category` and the CLI flag `--max-tasks`).
        """
        category_order = categories if categories is not None else list(REALMCategory)
        buckets: dict[REALMCategory, list[REALMTestCase]] = {c: [] for c in category_order}

        for tc in self.test_cases:
            if tc.task.category in buckets:
                buckets[tc.task.category].append(tc)

        if limit is None:
            return [tc for c in category_order for tc in buckets[c]]

        return [tc for c in category_order for tc in buckets[c][:limit]]

    def get_tasks_by_difficulty(self, difficulty: str) -> list[REALMTask]:
        """Get tasks filtered by difficulty level."""
        return [t for t in self.tasks if t.difficulty == difficulty]
