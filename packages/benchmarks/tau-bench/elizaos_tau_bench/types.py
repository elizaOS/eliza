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
    judge_passed: Optional[bool] = None  # only when outputs are present
    judge_explanation: str = ""
    r_actions: Optional[float] = None
    r_outputs: Optional[float] = None
    num_turns: int = 0
    num_tool_calls: int = 0
    user_cost: float = 0.0
    agent_cost: float = 0.0
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
    domain_results: dict[str, list[TaskRunResult]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "config": self.config.to_dict(),
            "num_tasks": self.num_tasks,
            "num_trials_per_task": self.num_trials_per_task,
            "avg_reward": self.avg_reward,
            "pass_k": {
                k: {"k": v.k, "num_tasks": v.num_tasks, "pass_hat_k": v.pass_hat_k}
                for k, v in self.pass_k.items()
            },
            "domain_results": {
                domain: [
                    {
                        "task_id": r.task_id,
                        "trial": r.trial,
                        "reward": r.reward,
                        "success": r.success,
                        "judge_passed": r.judge_passed,
                        "judge_explanation": r.judge_explanation,
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

    # Agent
    use_mock: bool = False
    # Which agent harness drives per-turn completions:
    #   "litellm"  – built-in LiteLLM tool-calling agent (default)
    #   "eliza"    – elizaos TS bench server bridge
    #   "hermes"   – hermes-adapter (OpenAI-compatible, in_process when available)
    #   "openclaw" – openclaw-adapter (OpenAI-compatible direct mode by default)
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
