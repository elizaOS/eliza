from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from elizaos_webshop.dataset import WebShopDataset
from elizaos_webshop.environment import WebShopEnvironment
from elizaos_webshop.evaluator import WebShopEvaluator
from elizaos_webshop.eliza_agent import create_webshop_agent
from elizaos_webshop.trajectory_integration import (
    WebShopTrajectoryConfig,
    WebShopTrajectoryIntegration,
    TRAJECTORY_LOGGER_AVAILABLE,
)
from elizaos_webshop.types import (
    EpisodeStep,
    WebShopConfig,
    WebShopReport,
    WebShopResult,
    WebShopTask,
)


def _maybe_make_bridge_factory(config: WebShopConfig):
    """Return (agent_factory, bridge_client_for_summary) when bridge mode is active."""
    if not config.use_bridge:
        return None, None
    try:
        import os

        from eliza_adapter.client import ElizaClient
        from eliza_adapter.server_manager import ElizaServerManager
        from eliza_adapter.webshop import create_eliza_bridge_webshop_agent
    except ImportError as exc:
        raise RuntimeError(
            "Bridge mode requires the eliza_adapter package. "
            "Install it from packages/benchmarks/eliza-adapter or add its src "
            f"directory to PYTHONPATH (import error: {exc})."
        ) from exc

    if os.environ.get("ELIZA_BENCH_URL"):
        client = ElizaClient()
        client.wait_until_ready(timeout=120)

        class _ExternalBridgeManager:
            def __init__(self, client: ElizaClient) -> None:
                self.client = client

            def stop(self) -> None:
                return None

        mgr = _ExternalBridgeManager(client)
    else:
        mgr = ElizaServerManager()
        mgr.start()
    logger.info("[WebShopRunner] Eliza bridge ready at %s", mgr.client.base_url)

    def _factory(env: WebShopEnvironment) -> object:
        return create_eliza_bridge_webshop_agent(
            env=env,
            max_turns=config.max_turns_per_task,
            client=mgr.client,
            model=config.model_name,
        )

    return _factory, mgr

logger = logging.getLogger(__name__)


