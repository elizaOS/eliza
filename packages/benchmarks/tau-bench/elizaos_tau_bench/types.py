"""ElizaOS tau-bench harness types.

These wrap the upstream Action/Task models and add the eliza-specific
config + per-trial bookkeeping used by the runner. Upstream's own pydantic
models (Action, Task, EnvResponse, RewardResult) are re-exported here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from elizaos_tau_bench.upstream.types import (
    Action as Action,
    Task as Task,
    EnvResponse as EnvResponse,
    EnvResetResponse as EnvResetResponse,
    EnvInfo as EnvInfo,
    RewardResult as RewardResult,
    RewardOutputInfo as RewardOutputInfo,
    RewardActionInfo as RewardActionInfo,
    SolveResult as SolveResult,
    RESPOND_ACTION_NAME as RESPOND_ACTION_NAME,
    RESPOND_ACTION_FIELD_NAME as RESPOND_ACTION_FIELD_NAME,
)

DomainName = Literal["retail", "airline"]
TaskSplit = Literal["test", "dev", "train"]


@dataclass
class TaskRunResult:
    """Outcome of a single (task, trial) execution."""

    task_id: int
    trial: int
    domain: DomainName
    reward: float  # upstream env reward (action + outputs match) in [0,1]
    success: bool  # reward >= 1.0 after gating by judge / data hash
    scenario_id: str = "base"
    scenario_note: str = ""
    judge_passed: Optional[bool] = None  # only when outputs are present
    judge_explanation: str = ""
    judge_mode: Optional[str] = None  # "llm" | "substring" | "none-required"
    # True when the opt-in heuristic replaced a failed LLM judge — a degraded
    # verdict must stay distinguishable from a healthy one in report.json.
    judge_degraded: bool = False
    r_actions: Optional[float] = None
    r_outputs: Optional[float] = None
    num_turns: int = 0
    num_tool_calls: int = 0
    user_cost: float | None = None
    agent_cost: float | None = None
    error: Optional[str] = None
    messages: list[dict[str, Any]] = field(default_factory=list)
    info: dict[str, Any] = field(default_factory=dict)


@dataclass
class PassKResult:
    k: int
    num_tasks: int
    pass_hat_k: float


@dataclass
class BenchmarkReport:
    config: "TauBenchConfig"
    results: list[TaskRunResult]
    pass_k: dict[int, PassKResult]
    avg_reward: float
    num_tasks: int
    num_trials_per_task: int
    data_provenance: dict[str, Any]
    scenario_counts: dict[str, int]
    complete: bool
    expected_rollouts: int
    completed_rollouts: int
    workload_sha256: str
    domain_results: dict[str, list[TaskRunResult]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "config": self.config.to_dict(),
            "num_tasks": self.num_tasks,
            "num_trials_per_task": self.num_trials_per_task,
            "data_provenance": self.data_provenance,
            "scenario_counts": self.scenario_counts,
            "complete": self.complete,
            "expected_rollouts": self.expected_rollouts,
            "completed_rollouts": self.completed_rollouts,
            "workload_sha256": self.workload_sha256,
            "avg_reward": self.avg_reward,
            "judge_degraded_rollouts": sum(1 for r in self.results if r.judge_degraded),
            "pass_k": {
                k: {"k": v.k, "num_tasks": v.num_tasks, "pass_hat_k": v.pass_hat_k}
                for k, v in self.pass_k.items()
            },
            "domain_results": {
                domain: [
                    {
                        "task_id": r.task_id,
                        "trial": r.trial,
                        "scenario_id": r.scenario_id,
                        "scenario_note": r.scenario_note,
                        "reward": r.reward,
                        "success": r.success,
                        "judge_passed": r.judge_passed,
                        "judge_explanation": r.judge_explanation,
                        "judge_mode": r.judge_mode,
                        "judge_degraded": r.judge_degraded,
                        "r_actions": r.r_actions,
                        "r_outputs": r.r_outputs,
                        "num_turns": r.num_turns,
                        "num_tool_calls": r.num_tool_calls,
                        "user_cost": r.user_cost,
                        "agent_cost": r.agent_cost,
                        "error": r.error,
                    }
                    for r in rs
                ]
                for domain, rs in self.domain_results.items()
            },
        }


@dataclass
class TauBenchConfig:
    """Configuration for running the tau-bench harness.

    Defaults match the τ-bench paper: pass^k with k=4 on the test split,
    user simulator gpt-4o, judge gpt-4o-mini.
    """

    # Which domains to run
    domains: list[DomainName] = field(default_factory=lambda: ["retail", "airline"])
    task_split: TaskSplit = "test"

    # Pass^k
    num_trials: int = 4
    pass_k_values: list[int] = field(default_factory=lambda: [1, 2, 4])

    # Task selection
    task_ids: Optional[list[int]] = None
    start_index: int = 0
    end_index: int = -1  # -1 = run all
    max_tasks_per_domain: Optional[int] = None
    use_sample_tasks: bool = False
    include_edge_scenarios: bool = False

    # Agent
    use_mock: bool = False
    # Which agent harness drives per-turn completions:
    #   "litellm"  – built-in LiteLLM tool-calling agent (default)
    #   "eliza"    – elizaos TS bench server bridge
    #   "hermes"   – pinned native hermes-agent subprocess adapter
    #   "openclaw" – isolated OpenClaw embedded runtime + native tool plugin
    agent_harness: str = "litellm"
    agent_model: str = "gpt-4o"
    agent_provider: str = "openai"
    agent_temperature: float = 0.0
    agent_max_turns: int = 30

    # User simulator (LLM-driven by default, matches upstream)
    user_strategy: str = "llm"  # "grounded", "human", "llm", "react", "verify", "reflection"
    user_model: str = "gpt-4o"
    user_provider: str = "openai"

    # LLM judge for outputs
    use_llm_judge: bool = True
    judge_model: str = "gpt-4o-mini"
    judge_provider: str = "openai"
    # Opt-in only: when the LLM judge fails, degrade to the substring heuristic
    # instead of raising. Degraded trials are marked in report.json; the
    # default (False) fails the run — a broken judge must never look healthy.
    judge_allow_heuristic_fallback: bool = False

    # IO
    output_dir: str = "./benchmark_results/tau-bench"
    seed: int = 10
    max_concurrency: int = 1
    verbose: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "domains": list(self.domains),
            "task_split": self.task_split,
            "num_trials": self.num_trials,
            "pass_k_values": list(self.pass_k_values),
            "task_ids": list(self.task_ids) if self.task_ids else None,
            "start_index": self.start_index,
            "end_index": self.end_index,
            "max_tasks_per_domain": self.max_tasks_per_domain,
            "use_sample_tasks": self.use_sample_tasks,
            "include_edge_scenarios": self.include_edge_scenarios,
            "use_mock": self.use_mock,
            "agent_harness": self.agent_harness,
            "agent_model": self.agent_model,
            "agent_provider": self.agent_provider,
            "agent_temperature": self.agent_temperature,
            "agent_max_turns": self.agent_max_turns,
            "user_strategy": self.user_strategy,
            "user_model": self.user_model,
            "user_provider": self.user_provider,
            "use_llm_judge": self.use_llm_judge,
            "judge_model": self.judge_model,
            "judge_provider": self.judge_provider,
            "judge_allow_heuristic_fallback": self.judge_allow_heuristic_fallback,
            "output_dir": self.output_dir,
            "seed": self.seed,
            "max_concurrency": self.max_concurrency,
            "verbose": self.verbose,
        }


__all__ = [
    "Action",
    "Task",
    "EnvResponse",
    "EnvResetResponse",
    "EnvInfo",
    "RewardResult",
    "RewardOutputInfo",
    "RewardActionInfo",
    "SolveResult",
    "RESPOND_ACTION_NAME",
    "RESPOND_ACTION_FIELD_NAME",
    "DomainName",
    "TaskSplit",
    "TaskRunResult",
    "PassKResult",
    "BenchmarkReport",
    "TauBenchConfig",
]
