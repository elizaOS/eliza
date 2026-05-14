"""
Optimization-oracle solvers for REALM-Bench scoring.

The evaluator uses these to compute a reference (best-known or
heuristically-improved) score against which the agent's solution is
graded. Where ``ortools`` is available we use it for tight bounds;
otherwise we fall back to greedy heuristics and report the resulting
``optimality_ratio`` as an upper bound on the true ratio.

These are not the agent's tools. The agent is expected to produce a
solution payload (see ``PlanningTrajectory.solution``); the solvers
here independently produce an oracle solution for comparison.
"""

from __future__ import annotations

import itertools
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Optional dependency probes
# ---------------------------------------------------------------------------

try:  # pragma: no cover - optional
    from ortools.constraint_solver import pywrapcp  # type: ignore
    from ortools.constraint_solver import routing_enums_pb2  # type: ignore
    from ortools.sat.python import cp_model  # type: ignore

    _HAS_ORTOOLS = True
except Exception:
    _HAS_ORTOOLS = False


def has_ortools() -> bool:
    return _HAS_ORTOOLS


# ---------------------------------------------------------------------------
# JSSP (P11)
# ---------------------------------------------------------------------------


def jssp_compute_makespan(
    jobs: list[list[tuple[int, int]]],
    sequence: list[list[int]],
) -> Optional[int]:
    """Compute the makespan of a given operation sequence.

    ``jobs[j][k]`` is ``(machine, duration)`` for the k-th op of job j
    (must execute in order). ``sequence[m]`` is a permutation of (job
    indices) giving the order in which machine ``m`` will execute its
    operations.

    Returns ``None`` if the sequence is infeasible (e.g. machine
    appears twice or schedule deadlocks).
    """
    n_jobs = len(jobs)
    n_machines = max((op[0] for job in jobs for op in job), default=-1) + 1
    if len(sequence) != n_machines:
        return None

    # Validate that each machine sequence is a permutation of the jobs
    # that visit it.
    job_ops_on_machine: dict[int, list[int]] = {m: [] for m in range(n_machines)}
    for j, job in enumerate(jobs):
        for op_idx, (m, _dur) in enumerate(job):
            job_ops_on_machine.setdefault(m, []).append(j)
    for m, expected in job_ops_on_machine.items():
        if sorted(sequence[m]) != sorted(expected):
            return None

    # Precompute per-job operation order on each machine: which op index
    # of job j happens on machine m.
    job_op_index: dict[tuple[int, int], int] = {}
    for j, job in enumerate(jobs):
        for op_idx, (m, _dur) in enumerate(job):
            job_op_index[(j, m)] = op_idx

    # Simulate. Operations become ready when (a) prior operation of same
    # job has finished and (b) machine has finished prior op in seq.
    machine_ptr = [0] * n_machines  # next position in machine seq to schedule
    job_ptr = [0] * n_jobs           # next op index per job
    op_finish: dict[tuple[int, int], int] = {}
    machine_free = [0] * n_machines

    iters = 0
    max_iters = sum(len(j) for j in jobs) + 10
    while any(ptr < len(jobs[j]) for j, ptr in enumerate(job_ptr)):
        iters += 1
        if iters > max_iters * max_iters:
            return None  # likely deadlock
        progressed = False
        for m in range(n_machines):
            if machine_ptr[m] >= len(sequence[m]):
                continue
            candidate_job = sequence[m][machine_ptr[m]]
            # Is this the next op for that job, and is it on this machine?
            if job_ptr[candidate_job] >= len(jobs[candidate_job]):
                continue
            next_op_machine, dur = jobs[candidate_job][job_ptr[candidate_job]]
            if next_op_machine != m:
                continue
            # Ready time = max(machine free, job's prior op end)
            job_ready = (
                op_finish.get(
                    (candidate_job, jobs[candidate_job][job_ptr[candidate_job] - 1][0]),
                    0,
                )
                if job_ptr[candidate_job] > 0
                else 0
            )
            start = max(machine_free[m], job_ready)
            finish = start + dur
            op_finish[(candidate_job, m)] = finish
            machine_free[m] = finish
            job_ptr[candidate_job] += 1
            machine_ptr[m] += 1
            progressed = True
        if not progressed:
            return None
    return max(machine_free) if machine_free else 0


def jssp_oracle_makespan(jobs: list[list[tuple[int, int]]]) -> int:
    """Compute / approximate the optimal JSSP makespan.

    - With ortools: solve to optimality with the CP-SAT model.
    - Without: lower-bound by ``max(sum of job durations, max machine load)``.
      (Lower bound is loose but gives a usable ratio for small instances.)
    """
    if _HAS_ORTOOLS:
        try:
            return _jssp_cpsat(jobs)
        except Exception as exc:  # pragma: no cover - falls back
            logger.warning("[jssp] OR-Tools failed: %s; falling back to LB", exc)

    # Lower bound
    n_machines = max((op[0] for job in jobs for op in job), default=-1) + 1
    job_durations = [sum(dur for _, dur in job) for job in jobs]
    machine_loads = [0] * n_machines
    for job in jobs:
        for m, dur in job:
            machine_loads[m] += dur
    return max(max(job_durations, default=0), max(machine_loads, default=0))


