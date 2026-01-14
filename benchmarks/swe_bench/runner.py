"""Benchmark runner for SWE-bench evaluation."""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from .agent import SWEAgent, TRAJECTORY_LOGGER_AVAILABLE
from .dataset import SWEBenchDataset
from .evaluator import SimplePatchEvaluator, SWEBenchEvaluator
from .plugin import RepoManagerService, create_swe_bench_plugin
from .repo_manager import RepositoryManager
from .tools import REPO_MANAGER_KEY
from .types import (
    LEADERBOARD_SCORES,
    PatchStatus,
    RepoStats,
    SWEBenchConfig,
    SWEBenchReport,
    SWEBenchResult,
)

# Trajectory logger integration
if TRAJECTORY_LOGGER_AVAILABLE:
    from elizaos_plugin_trajectory_logger import (
        ExportOptions,
        Trajectory,
        TrajectoryLoggerService,
        export_for_openpipe_art,
        export_grouped_for_grpo,
    )

    from .trajectory_service import TrajectoryLoggerAdapterService
else:
    TrajectoryLoggerService = None  # type: ignore[misc, assignment]
    TrajectoryLoggerAdapterService = None  # type: ignore[misc, assignment]

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


class SWEBenchRunner:
    """Run SWE-bench benchmark evaluation."""

    def __init__(
        self,
        runtime: AgentRuntime,
        config: SWEBenchConfig | None = None,
        enable_trajectory_logging: bool = True,
    ):
        self.runtime = runtime
        self.config = config or SWEBenchConfig()
        self.dataset = SWEBenchDataset(self.config.variant)
        self.repo_manager = RepositoryManager(self.config.workspace_dir)
        dataset_name = (
            self.config.swebench_dataset_name
            or SWEBenchDataset.DATASET_MAPPING[self.config.variant]
        )
        self.evaluator = SWEBenchEvaluator(
            use_docker=self.config.use_docker_eval,
            timeout_seconds=self.config.timeout_seconds,
            dataset_name=dataset_name,
            max_workers=self.config.swebench_max_workers,
            namespace=self.config.swebench_namespace,
            instance_image_tag=self.config.swebench_instance_image_tag,
            env_image_tag=self.config.swebench_env_image_tag,
        )
        self.patch_evaluator = SimplePatchEvaluator()
        
        # Initialize trajectory logger if available and enabled
        self.trajectory_logger: TrajectoryLoggerService | None = None
        self._logged_trajectories: list[Trajectory] = []
        if enable_trajectory_logging and TRAJECTORY_LOGGER_AVAILABLE:
            # TrajectoryLoggerService is guaranteed to be available when TRAJECTORY_LOGGER_AVAILABLE is True
            self.trajectory_logger = TrajectoryLoggerService()  # type: ignore[misc]
            logger.info("Trajectory logging enabled for training data export")
        
        self.agent = SWEAgent(
            runtime,
            self.repo_manager,
            max_steps=self.config.max_steps,
            trajectory_logger=self.trajectory_logger,
        )
        self._plugin_registered = False
        self._trajectory_service_registered = False

    async def _ensure_swe_bench_plugin(self) -> None:
        """Register the SWE-bench plugin and bind its service to our repo manager.
        
        This ensures the runtime's actions operate on the same RepositoryManager
        instance that the runner uses, so they share repository state.
        """
        if self._plugin_registered:
            return

        # Register trajectory logger adapter service (so runtime can log provider/model calls)
        if (
            not self._trajectory_service_registered
            and self.trajectory_logger is not None
            and TRAJECTORY_LOGGER_AVAILABLE
        ):
            TrajectoryLoggerAdapterService.set_shared_logger(self.trajectory_logger)  # type: ignore[union-attr]
            await self.runtime.register_service(TrajectoryLoggerAdapterService)  # type: ignore[arg-type]
            self._trajectory_service_registered = True

        # Set the shared manager BEFORE registering the plugin
        # This ensures the service uses our manager instance
        RepoManagerService.set_shared_manager(self.repo_manager)
        RepoManagerService.set_workspace_dir(self.config.workspace_dir)

        await self.runtime.register_plugin(
            create_swe_bench_plugin(workspace_dir=self.config.workspace_dir)
        )

        # Verify the service is using our manager
        service = self.runtime.get_service(REPO_MANAGER_KEY)
        if service is not None and hasattr(service, "manager"):
            # Double-check and bind if needed
            if getattr(service, "manager", None) is not self.repo_manager:
                setattr(service, "manager", self.repo_manager)
                logger.debug("Bound runner's repo_manager to service")

        self._plugin_registered = True

    async def run_benchmark(self) -> SWEBenchReport:
        """Run the full SWE-bench evaluation."""
        start_time = time.time()

        await self._ensure_swe_bench_plugin()

        # Load dataset
        logger.info(f"Loading SWE-bench {self.config.variant.value} dataset...")
        await self.dataset.load()

        # Get instances to evaluate
        instances = self.dataset.get_instances(
            repo_filter=self.config.repo_filter,
            limit=self.config.max_instances,
        )

        logger.info(f"Running benchmark on {len(instances)} instances...")

        results: list[SWEBenchResult] = []
        resolved_count = 0
        generated_count = 0
        applied_count = 0  # patch successfully applied in harness (docker eval only)

        for idx, instance in enumerate(instances):
            logger.info(
                f"[{idx + 1}/{len(instances)}] Processing {instance.instance_id}"
            )

            try:
                if self.config.use_gold_patches:
                    # Use ground-truth patch (useful for validating the harness).
                    result = SWEBenchResult(
                        instance_id=instance.instance_id,
                        generated_patch=instance.patch,
                        patch_status=PatchStatus.GENERATED,
                        tests_passed=[],
                        tests_failed=[],
                        success=False,
                        duration_seconds=0.0,
                        tokens_used=0,
                    )
                else:
                    # Agent attempts to solve the issue
                    result = await self.agent.solve_issue(instance)

                # Evaluate the patch if generated
                if result.generated_patch.strip():
                    generated_count += 1

                    # Run test evaluation
                    eval_result = await self.evaluator.evaluate_patch(
                        instance,
                        result.generated_patch,
                    )

                    # Update result with evaluation
                    result.tests_passed = eval_result.tests_passed
                    result.tests_failed = eval_result.tests_failed
                    result.success = eval_result.success
                    result.patch_status = eval_result.patch_status

                    if result.success:
                        resolved_count += 1
                    if result.patch_status != PatchStatus.APPLY_FAILED:
                        applied_count += 1

                    # Also calculate patch similarity to ground truth
                    quality = self.patch_evaluator.evaluate_patch_quality(
                        result.generated_patch,
                        instance.patch,
                    )
                    logger.info(
                        f"  Patch quality: {quality.similarity:.2%} similarity"
                    )

                results.append(result)
                
                # Collect trajectory for training export
                if self.trajectory_logger and TRAJECTORY_LOGGER_AVAILABLE:
                    logged_traj = self.agent.get_logged_trajectory()
                    if logged_traj:
                        self._logged_trajectories.append(logged_traj)

                # Log progress
                status = "✓ RESOLVED" if result.success else "✗ Failed"
                logger.info(f"  {status} ({result.duration_seconds:.1f}s)")

            except Exception as e:
                logger.error(f"Error processing {instance.instance_id}: {e}")
                results.append(
                    SWEBenchResult(
                        instance_id=instance.instance_id,
                        generated_patch="",
                        patch_status=PatchStatus.NOT_GENERATED,
                        tests_passed=[],
                        tests_failed=[],
                        success=False,
                        duration_seconds=0,
                        tokens_used=0,
                        error=str(e),
                    )
                )

            # Reset repo for next instance
            await self.repo_manager.reset_repo()

        # Generate report
        total = len(results)
        generated_rate = generated_count / total if total > 0 else 0.0
        apply_rate = applied_count / total if total > 0 else 0.0
        report = SWEBenchReport(
            variant=self.config.variant.value,
            total_instances=total,
            resolved=resolved_count,
            unresolved=total - resolved_count,
            resolve_rate=resolved_count / total if total > 0 else 0,
            apply_rate=apply_rate if self.config.use_docker_eval else generated_rate,
            average_duration=sum(r.duration_seconds for r in results) / total if total > 0 else 0,
            average_tokens=sum(r.tokens_used for r in results) / total if total > 0 else 0,
            results=results,
            by_repo=self._group_by_repo(results),
            errors=self._categorize_errors(results),
        )

        # Save report
        self._save_report(report)
        
        # Export trajectories for training if available
        if self._logged_trajectories and TRAJECTORY_LOGGER_AVAILABLE:
            self._export_trajectories()

        total_time = time.time() - start_time
        logger.info(f"Benchmark complete in {total_time:.1f}s")
        logger.info(f"Resolve rate: {report.resolve_rate:.1%} ({resolved_count}/{total})")

        return report

    async def run_single(self, instance_id: str) -> SWEBenchResult:
        """Run benchmark on a single instance."""
        await self._ensure_swe_bench_plugin()
        await self.dataset.load()

        instance = next(
            (i for i in self.dataset.instances if i.instance_id == instance_id),
            None,
        )

        if not instance:
            raise ValueError(f"Instance not found: {instance_id}")

        if self.config.use_gold_patches:
            result = SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=instance.patch,
                patch_status=PatchStatus.GENERATED,
                tests_passed=[],
                tests_failed=[],
                success=False,
                duration_seconds=0.0,
                tokens_used=0,
            )
        else:
            result = await self.agent.solve_issue(instance)

        if result.generated_patch.strip():
            eval_result = await self.evaluator.evaluate_patch(
                instance,
                result.generated_patch,
            )
            result.tests_passed = eval_result.tests_passed
            result.tests_failed = eval_result.tests_failed
            result.success = eval_result.success
            result.patch_status = eval_result.patch_status

        return result

    def _group_by_repo(
        self, results: list[SWEBenchResult]
    ) -> dict[str, RepoStats]:
        """Group results by repository."""
        by_repo: dict[str, list[SWEBenchResult]] = {}

        for result in results:
            # Extract repo from instance_id (format: owner__repo-issue_id)
            repo = "unknown"
            parts = result.instance_id.split("__", 1)
            if len(parts) == 2:
                owner = parts[0]
                rest = parts[1]
                repo_name = rest.split("-", 1)[0]
                if owner and repo_name:
                    repo = f"{owner}/{repo_name}"

            if repo not in by_repo:
                by_repo[repo] = []
            by_repo[repo].append(result)

        stats: dict[str, RepoStats] = {}
        for repo, repo_results in by_repo.items():
            total = len(repo_results)
            resolved = sum(1 for r in repo_results if r.success)
            stats[repo] = RepoStats(
                total=total,
                resolved=resolved,
                resolve_rate=resolved / total if total > 0 else 0.0,
            )

        return stats

    def _categorize_errors(
        self, results: list[SWEBenchResult]
    ) -> dict[str, int]:
        """Categorize errors by type."""
        errors: dict[str, int] = {}

        for result in results:
            if result.error:
                # Simplify error message
                error_type = result.error.split(":")[0][:50]
                errors[error_type] = errors.get(error_type, 0) + 1
            elif result.patch_status == PatchStatus.NOT_GENERATED:
                errors["No patch generated"] = errors.get("No patch generated", 0) + 1
            elif result.patch_status == PatchStatus.APPLY_FAILED:
                errors["Patch apply failed"] = errors.get("Patch apply failed", 0) + 1
            elif result.patch_status == PatchStatus.TESTS_FAILED:
                errors["Tests failed"] = errors.get("Tests failed", 0) + 1

        return errors

    def _export_trajectories(self) -> None:
        """Export collected trajectories for training."""
        if not self._logged_trajectories or not TRAJECTORY_LOGGER_AVAILABLE:
            return
        
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        try:
            # Export in ART format for OpenPipe
            art_result = export_for_openpipe_art(
                ExportOptions(
                    dataset_name=f"swe-bench-{self.config.variant.value}",
                    trajectories=self._logged_trajectories,
                    output_dir=str(output_dir / "trajectories"),
                )
            )
            if art_result.success:
                logger.info(
                    f"Exported {art_result.trajectories_exported} trajectories "
                    f"to {art_result.dataset_url}"
                )
            
            # Export in GRPO format for group preference optimization
            grpo_result = export_grouped_for_grpo(
                ExportOptions(
                    dataset_name=f"swe-bench-{self.config.variant.value}",
                    trajectories=self._logged_trajectories,
                    output_dir=str(output_dir / "trajectories"),
                )
            )
            if grpo_result.success:
                logger.info(
                    f"Exported {grpo_result.trajectories_exported} trajectories "
                    f"for GRPO to {grpo_result.dataset_url}"
                )
                
        except Exception as e:
            logger.warning(f"Failed to export trajectories: {e}")
    
    def get_logged_trajectories(self) -> list[Trajectory]:
        """Get all logged trajectories for external processing."""
        return self._logged_trajectories

    def _save_report(self, report: SWEBenchReport) -> None:
        """Save benchmark report to file."""
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        mode = "gold" if self.config.use_gold_patches else "agent"

        # Save JSON report
        report_path = output_dir / f"swe-bench-{report.variant}-{mode}-{timestamp}.json"

        # Convert RepoStats to dict for JSON serialization
        by_repo_dict: dict[str, dict[str, float | int]] = {}
        for repo, stats in report.by_repo.items():
            by_repo_dict[repo] = {
                "total": stats.total,
                "resolved": stats.resolved,
                "resolve_rate": stats.resolve_rate,
            }

        report_dict: dict[str, object] = {
            "metadata": {
                "timestamp": datetime.now().isoformat(),
                "variant": report.variant,
                "config": {
                    "mode": mode,
                    "use_gold_patches": self.config.use_gold_patches,
                    "max_steps": self.config.max_steps,
                    "max_instances": self.config.max_instances,
                    "repo_filter": self.config.repo_filter,
                    "model": self.config.model_name,
                    "use_docker_eval": self.config.use_docker_eval,
                    "timeout_seconds": self.config.timeout_seconds,
                    "swebench_namespace": self.config.swebench_namespace,
                    "swebench_max_workers": self.config.swebench_max_workers,
                },
            },
            "summary": {
                "total_instances": report.total_instances,
                "resolved": report.resolved,
                "unresolved": report.unresolved,
                "resolve_rate": report.resolve_rate,
                "apply_rate": report.apply_rate,
                "average_duration": report.average_duration,
                "average_tokens": report.average_tokens,
            },
            "by_repository": by_repo_dict,
            "errors": report.errors,
            "results": [
                {
                    "instance_id": r.instance_id,
                    "success": r.success,
                    "patch_status": r.patch_status.value,
                    "duration_seconds": r.duration_seconds,
                    "tokens_used": r.tokens_used,
                    "tests_passed": len(r.tests_passed),
                    "tests_failed": len(r.tests_failed),
                    "error": r.error,
                    "trajectory": {
                        "steps": [
                            {
                                "step_number": s.step_number,
                                "action": s.action,
                                "action_input": s.action_input,
                                "observation": s.observation[:500] if s.observation else "",
                                "thought": s.thought,
                            }
                            for s in (r.trajectory.steps if r.trajectory else [])
                        ],
                        "files_viewed": r.trajectory.files_viewed if r.trajectory else [],
                        "files_edited": r.trajectory.files_edited if r.trajectory else [],
                        "search_queries": r.trajectory.search_queries if r.trajectory else [],
                    }
                    if r.trajectory
                    else None,
                }
                for r in report.results
            ],
        }

        with open(report_path, "w") as f:
            json.dump(report_dict, f, indent=2)

        logger.info(f"Report saved to {report_path}")

        # Save markdown summary
        md_path = output_dir / f"swe-bench-{report.variant}-{mode}-{timestamp}.md"
        self._save_markdown_report(report, md_path)

    def _save_markdown_report(
        self, report: SWEBenchReport, path: Path
    ) -> None:
        """Save markdown summary report."""
        mode = "gold" if self.config.use_gold_patches else "agent"

        our_score = report.resolve_rate * 100
        leaderboard: dict[str, float] = {}
        rank: int | None = None

        if mode == "agent":
            # Get leaderboard comparison (only meaningful for agent runs)
            variant_key = f"SWE-bench {report.variant.title()}"
            leaderboard = LEADERBOARD_SCORES.get(variant_key, {})

            # Calculate rank
            rank_calc = 1
            for _, score in sorted(leaderboard.items(), key=lambda x: -x[1]):
                if our_score < score:
                    rank_calc += 1
            rank = rank_calc

        md_content = f"""# SWE-bench Benchmark Results

## Summary

| Metric | Value |
|--------|-------|
| **Variant** | {report.variant} |
| **Mode** | {mode} |
| **Total Instances** | {report.total_instances} |
| **Resolved** | {report.resolved} |
| **Resolve Rate** | {report.resolve_rate:.1%} |
| **Apply Rate** | {report.apply_rate:.1%} |
| **Avg Duration** | {report.average_duration:.1f}s |
| **Avg Tokens** | {report.average_tokens:.0f} |

## Leaderboard Comparison

| System | Score |
|--------|-------|
| **ElizaOS (This Run)** | **{our_score:.1f}%** |
"""
        if mode == "agent":
            for name, score in sorted(leaderboard.items(), key=lambda x: -x[1]):
                md_content += f"| {name} | {score:.1f}% |\n"
            md_content += f"""
**Estimated Rank**: #{rank} out of {len(leaderboard) + 1}

## By Repository
"""
        else:
            md_content += (
                "| _Leaderboard comparison disabled_ | _gold/harness validation run_ |\n\n"
                "_Note: `--gold` runs evaluate the ground-truth patch to validate the SWE-bench harness and image setup. "
                "They are not a model/agent score._\n\n"
                "## By Repository\n"
            )

        md_content += """| Repository | Total | Resolved | Rate |
|------------|-------|----------|------|
"""
        for repo, stats in sorted(report.by_repo.items(), key=lambda x: -x[1].resolve_rate):
            md_content += f"| {repo} | {stats.total} | {stats.resolved} | {stats.resolve_rate:.1%} |\n"

        md_content += """
## Error Analysis

| Error Type | Count |
|------------|-------|
"""
        for error, count in sorted(report.errors.items(), key=lambda x: -x[1]):
            md_content += f"| {error} | {count} |\n"

        md_content += f"""
## Configuration

- Model: {self.config.model_name}
- Max Steps: {self.config.max_steps}
- Docker Evaluation: {self.config.use_docker_eval}
- Timeout: {self.config.timeout_seconds}s

---
*Generated by ElizaOS SWE-bench Benchmark*
*Timestamp: {datetime.now().isoformat()}*
"""

        with open(path, "w") as f:
            f.write(md_content)

        logger.info(f"Markdown report saved to {path}")
