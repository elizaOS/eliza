"""
Optimization-oracle solvers for REALM-Bench scoring.

The evaluator uses these to compute a reference (true-optimum where the
problem is tractable, otherwise a tight provably-near-optimal value)
against which the agent's solution is graded.

OR-Tools is an optional runtime dependency. Importing this module must
not fail when it is absent; benchmark runs that need CP-SAT or
RoutingModel call :func:`ensure_ortools` lazily. If auto-install is
enabled, OR-Tools is installed into an isolated cache venv and added to
``sys.path`` for this process. If it is disabled or installation fails,
the public solvers either use bounded fallbacks or raise a clear
``ORToolsUnavailableError`` at the solver callsite.

Per-problem solver summary:

================== ====================================================
Problem            Solver
================== ====================================================
P1  (TSP-TW)       OR-Tools RoutingModel, time-window dimension.
P2  (VRP-TW)       (scored by evaluator; planning-quality coverage).
P3/P4 (DARP/CVRP-TW)
                   OR-Tools RoutingModel with pickup-delivery pairs and
                   capacity + time-window dimensions. Greedy fallback
                   only on infeasibility/timeout, with a logged warning.
P7  (Disaster)     Closed-form priority-weighted coverage (no solver
                   needed — the optimum is computable in O(n log n)).
P11 (JSSP)         OR-Tools CP-SAT (NoOverlap + interval makespan
                   minimisation). The configurable timeout controls
                   when a solution is reported as ``OPTIMAL`` vs
                   ``FEASIBLE`` (still a valid UB).
================== ====================================================

These are not the agent's tools. The agent is expected to produce a
solution payload (see ``PlanningTrajectory.solution``); the solvers
here independently produce an oracle solution for comparison.
"""

from __future__ import annotations

import importlib
import itertools
import json
import logging
import os
import subprocess
import sys
import sysconfig
import venv
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


ORTOOLS_SPEC = "ortools>=9.5,<10.0"
ORTOOLS_AUTO_INSTALL_ENV = "REALM_AUTO_INSTALL_ORTOOLS"
ORTOOLS_CACHE_ENV = "REALM_ORTOOLS_CACHE_DIR"
ORTOOLS_DISABLE_INSTALL_ENV = "REALM_DISABLE_ORTOOLS_INSTALL"


class ORToolsUnavailableError(RuntimeError):
    """Raised when a solver needs OR-Tools but it is unavailable."""


pywrapcp: Any | None = None
routing_enums_pb2: Any | None = None
cp_model: Any | None = None
_ORTOOLS_IMPORT_ERROR: BaseException | None = None
_ORTOOLS_INSTALL_ATTEMPTED = False


def has_ortools() -> bool:
    """Return whether OR-Tools can be imported without installing it."""
    return _import_ortools() is True


def ensure_ortools(*, auto_install: bool | None = None) -> bool:
    """Ensure OR-Tools is importable.

    ``auto_install`` defaults to ``REALM_AUTO_INSTALL_ORTOOLS=1``. When
    enabled, installation happens in an isolated venv under
    ``REALM_ORTOOLS_CACHE_DIR`` or the user cache directory. The current
    Python environment is not modified.
    """
    if _import_ortools():
        return True

    should_install = _auto_install_enabled() if auto_install is None else auto_install
    if should_install and not _install_disabled():
        _install_ortools_to_cache()
        if _import_ortools():
            return True

    raise ORToolsUnavailableError(_missing_ortools_message(auto_install=should_install))


def _import_ortools() -> bool:
    global pywrapcp, routing_enums_pb2, cp_model, _ORTOOLS_IMPORT_ERROR
    if pywrapcp is not None and routing_enums_pb2 is not None and cp_model is not None:
        return True
    try:
        pywrapcp = importlib.import_module("ortools.constraint_solver.pywrapcp")
        routing_enums_pb2 = importlib.import_module(
            "ortools.constraint_solver.routing_enums_pb2"
        )
        cp_model = importlib.import_module("ortools.sat.python.cp_model")
        _ORTOOLS_IMPORT_ERROR = None
        return True
    except ImportError as exc:
        pywrapcp = None
        routing_enums_pb2 = None
        cp_model = None
        _ORTOOLS_IMPORT_ERROR = exc
        return False


