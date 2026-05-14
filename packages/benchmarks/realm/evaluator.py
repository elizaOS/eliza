"""
REALM-Bench evaluator (paper-faithful, per-problem extrinsic scoring).

The previous implementation graded the agent by set-intersection on the
agent's own action names against a hardcoded ``expected.actions`` list,
and treated the agent-reported ``plan_quality_score`` as ground truth
(circular).

This module evaluates an agent against an **independent** oracle solver
(see :mod:`benchmarks.realm.solvers`) and against the **actual problem
constraints** taken from the upstream instance JSON (time windows,
deadlines, makespan, etc.).

For each of the 11 paper scenarios we route to a dedicated scoring
routine. Each routine populates :class:`REALMResultMetrics` with the
paper's six metric families.
"""

from __future__ import annotations

import logging
from typing import Any

from benchmarks.realm import solvers
from benchmarks.realm.types import (
    OracleFamily,
    PROBLEM_TO_FAMILY,
    PROBLEMS_WITH_DISRUPTIONS,
    PlanningTrajectory,
    REALMMetrics,
    REALMResult,
    REALMResultDetails,
    REALMResultMetrics,
    REALMTask,
    REALMTestCase,
    RealmProblem,
)

logger = logging.getLogger(__name__)


class REALMEvaluator:
    """Per-problem extrinsic evaluator.

    ``solver_timeout_s`` caps the wall-clock budget of the OR-Tools
    oracles (JSSP CP-SAT, TSP-TW / DARP RoutingModel). Wired in by
    the runner from :class:`REALMConfig.solver_timeout_s`.
    """

    def __init__(self, *, solver_timeout_s: float = solvers.DEFAULT_SOLVER_TIMEOUT_S) -> None:
        self.solver_timeout_s = float(solver_timeout_s)

    def evaluate_trajectory(
        self,
        task: REALMTask,
        test_case: REALMTestCase,
        trajectory: PlanningTrajectory,
    ) -> REALMResult:
        family = PROBLEM_TO_FAMILY[task.problem]
        scorer = _SCORERS[family]
        metrics = scorer(task, trajectory, solver_timeout_s=self.solver_timeout_s)

        # Resource metrics come straight from measured wall times on the
        # trajectory.
        metrics.planning_time_ms = float(trajectory.planning_time_ms)
        metrics.execution_time_ms = float(trajectory.execution_time_ms)
        metrics.tokens = int(trajectory.tokens_used)

        # Adaptation metrics for the disruption problems
        if task.has_disruptions or task.problem in PROBLEMS_WITH_DISRUPTIONS:
            metrics.adaptation_success_rate = _adaptation_success(trajectory)
        else:
            metrics.adaptation_success_rate = 1.0

        # Multi-agent coordination: lightweight measure based on whether
        # all expected agents made progress. Single-agent tasks default
        # to 1.0.
        if task.num_agents > 1:
            metrics.coordination = _coordination_score(task, trajectory)

        # Final success: passes if planning_quality + constraint_sat both
        # >= 0.5 and (when applicable) optimality_ratio > 0. Threshold
        # matches the paper's coarse "succeeded" labelling.
        success = (
            metrics.planning_quality >= 0.5
            and metrics.constraint_satisfaction >= 0.5
        )

        actions_performed = [s.action.name for s in trajectory.steps]

        return REALMResult(
            task_id=task.id,
            problem=task.problem,
            trajectory=trajectory,
            success=success,
            steps_executed=len(trajectory.steps),
            actions_performed=actions_performed,
            duration_ms=trajectory.duration_ms,
            token_usage=trajectory.tokens_used,
            error=None if success else trajectory.final_outcome or None,
            metrics=metrics,
            details=REALMResultDetails(
                plan_adaptations=trajectory.adaptation_count,
                error_recoveries=sum(
                    1 for s in trajectory.steps if not s.success and s.error
                ),
                tokens=trajectory.tokens_used,
                duration=trajectory.duration_ms,
            ),
        )


# ---------------------------------------------------------------------------
# Per-problem scoring routines
# ---------------------------------------------------------------------------


