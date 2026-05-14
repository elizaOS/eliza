"""
REALM-Bench runner.

Drives a (possibly multi-agent) eliza-backed agent through the 11
canonical scenarios. Measures planning and execution wall time
separately, injects disruptions for P4/P7/P8/P9/P10, and dispatches per-
problem extrinsic scoring.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

from benchmarks.realm.dataset import REALMDataset
from benchmarks.realm.disruption import apply_disruption, first_disruption
from benchmarks.realm.evaluator import MetricsCalculator, REALMEvaluator
from benchmarks.realm.types import (
    LEADERBOARD_NOTE,
    LEADERBOARD_SCORES,
    PROBLEMS_WITH_DISRUPTIONS,
    PlanningAction,
    PlanningStep,
    PlanningTrajectory,
    REALMConfig,
    REALMMetrics,
    REALMReport,
    REALMResult,
    REALMResultDetails,
    REALMResultMetrics,
    RealmProblem,
)

logger = logging.getLogger(__name__)


SolveFn = Callable[..., Awaitable[PlanningTrajectory]]


class REALMRunner:
    """Run the complete REALM benchmark evaluation."""

    def __init__(
        self,
        config: REALMConfig,
        agent: object | None = None,
        use_mock: bool = False,
        enable_trajectory_logging: bool = True,
    ) -> None:
        self.config = config
        self.enable_trajectory_logging = enable_trajectory_logging

        self.dataset = REALMDataset(
            config.data_path,
            use_sample_tasks=config.use_sample_tasks,
        )
        if agent is None:
            if not use_mock:
                raise ValueError(
                    "REALMRunner requires an agent unless use_mock=True"
                )
            self.agent = _MockREALMAgent(config)
        else:
            self.agent = agent

        self.evaluator = REALMEvaluator()
        self.metrics_calculator = MetricsCalculator()

        self._start_time = 0.0
        self._agent_initialized = False

    async def run_benchmark(self) -> REALMReport:
        self._start_time = time.time()

        logger.info("[REALMRunner] Starting REALM benchmark (paper-faithful P1..P11)")

        if not self._agent_initialized:
            await self.agent.initialize()  # type: ignore[attr-defined]
            self._agent_initialized = True

        await self.dataset.load()
        test_cases = self.dataset.get_test_cases(
            problems=self.config.problems,
            limit=self.config.max_tasks_per_problem,
        )
        if not test_cases:
            raise ValueError("No test cases loaded from dataset")
        logger.info("[REALMRunner] Loaded %d test cases", len(test_cases))

        results: list[REALMResult] = []
        for idx, test_case in enumerate(test_cases):
            task = test_case.task
            logger.info(
                "[REALMRunner] [%d/%d] %s (%s, %d agent%s, disruptions=%s)",
                idx + 1,
                len(test_cases),
                task.id,
                task.problem.value,
                task.num_agents,
                "" if task.num_agents == 1 else "s",
                task.has_disruptions,
            )
            try:
                trajectory = await asyncio.wait_for(
                    self._run_one(task, test_case),
                    timeout=self.config.timeout_per_task_ms / 1000,
                )
                result = self.evaluator.evaluate_trajectory(task, test_case, trajectory)
                results.append(result)
                logger.info(
                    "[REALMRunner] %s %s: planning=%.0fms exec=%.0fms quality=%.2f opt=%.2f",
                    "PASS" if result.success else "FAIL",
                    task.id,
                    result.metrics.planning_time_ms,
                    result.metrics.execution_time_ms,
                    result.metrics.planning_quality,
                    result.metrics.optimality_ratio,
                )
            except asyncio.TimeoutError:
                logger.warning("[REALMRunner] Task %s timed out", task.id)
                results.append(
                    REALMResult(
                        task_id=task.id,
                        problem=task.problem,
                        trajectory=PlanningTrajectory(task_id=task.id),
                        success=False,
                        steps_executed=0,
                        actions_performed=[],
                        duration_ms=float(self.config.timeout_per_task_ms),
                        error="Timeout",
                        metrics=REALMResultMetrics(),
                        details=REALMResultDetails(),
                    )
                )
            except Exception as exc:
                logger.error("[REALMRunner] Task %s failed: %s", task.id, exc)
                results.append(
                    REALMResult(
                        task_id=task.id,
                        problem=task.problem,
                        trajectory=PlanningTrajectory(task_id=task.id),
                        success=False,
                        steps_executed=0,
                        actions_performed=[],
                        error=str(exc),
                        metrics=REALMResultMetrics(),
                        details=REALMResultDetails(),
                    )
                )

        metrics = self.metrics_calculator.calculate(results)
        comparison = self.metrics_calculator.compare_to_leaderboard(
            metrics, LEADERBOARD_SCORES
        )
        problem_breakdown = self._problem_breakdown(results)
        summary = self._summary(metrics)

        duration = time.time() - self._start_time
        report = REALMReport(
            metadata={
                "timestamp": datetime.now().isoformat(),
                "duration_seconds": duration,
                "total_tasks": len(test_cases),
                "problems": [
                    p.value
                    for p in (self.config.problems or list(RealmProblem))
                ],
                "config": {
                    "execution_model": self.config.execution_model.value,
                    "max_steps": self.config.max_steps,
                    "enable_adaptation": self.config.enable_adaptation,
                    "enable_multi_agent": self.config.enable_multi_agent,
                    "model": self.config.model_name,
                    "use_sample_tasks": self.config.use_sample_tasks,
                },
                "leaderboard_note": LEADERBOARD_NOTE,
            },
            metrics=metrics,
            results=results,
            problem_breakdown=problem_breakdown,
            summary=summary,
            comparison_to_leaderboard=comparison,
        )

        if self.config.generate_report:
            await self._save_results(report)

        logger.info(
            "[REALMRunner] Done in %.1fs. Success: %.1%%",
            duration,
            metrics.overall_success_rate * 100,
        )
        return report

    # ------------------------------------------------------------------
    # Per-task execution
    # ------------------------------------------------------------------

    async def _run_one(self, task, test_case) -> PlanningTrajectory:
        """Run one task, measuring planning/exec wall time, applying
        disruptions where required."""
        planning_start = time.time()
        trajectory: PlanningTrajectory = await self._call_solve(task, test_case)
        wall = (time.time() - planning_start) * 1000.0
        trajectory.duration_ms = trajectory.duration_ms or wall

        # If the agent didn't fill in planning/execution split, treat
        # the first call as "planning only" and any disruption replan
        # cycles as "execution".
        if trajectory.planning_time_ms == 0.0 and trajectory.execution_time_ms == 0.0:
            trajectory.planning_time_ms = wall
            trajectory.execution_time_ms = 0.0

        # Disruption injection for problems that carry scenarios.
        if (
            self.config.enable_adaptation
            and (task.has_disruptions or task.problem in PROBLEMS_WITH_DISRUPTIONS)
        ):
            disruption = first_disruption(task.instance)
            if disruption is not None:
                logger.info(
                    "[REALMRunner] Injecting disruption %s into %s",
                    disruption.type,
                    task.id,
                )
                replan_start = time.time()
                new_instance = apply_disruption(task.instance, disruption)
                # Rebind a copy of the task for the replan call
                disrupted_task = _shallow_copy_task_with_instance(task, new_instance)
                try:
                    replan_traj = await self._call_solve(disrupted_task, test_case)
                    replan_wall = (time.time() - replan_start) * 1000.0
                    trajectory.execution_time_ms += replan_wall
                    trajectory.adaptation_count += 1
                    success = bool(replan_traj.solution)
                    trajectory.replanning_attempts.append(
                        {
                            "disruption": disruption.type,
                            "success": success,
                            "replan_time_ms": replan_wall,
                            "solution": replan_traj.solution,
                        }
                    )
                    # Replace the task-level solution with the replan output
                    # since that's the one the evaluator will score.
                    if success:
                        trajectory.solution = replan_traj.solution
                except Exception as exc:
                    logger.warning(
                        "[REALMRunner] Replan failed for %s: %s", task.id, exc
                    )
                    trajectory.replanning_attempts.append(
                        {"disruption": disruption.type, "success": False, "error": str(exc)}
                    )

        # Total duration = planning + exec
        if trajectory.duration_ms == 0.0:
            trajectory.duration_ms = trajectory.planning_time_ms + trajectory.execution_time_ms
        return trajectory

    async def _call_solve(self, task, test_case) -> PlanningTrajectory:
        """Call ``agent.solve_task`` with whichever signature it supports."""
        solve = getattr(self.agent, "solve_task")
        sig = inspect.signature(solve)
        params = sig.parameters
        if "test_case" in params or len(params) >= 2:
            return await solve(task, test_case)
        return await solve(task)

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def _problem_breakdown(
        self, results: list[REALMResult]
    ) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for p in RealmProblem:
            sub = [r for r in results if r.problem == p]
            if not sub:
                continue
            passed = sum(1 for r in sub if r.success)
            out[p.value] = {
                "total": float(len(sub)),
                "passed": float(passed),
                "failed": float(len(sub) - passed),
                "success_rate": passed / len(sub),
                "avg_planning_quality": sum(r.metrics.planning_quality for r in sub)
                / len(sub),
                "avg_optimality_ratio": sum(r.metrics.optimality_ratio for r in sub)
                / len(sub),
                "avg_constraint_satisfaction": sum(
                    r.metrics.constraint_satisfaction for r in sub
                )
                / len(sub),
                "avg_adaptation_success_rate": sum(
                    r.metrics.adaptation_success_rate for r in sub
                )
                / len(sub),
            }
        return out

    def _summary(self, metrics: REALMMetrics) -> dict[str, Any]:
        findings: list[str] = [
            f"Overall pass rate: {metrics.overall_success_rate:.1%}",
            f"Avg planning quality: {metrics.avg_planning_quality:.2f}",
            f"Avg optimality ratio (oracle / agent): {metrics.avg_optimality_ratio:.2f}",
            f"Avg constraint satisfaction: {metrics.avg_constraint_satisfaction:.2f}",
            f"Avg adaptation success: {metrics.avg_adaptation_success_rate:.2f}",
        ]
        recommendations: list[str] = []
        if metrics.avg_optimality_ratio < 0.7:
            recommendations.append("Optimality ratio is low; review per-problem solvers")
        if metrics.avg_constraint_satisfaction < 0.7:
            recommendations.append("Constraint violations dominate; tighten plan parsing")
        status = (
            "excellent"
            if metrics.overall_success_rate >= 0.7
            else "good"
            if metrics.overall_success_rate >= 0.5
            else "needs_improvement"
        )
        return {
            "status": status,
            "success_rate": f"{metrics.overall_success_rate:.1%}",
            "key_findings": findings,
            "recommendations": recommendations,
        }

    async def _save_results(self, report: REALMReport) -> None:
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        json_path = output_dir / f"realm-benchmark-{timestamp}.json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(self._report_to_dict(report), f, indent=2, default=str)
        logger.info("[REALMRunner] Saved JSON results to %s", json_path)

    def _report_to_dict(self, report: REALMReport) -> dict[str, Any]:
        return {
            "metadata": report.metadata,
            "summary": report.summary,
            "metrics": self._metrics_to_dict(report.metrics),
            "problem_breakdown": report.problem_breakdown,
            "leaderboard_comparison": report.comparison_to_leaderboard,
            "results": [self._result_to_dict(r) for r in report.results],
        }

    def _metrics_to_dict(self, metrics: REALMMetrics) -> dict[str, Any]:
        return {
            "overall_success_rate": metrics.overall_success_rate,
            "total_tasks": metrics.total_tasks,
            "passed_tasks": metrics.passed_tasks,
            "failed_tasks": metrics.failed_tasks,
            "avg_planning_quality": metrics.avg_planning_quality,
            "avg_optimality_ratio": metrics.avg_optimality_ratio,
            "avg_coordination": metrics.avg_coordination,
            "avg_constraint_satisfaction": metrics.avg_constraint_satisfaction,
            "avg_adaptation_success_rate": metrics.avg_adaptation_success_rate,
            "avg_planning_time_ms": metrics.avg_planning_time_ms,
            "avg_execution_time_ms": metrics.avg_execution_time_ms,
            "avg_tokens_per_task": metrics.avg_tokens_per_task,
            "total_tokens": metrics.total_tokens,
            "total_duration_ms": metrics.total_duration_ms,
            "avg_latency_ms": metrics.avg_latency_ms,
            "problem_success_rates": {
                p.value: v for p, v in metrics.problem_success_rates.items()
            },
            "problem_counts": {
                p.value: v for p, v in metrics.problem_counts.items()
            },
        }

    def _result_to_dict(self, r: REALMResult) -> dict[str, Any]:
        return {
            "task_id": r.task_id,
            "problem": r.problem.value,
            "success": r.success,
            "steps_executed": r.steps_executed,
            "actions_performed": r.actions_performed,
            "duration_ms": r.duration_ms,
            "metrics": {
                "planning_quality": r.metrics.planning_quality,
                "optimality_ratio": r.metrics.optimality_ratio,
                "makespan": r.metrics.makespan,
                "oracle_makespan": r.metrics.oracle_makespan,
                "coordination": r.metrics.coordination,
                "constraint_satisfaction": r.metrics.constraint_satisfaction,
                "adaptation_success_rate": r.metrics.adaptation_success_rate,
                "planning_time_ms": r.metrics.planning_time_ms,
                "execution_time_ms": r.metrics.execution_time_ms,
                "extras": r.metrics.extras,
            },
            "error": r.error,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _shallow_copy_task_with_instance(task, new_instance: dict[str, Any]):
    """Return a clone of ``task`` with a swapped ``instance``."""
    from copy import copy as _copy

    clone = _copy(task)
    clone.instance = new_instance
    return clone


# ---------------------------------------------------------------------------
# Deterministic mock agent for smoke tests
# ---------------------------------------------------------------------------


class _MockREALMAgent:
    """Mock agent that emits an *oracle-optimal* solution per problem.

    This is the canonical "good agent" for smoke testing: it exercises
    every per-problem evaluator without requiring an LLM. It also
    measures planning vs execution time using real wall clock.
    """

    def __init__(self, config: REALMConfig) -> None:
        self.config = config
        self._initialized = False

    async def initialize(self) -> None:
        self._initialized = True

    async def close(self) -> None:
        pass

    async def solve_task(self, task, test_case=None) -> PlanningTrajectory:
        t0 = time.time()
        trajectory = PlanningTrajectory(task_id=task.id, start_time_ms=t0 * 1000)

        # Build a problem-specific oracle solution.
        from benchmarks.realm import solvers

        sol: dict[str, Any] = {}
        if task.problem == RealmProblem.P11:
            jobs = task.instance.get("jobs") or []
            # FIFO sequence is a valid baseline; for the sample instance
            # we know it matches the oracle.
            sol = {
                "sequence": [
                    [j for j, ops in enumerate(jobs) for m, _ in ops if m == mi]
                    for mi in range(
                        max((op[0] for jb in jobs for op in jb), default=-1) + 1
                    )
                ]
            }
        elif task.problem == RealmProblem.P1:
            cost, route = solvers.tsp_tw_oracle(
                task.instance.get("locations", []),
                task.instance.get("distances", {}),
                {
                    k: (float(v[0]), float(v[1]))
                    for k, v in task.instance.get("time_windows", {}).items()
                },
                start_location=task.instance.get("start_location", "entrance"),
                end_location=task.instance.get("end_location", "entrance"),
                max_duration=float(task.instance.get("max_duration", 1e9)),
            )
            sol = {"route": route, "cost": cost}
        elif task.problem in (RealmProblem.P3, RealmProblem.P4):
            cost, assignments = solvers.darp_oracle_distance(
                task.instance.get("vehicles", []),
                task.instance.get("passengers", []),
                task.instance.get("city_map", {}).get("distances")
                or task.instance.get("distances", {}),
            )
            sol = {"assignments": assignments, "cost": cost}
        elif task.problem == RealmProblem.P7:
            # Greedy proportional allocation matching the oracle.
            regions = task.instance.get("regions", []) or []
            resources = task.instance.get("resources", {}) or {}
            allocations: dict[str, dict[str, float]] = {}
            pool = sum(resources.values())
            sorted_regions = sorted(
                regions,
                key=lambda r: -solvers.SEVERITY_WEIGHT.get(r.get("severity", "normal"), 1.0),
            )
            for r in sorted_regions:
                rid = r.get("id")
                need = float(r.get("population", 0))
                give = min(pool, need)
                allocations[rid] = {"food": give}
                pool -= give
                if pool <= 0:
                    break
            sol = {"allocations": allocations}
        elif task.problem == RealmProblem.P2:
            groups = task.instance.get("visitor_groups", []) or []
            guides = task.instance.get("tour_guides", []) or []
            assignments_p2: dict[str, list[dict[str, Any]]] = {
                g["guide_id"]: [] for g in guides
            }
            for i, group in enumerate(groups):
                if not guides:
                    break
                guide = guides[i % len(guides)]
                avail = guide.get("availability", [0, 24])
                assignments_p2[guide["guide_id"]].append(
                    {"group": group["group_id"], "start": avail[0]}
                )
            sol = {"assignments": assignments_p2}
        elif task.problem in (
            RealmProblem.P5,
            RealmProblem.P6,
            RealmProblem.P8,
            RealmProblem.P9,
        ):
            # Hit every coverage axis the evaluator inspects.
            errands = task.instance.get("errands", []) or []
            cooking = task.instance.get("cooking_tasks", []) or []
            guests = task.instance.get("guests", []) or []
            sol = {
                "pickups": [
                    {"guest": g.get("name") or g.get("id"), "time": "12:00"}
                    for g in guests
                ],
                "errands_done": list(errands),
                "cooking_schedule": [{"task": c, "time": "16:00"} for c in cooking],
            }
        elif task.problem == RealmProblem.P10:
            deadlines = task.instance.get("delivery_deadlines", {}) or {}
            sol = {
                "orders": [
                    {"component": k, "cost": 1.0, "eta": float(v) - 1}
                    for k, v in deadlines.items()
                ]
            }

        # Record a single planning step so the trajectory looks coherent.
        trajectory.steps.append(
            PlanningStep(
                step_number=1,
                action=PlanningAction(
                    name="submit_solution",
                    parameters={"problem": task.problem.value},
                    description="Mock oracle-optimal solution",
                ),
                observation="ok",
                success=True,
                duration_ms=1.0,
            )
        )
        trajectory.solution = sol
        trajectory.overall_success = bool(sol)
        trajectory.final_outcome = "Mock oracle solution generated"

        wall = (time.time() - t0) * 1000
        trajectory.planning_time_ms = wall
        trajectory.execution_time_ms = 0.0
        trajectory.duration_ms = wall
        trajectory.end_time_ms = time.time() * 1000
        trajectory.tokens_used = 0
        return trajectory
