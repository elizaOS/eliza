"""
BFCL Benchmark Runner

Main runner that orchestrates BFCL benchmark execution.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

from benchmarks.bfcl.agent import BFCLAgent, MockBFCLAgent
from benchmarks.bfcl.dataset import BFCLDataset
from benchmarks.bfcl.evaluators import ASTEvaluator, ExecutionEvaluator, RelevanceEvaluator
from benchmarks.bfcl.metrics import MetricsCalculator
from benchmarks.bfcl.reporting import BFCLReporter
from benchmarks.bfcl.types import (
    BFCLBenchmarkResults,
    BFCLCategory,
    BFCLConfig,
    BFCLMetrics,
    BFCLResult,
    BFCLTestCase,
)

logger = logging.getLogger(__name__)


class BFCLRunner:
    """
    Main benchmark runner for BFCL.

    Orchestrates:
    - Dataset loading
    - Agent initialization
    - Test execution
    - Evaluation
    - Metrics calculation
    - Report generation
    
    Default model: Groq llama-3.1-8b-instant (fast, efficient)
    Override with provider/model args or BFCL_PROVIDER/BFCL_MODEL env vars.
    """

    def __init__(
        self,
        config: BFCLConfig,
        agent: Optional[BFCLAgent] = None,
        use_mock_agent: bool = False,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ):
        """
        Initialize BFCL runner.

        Args:
            config: Benchmark configuration
            agent: Optional pre-configured agent
            use_mock_agent: If True, use mock agent for testing
            provider: Model provider (groq, openai, anthropic, etc.)
            model: Specific model name (e.g., "groq/llama-3.1-8b-instant")
        """
        self.config = config
        self.dataset = BFCLDataset(config)
        self.ast_evaluator = ASTEvaluator()
        self.exec_evaluator = ExecutionEvaluator()
        self.relevance_evaluator = RelevanceEvaluator()
        self.metrics_calculator = MetricsCalculator()
        self.reporter = BFCLReporter(config)

        if use_mock_agent:
            self.agent: BFCLAgent | MockBFCLAgent = MockBFCLAgent(config)
            self._model_name: Optional[str] = "mock"
        elif agent:
            self.agent = agent
            self._model_name = getattr(agent, 'model_name', None)
        else:
            self.agent = BFCLAgent(config, provider=provider, model=model)
            self._model_name = None  # Will be set after initialization

        self._results: list[BFCLResult] = []
        self._provider = provider
        self._model = model

    async def run(self) -> BFCLBenchmarkResults:
        """
        Run the full BFCL benchmark.

        Returns:
            Complete benchmark results
        """
        start_time = time.time()
        logger.info("Starting BFCL benchmark...")

        try:
            # Initialize
            await self._initialize()

            # Load dataset
            await self.dataset.load()
            logger.info(f"Loaded {len(self.dataset)} test cases")

            # Print dataset statistics
            stats = self.dataset.get_statistics()
            logger.info(f"Dataset statistics: {stats}")

            # Run tests
            self._results = await self._run_all_tests()

            # Calculate metrics
            metrics = self.metrics_calculator.calculate(self._results)

            # Calculate baseline comparison
            baseline_comparison = self.metrics_calculator.compare_to_baselines(metrics)

            # Generate summary
            summary = self._generate_summary(metrics, baseline_comparison)

            # Get model name from agent
            if hasattr(self.agent, 'model_name'):
                self._model_name = self.agent.model_name
            
            # Create results object
            duration_ms = (time.time() - start_time) * 1000
            results = BFCLBenchmarkResults(
                metadata={
                    "benchmark": "BFCL",
                    "version": self.config.version,
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "duration_ms": duration_ms,
                    "total_tests": len(self._results),
                    "model": self._model_name or "unknown",
                },
                config=self.config,
                metrics=metrics,
                results=self._results,
                baseline_comparison=baseline_comparison,
                summary=summary,
                model_name=self._model_name,
                provider=self._provider,
            )

            # Generate report
            if self.config.generate_report:
                await self.reporter.generate_report(results)

            logger.info(
                f"BFCL benchmark completed in {duration_ms:.2f}ms. "
                f"Overall score: {metrics.overall_score:.2%}"
            )

            return results

        finally:
            await self._cleanup()

    async def _initialize(self) -> None:
        """Initialize runner components."""
        await self.agent.initialize()
        
        # Get model name from agent after initialization
        if hasattr(self.agent, 'model_name') and self.agent.model_name:
            self._model_name = self.agent.model_name

        # Set up execution evaluator with standard mocks
        self.exec_evaluator.setup_standard_mocks()

    async def _cleanup(self) -> None:
        """Clean up resources and export trajectories."""
        # Export trajectories for training if available
        if hasattr(self.agent, 'export_trajectories') and hasattr(self.agent, 'get_trajectories'):
            trajectories = self.agent.get_trajectories()
            logger.debug(f"Trajectories available for export: {len(trajectories) if trajectories else 0}")
            if trajectories:
                import os
                output_dir = self.config.output_dir or "benchmark_results/bfcl"
                os.makedirs(output_dir, exist_ok=True)
                
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                model_suffix = (self._model_name or "unknown").replace("/", "_").replace(".", "-")
                traj_dir = os.path.join(output_dir, "trajectories")
                os.makedirs(traj_dir, exist_ok=True)

                # Export training-friendly formats when possible.
                art_path = os.path.join(traj_dir, f"bfcl_art_{model_suffix}_{timestamp}.jsonl")
                grpo_path = os.path.join(traj_dir, f"bfcl_grpo_{model_suffix}_{timestamp}.json")
                jsonl_path = os.path.join(traj_dir, f"bfcl_raw_{model_suffix}_{timestamp}.jsonl")

                exported_any = False
                try:
                    export_path = self.agent.export_trajectories(art_path, format="art")
                    if export_path:
                        exported_any = True
                        logger.info(f"Exported BFCL ART trajectories to {export_path}")
                except Exception:
                    pass
                try:
                    export_path = self.agent.export_trajectories(grpo_path, format="grpo")
                    if export_path:
                        exported_any = True
                        logger.info(f"Exported BFCL GRPO trajectories to {export_path}")
                except Exception:
                    pass

                if not exported_any:
                    # Fallback: raw JSONL dump
                    export_path = self.agent.export_trajectories(jsonl_path, format="jsonl")
                    if export_path:
                        logger.info(f"Exported {len(trajectories)} raw trajectories to {export_path}")
                    else:
                        logger.warning("Trajectory export returned None")
            else:
                logger.debug("No trajectories to export")
        else:
            logger.debug("Agent does not support trajectory export")
        
        await self.agent.close()

    async def _run_all_tests(self) -> list[BFCLResult]:
        """Run all test cases."""
        results: list[BFCLResult] = []
        total = len(self.dataset)

        for i, test_case in enumerate(self.dataset):
            logger.debug(f"Running test {i + 1}/{total}: {test_case.id}")

            try:
                result = await self._run_single_test(test_case)
                results.append(result)

                if (i + 1) % 10 == 0:
                    logger.info(f"Progress: {i + 1}/{total} tests completed")

            except Exception as e:
                logger.error(f"Test {test_case.id} failed with error: {e}")
                results.append(BFCLResult(
                    test_case_id=test_case.id,
                    category=test_case.category,
                    predicted_calls=[],
                    expected_calls=test_case.expected_calls,
                    ast_match=False,
                    exec_success=False,
                    relevance_correct=False,
                    latency_ms=0,
                    error=str(e),
                ))

        return results

    async def _run_single_test(self, test_case: BFCLTestCase) -> BFCLResult:
        """Run a single test case."""
        # Execute query
        predicted_calls, raw_response, latency_ms = await self.agent.query(test_case)

        # Register mocks for execution evaluation
        self.exec_evaluator.register_mocks_from_definitions(test_case.functions)

        # Handle tests without ground truth (e.g., REST API)
        if not test_case.has_ground_truth:
            logger.debug(f"Skipping AST evaluation for {test_case.id}: no ground truth available")
            return BFCLResult(
                test_case_id=test_case.id,
                category=test_case.category,
                predicted_calls=predicted_calls,
                expected_calls=[],
                ast_match=False,  # Cannot evaluate without ground truth
                exec_success=False,
                relevance_correct=True,  # Assume relevant if it made calls
                latency_ms=latency_ms,
                raw_response=raw_response if self.config.save_raw_responses else None,
                details={"no_ground_truth": True, "predicted_count": len(predicted_calls)},
                error="No ground truth available for this test case",
            )

        # Evaluate AST
        ast_match = False
        if self.config.run_ast_eval:
            ast_match = self.ast_evaluator.evaluate(
                predicted_calls,
                test_case.expected_calls,
            )

        # Evaluate execution
        exec_success = False
        if self.config.run_exec_eval and ast_match:
            exec_success, _, _ = await self.exec_evaluator.execute_all(predicted_calls)

        # Evaluate relevance
        relevance_correct = True
        if self.config.run_relevance_eval:
            relevance_correct = self.relevance_evaluator.evaluate(
                predicted_calls,
                test_case.is_relevant,
                raw_response,
            )

        # Get detailed match info
        details = self.ast_evaluator.get_match_details(
            predicted_calls,
            test_case.expected_calls,
        )

        # Update trajectory reward with evaluation results
        if hasattr(self.agent, 'update_trajectory_reward'):
            reward = 0.0
            if ast_match:
                reward += 0.5
            if exec_success:
                reward += 0.3
            if relevance_correct:
                reward += 0.2
            self.agent.update_trajectory_reward(
                test_case.id,
                reward=reward,
                ast_match=ast_match,
                exec_match=exec_success,
            )
        
        return BFCLResult(
            test_case_id=test_case.id,
            category=test_case.category,
            predicted_calls=predicted_calls,
            expected_calls=test_case.expected_calls,
            ast_match=ast_match,
            exec_success=exec_success,
            relevance_correct=relevance_correct,
            latency_ms=latency_ms,
            raw_response=raw_response if self.config.save_raw_responses else None,
            details=details,
        )

    def _generate_summary(
        self,
        metrics: BFCLMetrics,
        baseline_comparison: dict[str, float],
    ) -> dict[str, str | list[str]]:
        """Generate human-readable summary."""
        summary: dict[str, str | list[str]] = {}

        # Overall status
        if metrics.overall_score >= 0.8:
            summary["status"] = "excellent"
        elif metrics.overall_score >= 0.6:
            summary["status"] = "good"
        elif metrics.overall_score >= 0.4:
            summary["status"] = "fair"
        else:
            summary["status"] = "needs_improvement"

        # Key findings
        findings: list[str] = []

        findings.append(
            f"Overall score: {metrics.overall_score:.2%} "
            f"(AST: {metrics.ast_accuracy:.2%}, Exec: {metrics.exec_accuracy:.2%})"
        )

        # Best/worst categories
        if metrics.category_metrics:
            sorted_cats = sorted(
                metrics.category_metrics.items(),
                key=lambda x: x[1].ast_accuracy,
                reverse=True,
            )
            best = sorted_cats[0] if sorted_cats else None
            worst = sorted_cats[-1] if len(sorted_cats) > 1 else None

            if best:
                findings.append(
                    f"Best category: {best[0].value} ({best[1].ast_accuracy:.2%})"
                )
            if worst and worst != best:
                findings.append(
                    f"Needs work: {worst[0].value} ({worst[1].ast_accuracy:.2%})"
                )

        # Baseline comparison
        if baseline_comparison:
            closest = min(
                baseline_comparison.items(),
                key=lambda x: abs(x[1]),
            )
            if closest[1] > 0:
                findings.append(f"Outperforms {closest[0]} by {closest[1]:.2%}")
            else:
                findings.append(f"Behind {closest[0]} by {abs(closest[1]):.2%}")

        summary["key_findings"] = findings

        # Recommendations
        recommendations: list[str] = []

        if metrics.ast_accuracy < 0.7:
            recommendations.append(
                "Focus on improving function name and argument matching"
            )
        if metrics.exec_accuracy < 0.7:
            recommendations.append(
                "Improve argument type handling and validation"
            )
        if metrics.relevance_accuracy < 0.8:
            recommendations.append(
                "Better detection of irrelevant queries"
            )

        summary["recommendations"] = recommendations

        return summary

    async def run_category(
        self,
        category: BFCLCategory,
    ) -> list[BFCLResult]:
        """Run tests for a specific category only."""
        await self._initialize()
        await self.dataset.load()

        try:
            results: list[BFCLResult] = []
            for test_case in self.dataset.get_by_category(category):
                result = await self._run_single_test(test_case)
                results.append(result)

            return results
        finally:
            await self._cleanup()

    async def run_sample(
        self,
        n: int = 50,
        categories: Optional[list[BFCLCategory]] = None,
    ) -> BFCLBenchmarkResults:
        """
        Run a quick sample of tests for rapid evaluation.

        Args:
            n: Number of tests to run
            categories: Optional category filter

        Returns:
            Benchmark results from sample
        """
        await self._initialize()
        await self.dataset.load()

        try:
            # Get stratified sample
            sample = self.dataset.get_sample(n, categories)
            logger.info(f"Running sample of {len(sample)} tests")

            results: list[BFCLResult] = []
            for test_case in sample:
                result = await self._run_single_test(test_case)
                results.append(result)

            # Calculate metrics
            metrics = self.metrics_calculator.calculate(results)
            baseline_comparison = self.metrics_calculator.compare_to_baselines(metrics)
            
            # Get model name from agent
            if hasattr(self.agent, 'model_name') and self.agent.model_name:
                self._model_name = self.agent.model_name

            benchmark_results = BFCLBenchmarkResults(
                metadata={
                    "benchmark": "BFCL",
                    "version": self.config.version,
                    "mode": "sample",
                    "sample_size": len(sample),
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "model": self._model_name or "unknown",
                },
                config=self.config,
                metrics=metrics,
                results=results,
                baseline_comparison=baseline_comparison,
                summary=self._generate_summary(metrics, baseline_comparison),
                model_name=self._model_name,
                provider=self._provider,
            )

            # Generate report if configured
            if self.config.generate_report:
                await self.reporter.generate_report(benchmark_results)

            return benchmark_results
        finally:
            await self._cleanup()

    def get_results(self) -> list[BFCLResult]:
        """Get results from the last run."""
        return self._results.copy()


async def run_bfcl_benchmark(
    config: Optional[BFCLConfig] = None,
    use_mock: bool = False,
) -> BFCLBenchmarkResults:
    """
    Convenience function to run BFCL benchmark.

    Args:
        config: Optional configuration (uses defaults if not provided)
        use_mock: If True, use mock agent

    Returns:
        Benchmark results
    """
    if config is None:
        config = BFCLConfig()

    runner = BFCLRunner(config, use_mock_agent=use_mock)
    return await runner.run()
