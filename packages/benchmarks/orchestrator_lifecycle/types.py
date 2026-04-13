"""Types for orchestrator lifecycle benchmark scenarios and metrics."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class BehaviorTag(str, Enum):
    ASK_CLARIFY = "ask_clarifying_question_before_start"
    DO_NOT_START = "do_not_start_without_required_info"
    SPAWN_SUBAGENT = "spawn_subagent"
    STATUS_REPORT = "report_active_subagent_status"
    ACK_SCOPE_CHANGE = "ack_scope_change"
    APPLY_SCOPE_CHANGE = "apply_scope_change_to_task"
    PAUSE_TASK = "pause_task"
    RESUME_TASK = "resume_task"
    CANCEL_TASK = "cancel_task"
    CONFIRM_CANCEL = "confirm_cancel_effect"
    FINAL_SUMMARY = "final_summary_to_stakeholder"


@dataclass
class ScenarioTurn:
    actor: str
    message: str
    expected_behaviors: list[str] = field(default_factory=list)
    forbidden_behaviors: list[str] = field(default_factory=list)


@dataclass
class Scenario:
    scenario_id: str
    title: str
    category: str
    required_capabilities: list[str] = field(default_factory=list)
    turns: list[ScenarioTurn] = field(default_factory=list)


@dataclass
class ScenarioResult:
    scenario_id: str
    title: str
    passed: bool
    score: float
    checks_passed: int
    checks_total: int
    violations: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class LifecycleMetrics:
    overall_score: float
    scenario_pass_rate: float
    total_scenarios: int
    passed_scenarios: int
    clarification_success_rate: float
    status_accuracy_rate: float
    interruption_handling_rate: float
    completion_summary_quality: float


@dataclass
class LifecycleConfig:
    output_dir: str = "./benchmark_results/orchestrator-lifecycle"
    scenario_dir: str = "benchmarks/orchestrator_lifecycle/scenarios"
    max_scenarios: int | None = None
    scenario_filter: str | None = None
    model: str = "gpt-4o"
    provider: str = "openai"
    strict: bool = True
    seed: int = 42
