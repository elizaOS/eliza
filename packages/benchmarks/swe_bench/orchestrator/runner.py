"""
Orchestrated SWE-bench benchmark runner.

Runs the orchestrated benchmark that tests whether an Eliza agent can
correctly orchestrate coding tasks through sub-agent providers, and
compares the results against direct (non-orchestrated) execution.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from ..dataset import SWEBenchDataset
from ..evaluator import SWEBenchEvaluator
from ..repo_manager import RepositoryManager
from ..runner import SWEBenchRunner
from ..types import PatchStatus, SWEBenchConfig, SWEBenchResult
from .agent import OrchestratingAgent
from .types import (
    ExecutionMode,
    OrchestratedBenchmarkConfig,
    OrchestratedBenchmarkReport,
    ProviderBenchmarkResult,
    ProviderType,
)

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


class OrchestratedSWEBenchRunner:
    """
    Runner for the orchestrated SWE-bench benchmark.

    This runner:
    1. Optionally runs the direct baseline (using the standard SWEAgent)
    2. For each configured provider, runs the orchestrated approach
    3. Evaluates all patches through the SWE-bench harness
    4. Compares orchestrated vs direct results
    5. Generates a comprehensive report
    """

    def __init__(
        self,
        runtime: AgentRuntime,
        config: OrchestratedBenchmarkConfig,
    ) -> None:
        self.runtime = runtime
        self.config = config
        self.dataset = SWEBenchDataset(config.variant)
        self.repo_manager = RepositoryManager(config.workspace_dir)

        dataset_name = (
            config.swebench_dataset_name
            or SWEBenchDataset.DATASET_MAPPING[config.variant]
        )
        self.evaluator = SWEBenchEvaluator(
            use_docker=config.use_docker_eval,
            timeout_seconds=config.timeout_seconds,
            dataset_name=dataset_name,
            max_workers=config.swebench_max_workers,
            namespace=config.swebench_namespace,
            instance_image_tag=config.swebench_instance_image_tag,
            env_image_tag=config.swebench_env_image_tag,
        )

        # The orchestrating agent
        self.agent = OrchestratingAgent(runtime, self.repo_manager, config)

    async def run_benchmark(self) -> OrchestratedBenchmarkReport:
        """Run the full orchestrated benchmark."""
        start_time = time.time()

        # Initialize the orchestrating agent
        await self.agent.initialize()

        # Load dataset
        logger.info(f"Loading SWE-bench {self.config.variant.value} dataset...")
        await self.dataset.load()

        instances = self.dataset.get_instances(
            repo_filter=self.config.repo_filter,
            limit=self.config.max_instances,
        )
        logger.info("Running benchmark on %s instances...", len(instances))

        report = OrchestratedBenchmarkReport(config=self.config)

        # Step 1: Run direct baseline if configured
        if self.config.run_direct_baseline:
            logger.info("=" * 60)
            logger.info("PHASE 1: Direct baseline (non-orchestrated)")
            logger.info("=" * 60)

            direct_config = SWEBenchConfig(
                variant=self.config.variant,
                workspace_dir=self.config.workspace_dir,
                output_dir=self.config.output_dir,
                max_steps=self.config.provider_max_steps,
                max_instances=self.config.max_instances,
                repo_filter=self.config.repo_filter,
                use_docker_eval=self.config.use_docker_eval,
                timeout_seconds=self.config.timeout_seconds,
                model_name=self.config.model_name,
                swebench_namespace=self.config.swebench_namespace,
                swebench_max_workers=self.config.swebench_max_workers,
            )

            direct_runner = SWEBenchRunner(self.runtime, direct_config)
            direct_report = await direct_runner.run_benchmark()
            report.direct_results = direct_report.results

            logger.info(
                f"Direct baseline: {direct_report.resolve_rate:.1%} resolve rate "
                f"({direct_report.resolved}/{direct_report.total_instances})"
            )

        modes = (
            [ExecutionMode.ORCHESTRATED, ExecutionMode.DIRECT_SHELL]
            if self.config.matrix
            else [self.config.execution_mode]
        )

        # Step 2: Run selected execution modes/providers
        for mode in modes:
            logger.info("=" * 60)
            logger.info("PHASE 2: %s", mode.value)
            logger.info("=" * 60)

            mode_results: dict[str, list[ProviderBenchmarkResult]] = {}
            for provider_type in self.config.providers:
                logger.info(
                    "Running %s via %s on %s instances",
                    mode.value,
                    provider_type.value,
                    len(instances),
                )
                provider_results: list[ProviderBenchmarkResult] = []

                for idx, instance in enumerate(instances):
                    logger.info(
                        "[%s/%s] %s via %s (%s)",
                        idx + 1,
                        len(instances),
                        instance.instance_id,
                        provider_type.value,
                        mode.value,
                    )

                    try:
                        result = await self.agent.execute_instance(
                            instance,
                            provider_type,
                            mode=mode,
                        )

                        # Evaluate the patch
                        if result.swe_result.generated_patch.strip():
                            eval_result = await self.evaluator.evaluate_patch(
                                instance,
                                result.swe_result.generated_patch,
                            )
                            result.swe_result.tests_passed = eval_result.tests_passed
                            result.swe_result.tests_failed = eval_result.tests_failed
                            result.swe_result.success = eval_result.success
                            result.swe_result.patch_status = eval_result.patch_status

                        provider_results.append(result)

                        status = "RESOLVED" if result.swe_result.success else "Failed"
                        logger.info(
                            "  %s | delegation=%s | orchestration=%.1fs | execution=%.1fs",
                            status,
                            result.delegation_successful,
                            result.orchestration_time_seconds,
                            result.provider_execution_time_seconds,
                        )
                        if result.capability_violations:
                            logger.warning(
                                "  capability_violations=%s",
                                ",".join(result.capability_violations),
                            )
                        if result.trace_file:
                            logger.info("  trace=%s", result.trace_file)

                    except Exception as e:
                        logger.error("Error: %s: %s", instance.instance_id, e)
                        provider_results.append(
                            ProviderBenchmarkResult(
                                provider=provider_type,
                                control_plane_mode=mode,
                                instance_id=instance.instance_id,
                                swe_result=SWEBenchResult(
                                    instance_id=instance.instance_id,
                                    generated_patch="",
                                    patch_status=PatchStatus.NOT_GENERATED,
                                    tests_passed=[],
                                    tests_failed=[],
                                    success=False,
                                    duration_seconds=0,
                                    tokens_used=0,
                                    error=str(e),
                                ),
                            )
                        )

                    # Reset repo for next instance
                    await self.repo_manager.reset_repo()

                mode_results[provider_type.value] = provider_results

            report.matrix_results[mode.value] = mode_results

        # Primary summary block follows selected execution mode.
        primary_mode_key = self.config.execution_mode.value
        if primary_mode_key in report.matrix_results:
            report.by_provider = report.matrix_results[primary_mode_key]
        elif report.matrix_results:
            report.by_provider = next(iter(report.matrix_results.values()))

        # Step 3: Compute summaries and comparison
        report.compute_summaries()

        # Step 4: Save report
        self._save_report(report)

        total_time = time.time() - start_time
        logger.info(f"\nOrchestrated benchmark complete in {total_time:.1f}s")
        self._print_summary(report)

        return report

    async def run_single_verification(
        self,
        instance_id: str,
        provider_type: ProviderType,
    ) -> ProviderBenchmarkResult:
        """
        Run a single instance with a specific provider for verification.

        This is useful for quickly verifying that each provider approach
        works correctly on at least one task.
        """
        await self.agent.initialize()
        await self.dataset.load()

        instance = next(
            (i for i in self.dataset.instances if i.instance_id == instance_id),
            None,
        )
        if not instance:
            raise ValueError(f"Instance not found: {instance_id}")

        logger.info(f"Verification run: {instance_id} via {provider_type.value}")

        result = await self.agent.execute_instance(
            instance,
            provider_type,
            mode=self.config.execution_mode,
        )

        # Evaluate
        if result.swe_result.generated_patch.strip():
            eval_result = await self.evaluator.evaluate_patch(
                instance,
                result.swe_result.generated_patch,
            )
            result.swe_result.tests_passed = eval_result.tests_passed
            result.swe_result.tests_failed = eval_result.tests_failed
            result.swe_result.success = eval_result.success
            result.swe_result.patch_status = eval_result.patch_status

        return result

    def _print_summary(self, report: OrchestratedBenchmarkReport) -> None:
        """Print a summary of the benchmark results."""
        print("\n" + "=" * 70)
        print("ORCHESTRATED SWE-BENCH BENCHMARK RESULTS")
        print("=" * 70)
        print(f"Execution Mode: {self.config.execution_mode.value}")
        if self.config.matrix:
            print("Matrix: enabled (direct_shell + orchestrated)")

        # Direct baseline
        if report.direct_results:
            direct_resolved = sum(1 for r in report.direct_results if r.success)
            direct_total = len(report.direct_results)
            direct_rate = direct_resolved / direct_total if direct_total > 0 else 0
            print(f"\nDirect Baseline: {direct_rate:.1%} ({direct_resolved}/{direct_total})")

        # Per-provider results
        for provider_key, summary in report.provider_summaries.items():
            print(
                f"\n--- {summary.provider.value} "
                f"({self.config.execution_mode.value}) ---"
            )
            print(f"  Resolve Rate:       {summary.resolve_rate:.1%} ({summary.resolved}/{summary.total_instances})")
            print(f"  Delegation Success: {summary.delegation_success_rate:.1%}")
            print(f"  Avg Duration:       {summary.average_duration:.1f}s")

            if report.direct_results:
                print(f"  vs Direct:")
                print(f"    Improvements:     {summary.improvements_over_direct}")
                print(f"    Regressions:      {summary.regressions_from_direct}")

        print("=" * 70)

    def _save_report(self, report: OrchestratedBenchmarkReport) -> None:
        """Save the benchmark report to disk."""
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        providers_str = "-".join(p.value for p in self.config.providers)

        # JSON report
        report_path = output_dir / f"orchestrated-{providers_str}-{timestamp}.json"

        report_dict: dict[str, object] = {
            "metadata": {
                "timestamp": datetime.now().isoformat(),
                "variant": self.config.variant.value,
                "providers": [p.value for p in self.config.providers],
                "execution_mode": self.config.execution_mode.value,
                "matrix": bool(self.config.matrix),
                "orchestrator_model": self.config.orchestrator_model,
                "run_direct_baseline": self.config.run_direct_baseline,
                "required_capabilities": self.config.required_capabilities,
                "strict_capabilities": bool(self.config.strict_capabilities),
                "max_instances": self.config.max_instances,
                "provider_max_steps": self.config.provider_max_steps,
                "orchestrator_max_steps": self.config.orchestrator_max_steps,
            },
            "direct_baseline": {
                "total": len(report.direct_results),
                "resolved": sum(1 for r in report.direct_results if r.success),
                "results": [
                    {
                        "instance_id": r.instance_id,
                        "success": r.success,
                        "patch_status": r.patch_status.value,
                        "duration_seconds": r.duration_seconds,
                    }
                    for r in report.direct_results
                ],
            } if report.direct_results else None,
            "orchestrated": {},
        }

        orchestrated_dict = report_dict["orchestrated"]
        if isinstance(orchestrated_dict, dict):
            for provider_key, results in report.by_provider.items():
                summary = report.provider_summaries.get(provider_key)
                orchestrated_dict[provider_key] = {
                    "summary": {
                        "total_instances": summary.total_instances if summary else 0,
                        "resolved": summary.resolved if summary else 0,
                        "resolve_rate": summary.resolve_rate if summary else 0,
                        "delegation_success_rate": (
                            summary.delegation_success_rate if summary else 0
                        ),
                        "average_duration": summary.average_duration if summary else 0,
                        "improvements_over_direct": (
                            summary.improvements_over_direct if summary else 0
                        ),
                        "regressions_from_direct": (
                            summary.regressions_from_direct if summary else 0
                        ),
                    },
                    "results": [
                        {
                            "instance_id": r.instance_id,
                            "success": r.swe_result.success,
                            "patch_status": r.swe_result.patch_status.value,
                            "duration_seconds": r.swe_result.duration_seconds,
                            "orchestration_time": r.orchestration_time_seconds,
                            "provider_execution_time": r.provider_execution_time_seconds,
                            "delegation_successful": r.delegation_successful,
                            "control_plane_mode": r.control_plane_mode.value,
                            "improvement": r.improvement_over_direct(),
                            "task_description_length": len(r.task_description_generated),
                            "declared_capabilities": r.declared_capabilities,
                            "observed_capabilities": r.observed_capabilities,
                            "capability_violations": r.capability_violations,
                            "trace_file": r.trace_file,
                        }
                        for r in results
                    ],
                }

            if report.matrix_results:
                matrix_block: dict[str, object] = {
                    "execution_modes": list(report.matrix_results.keys()),
                    "providers": [p.value for p in self.config.providers],
                    "cells": {},
                }
                cells = matrix_block["cells"]
                if isinstance(cells, dict):
                    for mode_key, mode_results in report.matrix_results.items():
                        for provider_key, results in mode_results.items():
                            key = f"{mode_key}:{provider_key}"
                            total = len(results)
                            resolved = sum(1 for r in results if r.swe_result.success)
                            cells[key] = {
                                "mode": mode_key,
                                "provider": provider_key,
                                "total_instances": total,
                                "resolved": resolved,
                                "resolve_rate": (resolved / total) if total > 0 else 0.0,
                                "avg_duration_seconds": (
                                    sum(r.swe_result.duration_seconds for r in results) / total
                                    if total > 0
                                    else 0.0
                                ),
                                "capability_violations": sum(
                                    1 for r in results if r.capability_violations
                                ),
                            }
                report_dict["matrix"] = matrix_block

        with open(report_path, "w") as f:
            json.dump(report_dict, f, indent=2)

        logger.info(f"Report saved to {report_path}")

        # Markdown report
        md_path = output_dir / f"orchestrated-{providers_str}-{timestamp}.md"
        self._save_markdown_report(report, md_path)

    def _save_markdown_report(
        self,
        report: OrchestratedBenchmarkReport,
        path: Path,
    ) -> None:
        """Save a markdown summary report."""
        md = ["# Orchestrated SWE-bench Benchmark Results\n"]

        md.append("## Configuration\n")
        md.append(f"- **Variant**: {self.config.variant.value}")
        md.append(f"- **Providers**: {', '.join(p.value for p in self.config.providers)}")
        md.append(f"- **Execution Mode**: {self.config.execution_mode.value}")
        md.append(f"- **Matrix**: {'Yes' if self.config.matrix else 'No'}")
        md.append(f"- **Orchestrator Model**: {self.config.orchestrator_model}")
        md.append(f"- **Provider Max Steps**: {self.config.provider_max_steps}")
        md.append(f"- **Direct Baseline**: {'Yes' if self.config.run_direct_baseline else 'No'}")
        if self.config.required_capabilities:
            md.append(
                f"- **Required Capabilities**: {', '.join(self.config.required_capabilities)}"
            )
            md.append(f"- **Strict Capabilities**: {'Yes' if self.config.strict_capabilities else 'No'}")
        md.append("")

        # Direct baseline
        if report.direct_results:
            direct_resolved = sum(1 for r in report.direct_results if r.success)
            direct_total = len(report.direct_results)
            direct_rate = direct_resolved / direct_total if direct_total > 0 else 0
            md.append("## Direct Baseline (Non-Orchestrated)\n")
            md.append(f"| Metric | Value |")
            md.append(f"|--------|-------|")
            md.append(f"| Total | {direct_total} |")
            md.append(f"| Resolved | {direct_resolved} |")
            md.append(f"| Resolve Rate | {direct_rate:.1%} |")
            md.append("")

        # Provider comparison table
        md.append("## Provider Comparison\n")
        md.append(
            "| Provider | Resolved | Rate | Delegation | Avg Time | "
            "vs Direct (+/-) |"
        )
        md.append(
            "|----------|----------|------|------------|----------|"
            "-----------------|"
        )

        for provider_key, summary in report.provider_summaries.items():
            delta = ""
            if report.direct_results:
                delta = f"+{summary.improvements_over_direct}/-{summary.regressions_from_direct}"
            md.append(
                f"| {summary.provider.value} | "
                f"{summary.resolved}/{summary.total_instances} | "
                f"{summary.resolve_rate:.1%} | "
                f"{summary.delegation_success_rate:.1%} | "
                f"{summary.average_duration:.1f}s | "
                f"{delta} |"
            )

        md.append("")

        if report.matrix_results:
            md.append("## Matrix Results\n")
            md.append("| Mode | Provider | Resolved | Rate | Avg Time | Violations |")
            md.append("|------|----------|----------|------|----------|------------|")
            for mode_key, mode_results in report.matrix_results.items():
                for provider_key, results in mode_results.items():
                    total = len(results)
                    resolved = sum(1 for r in results if r.swe_result.success)
                    rate = (resolved / total) if total > 0 else 0.0
                    avg_time = (
                        sum(r.swe_result.duration_seconds for r in results) / total
                        if total > 0
                        else 0.0
                    )
                    violations = sum(1 for r in results if r.capability_violations)
                    md.append(
                        f"| {mode_key} | {provider_key} | {resolved}/{total} | "
                        f"{rate:.1%} | {avg_time:.1f}s | {violations} |"
                    )
            md.append("")

        # Per-provider details
        for provider_key, results in report.by_provider.items():
            md.append(f"## {provider_key} - Detailed Results\n")
            md.append(
                "| Instance | Success | Orchestration | Execution | Delegation | vs Direct | Trace |"
            )
            md.append(
                "|----------|---------|---------------|-----------|------------|-----------|-------|"
            )

            for r in results:
                status = "PASS" if r.swe_result.success else "FAIL"
                delta = r.improvement_over_direct()
                trace_ref = f"`{r.trace_file}`" if r.trace_file else ""
                md.append(
                    f"| {r.instance_id} | {status} | "
                    f"{r.orchestration_time_seconds:.1f}s | "
                    f"{r.provider_execution_time_seconds:.1f}s | "
                    f"{'Yes' if r.delegation_successful else 'No'} | "
                    f"{delta} | "
                    f"{trace_ref} |"
                )
            md.append("")

        md.append(f"\n---\n*Generated by ElizaOS Orchestrated SWE-bench Benchmark*\n")
        md.append(f"*Timestamp: {datetime.now().isoformat()}*\n")

        with open(path, "w") as f:
            f.write("\n".join(md))

        logger.info(f"Markdown report saved to {path}")