def _auto_install_enabled() -> bool:
    return os.environ.get(ORTOOLS_AUTO_INSTALL_ENV, "").lower() in {"1", "true", "yes"}


def _install_disabled() -> bool:
    return os.environ.get(ORTOOLS_DISABLE_INSTALL_ENV, "").lower() in {"1", "true", "yes"}


def _missing_ortools_message(*, auto_install: bool) -> str:
    install_note = (
        f"Auto-install was enabled via {ORTOOLS_AUTO_INSTALL_ENV}=1, but installation "
        "did not make OR-Tools importable."
        if auto_install
        else f"Set {ORTOOLS_AUTO_INSTALL_ENV}=1 to let REALM install OR-Tools into "
        "an isolated cache venv for the current run."
    )
    details = f" Last import error: {_ORTOOLS_IMPORT_ERROR}" if _ORTOOLS_IMPORT_ERROR else ""
    return (
        "REALM OR-Tools oracle support is unavailable. Install "
        f"`{ORTOOLS_SPEC}` in your environment, or run with auto-install enabled. "
        f"{install_note}{details}"
    )


def _ortools_cache_dir() -> Path:
    override = os.environ.get(ORTOOLS_CACHE_ENV)
    if override:
        return Path(override).expanduser()
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    version = f"py{sys.version_info.major}{sys.version_info.minor}"
    return base / "elizaos" / "realm" / f"ortools-{version}"


def _venv_python(venv_dir: Path) -> Path:
    exe = "python.exe" if os.name == "nt" else "python"
    return venv_dir / ("Scripts" if os.name == "nt" else "bin") / exe