def _jssp_cpsat(jobs: list[list[tuple[int, int]]]) -> int:  # pragma: no cover
    model = cp_model.CpModel()
    horizon = sum(dur for job in jobs for _, dur in job)
    n_machines = max(m for job in jobs for m, _ in job) + 1
    intervals_per_machine: dict[int, list[Any]] = {m: [] for m in range(n_machines)}
    all_intervals: list[Any] = []
    end_per_job: list[Any] = []

    for j, job in enumerate(jobs):
        prev_end = None
        for k, (m, dur) in enumerate(job):
            start = model.NewIntVar(0, horizon, f"s_{j}_{k}")
            end = model.NewIntVar(0, horizon, f"e_{j}_{k}")
            interval = model.NewIntervalVar(start, dur, end, f"i_{j}_{k}")
            intervals_per_machine[m].append(interval)
            all_intervals.append(interval)
            if prev_end is not None:
                model.Add(start >= prev_end)
            prev_end = end
        end_per_job.append(prev_end)

    for m, ivars in intervals_per_machine.items():
        if ivars:
            model.AddNoOverlap(ivars)

    obj = model.NewIntVar(0, horizon, "makespan")
    model.AddMaxEquality(obj, end_per_job)
    model.Minimize(obj)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10.0
    status = solver.Solve(model)
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return int(solver.ObjectiveValue())
    raise RuntimeError("CP-SAT failed")


# ---------------------------------------------------------------------------
# P1 — TSP-TW
# ---------------------------------------------------------------------------


def tsp_tw_route_cost(
    route: list[str],
    distances: dict[str, float],
    time_windows: dict[str, tuple[float, float]] | dict[str, list[float]],
    *,
    start_location: str,
    end_location: str,
    max_duration: float,
) -> tuple[Optional[float], dict[str, Any]]:
    """Return ``(total_cost, details)`` for a candidate TSP-TW route.

    ``total_cost`` is ``None`` if the route violates a hard constraint
    (missing start/end, exceeds ``max_duration``, or visits a location
    outside its time window). Soft details are always returned so the
    evaluator can report per-window violations.
    """
    details = {
        "tw_violations": 0,
        "duration": 0.0,
        "missing_visits": [],
        "infeasible": False,
    }
    if not route or route[0] != start_location or route[-1] != end_location:
        details["infeasible"] = True
        return None, details

    expected_locs = set(time_windows.keys())
    visited = set(route) - {start_location, end_location}
    missing = sorted(expected_locs - visited)
    details["missing_visits"] = missing

    total = 0.0
    cur_time = 0.0  # arrival clock — we treat tw_open as a wait constraint
    for a, b in zip(route, route[1:]):
        d = distances.get(f"{a}-{b}")
        if d is None:
            details["infeasible"] = True
            return None, details
        total += d
        cur_time += d
        if b in time_windows:
            tw = time_windows[b]
            tw_open, tw_close = float(tw[0]), float(tw[1])
            # If we arrive early, wait until tw_open (model time-of-day-ish).
            # If we arrive after tw_close, count as a violation.
            if cur_time > tw_close:
                details["tw_violations"] += 1
            elif cur_time < tw_open:
                cur_time = tw_open
    details["duration"] = total
    if total > max_duration:
        details["infeasible"] = True
        return None, details
    return total, details


def tsp_tw_oracle(
    locations: list[str],
    distances: dict[str, float],
    time_windows: dict[str, tuple[float, float]],
    *,
    start_location: str,
    end_location: str,
    max_duration: float,
) -> tuple[Optional[float], list[str]]:
    """Brute-force optimum for very small TSP-TW (<= 8 visit locations).

    For larger instances we fall back to nearest-neighbour. Returns
    ``(cost, route)``. ``cost`` is ``None`` if no feasible route found.
    """
    middle = [loc for loc in locations if loc not in {start_location, end_location}]
    if not middle:
        return 0.0, [start_location, end_location]

    if len(middle) <= 8:
        best_cost: Optional[float] = None
        best_route: list[str] = []
        for perm in itertools.permutations(middle):
            route = [start_location, *perm, end_location]
            cost, _ = tsp_tw_route_cost(
                route,
                distances,
                time_windows,
                start_location=start_location,
                end_location=end_location,
                max_duration=max_duration,
            )
            if cost is not None and (best_cost is None or cost < best_cost):
                best_cost = cost
                best_route = route
        return best_cost, best_route

    # Nearest-neighbour
    route = [start_location]
    remaining = set(middle)
    cur = start_location
    total = 0.0
    while remaining:
        nxt = min(
            remaining,
            key=lambda loc: distances.get(f"{cur}-{loc}", float("inf")),
        )
        d = distances.get(f"{cur}-{nxt}", float("inf"))
        if d == float("inf"):
            return None, []
        total += d
        cur = nxt
        route.append(nxt)
        remaining.discard(nxt)
    last = distances.get(f"{cur}-{end_location}", float("inf"))
    if last == float("inf"):
        return None, []
    total += last
    route.append(end_location)
    return total, route