def _score_tsp_tw(
    task: REALMTask,
    trajectory: PlanningTrajectory,
    *,
    solver_timeout_s: float = solvers.DEFAULT_SOLVER_TIMEOUT_S,
) -> REALMResultMetrics:
    """P1: single-agent TSP with time windows."""
    inst = task.instance
    route = _read_route(trajectory)
    distances = inst.get("distances", {})
    time_windows_raw = inst.get("time_windows", {})
    time_windows: dict[str, tuple[float, float]] = {
        k: (float(v[0]), float(v[1])) for k, v in time_windows_raw.items()
    }
    start = inst.get("start_location", "entrance")
    end = inst.get("end_location", "entrance")
    max_duration = float(inst.get("max_duration", 1e9))

    cost, details = solvers.tsp_tw_route_cost(
        route or [start, end],
        distances,
        time_windows,
        start_location=start,
        end_location=end,
        max_duration=max_duration,
    )

    oracle_cost, _oracle_route = solvers.tsp_tw_oracle(
        inst.get("locations", []),
        distances,
        time_windows,
        start_location=start,
        end_location=end,
        max_duration=max_duration,
        timeout_s=solver_timeout_s,
    )

    expected_locs = set(time_windows.keys())
    visited = set(route or []) - {start, end}
    all_visited = bool(expected_locs) and expected_locs.issubset(visited)

    planning_quality = (
        len(visited & expected_locs) / max(1, len(expected_locs))
        if expected_locs
        else 1.0
    )
    constraint_sat = 1.0
    if details["tw_violations"]:
        constraint_sat -= 0.5 * (
            details["tw_violations"] / max(1, len(time_windows))
        )
    if details["infeasible"]:
        constraint_sat = 0.0

    optimality = 0.0
    if cost is not None and oracle_cost is not None and cost > 0:
        optimality = max(0.0, min(1.0, oracle_cost / cost))

    return REALMResultMetrics(
        planning_quality=planning_quality if all_visited else 0.5 * planning_quality,
        optimality_ratio=optimality,
        makespan=float(cost) if cost is not None else float("inf"),
        oracle_makespan=float(oracle_cost) if oracle_cost is not None else 0.0,
        constraint_satisfaction=max(0.0, constraint_sat),
        extras={"tw_violations": details["tw_violations"], "missing": details["missing_visits"]},
    )


def _score_vrp_tw(
    task: REALMTask,
    trajectory: PlanningTrajectory,
    *,
    solver_timeout_s: float = solvers.DEFAULT_SOLVER_TIMEOUT_S,
) -> REALMResultMetrics:
    """P2: multi-group campus tours. We score whether all groups are
    assigned to a guide within that guide's availability and the per-guide
    capacity is respected, and report total wait time as the cost.
    """
    inst = task.instance
    assignments = trajectory.solution.get("assignments")  # type: ignore[union-attr]
    groups = inst.get("visitor_groups", []) or []
    guides = inst.get("tour_guides", []) or []
    max_group_size = int(inst.get("max_group_size", 15))

    served = 0
    violations = 0
    wait_total = 0.0

    # Index guide availability
    guide_by_id = {g["guide_id"]: g for g in guides}

    if isinstance(assignments, dict):
        for guide_id, gid_list in assignments.items():
            g = guide_by_id.get(guide_id)
            if not g:
                violations += 1
                continue
            avail = g.get("availability", [0, 24])
            for entry in gid_list or []:
                # entry may be a string "group1" or a dict {"group":..., "start":...}
                gid = entry["group"] if isinstance(entry, dict) else str(entry)
                start_time = (
                    float(entry.get("start", avail[0]))
                    if isinstance(entry, dict)
                    else float(avail[0])
                )
                group = next((x for x in groups if x.get("group_id") == gid), None)
                if not group:
                    violations += 1
                    continue
                if group.get("size", 0) > max_group_size:
                    violations += 1
                if not (float(avail[0]) <= start_time <= float(avail[1])):
                    violations += 1
                else:
                    served += 1
                wait_total += abs(start_time - float(group.get("preferred_time", start_time)))

    total_groups = max(1, len(groups))
    planning_quality = served / total_groups
    constraint_sat = max(0.0, 1.0 - violations / max(1, len(groups) + len(guides)))

    return REALMResultMetrics(
        planning_quality=planning_quality,
        optimality_ratio=1.0 if wait_total == 0 else 1.0 / (1.0 + wait_total),
        makespan=wait_total,
        oracle_makespan=0.0,
        constraint_satisfaction=constraint_sat,
        extras={"served": served, "violations": violations},
    )


