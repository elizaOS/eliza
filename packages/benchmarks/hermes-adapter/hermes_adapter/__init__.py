"""Benchmark adapter for the hermes-agent (NousResearch) tool-calling agent.

Mirrors the public surface of :mod:`eliza_adapter` so the tri-agent
benchmarking harness can swap between elizaOS, OpenClaw, and hermes-agent
without per-benchmark plumbing.
"""

from hermes_adapter.bfcl import build_bfcl_agent_fn
from hermes_adapter.clawbench import build_clawbench_agent_fn
from hermes_adapter.client import HermesClient, MessageResponse
from hermes_adapter.swe_bench import build_swe_bench_agent_fn
from hermes_adapter.terminal_bench import (
    HermesTerminalAgent,
    build_terminal_bench_agent_fn,
)
from hermes_adapter.env_runner import (
    ENV_MODULES,
    HermesEnvResult,
    build_evaluate_command,
    parse_hermes_env_result,
    run_hermes_env,
)
from hermes_adapter.server_manager import HermesAgentManager

__all__ = [
    "HermesClient",
    "MessageResponse",
    "HermesAgentManager",
    "HermesEnvResult",
    "ENV_MODULES",
    "build_evaluate_command",
    "parse_hermes_env_result",
    "run_hermes_env",
    "build_bfcl_agent_fn",
    "build_clawbench_agent_fn",
    "build_swe_bench_agent_fn",
    "build_terminal_bench_agent_fn",
    "HermesTerminalAgent",
]

# LifeOpsBench bridge — only useful when eliza_lifeops_bench.types is present
# (lazy import inside the builder), so the import here is best-effort.
try:
    from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn  # noqa: F401, E402

    __all__.append("build_lifeops_bench_agent_fn")
except Exception:  # noqa: BLE001 — keep the package importable if a stub is missing
    pass