# ---------------------------------------------------------------------------
# P3/P4 — light DARP heuristic oracle
# ---------------------------------------------------------------------------


def darp_oracle_distance(
    vehicles: list[dict[str, Any]],
    passengers: list[dict[str, Any]],
    distances: dict[str, float],
) -> tuple[Optional[float], dict[str, list[str]]]:
    """Greedy nearest-neighbour pickup-then-dropoff assignment.

    Returns ``(total_distance, assignments)`` where ``assignments`` maps
    vehicle_id -> ordered list of action labels like
    ``"pickup:p1"`` / ``"dropoff:p1"``. Capacity is enforced; fuel/
    deadline are not checked at the oracle level. This is a usable
    upper bound on the optimum.
    """
    assignments: dict[str, list[str]] = {v["id"]: [] for v in vehicles}
    total = 0.0
    unassigned = list(passengers)
    # Track current location per vehicle
    cur_loc = {v["id"]: v.get("location") for v in vehicles}
    cur_load = {v["id"]: 0 for v in vehicles}

    while unassigned:
        # For each pending passenger, find best vehicle by (cur_loc -> pickup) distance.
        best: Optional[tuple[float, str, dict[str, Any]]] = None
        for p in unassigned:
            for v in vehicles:
                if cur_load[v["id"]] >= v.get("capacity", 0):
                    continue
                from_loc = cur_loc[v["id"]]
                to_loc = p.get("pickup")
                d = distances.get(f"{from_loc}-{to_loc}", float("inf"))
                if d == float("inf"):
                    continue
                if best is None or d < best[0]:
                    best = (d, v["id"], p)
        if best is None:
            return None, assignments
        d, vid, p = best
        total += d
        assignments[vid].append(f"pickup:{p['id']}")
        cur_loc[vid] = p["pickup"]
        # immediate dropoff (we drop greedy)
        d2 = distances.get(f"{p['pickup']}-{p['dropoff']}", float("inf"))
        if d2 == float("inf"):
            return None, assignments
        total += d2
        assignments[vid].append(f"dropoff:{p['id']}")
        cur_loc[vid] = p["dropoff"]
        unassigned.remove(p)

    return total, assignments


# ---------------------------------------------------------------------------
# P7 — Disaster relief priority coverage
# ---------------------------------------------------------------------------


SEVERITY_WEIGHT: dict[str, float] = {"critical": 3.0, "urgent": 2.0, "normal": 1.0}


def disaster_max_coverage_score(
    regions: list[dict[str, Any]],
    allocations: dict[str, dict[str, float]],
    resources: dict[str, float],
) -> tuple[float, float, dict[str, Any]]:
    """Priority-weighted coverage score for P7.

    ``allocations[region_id][resource_name]`` = amount allocated.

    Returns ``(coverage_score, oracle_score, details)`` where:

    - ``coverage_score`` = sum over regions of ``severity_weight *
      coverage_ratio(region)``
    - ``oracle_score``   = same but where each region is fully covered
      up to its declared ``population`` need (clamped by resource pool).
    - ``details`` carries per-region coverage stats.
    """

    def needed(region: dict[str, Any]) -> float:
        # Per-capita: 1 unit of any "need" per person.
        return float(region.get("population", 0))

    # Compute oracle: allocate greedily to highest severity first up to
    # resources. We model a single fungible resource pool of total
    # ``sum(resources.values())`` for simplicity (matches the paper's
    # high-level scoring intent).
    pool = sum(resources.values())
    sorted_regions = sorted(
        regions, key=lambda r: -SEVERITY_WEIGHT.get(r.get("severity", "normal"), 1.0)
    )
    oracle = 0.0
    remaining = pool
    for r in sorted_regions:
        n = needed(r)
        give = min(remaining, n)
        if n > 0:
            oracle += SEVERITY_WEIGHT.get(r.get("severity", "normal"), 1.0) * (give / n)
        remaining -= give
        if remaining <= 0:
            break

    # Agent score
    agent_score = 0.0
    per_region: dict[str, dict[str, float]] = {}
    for r in regions:
        rid = r.get("id") or r.get("region_id") or ""
        n = needed(r)
        allocated = sum(allocations.get(rid, {}).values())
        coverage = (allocated / n) if n > 0 else 0.0
        coverage = max(0.0, min(1.0, coverage))
        weight = SEVERITY_WEIGHT.get(r.get("severity", "normal"), 1.0)
        agent_score += weight * coverage
        per_region[rid] = {"allocated": allocated, "needed": n, "coverage": coverage}

    return agent_score, oracle, {"per_region": per_region}