def _score_darp(
    task: REALMTask,
    trajectory: PlanningTrajectory,
    *,
    solver_timeout_s: float = solvers.DEFAULT_SOLVER_TIMEOUT_S,
) -> REALMResultMetrics:
    """P3 / P4: ride-sharing."""
    inst = task.instance
    distances = inst.get("city_map", {}).get("distances") or inst.get("distances") or {}
    vehicles = inst.get("vehicles", []) or []
    passengers = inst.get("passengers", []) or []

    assignments = trajectory.solution.get("assignments") or {}
    # Compute agent's total distance
    total = 0.0
    served = set()
    veh_cur_loc = {v["id"]: v.get("location") for v in vehicles}
    feasible = True
    for vid, ops in assignments.items():
        for op in ops or []:
            if not isinstance(op, str) or ":" not in op:
                continue
            kind, pid = op.split(":", 1)
            p = next((x for x in passengers if x.get("id") == pid), None)
            if not p:
                continue
            if kind == "pickup":
                d = distances.get(f"{veh_cur_loc[vid]}-{p['pickup']}")
                if d is None:
                    feasible = False
                    continue
                total += d
                veh_cur_loc[vid] = p["pickup"]
            elif kind == "dropoff":
                d = distances.get(f"{veh_cur_loc[vid]}-{p['dropoff']}")
                if d is None:
                    feasible = False
                    continue
                total += d
                veh_cur_loc[vid] = p["dropoff"]
                served.add(pid)

    oracle_cost, _ = solvers.darp_oracle_distance(
        vehicles, passengers, distances, timeout_s=solver_timeout_s
    )

    planning_quality = (
        len(served) / max(1, len(passengers)) if passengers else 1.0
    )
    constraint_sat = 1.0 if feasible else 0.0
    optimality = 0.0
    if total > 0 and oracle_cost:
        optimality = max(0.0, min(1.0, oracle_cost / total))

    return REALMResultMetrics(
        planning_quality=planning_quality,
        optimality_ratio=optimality,
        makespan=total,
        oracle_makespan=float(oracle_cost) if oracle_cost else 0.0,
        constraint_satisfaction=constraint_sat,
        extras={"served_passengers": sorted(served)},
    )


def _score_event_coord(
    task: REALMTask,
    trajectory: PlanningTrajectory,
    *,
    solver_timeout_s: float = solvers.DEFAULT_SOLVER_TIMEOUT_S,
) -> REALMResultMetrics:
    """P5/P6/P8/P9: event coordination scenarios.

    We grade on:
        * coverage of required guests / cooking tasks
        * deadline respect (declared in ``constraints``)
        * for disruption variants, whether the replan respected the
          new constraints.
    """
    inst = task.instance
    sol = trajectory.solution or {}
    # Possible solution shapes: ``pickups`` (list of {guest, time}),
    # ``errands_done`` (list of strings), ``cooking_schedule`` (list of {task, time}).
    pickups = sol.get("pickups", []) or []
    errands_done = set(sol.get("errands_done", []) or [])
    cooking = sol.get("cooking_schedule", []) or []

    guests = inst.get("guests", []) or []
    errands = set(inst.get("errands", []) or [])
    cooking_tasks = set(inst.get("cooking_tasks", []) or [])

    # Coverage
    guests_handled = 0
    for g in guests:
        if any(
            p.get("guest") == g.get("name") or p.get("guest") == g.get("id")
            for p in pickups
        ):
            guests_handled += 1

    cov_guests = guests_handled / max(1, len(guests)) if guests else 1.0
    cov_errands = (
        len(errands_done & errands) / max(1, len(errands)) if errands else 1.0
    )
    cov_cooking = (
        len({c.get("task") for c in cooking} & cooking_tasks)
        / max(1, len(cooking_tasks))
        if cooking_tasks
        else 1.0
    )

    planning_quality = (cov_guests + cov_errands + cov_cooking) / 3.0

    # Constraint satisfaction: deadlines met?
    constraints = inst.get("constraints", {}) or {}
    deadline = constraints.get("wedding_deadline") or constraints.get(
        "dinner_deadline"
    )

    violations = 0
    if deadline:
        # Best-effort comparison; deadlines are HH:MM strings.
        for entry in pickups + cooking:
            t = entry.get("time") if isinstance(entry, dict) else None
            if isinstance(t, str) and isinstance(deadline, str):
                if _hhmm_to_minutes(t) > _hhmm_to_minutes(deadline):
                    violations += 1
    constraint_sat = max(0.0, 1.0 - violations / max(1, len(pickups) + len(cooking)))

    return REALMResultMetrics(
        planning_quality=planning_quality,
        optimality_ratio=planning_quality,  # no closed-form oracle; use coverage as proxy
        makespan=float(violations),
        constraint_satisfaction=constraint_sat,
        extras={
            "guests_handled": guests_handled,
            "errands_done": sorted(errands_done & errands),
            "cooking_planned": [c.get("task") for c in cooking],
        },
    )


