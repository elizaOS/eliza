"""
Terminal-Bench Runner

Orchestrates the full Terminal-Bench evaluation pipeline.
"""

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from elizaos_terminal_bench.agent import TerminalAgent
from elizaos_terminal_bench.dataset import TerminalBenchDataset
from elizaos_terminal_bench.environment import TerminalEnvironment
from elizaos_terminal_bench.evaluator import (
    TerminalBenchEvaluator,
    format_report_markdown,
)
from elizaos_terminal_bench.types import (
    TaskCategory,
    TaskDifficulty,
    TerminalBenchConfig,
    TerminalBenchReport,
    TerminalBenchResult,
    TerminalSession,
    TerminalTask,
)

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


class TerminalBenchRunner:
    """Orchestrates Terminal-Bench benchmark evaluation."""

    def __init__(
        self,
        runtime: Optional["AgentRuntime"] = None,
        config: Optional[TerminalBenchConfig] = None,
    ):
        """
        Initialize the benchmark runner.

        Args:
            runtime: Optional ElizaOS runtime for LLM access
            config: Benchmark configuration (uses defaults if not provided)
        """
        self.runtime = runtime
        self.config = config or TerminalBenchConfig()

        self.dataset: Optional[TerminalBenchDataset] = None
        self.evaluator = TerminalBenchEvaluator(
            timeout_seconds=self.config.timeout_per_task_seconds
        )

        self._results: list[TerminalBenchResult] = []
        self._setup_complete = False
        self._use_sample_tasks = False

    async def setup(self, use_sample_tasks: bool = False) -> None:
        """
        Initialize the benchmark runner.

        Args:
            use_sample_tasks: Use built-in sample tasks instead of full dataset
        """
        # Load dataset
        self.dataset = TerminalBenchDataset(
            data_path=Path(self.config.data_path) if self.config.data_path else None,
            version=self.config.version,
            use_sample_tasks=use_sample_tasks,
        )
        await self.dataset.load()

        # Create output directory
        output_path = Path(self.config.output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        self._use_sample_tasks = use_sample_tasks
        self._setup_complete = True
        logger.info(f"Runner setup complete. Loaded {len(self.dataset)} tasks.")

    async def run(
        self,
        categories: Optional[list[TaskCategory]] = None,
        difficulties: Optional[list[TaskDifficulty]] = None,
        task_ids: Optional[list[str]] = None,
        max_tasks: Optional[int] = None,
    ) -> TerminalBenchReport:
        """
        Run the benchmark evaluation.

        Args:
            categories: Filter by task categories
            difficulties: Filter by difficulty levels
            task_ids: Filter by specific task IDs
            max_tasks: Maximum number of tasks to run

        Returns:
            TerminalBenchReport with results and metrics
        """
        if not self._setup_complete or not self.dataset:
            raise RuntimeError("Runner not initialized. Call setup() first.")

        # Apply config filters if not overridden
        categories = categories or self.config.categories
        difficulties = difficulties or self.config.difficulties
        task_ids = task_ids or self.config.task_ids
        max_tasks = max_tasks or self.config.max_tasks

        # Filter tasks
        tasks = list(self.dataset.tasks)

        if categories:
            tasks = [t for t in tasks if t.category in categories]
        if difficulties:
            tasks = [t for t in tasks if t.difficulty in difficulties]
        if task_ids:
            id_set = set(task_ids)
            tasks = [t for t in tasks if t.task_id in id_set]
        if max_tasks:
            tasks = tasks[:max_tasks]

        if not tasks:
            logger.warning("No tasks to evaluate after filtering")
            return self._create_empty_report()

        logger.info(f"Running benchmark on {len(tasks)} tasks...")

        # Run evaluation
        self._results = []
        start_time = time.time()

        for idx, task in enumerate(tasks):
            logger.info(
                f"[{idx + 1}/{len(tasks)}] Running task: {task.task_id} "
                f"({task.category.value}, {task.difficulty.value})"
            )

            if self.config.dry_run:
                # Dry run - don't actually execute
                result = TerminalBenchResult(
                    task_id=task.task_id,
                    success=False,
                    commands_executed=0,
                    total_execution_time_ms=0,
                    test_output="Dry run - not executed",
                    category=task.category,
                    difficulty=task.difficulty,
                )
            else:
                result = await self._run_single_task(task)

            self._results.append(result)

            status = "✅ PASS" if result.success else "❌ FAIL"
            logger.info(
                f"  {status} | Commands: {result.commands_executed} | "
                f"Time: {result.total_execution_time_ms:.0f}ms"
            )

        evaluation_time = time.time() - start_time

        # Create report
        report = self.evaluator.create_report(
            results=self._results,
            evaluation_time_seconds=evaluation_time,
            metadata={
                "version": self.config.version,
                "model": "Oracle" if self.config.oracle else self.config.model_name,
                "max_iterations": self.config.max_iterations,
                "timestamp": datetime.now().isoformat(),
                "sample_tasks": self._use_sample_tasks,
            },
            # Leaderboard numbers are only meaningful on the official dataset,
            # not on built-in sample tasks.
            compare_leaderboard=self.config.compare_leaderboard and (not self._use_sample_tasks),
        )

        # Save report
        await self._save_report(report)

        # Log summary
        logger.info(f"\n{'='*50}")
        logger.info(f"Terminal-Bench Evaluation Complete")
        logger.info(f"{'='*50}")
        logger.info(f"Accuracy: {report.accuracy:.1%}")
        logger.info(f"Passed: {report.passed_tasks}/{report.total_tasks}")
        logger.info(f"Total Time: {report.evaluation_time_seconds:.1f}s")

        if report.leaderboard_comparison:
            logger.info(
                f"Leaderboard Rank: #{report.leaderboard_comparison.rank} "
                f"({report.leaderboard_comparison.our_score:.1f}%)"
            )

        return report

    async def run_single(self, task_id: str) -> TerminalBenchResult:
        """
        Run benchmark on a single task.

        Args:
            task_id: ID of the task to run

        Returns:
            TerminalBenchResult for the task
        """
        if not self._setup_complete or not self.dataset:
            raise RuntimeError("Runner not initialized. Call setup() first.")

        task = self.dataset.get_task(task_id)
        if not task:
            raise ValueError(f"Task not found: {task_id}")

        logger.info(f"Running single task: {task_id}")
        result = await self._run_single_task(task)

        status = "PASS" if result.success else "FAIL"
        logger.info(f"Result: {status}")

        return result

    async def _run_single_task(self, task: TerminalTask) -> TerminalBenchResult:
        """Run a single task and return the result."""
        if self.config.oracle:
            # Oracle mode: execute the reference solution and then run the test script.
            env = TerminalEnvironment(
                image=task.docker_image,
                timeout_seconds=task.timeout_seconds,
                network_mode="bridge" if task.network_enabled else "none",
            )
            session = TerminalSession(
                session_id=f"oracle_{task.task_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
                task=task,
                commands=[],
                working_directory="/workspace",
                environment_vars={},
                start_time=datetime.now(),
            )

            try:
                await env.start(task)
                cmd = await env.execute(task.reference_solution)
                session.commands.append(cmd)

                success, test_output, test_exit_code = await env.run_test(task.test_script)
                session.end_time = datetime.now()

                total_execution_time = sum(c.execution_time_ms for c in session.commands)
                return TerminalBenchResult(
                    task_id=task.task_id,
                    success=success,
                    commands_executed=len(session.commands),
                    total_execution_time_ms=total_execution_time,
                    test_output=test_output,
                    test_exit_code=test_exit_code,
                    tokens_used=0,
                    session=session,
                    category=task.category,
                    difficulty=task.difficulty,
                )
            finally:
                await env.stop()

        # Choose agent based on configuration
        if self.config.use_eliza_agent:
            # Full ElizaOS agent with message_service, actions, providers
            return await self._run_with_eliza_agent(task)
        else:
            # Standalone agent with direct API calls
            return await self._run_with_standalone_agent(task)

    async def _run_with_eliza_agent(self, task: TerminalTask) -> TerminalBenchResult:
        """Run task with full ElizaOS agent (canonical)."""
        from elizaos_terminal_bench.eliza_agent import ElizaTerminalAgent

        # Create environment
        env = TerminalEnvironment(
            image=task.docker_image,
            timeout_seconds=task.timeout_seconds,
            network_mode="bridge" if task.network_enabled else "none",
        )

        try:
            await env.start(task)

            # Create ElizaOS agent
            agent = ElizaTerminalAgent(
                environment=env,
                max_iterations=self.config.max_iterations,
                model_name=self.config.model_name,
                temperature=self.config.temperature,
                verbose=self.config.verbose,
            )

            result = await asyncio.wait_for(
                agent.solve_task(task),
                timeout=self.config.timeout_per_task_seconds,
            )
            return result

        except asyncio.TimeoutError:
            logger.warning(f"Task {task.task_id} timed out")
            return TerminalBenchResult(
                task_id=task.task_id,
                success=False,
                commands_executed=0,
                total_execution_time_ms=0,
                test_output="",
                error_message=f"Task timed out after {self.config.timeout_per_task_seconds}s",
                category=task.category,
                difficulty=task.difficulty,
            )

        except Exception as e:
            logger.error(f"Error running task {task.task_id} with Eliza agent: {e}")
            return TerminalBenchResult(
                task_id=task.task_id,
                success=False,
                commands_executed=0,
                total_execution_time_ms=0,
                test_output="",
                error_message=str(e),
                category=task.category,
                difficulty=task.difficulty,
            )

        finally:
            await env.stop()
            if "agent" in locals():
                await agent.cleanup()

    async def _run_with_standalone_agent(self, task: TerminalTask) -> TerminalBenchResult:
        """Run task with standalone agent (direct API calls)."""
        # Create agent for this task
        agent = TerminalAgent(
            runtime=self.runtime,
            environment=None,  # Agent will create its own
            max_iterations=self.config.max_iterations,
            model_name=self.config.model_name,
            temperature=self.config.temperature,
            verbose=self.config.verbose,
        )

        try:
            result = await asyncio.wait_for(
                agent.solve_task(task),
                timeout=self.config.timeout_per_task_seconds,
            )
            return result

        except asyncio.TimeoutError:
            logger.warning(f"Task {task.task_id} timed out")
            return TerminalBenchResult(
                task_id=task.task_id,
                success=False,
                commands_executed=0,
                total_execution_time_ms=0,
                test_output="",
                error_message=f"Task timed out after {self.config.timeout_per_task_seconds}s",
                category=task.category,
                difficulty=task.difficulty,
            )

        except Exception as e:
            logger.error(f"Error running task {task.task_id}: {e}")
            return TerminalBenchResult(
                task_id=task.task_id,
                success=False,
                commands_executed=0,
                total_execution_time_ms=0,
                test_output="",
                error_message=str(e),
                category=task.category,
                difficulty=task.difficulty,
            )

        finally:
            await agent.close()

    def _create_empty_report(self) -> TerminalBenchReport:
        """Create an empty report for when no tasks are run."""
        return TerminalBenchReport(
            total_tasks=0,
            passed_tasks=0,
            failed_tasks=0,
            accuracy=0.0,
            results=[],
            total_commands=0,
            avg_commands_per_task=0.0,
            total_tokens=0,
            avg_tokens_per_task=0.0,
            evaluation_time_seconds=0.0,
            avg_time_per_task_seconds=0.0,
        )

    async def _save_report(self, report: TerminalBenchReport) -> None:
        """Save the benchmark report to disk."""
        output_dir = Path(self.config.output_dir)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Save JSON report
        json_path = output_dir / f"terminal-bench-{timestamp}.json"
        json_report = self._report_to_dict(report)

        with open(json_path, "w") as f:
            json.dump(json_report, f, indent=2, default=str)

        logger.info(f"JSON report saved to {json_path}")

        # Save Markdown report
        if self.config.generate_markdown:
            md_path = output_dir / f"terminal-bench-{timestamp}.md"
            md_content = format_report_markdown(report)

            with open(md_path, "w") as f:
                f.write(md_content)

            logger.info(f"Markdown report saved to {md_path}")

        # Save detailed session logs
        if self.config.save_sessions:
            sessions_dir = output_dir / f"sessions-{timestamp}"
            sessions_dir.mkdir(exist_ok=True)

            for result in report.results:
                if result.session:
                    session_path = sessions_dir / f"{result.task_id}.json"
                    session_data = {
                        "session_id": result.session.session_id,
                        "task_id": result.task_id,
                        "success": result.success,
                        "commands": [
                            {
                                "command": cmd.command,
                                "stdout": cmd.stdout[:1000],
                                "stderr": cmd.stderr[:500],
                                "exit_code": cmd.exit_code,
                                "execution_time_ms": cmd.execution_time_ms,
                            }
                            for cmd in result.session.commands
                        ],
                        "total_tokens": result.session.total_tokens,
                    }
                    with open(session_path, "w") as f:
                        json.dump(session_data, f, indent=2, default=str)

            logger.info(f"Session logs saved to {sessions_dir}")

    def _report_to_dict(self, report: TerminalBenchReport) -> dict:
        """Convert report to dictionary for JSON serialization."""
        return {
            "metadata": {
                "timestamp": datetime.now().isoformat(),
                "version": self.config.version,
                **report.metadata,
            },
            "summary": {
                "total_tasks": report.total_tasks,
                "passed_tasks": report.passed_tasks,
                "failed_tasks": report.failed_tasks,
                "accuracy": report.accuracy,
                "total_commands": report.total_commands,
                "avg_commands_per_task": report.avg_commands_per_task,
                "total_tokens": report.total_tokens,
                "avg_tokens_per_task": report.avg_tokens_per_task,
                "evaluation_time_seconds": report.evaluation_time_seconds,
                "avg_time_per_task_seconds": report.avg_time_per_task_seconds,
            },
            "leaderboard_comparison": (
                {
                    "our_score": report.leaderboard_comparison.our_score,
                    "rank": report.leaderboard_comparison.rank,
                    "total_entries": report.leaderboard_comparison.total_entries,
                    "percentile": report.leaderboard_comparison.percentile,
                    "comparison": report.leaderboard_comparison.comparison,
                }
                if report.leaderboard_comparison
                else None
            ),
            "by_category": {
                cat.value: {
                    "total": metrics.total,
                    "passed": metrics.passed,
                    "failed": metrics.failed,
                    "accuracy": metrics.accuracy,
                    "avg_commands": metrics.avg_commands,
                    "avg_time_ms": metrics.avg_time_ms,
                }
                for cat, metrics in report.by_category.items()
            },
            "by_difficulty": {
                diff.value: {
                    "total": metrics.total,
                    "passed": metrics.passed,
                    "failed": metrics.failed,
                    "accuracy": metrics.accuracy,
                    "avg_commands": metrics.avg_commands,
                    "avg_time_ms": metrics.avg_time_ms,
                }
                for diff, metrics in report.by_difficulty.items()
            },
            "error_categories": report.error_categories,
            "results": [
                {
                    "task_id": r.task_id,
                    "success": r.success,
                    "commands_executed": r.commands_executed,
                    "total_execution_time_ms": r.total_execution_time_ms,
                    "tokens_used": r.tokens_used,
                    "test_exit_code": r.test_exit_code,
                    "error_message": r.error_message,
                    "category": r.category.value if r.category else None,
                    "difficulty": r.difficulty.value if r.difficulty else None,
                }
                for r in report.results
            ],
        }


async def run_terminal_bench(
    runtime: Optional["AgentRuntime"] = None,
    config: Optional[TerminalBenchConfig] = None,
    use_sample_tasks: bool = True,
) -> TerminalBenchReport:
    """
    Convenience function to run Terminal-Bench evaluation.

    Args:
        runtime: Optional ElizaOS runtime
        config: Optional configuration
        use_sample_tasks: Use sample tasks for testing

    Returns:
        TerminalBenchReport with results
    """
    runner = TerminalBenchRunner(runtime=runtime, config=config)
    await runner.setup(use_sample_tasks=use_sample_tasks)
    return await runner.run()