class WebShopRunner:
    def __init__(self, config: WebShopConfig, *, split: str = "test", use_hf: bool = False) -> None:
        self.config = config
        self.split = split
        self.use_hf = use_hf

        self.dataset = WebShopDataset(split=split)
        self.evaluator = WebShopEvaluator()
        self._start_time = 0.0

        self._bridge_factory, self._bridge_manager = _maybe_make_bridge_factory(config)
        self._trajectory: WebShopTrajectoryIntegration | None = None
        if config.enable_trajectory_logging and config.use_bridge:
            logger.warning(
                "[WebShopRunner] Local Python trajectory logging is not available in bridge mode; "
                "continuing without trajectory export"
            )
        elif (not config.use_mock) and config.enable_trajectory_logging:
            if not TRAJECTORY_LOGGER_AVAILABLE:
                raise RuntimeError(
                    "Trajectory logging enabled but elizaos-plugin-trajectory-logger is not installed. "
                    "Install plugins/plugin-trajectory-logger/python."
                )
            self._trajectory = WebShopTrajectoryIntegration(
                WebShopTrajectoryConfig(
                    enabled=True,
                    export_format="grpo"
                    if config.trajectory_export_format == "grpo"
                    else "art",
                    scenario_prefix="webshop",
                )
            )

    async def run_benchmark(self) -> WebShopReport:
        self._start_time = time.time()
        try:
            await self.dataset.load(use_huggingface=self.use_hf)

            tasks = self.dataset.get_tasks(limit=self.config.max_tasks)
            if not tasks:
                raise RuntimeError("No tasks loaded")

            results: list[WebShopResult] = []
            for task in tasks:
                for trial in range(1, max(1, self.config.num_trials) + 1):
                    task.metadata["trial_number"] = trial
                    results.append(await self._run_task(task, trial_number=trial))

            report = self._generate_report(results)
            await self._save_results(report)

            if self._trajectory and self._trajectory.enabled:
                traj_dir = str(Path(self.config.output_dir) / "trajectories")
                exported = self._trajectory.export_trajectories(
                    output_dir=traj_dir, dataset_name="webshop_trajectories"
                )
                if exported and exported.success:
                    logger.info(
                        f"[WebShopRunner] Exported {exported.trajectories_exported} trajectories"
                    )

            return report
        finally:
            if self._bridge_manager is not None:
                self._bridge_manager.stop()
                self._bridge_manager = None

    async def _run_task(self, task: WebShopTask, *, trial_number: int) -> WebShopResult:
        start = time.time()

        if not self.dataset.products:
            # HF mode without products isn't runnable in this lightweight harness.
            return WebShopResult(
                task_id=task.task_id,
                trial_number=trial_number,
                success=False,
                purchased_product_id=None,
                reward=0.0,
                turns_used=0,
                duration_ms=(time.time() - start) * 1000,
                steps=[],
                final_response="",
                error="No product catalog available (HF mode not supported for env in this harness)",
            )

        env = WebShopEnvironment(products=self.dataset.products)
        if self._bridge_factory is not None:
            agent = self._bridge_factory(env)
        elif self.config.use_mock:
            agent = create_webshop_agent(
                env,
                max_turns=self.config.max_turns_per_task,
                use_mock=self.config.use_mock,
                model_provider=self.config.model_provider,
                temperature=self.config.temperature,
                trajectory=self._trajectory,
            )
        else:
            raise RuntimeError(
                "Non-mock WebShop execution now requires bridge mode. "
                "Use --bridge or configure WebShopConfig(use_bridge=True)."
            )

        await agent.initialize()

        steps: list[EpisodeStep] = []
        final_response = ""
        try:
            steps, final_response, _last_obs = await asyncio.wait_for(
                agent.process_task(task),
                timeout=self.config.timeout_ms / 1000,
            )
        except asyncio.TimeoutError:
            return WebShopResult(
                task_id=task.task_id,
                trial_number=trial_number,
                success=False,
                purchased_product_id=None,
                reward=0.0,
                turns_used=0,
                duration_ms=(time.time() - start) * 1000,
                steps=[],
                final_response="",
                error="Task timed out",
            )
        except Exception as e:
            return WebShopResult(
                task_id=task.task_id,
                trial_number=trial_number,
                success=False,
                purchased_product_id=env.purchased_product_id,
                reward=env.final_reward,
                turns_used=len(steps),
                duration_ms=(time.time() - start) * 1000,
                steps=list(steps),
                final_response=final_response,
                error=str(e),
            )

        duration_ms = (time.time() - start) * 1000
        result = self.evaluator.evaluate(
            task=task,
            trial_number=trial_number,
            purchased_product_id=env.purchased_product_id,
            reward=float(env.final_reward),
            turns_used=self._estimate_turns_from_steps(steps),
            duration_ms=duration_ms,
            steps=list(steps),
            final_response=final_response,
        )

        if self._trajectory and self._trajectory.enabled:
            await self._trajectory.end_task(result=result)

        return result

    def _estimate_turns_from_steps(self, steps: list[EpisodeStep]) -> int:
        # In this harness, steps map 1:1 to tool-like turns.
        return len(steps)

    def _generate_report(self, results: list[WebShopResult]) -> WebShopReport:
        total_trials = len(results)
        total_tasks = len(set(r.task_id for r in results))
        success_count = sum(1 for r in results if r.success)
        avg_reward = sum(r.reward for r in results) / total_trials if total_trials else 0.0
        avg_turns = sum(r.turns_used for r in results) / total_trials if total_trials else 0.0
        avg_steps = sum(len(r.steps) for r in results) / total_trials if total_trials else 0.0
        avg_duration = (
            sum(r.duration_ms for r in results) / total_trials if total_trials else 0.0
        )
        success_rate = success_count / total_trials if total_trials else 0.0

        status: str
        if success_rate >= 0.7:
            status = "success"
        elif success_rate >= 0.4:
            status = "partial"
        else:
            status = "needs_improvement"

        if self._bridge_factory is not None:
            mode = "eliza-bridge"
        elif self.config.use_mock:
            mode = "mock"
        else:
            mode = "unsupported"
        summary: dict[str, str | int | float | bool] = {
            "status": status,
            "timestamp": datetime.now().isoformat(),
            "mode": mode,
        }

        return WebShopReport(
            total_tasks=total_tasks,
            total_trials=total_trials,
            success_rate=success_rate,
            average_reward=avg_reward,
            average_turns=avg_turns,
            average_steps=avg_steps,
            average_duration_ms=avg_duration,
            results=results,
            summary=summary,
        )

    async def _save_results(self, report: WebShopReport) -> None:
        out = Path(self.config.output_dir)
        out.mkdir(parents=True, exist_ok=True)

        results_path = out / "webshop-results.json"
        with open(results_path, "w") as f:
            json.dump(self._report_to_dict(report), f, indent=2, default=str)

        summary_path = out / "webshop-summary.md"
        with open(summary_path, "w") as f:
            f.write(self._generate_markdown_summary(report))

        if self.config.save_detailed_logs:
            detailed_path = out / "webshop-detailed.json"
            with open(detailed_path, "w") as f:
                json.dump(
                    {"results": [asdict(r) for r in report.results]},
                    f,
                    indent=2,
                    default=str,
                )

        logger.info(f"[WebShopRunner] Results saved to {out}")

    def _report_to_dict(self, report: WebShopReport) -> dict[str, object]:
        return {
            "total_tasks": report.total_tasks,
            "total_trials": report.total_trials,
            "success_rate": report.success_rate,
            "average_reward": report.average_reward,
            "average_turns": report.average_turns,
            "average_steps": report.average_steps,
            "average_duration_ms": report.average_duration_ms,
            "summary": report.summary,
        }

    def _generate_markdown_summary(self, report: WebShopReport) -> str:
        return f"""# WebShop Benchmark Results

## Summary

| Metric | Value |
|---|---:|
| Status | {str(report.summary.get("status", ""))} |
| Total Tasks | {report.total_tasks} |
| Total Trials | {report.total_trials} |
| Success Rate | {report.success_rate * 100:.1f}% |
| Avg Reward | {report.average_reward:.3f} |
| Avg Turns | {report.average_turns:.1f} |
| Avg Steps | {report.average_steps:.1f} |
| Avg Duration (ms) | {report.average_duration_ms:.0f} |

## Notes
- Success is currently defined as reward == 1.0 (perfect match).
"""