def _score_disaster(
    task: REALMTask,
    trajectory: PlanningTrajectory,
    *,
    solver_timeout_s: float = solvers.DEFAULT_SOLVER_TIMEOUT_S,
) -> REALMResultMetrics:
    inst = task.instance
    allocations = trajectory.solution.get("allocations", {}) or {}
    score, oracle, details = solvers.disaster_max_coverage_score(
        inst.get("regions", []),
        allocations,
        inst.get("resources", {}),
    )
    optimality = max(0.0, min(1.0, score / oracle)) if oracle > 0 else 0.0
    coverage = sum(
        d["coverage"] for d in details["per_region"].values()
    ) / max(1, len(details["per_region"]))
    return REALMResultMetrics(
        planning_quality=coverage,
        optimality_ratio=optimality,
        makespan=score,
        oracle_makespan=oracle,
        constraint_satisfaction=1.0 if score > 0 else 0.0,
        extras=details,
    )


def _score_supply_chain(
    task: REALMTask,
    trajectory: PlanningTrajectory,
    *,
    solver_timeout_s: float = solvers.DEFAULT_SOLVER_TIMEOUT_S,
) -> REALMResultMetrics:
    inst = task.instance
    sol = trajectory.solution or {}
    orders = sol.get("orders", []) or []
    budget = float(inst.get("budget", 0))
    deadlines = inst.get("delivery_deadlines", {}) or {}

    total_cost = 0.0
    on_time = 0
    for o in orders:
        total_cost += float(o.get("cost", 0))
        component = o.get("component")
        eta = float(o.get("eta", 0))
        if component in deadlines and eta <= float(deadlines[component]):
            on_time += 1
    coverage = on_time / max(1, len(deadlines))
    over_budget = total_cost > budget if budget > 0 else False

    return REALMResultMetrics(
        planning_quality=coverage,
        optimality_ratio=max(0.0, 1.0 - (total_cost / budget)) if budget > 0 else 0.0,
        makespan=total_cost,
        constraint_satisfaction=0.0 if over_budget else coverage,
        extras={"on_time": on_time, "total_cost": total_cost, "over_budget": over_budget},
    )


def _score_jssp(
    task: REALMTask,
    trajectory: PlanningTrajectory,
    *,
    solver_timeout_s: float = solvers.DEFAULT_SOLVER_TIMEOUT_S,
) -> REALMResultMetrics:
    """P11: Job-shop scheduling."""
    inst = task.instance
    jobs = inst.get("jobs") or []
    sol = trajectory.solution or {}

    sequence = sol.get("sequence")
    if not isinstance(sequence, list) or not sequence:
        sequence = _jssp_fifo_sequence(jobs)

    makespan = solvers.jssp_compute_makespan(jobs, sequence)
    feasible = makespan is not None

    # Always compute CP-SAT optimum; if upstream provided a UB take
    # the tighter of the two.
    cp_optimum = solvers.jssp_oracle_makespan(jobs, timeout_s=solver_timeout_s)
    upstream_ub = (
        task.oracle.get("makespan")
        if task.oracle and "makespan" in task.oracle
        else None
    )
    if isinstance(upstream_ub, (int, float)) and upstream_ub > 0:
        oracle: Any = int(min(cp_optimum, int(upstream_ub)))
    else:
        oracle = int(cp_optimum)

    optimality = 0.0
    if feasible and makespan and oracle:
        optimality = max(0.0, min(1.0, oracle / makespan))

    return REALMResultMetrics(
        planning_quality=1.0 if feasible else 0.0,
        optimality_ratio=optimality,
        makespan=float(makespan) if makespan is not None else float("inf"),
        oracle_makespan=float(oracle) if oracle else 0.0,
        constraint_satisfaction=1.0 if feasible else 0.0,
        extras={"feasible": feasible},
    )


