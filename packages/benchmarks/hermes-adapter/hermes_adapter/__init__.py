"""Benchmark adapter for the hermes-agent (NousResearch) tool-calling agent.

Mirrors the public surface of :mod:`eliza_adapter` so the tri-agent
benchmarking harness can swap between elizaOS, OpenClaw, and hermes-agent
without per-benchmark plumbing.
"""

from hermes_adapter.client import HermesClient, MessageResponse
from hermes_adapter.server_manager import HermesAgentManager

__all__ = [
    "HermesClient",
    "MessageResponse",
    "HermesAgentManager",
]

# Optional per-benchmark factories — each one may depend on a sibling
# benchmark package (e.g. ``elizaos_tau_bench``) that isn't always on
# sys.path. Importing them defensively keeps ``hermes_adapter.<bench>``
# submodules importable even when an unrelated sibling can't be loaded.
try:
    from hermes_adapter.bfcl import build_bfcl_agent_fn  # noqa: F401, E402

    __all__.append("build_bfcl_agent_fn")
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.clawbench import build_clawbench_agent_fn  # noqa: F401, E402

    __all__.append("build_clawbench_agent_fn")
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.swe_bench import build_swe_bench_agent_fn  # noqa: F401, E402

    __all__.append("build_swe_bench_agent_fn")
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.tau_bench import (  # noqa: F401, E402
        HermesTauAgent,
        build_tau_bench_agent_fn,
    )

    __all__.extend(["HermesTauAgent", "build_tau_bench_agent_fn"])
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.terminal_bench import (  # noqa: F401, E402
        HermesTerminalAgent,
        build_terminal_bench_agent_fn,
    )

    __all__.extend(["HermesTerminalAgent", "build_terminal_bench_agent_fn"])
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.env_runner import (  # noqa: F401, E402
        ENV_MODULES,
        HermesEnvResult,
        build_evaluate_command,
        parse_hermes_env_result,
        run_hermes_env,
    )

    __all__.extend(
        [
            "ENV_MODULES",
            "HermesEnvResult",
            "build_evaluate_command",
            "parse_hermes_env_result",
            "run_hermes_env",
        ]
    )
except Exception:  # noqa: BLE001
    pass

# LifeOpsBench bridge — only useful when eliza_lifeops_bench.types is present
# (lazy import inside the builder), so the import here is best-effort.
try:
    from hermes_adapter.lifeops_bench import build_lifeops_bench_agent_fn  # noqa: F401, E402

    __all__.append("build_lifeops_bench_agent_fn")
except Exception:  # noqa: BLE001 — keep the package importable if a stub is missing
    pass

try:
    from hermes_adapter.action_calling import build_action_calling_agent_fn  # noqa: F401, E402

    __all__.append("build_action_calling_agent_fn")
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.agentbench import build_agentbench_agent_fn  # noqa: F401, E402

    __all__.append("build_agentbench_agent_fn")
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.mind2web import build_mind2web_agent_fn  # noqa: F401, E402

    __all__.append("build_mind2web_agent_fn")
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.mint import build_mint_agent_fn  # noqa: F401, E402

    __all__.append("build_mint_agent_fn")
except Exception:  # noqa: BLE001
    pass

try:
    from hermes_adapter.woobench import build_hermes_woobench_agent_fn  # noqa: F401, E402

    __all__.append("build_hermes_woobench_agent_fn")
except Exception:  # noqa: BLE001
    pass