def _install_ortools_to_cache() -> None:
    global _ORTOOLS_INSTALL_ATTEMPTED
    if _ORTOOLS_INSTALL_ATTEMPTED:
        return
    _ORTOOLS_INSTALL_ATTEMPTED = True

    venv_dir = _ortools_cache_dir()
    py = _venv_python(venv_dir)
    if not py.exists():
        logger.info("[REALM] Creating isolated OR-Tools cache venv at %s", venv_dir)
        venv.EnvBuilder(with_pip=True, clear=False).create(venv_dir)

    logger.info("[REALM] Installing %s into %s", ORTOOLS_SPEC, venv_dir)
    subprocess.run(
        [str(py), "-m", "pip", "install", "--upgrade", ORTOOLS_SPEC],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    for path in _venv_site_paths(py):
        if path and path not in sys.path:
            sys.path.insert(0, path)


def _venv_site_paths(py: Path) -> list[str]:
    script = (
        "import json, sysconfig; "
        "print(json.dumps([sysconfig.get_path('purelib'), sysconfig.get_path('platlib')]))"
    )
    try:
        proc = subprocess.run(
            [str(py), "-c", script],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        paths = json.loads(proc.stdout)
        return [str(Path(p)) for p in paths if p]
    except Exception:
        scheme = "nt" if os.name == "nt" else "posix_prefix"
        base = str(py.parent.parent)
        purelib = sysconfig.get_path(
            "purelib",
            scheme=scheme,
            vars={"base": base, "platbase": base, "installed_base": base},
        )
        return [str(Path(purelib))] if purelib else []


# Default per-instance solver wall-clock budget. Overridable via the
# REALMConfig / CLI ``--solver-timeout`` and per-call kwargs.
DEFAULT_SOLVER_TIMEOUT_S: float = 30.0


# ---------------------------------------------------------------------------
# JSSP (P11) — OR-Tools CP-SAT.
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

    job_ops_on_machine: dict[int, list[int]] = {m: [] for m in range(n_machines)}
    for j, job in enumerate(jobs):
        for _op_idx, (m, _dur) in enumerate(job):
            job_ops_on_machine.setdefault(m, []).append(j)
    for m, expected in job_ops_on_machine.items():
        if sorted(sequence[m]) != sorted(expected):
            return None

    machine_ptr = [0] * n_machines
    job_ptr = [0] * n_jobs
    op_finish: dict[tuple[int, int], int] = {}
    machine_free = [0] * n_machines

    iters = 0
    max_iters = sum(len(j) for j in jobs) + 10
    while any(ptr < len(jobs[j]) for j, ptr in enumerate(job_ptr)):
        iters += 1
        if iters > max_iters * max_iters:
            return None
        progressed = False
        for m in range(n_machines):
            if machine_ptr[m] >= len(sequence[m]):
                continue
            candidate_job = sequence[m][machine_ptr[m]]
            if job_ptr[candidate_job] >= len(jobs[candidate_job]):
                continue
            next_op_machine, dur = jobs[candidate_job][job_ptr[candidate_job]]
            if next_op_machine != m:
                continue
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


def jssp_oracle_makespan(
    jobs: list[list[tuple[int, int]]],
    *,
    timeout_s: float = DEFAULT_SOLVER_TIMEOUT_S,
    auto_install_ortools: bool | None = None,
) -> int:
    """Compute the optimal (or best-found, on timeout) JSSP makespan.

    Uses OR-Tools CP-SAT. If the solver returns ``OPTIMAL`` within
    ``timeout_s`` the answer is provably optimal. If it returns
    ``FEASIBLE`` only, the result is the best schedule found within the
    budget (still a valid upper bound; the makespan-LB inside CP-SAT
    keeps it tight). On the rare case the model cannot find any feasible
    solution within the budget we fall back to the trivial
    ``max(job_duration_sum, max_machine_load)`` lower bound and log a
    warning so the failure is visible in the run output.
    """
    if not jobs:
        return 0
    ensure_ortools(auto_install=auto_install_ortools)
    try:
        status, makespan = _jssp_cpsat(jobs, timeout_s=timeout_s)
    except Exception as exc:  # pragma: no cover - extremely defensive
        logger.warning("[jssp] CP-SAT crashed (%s); falling back to LB", exc)
        return _jssp_lb(jobs)

    if status == cp_model.OPTIMAL:
        return int(makespan)
    if status == cp_model.FEASIBLE:
        return int(makespan)
    logger.warning(
        "[jssp] CP-SAT returned status=%s within %.1fs; falling back to LB. "
        "Optimality ratio against this run will be conservative.",
        status,
        timeout_s,
    )
    return _jssp_lb(jobs)


def _jssp_lb(jobs: list[list[tuple[int, int]]]) -> int:
    """Trivial LB used only when CP-SAT can't return any solution."""
    n_machines = max((op[0] for job in jobs for op in job), default=-1) + 1
    job_durations = [sum(dur for _, dur in job) for job in jobs]
    machine_loads = [0] * n_machines
    for job in jobs:
        for m, dur in job:
            machine_loads[m] += dur
    return max(max(job_durations, default=0), max(machine_loads, default=0))


def _jssp_cpsat(
    jobs: list[list[tuple[int, int]]],
    *,
    timeout_s: float,
) -> tuple[int, int]:
    """Run CP-SAT and return ``(status, makespan)``."""
    model = cp_model.CpModel()
    horizon = sum(dur for job in jobs for _, dur in job)
    n_machines = max(m for job in jobs for m, _ in job) + 1
    intervals_per_machine: dict[int, list[Any]] = {m: [] for m in range(n_machines)}
    end_per_job: list[Any] = []

    for j, job in enumerate(jobs):
        prev_end = None
        for k, (m, dur) in enumerate(job):
            start = model.NewIntVar(0, horizon, f"s_{j}_{k}")
            end = model.NewIntVar(0, horizon, f"e_{j}_{k}")
            interval = model.NewIntervalVar(start, dur, end, f"i_{j}_{k}")
            intervals_per_machine[m].append(interval)
            if prev_end is not None:
                model.Add(start >= prev_end)
            prev_end = end
        end_per_job.append(prev_end)

    for _m, ivars in intervals_per_machine.items():
        if ivars:
            model.AddNoOverlap(ivars)

    obj = model.NewIntVar(0, horizon, "makespan")
    model.AddMaxEquality(obj, end_per_job)
    model.Minimize(obj)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(max(0.1, timeout_s))
    status = solver.Solve(model)
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return status, int(solver.ObjectiveValue())
    return status, _jssp_lb(jobs)


# ---------------------------------------------------------------------------
# P1 — TSP with time windows.
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
    details: dict[str, Any] = {
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
    cur_time = 0.0
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
    timeout_s: float = DEFAULT_SOLVER_TIMEOUT_S,
    auto_install_ortools: bool | None = None,
) -> tuple[Optional[float], list[str]]:
    """Solve TSP-TW with OR-Tools RoutingModel.

    Returns ``(cost, route)``. The route is a list of location names
    starting at ``start_location`` and ending at ``end_location``. If
    the solver finds no feasible solution within ``timeout_s`` we fall
    back to brute-force (<= 8 intermediate nodes) or nearest-neighbour
    (larger). Both fallbacks are upper bounds; the RoutingModel path is
    the standard "good enough" optimum used by the OR-Tools VRP-TW
    tutorials.
    """
    middle = [loc for loc in locations if loc not in {start_location, end_location}]
    if not middle:
        return 0.0, [start_location, end_location]

    try:
        ensure_ortools(auto_install=auto_install_ortools)
    except ORToolsUnavailableError as exc:
        logger.warning("[tsp_tw] %s Falling back to local heuristic.", exc)
        return _tsp_tw_fallback(
            middle, distances, time_windows,
            start_location=start_location,
            end_location=end_location,
            max_duration=max_duration,
        )

    nodes = [start_location] + middle + [end_location]
    n = len(nodes)
    idx_of: dict[str, int] = {loc: i for i, loc in enumerate(nodes)}

    SCALE = 1000
    big = 10**12

    def edge(a: str, b: str) -> int:
        if a == b:
            return 0
        d = distances.get(f"{a}-{b}")
        if d is None:
            return big
        return int(round(float(d) * SCALE))

    matrix = [[edge(nodes[i], nodes[j]) for j in range(n)] for i in range(n)]

    manager = pywrapcp.RoutingIndexManager(n, 1, [0], [n - 1])
    routing = pywrapcp.RoutingModel(manager)

    def distance_callback(from_index, to_index):
        return matrix[manager.IndexToNode(from_index)][manager.IndexToNode(to_index)]

    transit_idx = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_idx)

    horizon = int(max(1, max_duration) * SCALE)
    routing.AddDimension(
        transit_idx,
        horizon,
        horizon,
        False,
        "Time",
    )
    time_dim = routing.GetDimensionOrDie("Time")

    for loc, tw in time_windows.items():
        i = idx_of.get(loc)
        if i is None:
            continue
        lo = int(round(float(tw[0]) * SCALE))
        hi = int(round(float(tw[1]) * SCALE))
        if lo > hi:
            lo, hi = hi, lo
        index = manager.NodeToIndex(i)
        time_dim.CumulVar(index).SetRange(lo, hi)

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search_parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search_parameters.time_limit.FromSeconds(int(max(1, timeout_s)))

    assignment = routing.SolveWithParameters(search_parameters)
    if assignment is None:
        logger.warning("[tsp_tw] RoutingModel found no solution; falling back to heuristic")
        return _tsp_tw_fallback(
            middle, distances, time_windows,
            start_location=start_location,
            end_location=end_location,
            max_duration=max_duration,
        )

    index = routing.Start(0)
    route_nodes: list[str] = []
    while not routing.IsEnd(index):
        route_nodes.append(nodes[manager.IndexToNode(index)])
        index = assignment.Value(routing.NextVar(index))
    route_nodes.append(nodes[manager.IndexToNode(index)])

    cost, details = tsp_tw_route_cost(
        route_nodes, distances, time_windows,
        start_location=start_location,
        end_location=end_location,
        max_duration=max_duration,
    )
    if cost is None:
        return _tsp_tw_fallback(
            middle, distances, time_windows,
            start_location=start_location,
            end_location=end_location,
            max_duration=max_duration,
        )
    return cost, route_nodes


def _tsp_tw_fallback(
    middle: list[str],
    distances: dict[str, float],
    time_windows: dict[str, tuple[float, float]],
    *,
    start_location: str,
    end_location: str,
    max_duration: float,
) -> tuple[Optional[float], list[str]]:
    """Brute-force (<= 8 nodes) or nearest-neighbour fallback."""
    if len(middle) <= 8:
        best_cost: Optional[float] = None
        best_route: list[str] = []
        for perm in itertools.permutations(middle):
            route = [start_location, *perm, end_location]
            cost, _ = tsp_tw_route_cost(
                route, distances, time_windows,
                start_location=start_location,
                end_location=end_location,
                max_duration=max_duration,
            )
            if cost is not None and (best_cost is None or cost < best_cost):
                best_cost = cost
                best_route = route
        return best_cost, best_route

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
# P3/P4 — DARP / CVRP-TW oracle (OR-Tools RoutingModel + pickup-delivery).
# ---------------------------------------------------------------------------


def darp_oracle_distance(
    vehicles: list[dict[str, Any]],
    passengers: list[dict[str, Any]],
    distances: dict[str, float],
    *,
    timeout_s: float = DEFAULT_SOLVER_TIMEOUT_S,
    use_time_windows: bool = True,
    auto_install_ortools: bool | None = None,
) -> tuple[Optional[float], dict[str, list[str]]]:
    """Solve P3/P4 ride-sharing as a CVRP-TW with pickup-delivery pairs.

    Models the problem as a multi-vehicle routing problem on a graph
    whose nodes are: ``[depot, pickup_p0, dropoff_p0, pickup_p1,
    dropoff_p1, ...]``. The depot is a virtual node connected with
    cost-zero edges to each vehicle's start location.

    Constraints:

    - **Pickup-delivery**: passenger's pickup must be visited before
      their dropoff, by the *same* vehicle.
    - **Capacity**: each vehicle's seats can't be exceeded (each
      passenger counts as +1 on pickup, -1 on dropoff).
    - **Time windows** (optional): if the upstream passenger has a
      ``time_window`` we enforce it on the Distance dimension cumul at
      pickup; tight windows can make the problem infeasible, so each
      pickup-dropoff pair carries a disjunction penalty that lets the
      solver drop unservable requests rather than return INFEASIBLE.

    Objective: total travel distance (paper's metric for P3/P4).

    Returns ``(total_distance, assignments)`` where ``assignments`` maps
    ``vehicle_id -> ["pickup:p_id", "dropoff:p_id", ...]``. On infeasi-
    bility or timeout we fall back to the greedy heuristic and log a
    warning; the returned ``assignments[vehicle_id]`` will be the
    greedy schedule and the caller sees a value but should treat the
    optimality ratio as a *bound*.
    """
    if not vehicles or not passengers:
        return 0.0, {v["id"]: [] for v in vehicles}

    try:
        ensure_ortools(auto_install=auto_install_ortools)
    except ORToolsUnavailableError as exc:
        logger.warning("[darp] %s Falling back to greedy heuristic.", exc)
        return _darp_greedy_fallback(vehicles, passengers, distances)

    n_passengers = len(passengers)
    n_vehicles = len(vehicles)
    n_nodes = 1 + 2 * n_passengers

    pickup_node = [1 + 2 * i for i in range(n_passengers)]
    dropoff_node = [2 + 2 * i for i in range(n_passengers)]
    node_location: list[str] = ["_depot"]
    for p in passengers:
        node_location.append(p["pickup"])
        node_location.append(p["dropoff"])

    SCALE = 1000
    big = 10**11

    def loc_distance(a: str, b: str) -> int:
        if a == b:
            return 0
        d = distances.get(f"{a}-{b}")
        if d is None:
            return big
        return int(round(float(d) * SCALE))

    def edge(i: int, j: int, veh_idx: int) -> int:
        if i == j:
            return 0
        if i == 0:
            return loc_distance(vehicles[veh_idx]["location"], node_location[j])
        if j == 0:
            return 0
        return loc_distance(node_location[i], node_location[j])

    manager = pywrapcp.RoutingIndexManager(n_nodes, n_vehicles, 0)
    routing = pywrapcp.RoutingModel(manager)

    transit_indices: list[int] = []
    for v_idx in range(n_vehicles):
        def make_cb(vi: int):
            def cb(from_index, to_index):
                i = manager.IndexToNode(from_index)
                j = manager.IndexToNode(to_index)
                return edge(i, j, vi)
            return cb
        cb = make_cb(v_idx)
        transit_indices.append(routing.RegisterTransitCallback(cb))
    for v_idx in range(n_vehicles):
        routing.SetArcCostEvaluatorOfVehicle(transit_indices[v_idx], v_idx)

    def demand_cb(from_index):
        i = manager.IndexToNode(from_index)
        if i in pickup_node:
            return 1
        if i in dropoff_node:
            return -1
        return 0

    demand_idx = routing.RegisterUnaryTransitCallback(demand_cb)
    capacities = [int(v.get("capacity", 4)) for v in vehicles]
    routing.AddDimensionWithVehicleCapacity(
        demand_idx,
        0,
        capacities,
        True,
        "Capacity",
    )

    routing.AddDimension(
        transit_indices[0],
        big,
        big,
        True,
        "Distance",
    )

    for i in range(n_passengers):
        p_idx = manager.NodeToIndex(pickup_node[i])
        d_idx = manager.NodeToIndex(dropoff_node[i])
        routing.AddPickupAndDelivery(p_idx, d_idx)
        routing.solver().Add(
            routing.VehicleVar(p_idx) == routing.VehicleVar(d_idx)
        )
        distance_dim = routing.GetDimensionOrDie("Distance")
        routing.solver().Add(
            distance_dim.CumulVar(p_idx) <= distance_dim.CumulVar(d_idx)
        )

    if use_time_windows:
        distance_dim = routing.GetDimensionOrDie("Distance")
        for i, p in enumerate(passengers):
            tw = p.get("time_window")
            if not tw:
                continue
            try:
                lo = int(round(float(tw[0]) * SCALE))
                hi = int(round(float(tw[1]) * SCALE))
            except (TypeError, ValueError, IndexError):
                continue
            if lo > hi:
                lo, hi = hi, lo
            p_idx = manager.NodeToIndex(pickup_node[i])
            distance_dim.CumulVar(p_idx).SetRange(lo, hi)

    disjunction_penalty = int(10_000 * SCALE)
    for i in range(n_passengers):
        routing.AddDisjunction(
            [manager.NodeToIndex(pickup_node[i]), manager.NodeToIndex(dropoff_node[i])],
            disjunction_penalty,
            2,
        )

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    )
    search_parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search_parameters.time_limit.FromSeconds(int(max(1, timeout_s)))

    assignment = routing.SolveWithParameters(search_parameters)
    if assignment is None:
        logger.warning(
            "[darp] RoutingModel returned no solution within %.1fs; "
            "falling back to greedy heuristic.",
            timeout_s,
        )
        return _darp_greedy_fallback(vehicles, passengers, distances)

    assignments: dict[str, list[str]] = {v["id"]: [] for v in vehicles}
    total_cost_scaled = 0
    for v_idx in range(n_vehicles):
        vid = vehicles[v_idx]["id"]
        index = routing.Start(v_idx)
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node in pickup_node:
                p_i = pickup_node.index(node)
                assignments[vid].append(f"pickup:{passengers[p_i]['id']}")
            elif node in dropoff_node:
                p_i = dropoff_node.index(node)
                assignments[vid].append(f"dropoff:{passengers[p_i]['id']}")
            next_index = assignment.Value(routing.NextVar(index))
            total_cost_scaled += routing.GetArcCostForVehicle(index, next_index, v_idx)
            index = next_index

    total_cost = total_cost_scaled / SCALE
    return total_cost, assignments


def _darp_greedy_fallback(
    vehicles: list[dict[str, Any]],
    passengers: list[dict[str, Any]],
    distances: dict[str, float],
) -> tuple[Optional[float], dict[str, list[str]]]:
    """Greedy nearest-pickup-then-dropoff. Upper bound on the optimum."""
    assignments: dict[str, list[str]] = {v["id"]: [] for v in vehicles}
    total = 0.0
    unassigned = list(passengers)
    cur_loc = {v["id"]: v.get("location") for v in vehicles}
    cur_load = {v["id"]: 0 for v in vehicles}

    while unassigned:
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
        d2 = distances.get(f"{p['pickup']}-{p['dropoff']}", float("inf"))
        if d2 == float("inf"):
            return None, assignments
        total += d2
        assignments[vid].append(f"dropoff:{p['id']}")
        cur_loc[vid] = p["dropoff"]
        unassigned.remove(p)

    return total, assignments


# ---------------------------------------------------------------------------
# P7 — Disaster relief priority coverage (closed-form).
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
        return float(region.get("population", 0))

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
