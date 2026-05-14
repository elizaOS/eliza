"""
REALM-Bench Type Definitions.

Faithful to the 11 canonical scenarios of the paper:

    REALM-Bench: A Real-World Planning Benchmark for LLMs and Multi-Agent Systems
    Geng et al., arXiv:2502.18836

The taxonomy below is the paper's: P1..P11 are the actual problem types,
not the synthetic "sequential/reactive/complex" buckets that previously
lived here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Canonical problem types (P1..P11)
# ---------------------------------------------------------------------------


class RealmProblem(str, Enum):
    """The 11 canonical REALM-Bench problem types.

    The string values are kept as ``P1`` … ``P11`` so they match the
    upstream dataset directory names and the strings used by the paper.
    """

    P1 = "P1"   # Single-Agent Campus Tour (TSP/VRP with time windows)
    P2 = "P2"   # Multi-Group Campus Tours (multi-agent VRP-TW)
    P3 = "P3"   # Urban Ride-Sharing (VRP / DARP)
    P4 = "P4"   # URS with Disruptions (DARP + traffic disruptions)
    P5 = "P5"   # Wedding Logistics (multi-agent coordination)
    P6 = "P6"   # Thanksgiving Dinner Planning (scheduling + pickups)
    P7 = "P7"   # Disaster Relief (priority-weighted resource allocation)
    P8 = "P8"   # Wedding Logistics with Disruptions
    P9 = "P9"   # Thanksgiving Dinner with Disruptions
    P10 = "P10"  # Global GPU Supply Chain (large-scale planning)
    P11 = "P11"  # Job Shop Scheduling (JSSP)


# Back-compat alias. Older code references ``REALMCategory``; we re-export
# the same enum under that name so existing imports keep working, but the
# values are now the 11 paper problem types instead of the fabricated
# six-category taxonomy.
REALMCategory = RealmProblem


# Map each problem to a coarse oracle family. Used by the evaluator to
# dispatch to the correct scoring routine.
class OracleFamily(str, Enum):
    TSP_TW = "tsp_tw"          # P1
    VRP_TW = "vrp_tw"          # P2
    DARP = "darp"              # P3, P4
    EVENT_COORD = "event_coord"  # P5, P6, P8, P9
    DISASTER = "disaster"      # P7
    SUPPLY_CHAIN = "supply_chain"  # P10
    JSSP = "jssp"              # P11


PROBLEM_TO_FAMILY: dict[RealmProblem, OracleFamily] = {
    RealmProblem.P1: OracleFamily.TSP_TW,
    RealmProblem.P2: OracleFamily.VRP_TW,
    RealmProblem.P3: OracleFamily.DARP,
    RealmProblem.P4: OracleFamily.DARP,
    RealmProblem.P5: OracleFamily.EVENT_COORD,
    RealmProblem.P6: OracleFamily.EVENT_COORD,
    RealmProblem.P7: OracleFamily.DISASTER,
    RealmProblem.P8: OracleFamily.EVENT_COORD,
    RealmProblem.P9: OracleFamily.EVENT_COORD,
    RealmProblem.P10: OracleFamily.SUPPLY_CHAIN,
    RealmProblem.P11: OracleFamily.JSSP,
}


# Problems that ship with disruption injection per the paper.
PROBLEMS_WITH_DISRUPTIONS: frozenset[RealmProblem] = frozenset(
    {RealmProblem.P4, RealmProblem.P7, RealmProblem.P8, RealmProblem.P9, RealmProblem.P10}
)


# Problems that paper describes as multi-agent.
MULTI_AGENT_PROBLEMS: frozenset[RealmProblem] = frozenset(
    {
        RealmProblem.P2,
        RealmProblem.P3,
        RealmProblem.P4,
        RealmProblem.P5,
        RealmProblem.P6,
        RealmProblem.P7,
        RealmProblem.P8,
        RealmProblem.P9,
        RealmProblem.P10,
    }
)


PROBLEM_DESCRIPTIONS: dict[RealmProblem, str] = {
    RealmProblem.P1: "Single-Agent Campus Tour — visit all locations within time windows, minimize travel.",
    RealmProblem.P2: "Multi-Group Campus Tours — assign tour guides to visitor groups concurrently.",
    RealmProblem.P3: "Urban Ride-Sharing — assign vehicles to passengers minimizing distance under capacity & deadlines.",
    RealmProblem.P4: "URS with Disruptions — same as P3 with mid-run traffic delays and road closures.",
    RealmProblem.P5: "Wedding Logistics — coordinate guest pickups, errands, shared vehicles to a deadline.",
    RealmProblem.P6: "Thanksgiving Dinner — synchronize travel and meal preparation among family members.",
    RealmProblem.P7: "Disaster Relief — allocate aid to regions weighted by severity/population.",
    RealmProblem.P8: "Wedding Logistics with Disruptions — P5 + road closures requiring replanning.",
    RealmProblem.P9: "Thanksgiving Dinner with Disruptions — P6 + flight delays requiring replanning.",
    RealmProblem.P10: "Global GPU Supply Chain — large-scale industrial planning with cost/risk tradeoffs.",
    RealmProblem.P11: "Job Shop Scheduling — minimize makespan for n jobs on m machines.",
}


# ---------------------------------------------------------------------------
# Execution status + plan-shape models (kept stable for the eliza adapter)
# ---------------------------------------------------------------------------


class PlanStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


class ExecutionModel(str, Enum):
    SEQUENTIAL = "sequential"
    PARALLEL = "parallel"
    DAG = "dag"


@dataclass
class PlanningAction:
    name: str
    parameters: dict[str, Any]
    description: Optional[str] = None


@dataclass
class PlanningStep:
    step_number: int
    action: PlanningAction
    observation: str = ""
    success: bool = False
    error: Optional[str] = None
    duration_ms: float = 0.0


@dataclass
class PlanningTrajectory:
    """Trajectory produced by the agent harness.

    ``solution`` carries the agent's actual proposed solution payload
    (e.g. a JSSP schedule or a VRP route assignment) — the extrinsic
    evaluator reads this to score against the oracle. This replaces the
    old "set-intersect on action names" scoring.

    ``planning_time_ms`` and ``execution_time_ms`` are measured by the
    agent harness (wall clock), not estimated as a fixed percentage of
    total duration.

    ``replanning_attempts`` records each adapt-after-disruption attempt
    with the resulting solution and a success flag (for P4/P8/P9).
    """

    task_id: str
    steps: list[PlanningStep] = field(default_factory=list)
    final_outcome: str = ""
    overall_success: bool = False
    duration_ms: float = 0.0
    planning_time_ms: float = 0.0
    execution_time_ms: float = 0.0
    tokens_used: int = 0
    adaptation_count: int = 0
    start_time_ms: float = 0.0
    end_time_ms: float = 0.0
    # Agent's proposed solution — interpreted by the per-problem evaluator
    solution: dict[str, Any] = field(default_factory=dict)
    # Replanning attempts (for disruption scenarios)
    replanning_attempts: list[dict[str, Any]] = field(default_factory=list)
    # Deprecated. Kept as a write-only attribute for adapter back-compat.
    # The new evaluator ignores this field — see ``benchmarks.realm.evaluator``.
    plan_quality_score: float = 0.0


# ---------------------------------------------------------------------------
# Tasks + test cases
# ---------------------------------------------------------------------------


@dataclass
class REALMTask:
    """A single REALM-Bench task instance.

    Each task is one instance of one of the 11 canonical problem types
    (P1..P11). ``instance`` carries the raw upstream JSON (e.g. the
    distance matrix, the JSSP job/machine tables, the wedding guest
    list…) — the evaluator reads from there.
    """

    id: str
    name: str
    description: str
    goal: str
    problem: RealmProblem
    instance: dict[str, Any] = field(default_factory=dict)
    # Pre-computed oracle solution from the upstream solver (e.g. UB for JSSP).
    # When ``oracle`` is ``None`` the evaluator falls back to a built-in
    # heuristic / approximate solver.
    oracle: Optional[dict[str, Any]] = None
    timeout_ms: int = 120_000
    max_steps: int = 32
    difficulty: str = "medium"
    num_agents: int = 1  # For multi-agent scenarios.
    has_disruptions: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    # Back-compat shim: legacy ``category`` attribute. Returns the same
    # enum value as ``problem``; older code may still reference this.
    @property
    def category(self) -> RealmProblem:  # noqa: D401
        return self.problem

    # Back-compat shim: ``available_tools`` was the legacy interface used
    # by the eliza adapter prompt. For canonical scenarios the available
    # "tools" depend on the problem family — return a reasonable default
    # so the prompt is still informative.
    @property
    def available_tools(self) -> list[str]:
        return self.metadata.get("available_tools", [])  # type: ignore[return-value]

    @property
    def constraints(self) -> dict[str, Any]:
        return self.metadata.get("constraints", {})  # type: ignore[return-value]

    @property
    def requirements(self) -> list[str]:
        return self.metadata.get("requirements", [])  # type: ignore[return-value]

    @property
    def expected_outcome(self) -> str:
        return str(self.metadata.get("expected_outcome", ""))


@dataclass
class REALMTestCase:
    task: REALMTask
    input: dict[str, Any]
    expected: dict[str, Any]


# ---------------------------------------------------------------------------
# Results and metrics
# ---------------------------------------------------------------------------


@dataclass
class REALMResultMetrics:
    """Per-task scoring (the six paper metrics).

    All values are normalised to [0, 1] where higher is better, except
    ``makespan`` / ``total_distance`` / ``total_cost`` which are raw
    physical quantities for reporting.
    """

    # 1. Planning Quality (goal satisfaction rate)
    planning_quality: float = 0.0
    # 2. Planning Optimality
    optimality_ratio: float = 0.0    # oracle / agent (1.0 == optimal)
    makespan: float = 0.0            # raw makespan / route cost / total cost
    oracle_makespan: float = 0.0     # oracle / UB if available
    # 3. Coordination Effectiveness (multi-agent only)
    coordination: float = 1.0
    # 4. Constraint Satisfaction Rate
    constraint_satisfaction: float = 0.0
    # 5. Resource Usage
    planning_time_ms: float = 0.0
    execution_time_ms: float = 0.0
    tokens: int = 0
    # 6. Adaptation to Disruption (P4/P7/P8/P9/P10)
    adaptation_success_rate: float = 1.0
    # Per-problem extras (e.g. number of TW violations, served-passenger ratio)
    extras: dict[str, Any] = field(default_factory=dict)


@dataclass
class REALMResultDetails:
    plan_adaptations: int = 0
    error_recoveries: int = 0
    tokens: int = 0
    duration: float = 0.0


@dataclass
class REALMResult:
    task_id: str
    problem: RealmProblem
    trajectory: PlanningTrajectory
    success: bool
    steps_executed: int
    actions_performed: list[str]
    duration_ms: float = 0.0
    token_usage: int = 0
    error: Optional[str] = None
    metrics: REALMResultMetrics = field(default_factory=REALMResultMetrics)
    details: REALMResultDetails = field(default_factory=REALMResultDetails)
    # Back-compat: some downstream code still reads ``.category``.
    @property
    def category(self) -> RealmProblem:
        return self.problem


@dataclass
class REALMMetrics:
    overall_success_rate: float
    total_tasks: int
    passed_tasks: int
    failed_tasks: int

    # Per-problem
    problem_success_rates: dict[RealmProblem, float] = field(default_factory=dict)
    problem_counts: dict[RealmProblem, int] = field(default_factory=dict)

    # Paper's six metric families, averaged
    avg_planning_quality: float = 0.0
    avg_optimality_ratio: float = 0.0
    avg_coordination: float = 0.0
    avg_constraint_satisfaction: float = 0.0
    avg_adaptation_success_rate: float = 0.0
    avg_planning_time_ms: float = 0.0
    avg_execution_time_ms: float = 0.0
    avg_tokens_per_task: float = 0.0
    total_tokens: int = 0
    total_duration_ms: float = 0.0
    avg_latency_ms: float = 0.0

    # Back-compat aliases for older callers.
    @property
    def category_success_rates(self) -> dict[RealmProblem, float]:
        return self.problem_success_rates

    @property
    def category_counts(self) -> dict[RealmProblem, int]:
        return self.problem_counts


@dataclass
class REALMConfig:
    data_path: str = "./packages/benchmarks/realm/upstream/datasets"
    output_dir: str = "./benchmark_results/realm"

    # Execution
    max_tasks_per_problem: Optional[int] = None
    timeout_per_task_ms: int = 300_000
    max_steps: int = 32
    execution_model: ExecutionModel = ExecutionModel.DAG

    # What to run
    problems: Optional[list[RealmProblem]] = None  # None = all
    enable_adaptation: bool = True
    enable_multi_agent: bool = True
    use_sample_tasks: bool = False  # Smoke-only: tiny built-in P1/P11 only.

    # Reporting
    save_detailed_logs: bool = True
    save_trajectories: bool = True
    generate_report: bool = True

    # Model
    model_name: str = "gpt-4"
    temperature: float = 0.3

    # Solver wall-clock budget (seconds) per instance. Applies to the
    # OR-Tools CP-SAT (JSSP) and RoutingModel (TSP-TW / DARP) calls. A
    # short timeout still produces a valid bound: CP-SAT returns its
    # best FEASIBLE schedule, RoutingModel returns the best route found
    # so far.
    solver_timeout_s: float = 30.0

    # Back-compat aliases
    @property
    def categories(self) -> Optional[list[RealmProblem]]:
        return self.problems

    @categories.setter
    def categories(self, value: Optional[list[RealmProblem]]) -> None:
        self.problems = value

    @property
    def max_tasks_per_category(self) -> Optional[int]:
        return self.max_tasks_per_problem

    @max_tasks_per_category.setter
    def max_tasks_per_category(self, value: Optional[int]) -> None:
        self.max_tasks_per_problem = value


@dataclass
class REALMReport:
    metadata: dict[str, Any]
    metrics: REALMMetrics
    results: list[REALMResult]
    problem_breakdown: dict[str, dict[str, float]]
    summary: dict[str, Any]
    # Back-compat: pre-existing fields used by older serializers.
    comparison_to_leaderboard: dict[str, dict[str, float]] = field(default_factory=dict)

    @property
    def category_breakdown(self) -> dict[str, dict[str, float]]:
        return self.problem_breakdown


# ---------------------------------------------------------------------------
# Leaderboard scores
# ---------------------------------------------------------------------------

# The paper (arXiv:2502.18836) reports per-problem results in the JSSP
# dashboard tables for ALAS and several baselines, plus qualitative
# results for P1-P10. The previous version of this file shipped
# fabricated per-category "overall" percentages that don't correspond to
# any number in the paper. We replace that table with the real per-task
# JSSP optimality gap headline numbers from the paper README, and link
# out for the rest.
#
# Numbers below are "gap to upper bound (%)" reported on DMU/TA datasets
# in the upstream README (lower is better, 0 == matches the known UB).
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {
    "ALAS-static (P11/DMU)": {"jssp_dmu_gap_pct": 19.09},
    "ALAS-dynamic (P11/TA)": {"jssp_ta_gap_pct": 0.86},
    "SeEvo(GPT3.5) (P11/DMU)": {"jssp_dmu_gap_pct": 19.03},
    "DRL-Liu (P11/DMU)": {"jssp_dmu_gap_pct": 21.33},
    "GP (P11/DMU)": {"jssp_dmu_gap_pct": 23.02},
}

LEADERBOARD_NOTE = (
    "Numbers above are 'gap to upper bound (%)' on the P11/JSSP DMU and "
    "TA dataset families, as reported in the upstream REALM-Bench "
    "README. The paper does not publish a single 'overall %' across all "
    "11 scenarios; for the full per-problem breakdown see "
    "https://github.com/genglongling/REALM-Bench"
)


__all__ = [
    "RealmProblem",
    "REALMCategory",  # back-compat alias
    "OracleFamily",
    "PROBLEM_TO_FAMILY",
    "PROBLEMS_WITH_DISRUPTIONS",
    "MULTI_AGENT_PROBLEMS",
    "PROBLEM_DESCRIPTIONS",
    "PlanStatus",
    "ExecutionModel",
    "PlanningAction",
    "PlanningStep",
    "PlanningTrajectory",
    "REALMTask",
    "REALMTestCase",
    "REALMResultMetrics",
    "REALMResultDetails",
    "REALMResult",
    "REALMMetrics",
    "REALMConfig",
    "REALMReport",
    "LEADERBOARD_SCORES",
    "LEADERBOARD_NOTE",
]
