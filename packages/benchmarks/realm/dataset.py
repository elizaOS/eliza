"""
REALM-Bench dataset loader.

Loads the 11 canonical scenarios (P1..P11) from the vendored upstream
dataset directory at ``packages/benchmarks/realm/upstream/datasets``.

P1..P10 are JSON instance files (one JSON per instance).
P11 (JSSP) is plain text in the Taillard / DMU format (n_jobs n_machines
header + (machine, time) pairs per row).

A ``use_sample_tasks`` mode is exposed for smoke tests that don't want
to hit disk — it returns one tiny synthetic P1 instance and one tiny
synthetic P11 instance.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from benchmarks.realm.types import (
    MULTI_AGENT_PROBLEMS,
    PROBLEM_DESCRIPTIONS,
    PROBLEMS_WITH_DISRUPTIONS,
    REALMTask,
    REALMTestCase,
    RealmProblem,
)

logger = logging.getLogger(__name__)


DEFAULT_UPSTREAM_PATH = Path(__file__).resolve().parent / "upstream" / "datasets"

# Default per-problem instance counts when iterating (cap to keep runs cheap).
DEFAULT_INSTANCES_PER_PROBLEM = 5


# ---------------------------------------------------------------------------
# JSSP (P11) text-format parser. Used for DMU and TA file families.
# ---------------------------------------------------------------------------


def parse_jssp_instance(text: str) -> dict[str, Any]:
    """Parse a JSSP instance in the Taillard/DMU plain-text format.

    Two variants are common:

    * ``cscmax`` / Taillard short form: first non-blank line is
      ``n_jobs n_machines``; each subsequent row contains
      ``machine_idx_1 time_1 machine_idx_2 time_2 ...`` for one job.

    * Taillard long form ("TA01"): header with metadata, then a
      ``Times`` block (n_jobs x n_machines processing times), then a
      ``Machines`` block (n_jobs x n_machines machine indices).

    Returns ``{"n_jobs", "n_machines", "jobs"}`` where ``jobs`` is a
    list of lists of ``(machine_idx, duration)`` tuples (machine_idx is
    0-indexed).
    """
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise ValueError("Empty JSSP instance")

    # Taillard long form starts with "Nb of jobs..." header.
    if lines[0].lower().startswith("nb of jobs"):
        # Header has metadata. Look for "Times" / "Machines" sections.
        header_row = lines[1].split()
        n_jobs = int(header_row[0])
        n_machines = int(header_row[1])
        upper_bound = int(header_row[4]) if len(header_row) > 4 else 0
        # find Times and Machines sections
        try:
            times_idx = next(
                i for i, ln in enumerate(lines) if ln.strip().lower() == "times"
            )
            machines_idx = next(
                i for i, ln in enumerate(lines) if ln.strip().lower() == "machines"
            )
        except StopIteration:
            raise ValueError("Taillard JSSP missing Times/Machines blocks")

        times_block = lines[times_idx + 1 : machines_idx]
        machines_block = lines[machines_idx + 1 : machines_idx + 1 + n_jobs]
        times = [[int(x) for x in row.split()] for row in times_block[:n_jobs]]
        machines = [[int(x) for x in row.split()] for row in machines_block]
        jobs = []
        for j in range(n_jobs):
            row_ops = []
            for k in range(n_machines):
                # Taillard machines are 1-indexed; convert to 0-indexed.
                row_ops.append((machines[j][k] - 1, times[j][k]))
            jobs.append(row_ops)
        return {
            "n_jobs": n_jobs,
            "n_machines": n_machines,
            "jobs": jobs,
            "upper_bound": upper_bound,
        }

    # cscmax / short form
    header = lines[0].split()
    n_jobs = int(header[0])
    n_machines = int(header[1])
    jobs: list[list[tuple[int, int]]] = []
    for row in lines[1 : 1 + n_jobs]:
        tokens = [int(t) for t in row.split()]
        ops: list[tuple[int, int]] = []
        for k in range(0, len(tokens), 2):
            machine_idx = tokens[k]
            duration = tokens[k + 1]
            ops.append((machine_idx, duration))
        jobs.append(ops)
    return {"n_jobs": n_jobs, "n_machines": n_machines, "jobs": jobs}


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


class REALMDataset:
    """Loads the 11 canonical REALM-Bench problem instances."""

    def __init__(
        self,
        data_path: str | Path = DEFAULT_UPSTREAM_PATH,
        *,
        max_instances_per_problem: int = DEFAULT_INSTANCES_PER_PROBLEM,
        use_sample_tasks: bool = False,
    ) -> None:
        self.data_path = Path(data_path)
        self.max_instances_per_problem = max_instances_per_problem
        self.use_sample_tasks = use_sample_tasks
        self.tasks: list[REALMTask] = []
        self.test_cases: list[REALMTestCase] = []
        self._loaded = False

    async def load(self) -> None:
        if self._loaded:
            return
        if self.use_sample_tasks:
            self._load_sample_tasks()
        else:
            self._load_upstream()
        self._loaded = True
        logger.info(
            "[REALMDataset] Loaded %d tasks (sample=%s)",
            len(self.tasks),
            self.use_sample_tasks,
        )

    # ------------------------------------------------------------------
    # Built-in sample tasks (smoke runs)
    # ------------------------------------------------------------------

    def _load_sample_tasks(self) -> None:
        """Two small synthetic instances — P1 + P11 — for smoke tests."""
        # P1 — tiny tour
        p1_instance = {
            "instance_id": "p1_sample",
            "locations": ["entrance", "library", "cafeteria", "entrance"],
            "start_location": "entrance",
            "end_location": "entrance",
            "distances": {
                "entrance-library": 5,
                "library-entrance": 5,
                "entrance-cafeteria": 7,
                "cafeteria-entrance": 7,
                "library-cafeteria": 4,
                "cafeteria-library": 4,
            },
            "time_windows": {"library": [9, 12], "cafeteria": [11, 14]},
            "max_duration": 60,
        }
        self._register_instance(RealmProblem.P1, "p1_sample", p1_instance)

        # P11 — 2 jobs x 2 machines, known optimal makespan 5.
        # Job0: M0(3) -> M1(2). Job1: M1(2) -> M0(1).
        # Optimal makespan = 5 (Job1's M0 runs at t=4..5 after Job0's M0).
        p11_instance = {
            "instance_id": "p11_sample",
            "n_jobs": 2,
            "n_machines": 2,
            "jobs": [[(0, 3), (1, 2)], [(1, 2), (0, 1)]],
            "upper_bound": 5,
        }
        self._register_instance(
            RealmProblem.P11,
            "p11_sample",
            p11_instance,
            oracle={"makespan": 5},
        )

    # ------------------------------------------------------------------
    # Upstream JSON / JSSP loader
    # ------------------------------------------------------------------

    def _load_upstream(self) -> None:
        if not self.data_path.exists():
            logger.warning(
                "[REALMDataset] data path %s does not exist; falling back to sample tasks",
                self.data_path,
            )
            self._load_sample_tasks()
            return

        for problem in RealmProblem:
            self._load_problem(problem)

    def _load_problem(self, problem: RealmProblem) -> None:
        problem_dir = self.data_path / problem.value
        if not problem_dir.exists():
            logger.debug(
                "[REALMDataset] No directory for %s under %s", problem.value, self.data_path
            )
            return

        if problem == RealmProblem.P11:
            self._load_p11(problem_dir)
            return

        # P1..P10 are JSON instances under a few possible subdirs.
        candidate_subdirs = ["custom", "processed", "disruptions", ""]
        json_paths: list[Path] = []
        for sub in candidate_subdirs:
            base = problem_dir / sub if sub else problem_dir
            if base.is_dir():
                json_paths.extend(sorted(base.glob("*.json")))
        # de-dupe while preserving order
        seen: set[Path] = set()
        unique_paths: list[Path] = []
        for p in json_paths:
            if p not in seen:
                seen.add(p)
                unique_paths.append(p)

        for path in unique_paths[: self.max_instances_per_problem]:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning("[REALMDataset] Failed to parse %s: %s", path, exc)
                continue
            instance_id = data.get("instance_id") or path.stem
            self._register_instance(problem, instance_id, data)

    def _load_p11(self, problem_dir: Path) -> None:
        """Load JSSP instances from the TA / DMU / abzswvyn text families."""
        instances: list[tuple[str, Path]] = []
        # Prefer Taillard small instances (TA01/TA02) and small DMU ones.
        for sub in ("TA", "DMU", "abzswvyn"):
            sub_dir = problem_dir / sub
            if not sub_dir.is_dir():
                continue
            for path in sorted(sub_dir.glob("*.txt")):
                instances.append((path.stem, path))

        for instance_id, path in instances[: self.max_instances_per_problem]:
            try:
                parsed = parse_jssp_instance(path.read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning("[REALMDataset] Failed JSSP parse %s: %s", path, exc)
                continue
            instance = {
                "instance_id": instance_id,
                "source_file": str(path.relative_to(self.data_path)),
                **parsed,
            }
            oracle = (
                {"makespan": parsed["upper_bound"]}
                if parsed.get("upper_bound")
                else None
            )
            self._register_instance(
                RealmProblem.P11, instance_id, instance, oracle=oracle
            )

    # ------------------------------------------------------------------
    # Task registration
    # ------------------------------------------------------------------

    def _register_instance(
        self,
        problem: RealmProblem,
        instance_id: str,
        instance: dict[str, Any],
        *,
        oracle: Optional[dict[str, Any]] = None,
    ) -> None:
        task_id = f"{problem.value}-{instance_id}"
        name = f"{problem.value}: {PROBLEM_DESCRIPTIONS[problem].split(' — ', 1)[0]}"
        description = PROBLEM_DESCRIPTIONS[problem]

        num_agents = self._infer_num_agents(problem, instance)
        has_disruptions = (
            problem in PROBLEMS_WITH_DISRUPTIONS
            or bool(instance.get("disruption_scenarios"))
        )

        # Goal phrasing fed to the agent. Concrete, problem-specific.
        goal = _build_goal_text(problem, instance)

        # Embed any oracle that came along in the instance file
        # (e.g. JSSP upper_bound) into the explicit ``oracle`` field.
        if oracle is None and "upper_bound" in instance:
            oracle = {"makespan": instance["upper_bound"]}

        task = REALMTask(
            id=task_id,
            name=name,
            description=description,
            goal=goal,
            problem=problem,
            instance=instance,
            oracle=oracle,
            timeout_ms=300_000,
            max_steps=64,
            difficulty=_infer_difficulty(problem, instance),
            num_agents=num_agents,
            has_disruptions=has_disruptions,
            metadata={
                "available_tools": _suggested_tools(problem),
                "constraints": _problem_constraints(problem, instance),
                "requirements": [],
                "expected_outcome": goal,
            },
        )

        test_case = REALMTestCase(
            task=task,
            input={"message": goal, "context": {"instance_id": instance_id}},
            expected={
                "problem": problem.value,
                "oracle": oracle or {},
                "disruptions": instance.get("disruption_scenarios", []),
                # Back-compat: keep an ``actions`` key (list of suggested
                # tools). Older smoke code may read it.
                "actions": _suggested_tools(problem),
            },
        )

        self.tasks.append(task)
        self.test_cases.append(test_case)

    def _infer_num_agents(self, problem: RealmProblem, instance: dict[str, Any]) -> int:
        if problem not in MULTI_AGENT_PROBLEMS:
            return 1
        # Common shapes: ``tour_guides`` (P2), ``vehicles`` (P3/4/5/6/8/9),
        # ``personnel`` (P7), ``suppliers`` (P10).
        for key in ("tour_guides", "vehicles", "personnel", "suppliers"):
            if isinstance(instance.get(key), list):
                return max(1, len(instance[key]))
            if isinstance(instance.get(key), dict):
                return max(1, len(instance[key]))
        return 2

    # ------------------------------------------------------------------
    # Selection API
    # ------------------------------------------------------------------

    def get_tasks(
        self,
        problems: Optional[list[RealmProblem]] = None,
        limit: Optional[int] = None,
    ) -> list[REALMTask]:
        filtered = (
            [t for t in self.tasks if t.problem in problems]
            if problems
            else list(self.tasks)
        )
        return filtered[:limit] if limit else filtered

    def get_test_cases(
        self,
        problems: Optional[list[RealmProblem]] = None,
        categories: Optional[list[RealmProblem]] = None,  # back-compat alias
        limit: Optional[int] = None,
    ) -> list[REALMTestCase]:
        """Return test cases, optionally filtered.

        ``limit`` is interpreted as **limit per problem** (matches the
        old ``max_tasks_per_category`` semantics).
        """
        selected = problems if problems is not None else categories
        problem_order = selected if selected is not None else list(RealmProblem)
        buckets: dict[RealmProblem, list[REALMTestCase]] = {p: [] for p in problem_order}
        for tc in self.test_cases:
            if tc.task.problem in buckets:
                buckets[tc.task.problem].append(tc)

        if limit is None:
            return [tc for p in problem_order for tc in buckets[p]]
        return [tc for p in problem_order for tc in buckets[p][:limit]]

    def get_tasks_by_difficulty(self, difficulty: str) -> list[REALMTask]:
        return [t for t in self.tasks if t.difficulty == difficulty]


# ---------------------------------------------------------------------------
# Per-problem helpers
# ---------------------------------------------------------------------------


def _build_goal_text(problem: RealmProblem, instance: dict[str, Any]) -> str:
    """Build a concrete agent-facing goal string."""
    iid = instance.get("instance_id", "?")
    if problem == RealmProblem.P1:
        locs = instance.get("locations", [])
        return (
            f"[{iid}] Visit all locations {locs[1:-1]} starting from "
            f"{instance.get('start_location', 'entrance')} respecting time windows "
            f"and minimizing total travel time."
        )
    if problem == RealmProblem.P2:
        n_groups = len(instance.get("visitor_groups", []))
        n_guides = len(instance.get("tour_guides", []))
        return (
            f"[{iid}] Assign {n_guides} tour guides to {n_groups} visitor groups "
            "respecting size capacity and minimizing wait times."
        )
    if problem in (RealmProblem.P3, RealmProblem.P4):
        n_pass = len(instance.get("passengers", []))
        n_veh = len(instance.get("vehicles", []))
        return (
            f"[{iid}] Route {n_veh} vehicles to serve {n_pass} passengers under "
            "capacity, fuel, and deadline constraints; minimize total distance."
            + (" Adapt to live disruptions." if problem == RealmProblem.P4 else "")
        )
    if problem in (RealmProblem.P5, RealmProblem.P8):
        return (
            f"[{iid}] Coordinate guest pickups, errands, and shared vehicles to "
            f"the wedding deadline ({instance.get('constraints', {}).get('wedding_deadline', '18:00')})."
            + (" Adapt to road closures." if problem == RealmProblem.P8 else "")
        )
    if problem in (RealmProblem.P6, RealmProblem.P9):
        return (
            f"[{iid}] Coordinate family pickups and dinner preparation to be served by "
            f"{instance.get('constraints', {}).get('dinner_deadline', '18:00')}."
            + (" Adapt to flight delays." if problem == RealmProblem.P9 else "")
        )
    if problem == RealmProblem.P7:
        n_regions = len(instance.get("regions", []))
        return (
            f"[{iid}] Allocate aid to {n_regions} regions weighted by severity, "
            "subject to resource and personnel constraints; minimize unmet need."
        )
    if problem == RealmProblem.P10:
        return (
            f"[{iid}] Plan procurement, manufacturing, and delivery for the GPU "
            "supply chain to meet deadlines under budget and capacity constraints."
        )
    if problem == RealmProblem.P11:
        return (
            f"[{iid}] Job-shop schedule with {instance.get('n_jobs')} jobs on "
            f"{instance.get('n_machines')} machines; minimize makespan."
        )
    return f"[{iid}] {PROBLEM_DESCRIPTIONS[problem]}"


def _suggested_tools(problem: RealmProblem) -> list[str]:
    """Suggested tool palette for prompt-side hints. Not enforced by the evaluator."""
    if problem in (RealmProblem.P1, RealmProblem.P2):
        return ["plan_route", "check_time_window", "compute_distance", "submit_solution"]
    if problem in (RealmProblem.P3, RealmProblem.P4):
        return ["assign_passenger", "compute_route", "check_constraints", "submit_solution", "adapt_to_disruption"]
    if problem in (RealmProblem.P5, RealmProblem.P6, RealmProblem.P8, RealmProblem.P9):
        return ["schedule_task", "assign_vehicle", "check_deadline", "submit_solution", "adapt_to_disruption"]
    if problem == RealmProblem.P7:
        return ["allocate_resource", "prioritize_region", "dispatch_personnel", "submit_solution"]
    if problem == RealmProblem.P10:
        return ["order_components", "schedule_facility", "check_budget", "submit_solution"]
    if problem == RealmProblem.P11:
        return ["sequence_operations", "compute_makespan", "submit_solution"]
    return ["submit_solution"]


def _problem_constraints(problem: RealmProblem, instance: dict[str, Any]) -> dict[str, Any]:
    """Extract problem-level constraints from an upstream instance."""
    out: dict[str, Any] = {}
    if problem == RealmProblem.P1:
        out["max_duration"] = instance.get("max_duration", 180)
        out["time_windows"] = instance.get("time_windows", {})
    elif problem == RealmProblem.P2:
        out["tour_duration"] = instance.get("tour_duration", 90)
        out["max_group_size"] = instance.get("max_group_size", 15)
    elif problem in (RealmProblem.P3, RealmProblem.P4):
        out["deadlines"] = {
            p.get("id"): p.get("deadline")
            for p in instance.get("passengers", [])
            if p.get("deadline") is not None
        }
    elif problem == RealmProblem.P7:
        out["deadlines"] = instance.get("deadlines", {})
    elif problem == RealmProblem.P10:
        out["budget"] = instance.get("budget", 0)
        out["delivery_deadlines"] = instance.get("delivery_deadlines", {})
    return out


def _infer_difficulty(problem: RealmProblem, instance: dict[str, Any]) -> str:
    if problem == RealmProblem.P11:
        n = int(instance.get("n_jobs", 0)) * int(instance.get("n_machines", 0))
        if n <= 100:
            return "easy"
        if n <= 400:
            return "medium"
        return "hard"
    if problem in PROBLEMS_WITH_DISRUPTIONS:
        return "hard"
    if problem in MULTI_AGENT_PROBLEMS:
        return "medium"
    return "easy"
