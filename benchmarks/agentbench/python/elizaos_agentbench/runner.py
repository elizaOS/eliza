"""
AgentBench benchmark runner.

Orchestrates benchmark execution across all environments and generates reports.

This runner supports two modes:
1. Full ElizaOS pipeline: Uses message_service.handle_message() with Memory objects,
   provider context, and the complete agent flow. This is the canonical way.
2. Direct mode: Uses runtime.generate_text() directly for mock/test runtimes.

The full ElizaOS mode is used when the runtime has a message_service attribute.
"""

import asyncio
import json
import logging
import time
import tracemalloc
from datetime import datetime
from pathlib import Path

from elizaos_agentbench.types import (
    AgentBenchConfig,
    AgentBenchEnvironment,
    AgentBenchReport,
    AgentBenchResult,
    AgentBenchTask,
    AgentRuntimeProtocol,
    BaselineComparisonType,
    EnvironmentConfig,
    EnvironmentReport,
    GPT4_BASELINE_SCORES,
    GPT35_BASELINE_SCORES,
    CLAUDE_BASELINE_SCORES,
    JSONValue,
    OverallMetricsType,
    SummaryType,
    TaskDifficulty,
)
from elizaos_agentbench.adapters.base import EnvironmentAdapter
from elizaos_agentbench.adapters.os_adapter import OSEnvironmentAdapter
from elizaos_agentbench.adapters.db_adapter import DatabaseEnvironmentAdapter
from elizaos_agentbench.adapters.webshop_adapter import WebShopEnvironmentAdapter
from elizaos_agentbench.adapters.kg_adapter import KnowledgeGraphAdapter
from elizaos_agentbench.adapters.lateral_thinking_adapter import LateralThinkingAdapter

logger = logging.getLogger(__name__)


def _is_full_elizaos_runtime(runtime: AgentRuntimeProtocol | None) -> bool:
    """Check if the runtime is a full ElizaOS runtime with message service."""
    if runtime is None:
        return False
    # Check for message_service attribute which indicates full ElizaOS runtime
    return hasattr(runtime, "message_service") and runtime.message_service is not None


class MemoryTracker:
    """Track memory usage during benchmark execution."""

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.measurements: list[int] = []
        self._running = False
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if not self.enabled:
            return
        self.measurements = []
        self._running = True
        tracemalloc.start()
        self._task = asyncio.create_task(self._track())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self.enabled:
            tracemalloc.stop()

    async def _track(self) -> None:
        while self._running:
            current, _ = tracemalloc.get_traced_memory()
            self.measurements.append(current)
            await asyncio.sleep(1.0)

    def get_stats(self) -> dict[str, int]:
        if not self.enabled or not self.measurements:
            return {"peak": 0, "average": 0}
        return {
            "peak": max(self.measurements),
            "average": sum(self.measurements) // len(self.measurements),
        }