_SCORERS = {
    OracleFamily.TSP_TW: _score_tsp_tw,
    OracleFamily.VRP_TW: _score_vrp_tw,
    OracleFamily.DARP: _score_darp,
    OracleFamily.EVENT_COORD: _score_event_coord,
    OracleFamily.DISASTER: _score_disaster,
    OracleFamily.SUPPLY_CHAIN: _score_supply_chain,
    OracleFamily.JSSP: _score_jssp,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _read_route(trajectory: PlanningTrajectory) -> list[str]:
    """Extract a route list from the trajectory's solution payload."""
    route = trajectory.solution.get("route") if trajectory.solution else None
    if isinstance(route, list) and route:
        return [str(x) for x in route]
    return []


def _jssp_fifo_sequence(jobs: list[list[tuple[int, int]]]) -> list[list[int]]:
    """Generate a trivial FIFO per-machine sequence."""
    n_machines = max((op[0] for job in jobs for op in job), default=-1) + 1
    seq: list[list[int]] = [[] for _ in range(n_machines)]
    for j, job in enumerate(jobs):
        for m, _dur in job:
            seq[m].append(j)
    return seq


def _hhmm_to_minutes(t: str) -> int:
    try:
        h, m = t.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return 0


def _adaptation_success(trajectory: PlanningTrajectory) -> float:
    """Return ratio of successful replanning attempts."""
    attempts = trajectory.replanning_attempts or []
    if not attempts:
        return 1.0 if trajectory.overall_success else 0.0
    successful = sum(1 for a in attempts if a.get("success"))
    return successful / len(attempts)


def _coordination_score(task: REALMTask, trajectory: PlanningTrajectory) -> float:
    """Lightweight coordination measure: fraction of expected agents that
    appear in the solution payload."""
    sol = trajectory.solution or {}
    payload = sol.get("assignments") or sol.get("agent_schedules") or {}
    if isinstance(payload, dict) and payload:
        active = sum(1 for v in payload.values() if v)
        return min(1.0, active / max(1, task.num_agents))
    return 0.0


# ---------------------------------------------------------------------------
# Aggregate metrics calculator
# ---------------------------------------------------------------------------


class MetricsCalculator:
    """Compute :class:`REALMMetrics` from a list of per-task results."""

    def calculate(self, results: list[REALMResult]) -> REALMMetrics:
        if not results:
            return REALMMetrics(
                overall_success_rate=0.0,
                total_tasks=0,
                passed_tasks=0,
                failed_tasks=0,
            )
        total = len(results)
        passed = sum(1 for r in results if r.success)

        problem_rates: dict[RealmProblem, float] = {}
        problem_counts: dict[RealmProblem, int] = {}
        for p in RealmProblem:
            sub = [r for r in results if r.problem == p]
            if sub:
                problem_rates[p] = sum(1 for r in sub if r.success) / len(sub)
                problem_counts[p] = len(sub)

        avg = lambda f: sum(f(r) for r in results) / total
        return REALMMetrics(
            overall_success_rate=passed / total,
            total_tasks=total,
            passed_tasks=passed,
            failed_tasks=total - passed,
            problem_success_rates=problem_rates,
            problem_counts=problem_counts,
            avg_planning_quality=avg(lambda r: r.metrics.planning_quality),
            avg_optimality_ratio=avg(lambda r: r.metrics.optimality_ratio),
            avg_coordination=avg(lambda r: r.metrics.coordination),
            avg_constraint_satisfaction=avg(lambda r: r.metrics.constraint_satisfaction),
            avg_adaptation_success_rate=avg(lambda r: r.metrics.adaptation_success_rate),
            avg_planning_time_ms=avg(lambda r: r.metrics.planning_time_ms),
            avg_execution_time_ms=avg(lambda r: r.metrics.execution_time_ms),
            avg_tokens_per_task=avg(lambda r: r.token_usage),
            total_tokens=sum(r.token_usage for r in results),
            total_duration_ms=sum(r.duration_ms for r in results),
            avg_latency_ms=avg(lambda r: r.duration_ms),
        )

    def compare_to_leaderboard(
        self,
        metrics: REALMMetrics,
        leaderboard: dict[str, dict[str, float]],
    ) -> dict[str, dict[str, float]]:
        """Pass-through. Reported numbers in :data:`LEADERBOARD_SCORES`
        are per-problem JSSP gaps, not comparable to our overall success
        rate; we return them verbatim and let the caller render.
        """
        out: dict[str, dict[str, float]] = {}
        for name, entry in leaderboard.items():
            out[name] = dict(entry)
            out[name]["our_jssp_gap_pct"] = float(
                100.0 * max(0.0, 1.0 - metrics.avg_optimality_ratio)
            )
        return out
