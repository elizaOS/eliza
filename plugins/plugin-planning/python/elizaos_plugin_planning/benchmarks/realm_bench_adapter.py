"""REALM-Bench Adapter - Tests ElizaOS planning capabilities against REALM-Bench scenarios."""

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from elizaos_plugin_planning.benchmarks.types import (
    RealmBenchTask,
    RealmBenchTestCase,
    RealmBenchResult,
    RealmBenchReport,
)
from elizaos_plugin_planning.services.planning_service import PlanningService

logger = logging.getLogger(__name__)


class RealmBenchAdapter:
    """
    Production-Ready REALM-Bench Adapter.
    
    Tests ElizaOS planning capabilities against REALM-Bench scenarios.
    """

    def __init__(self, planning_service: PlanningService, runtime: Optional[Any] = None) -> None:
        self.planning_service = planning_service
        self.runtime = runtime
        self.test_cases: list[RealmBenchTestCase] = []

    async def load_test_cases(self, realm_bench_data_path: str) -> None:
        """Load test cases from REALM-Bench format."""
        try:
            logger.info(f"[RealmBenchAdapter] Loading test cases from {realm_bench_data_path}")

            # Generate test cases from planning patterns
            await self._load_planning_pattern_tests()

            # Generate test cases from multi-agent scenarios
            await self._load_multi_agent_tests()

            logger.info(f"[RealmBenchAdapter] Loaded {len(self.test_cases)} test cases")
        except Exception as e:
            logger.error(f"[RealmBenchAdapter] Error loading test cases: {e}")
            raise RuntimeError(f"Failed to load REALM-Bench test cases: {e}") from e

    async def run_benchmark(self) -> RealmBenchReport:
        """Run all loaded test cases."""
        start_time = time.time()
        results: list[RealmBenchResult] = []

        logger.info(f"[RealmBenchAdapter] Starting benchmark with {len(self.test_cases)} test cases")

        for test_case in self.test_cases:
            try:
                result = await self._run_test_case(test_case)
                results.append(result)

                logger.info(
                    f"[RealmBenchAdapter] Test {test_case.task.id}: "
                    f"{'PASS' if result.success else 'FAIL'} "
                    f"({result.duration:.0f}ms, {result.steps_executed} steps)"
                )
            except Exception as e:
                logger.error(f"[RealmBenchAdapter] Test {test_case.task.id} failed: {e}")
                results.append(
                    RealmBenchResult(
                        test_case_id=test_case.task.id,
                        task_id=test_case.task.id,
                        success=False,
                        duration=0,
                        steps_executed=0,
                        actions_performed=[],
                        plan_generated=None,
                        error=str(e),
                    )
                )

        report = self._generate_report(results, time.time() - start_time)

        logger.info(
            f"[RealmBenchAdapter] Benchmark completed: {report.passed_tests}/{report.total_tests} passed "
            f"({report.passed_tests / report.total_tests * 100:.1f}%)"
        )

        return report

    async def _run_test_case(self, test_case: RealmBenchTestCase) -> RealmBenchResult:
        """Run a specific test case."""
        start_time = time.time()
        planning_time = 0.0
        execution_time = 0.0
        plan_generated: Optional[dict[str, Any]] = None
        steps_executed = 0
        actions_performed: list[str] = []

        try:
            # Create test message
            test_message = {
                "id": str(uuid4()),
                "entity_id": str(uuid4()),
                "room_id": str(uuid4()),
                "content": {
                    "text": test_case.input.get("message", ""),
                    "source": "realm-bench-test",
                },
                "created_at": int(time.time() * 1000),
            }

            # Create planning context
            planning_context = {
                "goal": test_case.task.goal,
                "constraints": [
                    {"type": "custom", "value": v, "description": f"{k}: {v}"}
                    for k, v in test_case.task.constraints.items()
                ],
                "available_actions": test_case.task.available_tools,
                "preferences": {
                    "execution_model": "dag",
                    "max_steps": test_case.task.max_steps,
                    "timeout_ms": test_case.task.timeout_ms,
                },
            }

            # Create plan
            planning_start = time.time()
            plan = await self.planning_service.create_comprehensive_plan(
                planning_context, test_message, test_case.input.get("context")
            )
            planning_time = (time.time() - planning_start) * 1000

            plan_generated = {
                "id": str(plan.id),
                "goal": plan.goal,
                "steps": [{"id": str(s.id), "action_name": s.action_name} for s in plan.steps],
            }

            # Validate plan
            is_valid, issues = await self.planning_service.validate_plan(plan)
            if not is_valid:
                raise ValueError(f"Plan validation failed: {', '.join(issues or [])}")

            # Execute plan
            execution_start = time.time()

            async def callback(content: dict[str, Any]) -> list[Any]:
                if content.get("actions"):
                    actions_performed.extend(content["actions"])
                return []

            execution_result = await self.planning_service.execute_plan(
                plan, test_message, callback
            )
            execution_time = (time.time() - execution_start) * 1000
            steps_executed = execution_result.completed_steps

            # Evaluate results
            success = self._evaluate_test_result(test_case, execution_result, actions_performed)
            metrics = self._calculate_metrics(
                test_case, plan, execution_result, planning_time, execution_time
            )

            return RealmBenchResult(
                test_case_id=test_case.task.id,
                task_id=test_case.task.id,
                success=success,
                duration=(time.time() - start_time) * 1000,
                steps_executed=steps_executed,
                actions_performed=actions_performed,
                plan_generated=plan_generated,
                metrics=metrics,
                details={
                    "plan_adaptations": len(execution_result.adaptations or []),
                    "error_recoveries": len(execution_result.errors or []),
                    "resource_usage": {
                        "planning_time": planning_time,
                        "execution_time": execution_time,
                    },
                },
            )

        except Exception as e:
            return RealmBenchResult(
                test_case_id=test_case.task.id,
                task_id=test_case.task.id,
                success=False,
                duration=(time.time() - start_time) * 1000,
                steps_executed=steps_executed,
                actions_performed=actions_performed,
                plan_generated=plan_generated,
                error=str(e),
                metrics={
                    "planning_time": planning_time,
                    "execution_time": execution_time,
                    "plan_quality": 0,
                    "goal_achievement": 0,
                    "efficiency": 0,
                },
            )

    async def _load_planning_pattern_tests(self) -> None:
        """Load planning pattern tests from REALM-Bench."""
        planning_patterns = [
            {
                "name": "Sequential Planning",
                "goal": "Calculate sum of numbers, multiply result, then take logarithm",
                "requirements": ["mathematical calculation", "step sequencing"],
                "tools": ["sum_two_elements", "multiply_two_elements", "compute_log"],
                "input": (
                    "I want to calculate the sum of 1234 and 5678 and multiply the result by 5. "
                    "Then, I want to take the logarithm of this result"
                ),
                "expected_actions": ["sum_two_elements", "multiply_two_elements", "compute_log"],
            },
            {
                "name": "Reactive Planning",
                "goal": "Respond to dynamic conditions and adapt plan accordingly",
                "requirements": ["condition monitoring", "plan adaptation"],
                "tools": ["check_condition", "adapt_plan", "execute_action"],
                "input": "Monitor the system and adapt our approach based on current conditions",
                "expected_actions": ["check_condition", "adapt_plan"],
            },
            {
                "name": "Complex Multi-Step Planning",
                "goal": "Coordinate multiple interdependent tasks with resource constraints",
                "requirements": ["resource management", "dependency resolution", "parallel execution"],
                "tools": ["allocate_resource", "schedule_task", "coordinate_execution"],
                "input": (
                    "Create a comprehensive project plan with resource allocation and task coordination"
                ),
                "expected_actions": ["allocate_resource", "schedule_task", "coordinate_execution"],
            },
        ]

        for pattern in planning_patterns:
            task = RealmBenchTask(
                id=f"planning-{pattern['name'].lower().replace(' ', '-')}",
                name=pattern["name"],
                description=f"Test {pattern['name']} capabilities",
                goal=pattern["goal"],
                requirements=pattern["requirements"],
                constraints={"max_time": 30000, "max_steps": 5},
                expected_outcome=f"Successfully execute {' -> '.join(pattern['expected_actions'])}",
                available_tools=pattern["tools"],
                timeout_ms=30000,
                max_steps=5,
            )

            test_case = RealmBenchTestCase(
                task=task,
                input={"message": pattern["input"], "context": {}},
                expected={
                    "actions": pattern["expected_actions"],
                    "outcome": pattern["goal"],
                    "metrics": {
                        "max_duration": 30000,
                        "max_steps": 5,
                        "required_actions": pattern["expected_actions"],
                    },
                },
            )

            self.test_cases.append(test_case)

    async def _load_multi_agent_tests(self) -> None:
        """Load multi-agent tests from REALM-Bench."""
        multi_agent_scenarios = [
            {
                "name": "Information Gathering and Analysis",
                "goal": "Gather information from multiple sources and provide comprehensive analysis",
                "requirements": ["research", "data aggregation", "analysis"],
                "tools": ["search_information", "analyze_data", "generate_report"],
                "input": "Research the current market trends and provide a comprehensive analysis",
                "expected_actions": ["search_information", "analyze_data", "generate_report"],
            },
            {
                "name": "Problem Solving Workflow",
                "goal": "Identify problem, generate solutions, and implement the best approach",
                "requirements": ["problem identification", "solution generation", "implementation"],
                "tools": [
                    "identify_problem",
                    "generate_solutions",
                    "evaluate_solutions",
                    "implement_solution",
                ],
                "input": "Help me solve the performance issues in our application",
                "expected_actions": ["identify_problem", "generate_solutions", "implement_solution"],
            },
        ]

        for scenario in multi_agent_scenarios:
            task = RealmBenchTask(
                id=f"multi-agent-{scenario['name'].lower().replace(' ', '-')}",
                name=scenario["name"],
                description=f"Test {scenario['name']} in multi-agent context",
                goal=scenario["goal"],
                requirements=scenario["requirements"],
                constraints={"max_time": 60000, "max_steps": 8},
                expected_outcome=f"Successfully coordinate {' -> '.join(scenario['expected_actions'])}",
                available_tools=scenario["tools"],
                timeout_ms=60000,
                max_steps=8,
            )

            test_case = RealmBenchTestCase(
                task=task,
                input={"message": scenario["input"], "context": {}},
                expected={
                    "actions": scenario["expected_actions"],
                    "outcome": scenario["goal"],
                    "metrics": {
                        "max_duration": 60000,
                        "max_steps": 8,
                        "required_actions": scenario["expected_actions"],
                    },
                },
            )

            self.test_cases.append(test_case)

    def _evaluate_test_result(
        self,
        test_case: RealmBenchTestCase,
        execution_result: Any,
        actions_performed: list[str],
    ) -> bool:
        """Evaluate test result against expected outcomes."""
        if not execution_result.success:
            return False

        required_actions = test_case.expected.get("metrics", {}).get("required_actions", [])
        for required_action in required_actions:
            if required_action not in actions_performed:
                logger.warning(f"[RealmBenchAdapter] Missing required action: {required_action}")
                return False

        max_duration = test_case.expected.get("metrics", {}).get("max_duration")
        if max_duration and execution_result.duration > max_duration:
            logger.warning(
                f"[RealmBenchAdapter] Execution exceeded max duration: {execution_result.duration}ms"
            )
            return False

        max_steps = test_case.expected.get("metrics", {}).get("max_steps")
        if max_steps and execution_result.completed_steps > max_steps:
            logger.warning(
                f"[RealmBenchAdapter] Execution exceeded max steps: {execution_result.completed_steps}"
            )
            return False

        return True

    def _calculate_metrics(
        self,
        test_case: RealmBenchTestCase,
        plan: Any,
        execution_result: Any,
        planning_time: float,
        execution_time: float,
    ) -> dict[str, float]:
        """Calculate performance metrics."""
        plan_quality = min(1.0, 0.5 + len(plan.steps) / 10 if plan.steps else 0)

        required_actions = test_case.expected.get("metrics", {}).get("required_actions", [])
        action_coverage = (
            execution_result.completed_steps / len(required_actions)
            if required_actions
            else 1.0
        )
        goal_achievement = min(1.0, action_coverage) if execution_result.success else 0

        expected_time = test_case.expected.get("metrics", {}).get("max_duration", 30000)
        expected_steps = test_case.expected.get("metrics", {}).get("max_steps", 5)
        time_efficiency = max(0, 1 - execution_result.duration / expected_time)
        step_efficiency = max(0, 1 - execution_result.completed_steps / expected_steps)
        efficiency = (time_efficiency + step_efficiency) / 2

        return {
            "planning_time": planning_time,
            "execution_time": execution_time,
            "plan_quality": plan_quality,
            "goal_achievement": goal_achievement,
            "efficiency": efficiency,
        }

    def _generate_report(
        self, results: list[RealmBenchResult], total_duration: float
    ) -> RealmBenchReport:
        """Generate comprehensive benchmark report."""
        passed_tests = len([r for r in results if r.success])
        failed_tests = len(results) - passed_tests

        avg_duration = sum(r.duration for r in results) / len(results) if results else 0
        avg_steps = sum(r.steps_executed for r in results) / len(results) if results else 0
        avg_plan_quality = (
            sum(r.metrics.get("plan_quality", 0) for r in results) / len(results) if results else 0
        )
        avg_goal_achievement = (
            sum(r.metrics.get("goal_achievement", 0) for r in results) / len(results)
            if results
            else 0
        )
        avg_efficiency = (
            sum(r.metrics.get("efficiency", 0) for r in results) / len(results) if results else 0
        )

        # Analyze task categories
        task_categories: dict[str, dict[str, Any]] = {}
        for result in results:
            category = result.task_id.split("-")[0]
            if category not in task_categories:
                task_categories[category] = {"count": 0, "success_rate": 0, "average_score": 0}
            task_categories[category]["count"] += 1

        for category in task_categories:
            category_results = [r for r in results if r.task_id.startswith(category)]
            category_passed = len([r for r in category_results if r.success])
            task_categories[category]["success_rate"] = category_passed / len(category_results)
            task_categories[category]["average_score"] = (
                sum(r.metrics.get("goal_achievement", 0) for r in category_results)
                / len(category_results)
            )

        # Common failures
        error_counts: dict[str, int] = {}
        for result in results:
            if not result.success and result.error:
                error_counts[result.error] = error_counts.get(result.error, 0) + 1

        common_failures = sorted(error_counts.keys(), key=lambda e: error_counts[e], reverse=True)[
            :5
        ]

        # Recommendations
        recommendations: list[str] = []
        if avg_plan_quality < 0.7:
            recommendations.append(
                "Improve plan generation quality with better prompting and validation"
            )
        if avg_efficiency < 0.6:
            recommendations.append(
                "Optimize plan execution efficiency and reduce unnecessary steps"
            )
        if failed_tests > passed_tests * 0.3:
            recommendations.append("Address common failure patterns and improve error handling")

        return RealmBenchReport(
            total_tests=len(results),
            passed_tests=passed_tests,
            failed_tests=failed_tests,
            average_duration=avg_duration,
            average_steps=avg_steps,
            average_plan_quality=avg_plan_quality,
            average_goal_achievement=avg_goal_achievement,
            average_efficiency=avg_efficiency,
            results=results,
            summary={
                "task_categories": task_categories,
                "common_failures": common_failures,
                "recommendations": recommendations,
            },
        )

    async def save_report(self, report: RealmBenchReport, file_path: str) -> None:
        """Save benchmark report to file."""
        try:
            from dataclasses import asdict

            report_dict = asdict(report)
            with open(file_path, "w") as f:
                json.dump(report_dict, f, indent=2, default=str)
            logger.info(f"[RealmBenchAdapter] Benchmark report saved to {file_path}")
        except Exception as e:
            logger.error(f"[RealmBenchAdapter] Error saving report: {e}")
            raise