class AgentBenchRunner:
    """
    Main runner for AgentBench benchmarks.

    Coordinates execution across all environments and generates comprehensive reports.

    This runner supports two execution modes:

    1. **Full ElizaOS Pipeline** (recommended):
       When a real ElizaOS AgentRuntime is provided, uses the complete message
       processing pipeline with:
       - Memory objects for all messages
       - Provider context gathering (compose_state)
       - message_service.handle_message() for processing
       - Conversation history preservation

    2. **Direct Mode** (for testing):
       When a mock runtime is provided, directly calls generate_text() on the
       runtime. This is useful for testing the harness without a full ElizaOS
       setup.

    Usage:
        # Full ElizaOS mode
        runtime = AgentRuntime(character=character, plugins=[...])
        await runtime.initialize()
        runner = AgentBenchRunner(config=config, runtime=runtime)

        # Direct/mock mode
        runner = AgentBenchRunner(config=config, runtime=SmartMockRuntime())
    """

    def __init__(
        self,
        config: AgentBenchConfig,
        runtime: AgentRuntimeProtocol | None = None,
    ) -> None:
        self.config = config
        self.runtime = runtime
        self.memory_tracker = MemoryTracker(config.enable_memory_tracking)
        self._adapters: dict[AgentBenchEnvironment, EnvironmentAdapter] = {}
        self._start_time = 0.0
        self._results: list[AgentBenchResult] = []
        self._harness: "ElizaAgentHarness | None" = None

        # Initialize harness if we have a full ElizaOS runtime
        if _is_full_elizaos_runtime(runtime):
            from elizaos_agentbench.eliza_harness import ElizaAgentHarness

            self._harness = ElizaAgentHarness(runtime)  # type: ignore[arg-type]
            logger.info("[AgentBenchRunner] Using full ElizaOS pipeline with message_service")

    def _create_adapter(
        self,
        env: AgentBenchEnvironment,
        config: EnvironmentConfig,
    ) -> EnvironmentAdapter:
        """Create adapter for a specific environment."""
        adapter_map: dict[AgentBenchEnvironment, type[EnvironmentAdapter]] = {
            AgentBenchEnvironment.OS: OSEnvironmentAdapter,
            AgentBenchEnvironment.DATABASE: DatabaseEnvironmentAdapter,
            AgentBenchEnvironment.WEB_SHOPPING: WebShopEnvironmentAdapter,
            AgentBenchEnvironment.KNOWLEDGE_GRAPH: KnowledgeGraphAdapter,
            AgentBenchEnvironment.LATERAL_THINKING: LateralThinkingAdapter,
        }

        adapter_class = adapter_map.get(env)
        if not adapter_class:
            raise NotImplementedError(f"Adapter for {env.value} not yet implemented")

        return adapter_class(runtime=self.runtime, config=config)

    async def run_benchmarks(self) -> AgentBenchReport:
        """Run all enabled benchmarks."""
        self._start_time = time.time()
        await self.memory_tracker.start()
        self._results = []

        logger.info("[AgentBenchRunner] Starting AgentBench evaluation...")

        enabled_envs = self.config.get_enabled_environments()
        logger.info(f"[AgentBenchRunner] Enabled environments: {[e.value for e in enabled_envs]}")

        try:
            # Initialize adapters
            for env in enabled_envs:
                env_config = self.config.get_env_config(env)
                try:
                    adapter = self._create_adapter(env, env_config)
                    await adapter.initialize()
                    self._adapters[env] = adapter
                    logger.info(f"[AgentBenchRunner] Initialized {env.value} adapter")
                except NotImplementedError as e:
                    logger.warning(f"[AgentBenchRunner] {e}")
                except Exception as e:
                    logger.error(f"[AgentBenchRunner] Failed to initialize {env.value}: {e}")

            # Run benchmarks for each environment
            for env, adapter in self._adapters.items():
                logger.info(f"[AgentBenchRunner] Running {env.value} benchmark...")
                tasks = self._load_tasks(env)
                env_config = self.config.get_env_config(env)

                for task in tasks[: env_config.max_tasks]:
                    # Use harness for full ElizaOS pipeline, otherwise use adapter directly
                    if self._harness is not None:
                        # Full ElizaOS mode: uses message_service.handle_message()
                        result = await self._harness.run_task(task, adapter)
                        # Clear conversation between tasks for fresh context
                        await self._harness.clear_conversation()
                    else:
                        # Direct mode: uses runtime.generate_text() directly
                        result = await adapter.run_task(task)

                    self._results.append(result)
                    status = "✓ PASS" if result.success else "✗ FAIL"
                    logger.info(
                        f"[AgentBenchRunner] Task {task.id}: {status} "
                        f"({result.duration_ms:.0f}ms, {result.steps_taken} steps)"
                    )

            # Generate report
            report = self._generate_report()

            # Save results
            await self._save_results(report)

            logger.info(
                f"[AgentBenchRunner] Benchmark completed: "
                f"{report.passed_tasks}/{report.total_tasks} passed "
                f"({report.overall_success_rate * 100:.1f}%)"
            )

            return report

        except Exception as e:
            logger.error(f"[AgentBenchRunner] Benchmark execution failed: {e}")
            raise
        finally:
            await self.memory_tracker.stop()
            await self._cleanup()

    def _load_tasks(self, env: AgentBenchEnvironment) -> list[AgentBenchTask]:
        """Load tasks for a specific environment."""
        # Generate sample tasks for testing
        # In production, these would be loaded from AgentBench dataset files

        if env == AgentBenchEnvironment.OS:
            return self._generate_os_tasks()
        elif env == AgentBenchEnvironment.DATABASE:
            return self._generate_db_tasks()
        elif env == AgentBenchEnvironment.WEB_SHOPPING:
            return self._generate_webshop_tasks()
        elif env == AgentBenchEnvironment.KNOWLEDGE_GRAPH:
            return self._generate_kg_tasks()
        elif env == AgentBenchEnvironment.LATERAL_THINKING:
            return self._generate_lateral_thinking_tasks()
        else:
            return []

    def _generate_os_tasks(self) -> list[AgentBenchTask]:
        """Generate sample OS tasks."""
        return [
            AgentBenchTask(
                id="os-001",
                environment=AgentBenchEnvironment.OS,
                description="Create a new directory called 'test_dir' and create a file named 'hello.txt' inside it with the content 'Hello, World!'",
                initial_state={"working_dir": "/home/user"},
                goal="File test_dir/hello.txt exists with content 'Hello, World!'",
                max_steps=10,
                timeout_ms=30000,
                ground_truth="Hello, World!",
                metadata={"verify_command": "cat test_dir/hello.txt"},
            ),
            AgentBenchTask(
                id="os-002",
                environment=AgentBenchEnvironment.OS,
                description="Find all .txt files in the current directory and count them",
                initial_state={
                    "working_dir": "/home/user",
                    "files": {
                        "/home/user/file1.txt": "content1",
                        "/home/user/file2.txt": "content2",
                        "/home/user/file3.log": "log content",
                    },
                },
                goal="Count the number of .txt files",
                max_steps=5,
                timeout_ms=20000,
                ground_truth="2",
                difficulty=TaskDifficulty.EASY,
                metadata={"verify_command": "find . -maxdepth 1 -name \"*.txt\" | wc -l"},
            ),
            AgentBenchTask(
                id="os-003",
                environment=AgentBenchEnvironment.OS,
                description="Find the largest file in the logs directory",
                initial_state={
                    "working_dir": "/home/user",
                    "files": {
                        "/home/user/logs/small.log": "x" * 10,
                        "/home/user/logs/medium.log": "x" * 100,
                        "/home/user/logs/large.log": "x" * 1000,
                    },
                },
                goal="Identify the largest file name in logs/",
                max_steps=8,
                timeout_ms=30000,
                difficulty=TaskDifficulty.MEDIUM,
                ground_truth="large.log",
                metadata={"verify_command": "ls -S logs | head -1"},
            ),
        ]

    def _generate_db_tasks(self) -> list[AgentBenchTask]:
        """Generate sample database tasks."""
        return [
            AgentBenchTask(
                id="db-001",
                environment=AgentBenchEnvironment.DATABASE,
                description="Find all employees who earn more than $50000",
                initial_state={
                    "schema": {
                        "employees": [
                            {"name": "id", "type": "INTEGER", "primary_key": True},
                            {"name": "name", "type": "TEXT", "not_null": True},
                            {"name": "salary", "type": "REAL"},
                            {"name": "department", "type": "TEXT"},
                        ]
                    },
                    "data": {
                        "employees": [
                            {"id": 1, "name": "Alice", "salary": 60000, "department": "Engineering"},
                            {"id": 2, "name": "Bob", "salary": 45000, "department": "Sales"},
                            {"id": 3, "name": "Charlie", "salary": 75000, "department": "Engineering"},
                            {"id": 4, "name": "Diana", "salary": 52000, "department": "HR"},
                        ]
                    },
                },
                goal="Write a SQL query to find employees earning more than $50000",
                max_steps=5,
                timeout_ms=20000,
                ground_truth="SELECT * FROM employees WHERE salary > 50000",
                difficulty=TaskDifficulty.EASY,
            ),
            AgentBenchTask(
                id="db-002",
                environment=AgentBenchEnvironment.DATABASE,
                description="Calculate the average salary per department",
                initial_state={
                    "schema": {
                        "employees": [
                            {"name": "id", "type": "INTEGER", "primary_key": True},
                            {"name": "name", "type": "TEXT"},
                            {"name": "salary", "type": "REAL"},
                            {"name": "department", "type": "TEXT"},
                        ]
                    },
                    "data": {
                        "employees": [
                            {"id": 1, "name": "Alice", "salary": 60000, "department": "Engineering"},
                            {"id": 2, "name": "Bob", "salary": 45000, "department": "Sales"},
                            {"id": 3, "name": "Charlie", "salary": 75000, "department": "Engineering"},
                            {"id": 4, "name": "Diana", "salary": 52000, "department": "HR"},
                            {"id": 5, "name": "Eve", "salary": 48000, "department": "Sales"},
                        ]
                    },
                },
                goal="Write a SQL query to calculate average salary per department",
                max_steps=5,
                timeout_ms=20000,
                ground_truth="SELECT department, AVG(salary) as avg_salary FROM employees GROUP BY department",
                difficulty=TaskDifficulty.MEDIUM,
            ),
        ]

    def _generate_webshop_tasks(self) -> list[AgentBenchTask]:
        """Generate sample WebShop tasks."""
        return [
            AgentBenchTask(
                id="ws-001",
                environment=AgentBenchEnvironment.WEB_SHOPPING,
                description="Buy a pair of black wireless headphones under $100",
                initial_state={"budget": 100},
                goal="Purchase wireless headphones in black color within budget",
                max_steps=15,
                timeout_ms=60000,
                metadata={"target_product": "P001", "required_options": {"color": "black"}},
                difficulty=TaskDifficulty.EASY,
            ),
            AgentBenchTask(
                id="ws-002",
                environment=AgentBenchEnvironment.WEB_SHOPPING,
                description="Find and buy the highest-rated product in the Sports category",
                initial_state={"budget": 200},
                goal="Purchase the highest-rated sports product",
                max_steps=20,
                timeout_ms=60000,
                metadata={"target_category": "Sports", "selection_criteria": "highest_rating"},
                difficulty=TaskDifficulty.MEDIUM,
            ),
        ]

    def _generate_kg_tasks(self) -> list[AgentBenchTask]:
        """Generate sample knowledge graph tasks."""
        return [
            AgentBenchTask(
                id="kg-001",
                environment=AgentBenchEnvironment.KNOWLEDGE_GRAPH,
                description="Where was Albert Einstein born?",
                initial_state={},
                goal="Find the birthplace of Albert Einstein",
                max_steps=10,
                timeout_ms=30000,
                ground_truth="Germany",
                difficulty=TaskDifficulty.EASY,
            ),
            AgentBenchTask(
                id="kg-002",
                environment=AgentBenchEnvironment.KNOWLEDGE_GRAPH,
                description="Find all people who won the Nobel Prize in Physics",
                initial_state={},
                goal="List all Nobel Prize in Physics winners in the knowledge graph",
                max_steps=15,
                timeout_ms=45000,
                ground_truth="Albert Einstein, Marie Curie",
                difficulty=TaskDifficulty.MEDIUM,
            ),
            AgentBenchTask(
                id="kg-003",
                environment=AgentBenchEnvironment.KNOWLEDGE_GRAPH,
                description="Which continent is the birthplace of Marie Curie located in?",
                initial_state={},
                goal="Find the continent of Marie Curie's birthplace through multi-hop reasoning",
                max_steps=15,
                timeout_ms=45000,
                ground_truth="Europe",
                difficulty=TaskDifficulty.HARD,
            ),
        ]

    def _generate_lateral_thinking_tasks(self) -> list[AgentBenchTask]:
        """Generate lateral thinking puzzle tasks."""
        return [
            AgentBenchTask(
                id="lt-001",
                environment=AgentBenchEnvironment.LATERAL_THINKING,
                description="A man walks into a bar and asks for a glass of water. The bartender pulls out a gun and points it at him. The man says 'Thank you' and walks out. Why?",
                initial_state={"puzzle_id": "ltp001"},
                goal="Figure out why the man thanked the bartender",
                max_steps=20,
                timeout_ms=120000,
                ground_truth="hiccups",
                hints=[
                    "The man had a physical condition.",
                    "The gun wasn't meant to harm him.",
                    "Fear can cure certain conditions.",
                ],
                difficulty=TaskDifficulty.MEDIUM,
            ),
            AgentBenchTask(
                id="lt-002",
                environment=AgentBenchEnvironment.LATERAL_THINKING,
                description="A man is found dead in a field with an unopened package next to him. There are no other people, animals, or vehicles nearby. How did he die?",
                initial_state={"puzzle_id": "ltp002"},
                goal="Figure out how the man died",
                max_steps=20,
                timeout_ms=120000,
                ground_truth="parachute",
                hints=[
                    "The package is related to his death.",
                    "He fell from somewhere.",
                    "The package should have opened before he landed.",
                ],
                difficulty=TaskDifficulty.HARD,
            ),
        ]

    def _generate_report(self) -> AgentBenchReport:
        """Generate comprehensive benchmark report."""
        # Calculate per-environment metrics
        env_reports: dict[AgentBenchEnvironment, EnvironmentReport] = {}

        for env in AgentBenchEnvironment:
            env_results = [r for r in self._results if r.environment == env]
            if not env_results:
                continue

            passed = len([r for r in env_results if r.success])
            failed = len(env_results) - passed

            env_reports[env] = EnvironmentReport(
                environment=env,
                total_tasks=len(env_results),
                passed_tasks=passed,
                failed_tasks=failed,
                success_rate=passed / len(env_results) if env_results else 0,
                average_steps=sum(r.steps_taken for r in env_results) / len(env_results),
                average_duration_ms=sum(r.duration_ms for r in env_results) / len(env_results),
                average_reward=sum(r.metrics.get("reward", 0) for r in env_results) / len(env_results),
                results=env_results,
            )

        # Calculate overall metrics
        total_tasks = len(self._results)
        passed_tasks = len([r for r in self._results if r.success])
        failed_tasks = total_tasks - passed_tasks

        overall_metrics = {
            "total_tokens": sum(r.metrics.get("tokens_used", 0) for r in self._results),
            "average_tokens_per_task": (
                sum(r.metrics.get("tokens_used", 0) for r in self._results) / total_tasks
                if total_tasks > 0
                else 0
            ),
            "average_steps_per_task": (
                sum(r.steps_taken for r in self._results) / total_tasks if total_tasks > 0 else 0
            ),
            "average_reward": (
                sum(r.metrics.get("reward", 0) for r in self._results) / total_tasks
                if total_tasks > 0
                else 0
            ),
            "memory_usage": self.memory_tracker.get_stats(),
        }

        # Compare with baselines
        if self.config.enable_baseline_comparison:
            comparison = self._compare_with_baselines(env_reports)
        else:
            comparison = {"gpt4_comparison": {}, "gpt35_comparison": {}, "claude_comparison": {}}

        # Generate summary
        summary = self._generate_summary(env_reports, overall_metrics, comparison)

        return AgentBenchReport(
            total_tasks=total_tasks,
            passed_tasks=passed_tasks,
            failed_tasks=failed_tasks,
            overall_success_rate=passed_tasks / total_tasks if total_tasks > 0 else 0,
            average_duration_ms=(
                sum(r.duration_ms for r in self._results) / total_tasks if total_tasks > 0 else 0
            ),
            environment_reports=env_reports,
            overall_metrics=overall_metrics,
            comparison_to_baseline=comparison,
            summary=summary,
        )

    def _compare_with_baselines(
        self, env_reports: dict[AgentBenchEnvironment, EnvironmentReport]
    ) -> BaselineComparisonType:
        """Compare results with published baselines."""
        comparison: BaselineComparisonType = {
            "gpt4_comparison": {},
            "gpt35_comparison": {},
            "claude_comparison": {},
        }

        for env, report in env_reports.items():
            our_score = report.success_rate

            if env in GPT4_BASELINE_SCORES:
                gpt4_score = GPT4_BASELINE_SCORES[env]
                comparison["gpt4_comparison"][env.value] = {
                    "our_score": our_score,
                    "gpt4_score": gpt4_score,
                    "difference": our_score - gpt4_score,
                    "relative_performance": our_score / gpt4_score if gpt4_score > 0 else 0,
                }

            if env in GPT35_BASELINE_SCORES:
                gpt35_score = GPT35_BASELINE_SCORES[env]
                comparison["gpt35_comparison"][env.value] = {
                    "our_score": our_score,
                    "gpt35_score": gpt35_score,
                    "difference": our_score - gpt35_score,
                    "relative_performance": our_score / gpt35_score if gpt35_score > 0 else 0,
                }

            if env in CLAUDE_BASELINE_SCORES:
                claude_score = CLAUDE_BASELINE_SCORES[env]
                comparison["claude_comparison"][env.value] = {
                    "our_score": our_score,
                    "claude_score": claude_score,
                    "difference": our_score - claude_score,
                    "relative_performance": our_score / claude_score if claude_score > 0 else 0,
                }

        return comparison

    def _generate_summary(
        self,
        env_reports: dict[AgentBenchEnvironment, EnvironmentReport],
        metrics: OverallMetricsType,
        comparison: BaselineComparisonType,
    ) -> SummaryType:
        """Generate executive summary of benchmark results."""
        key_findings: list[str] = []
        recommendations: list[str] = []

        # Analyze overall performance
        total_success_rate = sum(r.success_rate for r in env_reports.values()) / len(env_reports) if env_reports else 0

        if total_success_rate > 0.6:
            status = "strong"
            key_findings.append("ElizaOS demonstrates strong agent capabilities across tested environments")
        elif total_success_rate > 0.3:
            status = "moderate"
            key_findings.append("ElizaOS shows moderate agent capabilities with room for improvement")
        else:
            status = "needs_improvement"
            key_findings.append("ElizaOS agent capabilities need significant improvement")

        # Analyze per-environment performance
        strong_envs = [e.value for e, r in env_reports.items() if r.success_rate > 0.5]
        weak_envs = [e.value for e, r in env_reports.items() if r.success_rate < 0.3]

        if strong_envs:
            key_findings.append(f"Strong performance in: {', '.join(strong_envs)}")

        if weak_envs:
            key_findings.append(f"Needs improvement in: {', '.join(weak_envs)}")
            for env in weak_envs:
                recommendations.append(f"Enhance {env} environment handling capabilities")

        # Compare with GPT-4 baseline
        gpt4_comparison = comparison.get("gpt4_comparison", {})
        beats_gpt4 = [
            env for env, data in gpt4_comparison.items() if data.get("difference", 0.0) > 0.0
        ]
        if beats_gpt4:
            key_findings.append(
                f"Higher success rate than published GPT-4 baseline (reference) in: {', '.join(beats_gpt4)}"
            )
        if gpt4_comparison:
            key_findings.append(
                "Note: baseline scores are published AgentBench results; comparisons are reference-only unless you run the official AgentBench task set."
            )

        # Efficiency analysis
        avg_steps_val = metrics.get("average_steps_per_task", 0.0)
        avg_steps = float(avg_steps_val) if isinstance(avg_steps_val, (int, float)) else 0.0
        if avg_steps > 15.0:
            recommendations.append("Optimize action planning to reduce steps per task")

        return {
            "status": status,
            "key_findings": key_findings,
            "recommendations": recommendations,
            "timestamp": datetime.now().isoformat(),
        }

    async def _save_results(self, report: AgentBenchReport) -> None:
        """Save benchmark results to files."""
        try:
            output_dir = Path(self.config.output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)

            # Convert report to dict
            report_dict = {
                "total_tasks": report.total_tasks,
                "passed_tasks": report.passed_tasks,
                "failed_tasks": report.failed_tasks,
                "overall_success_rate": report.overall_success_rate,
                "average_duration_ms": report.average_duration_ms,
                "overall_metrics": report.overall_metrics,
                "comparison_to_baseline": report.comparison_to_baseline,
                "summary": report.summary,
                "environment_reports": {
                    env.value: {
                        "environment": env.value,
                        "total_tasks": r.total_tasks,
                        "passed_tasks": r.passed_tasks,
                        "failed_tasks": r.failed_tasks,
                        "success_rate": r.success_rate,
                        "average_steps": r.average_steps,
                        "average_duration_ms": r.average_duration_ms,
                        "average_reward": r.average_reward,
                    }
                    for env, r in report.environment_reports.items()
                },
            }

            # Save JSON report
            json_path = output_dir / "agentbench-results.json"
            with open(json_path, "w") as f:
                # Intentionally do NOT use default=str; we want strict JSON output.
                json.dump(report_dict, f, indent=2)

            # Save markdown report
            md_path = output_dir / "agentbench-report.md"
            md_content = self._generate_markdown_report(report)
            with open(md_path, "w") as f:
                f.write(md_content)

            # Save detailed results if enabled
            if self.config.save_detailed_logs:
                detailed_path = output_dir / "agentbench-detailed.json"
                detailed = [self._result_to_json(r) for r in self._results]
                with open(detailed_path, "w") as f:
                    json.dump(detailed, f, indent=2)

            logger.info(f"[AgentBenchRunner] Results saved to {output_dir}")

        except Exception as e:
            logger.error(f"[AgentBenchRunner] Failed to save results: {e}")
            raise

    def _result_to_json(self, r: AgentBenchResult) -> dict[str, JSONValue]:
        """
        Convert an AgentBenchResult to a strictly JSON-serializable dict.

        We intentionally avoid json.dump(default=str) to ensure output is validated.
        """
        return {
            "task_id": r.task_id,
            "environment": r.environment.value,
            "success": r.success,
            "steps_taken": r.steps_taken,
            "actions": list(r.actions),
            "final_state": r.final_state,
            "duration_ms": r.duration_ms,
            "error": r.error,
            "metrics": dict(r.metrics),
            "details": dict(r.details),
            "step_records": [
                {
                    "step_number": s.step_number,
                    "action": s.action,
                    "observation": s.observation,
                    "reward": s.reward,
                    "timestamp_ms": s.timestamp_ms,
                    "metadata": dict(s.metadata),
                }
                for s in r.step_records
            ],
        }

    def _generate_markdown_report(self, report: AgentBenchReport) -> str:
        """Generate markdown report."""
        md = f"""# AgentBench Evaluation Results - ElizaOS Python

## Executive Summary

- **Status**: {report.summary['status'].upper()}
- **Overall Success Rate**: {report.overall_success_rate * 100:.1f}%
- **Total Tasks**: {report.total_tasks} ({report.passed_tasks} passed, {report.failed_tasks} failed)
- **Average Duration**: {report.average_duration_ms:.0f}ms per task

### Key Findings

"""
        for finding in report.summary.get("key_findings", []):
            md += f"- {finding}\n"

        md += """
### Recommendations

"""
        for rec in report.summary.get("recommendations", []):
            md += f"- {rec}\n"

        md += """
## Environment Breakdown

| Environment | Success Rate | Tasks | Avg Steps | Avg Duration |
|-------------|-------------|-------|-----------|--------------|
"""
        for env, env_report in report.environment_reports.items():
            md += f"| {env.value} | {env_report.success_rate * 100:.1f}% | {env_report.total_tasks} | {env_report.average_steps:.1f} | {env_report.average_duration_ms:.0f}ms |\n"

        # Comparison with baselines
        md += """
## Comparison with Published Baselines

### vs GPT-4

| Environment | ElizaOS | GPT-4 | Difference |
|-------------|---------|-------|------------|
"""
        gpt4_comp = report.comparison_to_baseline.get("gpt4_comparison", {})
        for env_name, data in gpt4_comp.items():
            diff = data.get("difference", 0) * 100
            diff_str = f"+{diff:.1f}%" if diff > 0 else f"{diff:.1f}%"
            md += f"| {env_name} | {data.get('our_score', 0) * 100:.1f}% | {data.get('gpt4_score', 0) * 100:.1f}% | {diff_str} |\n"

        md += """
### vs GPT-3.5

| Environment | ElizaOS | GPT-3.5 | Difference |
|-------------|---------|---------|------------|
"""
        gpt35_comp = report.comparison_to_baseline.get("gpt35_comparison", {})
        for env_name, data in gpt35_comp.items():
            diff = data.get("difference", 0) * 100
            diff_str = f"+{diff:.1f}%" if diff > 0 else f"{diff:.1f}%"
            md += f"| {env_name} | {data.get('our_score', 0) * 100:.1f}% | {data.get('gpt35_score', 0) * 100:.1f}% | {diff_str} |\n"

        mem_usage = report.overall_metrics.get("memory_usage")
        mem_dict = mem_usage if isinstance(mem_usage, dict) else {"peak": 0, "average": 0}
        peak = mem_dict.get("peak", 0) if isinstance(mem_dict.get("peak", 0), int) else 0
        avg = mem_dict.get("average", 0) if isinstance(mem_dict.get("average", 0), int) else 0
        avg_tokens_val = report.overall_metrics.get("average_tokens_per_task", 0.0)
        avg_tokens = float(avg_tokens_val) if isinstance(avg_tokens_val, (int, float)) else 0.0

        md += f"""
## Resource Usage

- **Peak Memory**: {peak / 1024 / 1024:.1f}MB
- **Average Memory**: {avg / 1024 / 1024:.1f}MB
- **Average Tokens per Task**: {avg_tokens:.0f}

---
*Generated on {report.summary.get('timestamp', datetime.now().isoformat())}*
*Benchmark: AgentBench (ICLR 2024)*
*Framework: ElizaOS Python*
"""
        return md

    async def _cleanup(self) -> None:
        """Cleanup all adapters."""
        for env, adapter in self._adapters.items():
            try:
                await adapter.cleanup()
                logger.info(f"[AgentBenchRunner] Cleaned up {env.value} adapter")
            except Exception as e:
                logger.error(f"[AgentBenchRunner] Failed to cleanup {env.value}: {e}")
        self._adapters = {}


async def run_agentbench(
    config: AgentBenchConfig | None = None,
    runtime: AgentRuntimeProtocol | None = None,
) -> AgentBenchReport:
    """
    Convenience function to run AgentBench benchmarks.

    Args:
        config: Benchmark configuration. If None, uses default config.
        runtime: ElizaOS runtime instance. If None, uses mock responses.

    Returns:
        AgentBenchReport with full benchmark results.
    """
    if config is None:
        config = AgentBenchConfig()

    runner = AgentBenchRunner(config=config, runtime=runtime)
    return await runner.run_benchmarks()
