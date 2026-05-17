"""ElizaOS Tau-bench — faithful implementation of Sierra's tau-bench.

This package vendors the upstream tau-bench (sierra-research/tau-bench, MIT)
under ``elizaos_tau_bench.upstream`` and provides an ElizaOS-friendly runner,
LLM judge, and pass^k harness on top of it.

Upstream commit pinned in README.
"""

__version__ = "2.1.0"

from elizaos_tau_bench.types import (
    DomainName,
    TaskRunResult,
    PassKResult,
    BenchmarkReport,
    TauBenchConfig,
)
from elizaos_tau_bench.dataset import (
    iter_tasks,
    iter_sample_tasks,
    task_count,
    SAMPLE_TASKS,
)
from elizaos_tau_bench.pass_k import calculate_pass_hat_k
from elizaos_tau_bench.judge import judge_outputs_satisfied
from elizaos_tau_bench.eliza_agent import (
    LiteLLMToolCallingAgent,
    MockTauAgent,
    create_tau_agent,
    BaseTauAgent,
)
from elizaos_tau_bench.runner import TauBenchRunner

__all__ = [
    "__version__",
    "DomainName",
    "TaskRunResult",
    "PassKResult",
    "BenchmarkReport",
    "TauBenchConfig",
    "iter_tasks",
    "iter_sample_tasks",
    "task_count",
    "SAMPLE_TASKS",
    "calculate_pass_hat_k",
    "judge_outputs_satisfied",
    "LiteLLMToolCallingAgent",
    "MockTauAgent",
    "BaseTauAgent",
    "create_tau_agent",
    "TauBenchRunner",
]
