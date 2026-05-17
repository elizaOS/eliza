"""Benchmark adapter for the TypeScript eliza agent.

Bridges Python benchmark runners with the eliza benchmark HTTP server.
"""

from eliza_adapter.client import ElizaClient
from eliza_adapter.server_manager import ElizaServerManager
from eliza_adapter.swe_bench import (
    SWEBenchModelHandler,
    make_eliza_swe_bench_model_handler,
)

__all__ = [
    "ElizaClient",
    "ElizaServerManager",
    "SWEBenchModelHandler",
    "make_eliza_swe_bench_model_handler",
]

# Optional: REALM adapter is only importable when the benchmarks.realm package
# is on sys.path (it lives under eliza/packages/benchmarks/realm). We expose it
# lazily to avoid forcing every consumer of eliza-adapter to install REALM.
try:
    from eliza_adapter.realm import ElizaREALMAgent  # noqa: F401
    __all__.append("ElizaREALMAgent")
except ImportError:
    pass

# Optional: ADHDBench bridge — only loaded when elizaos_adhdbench is on sys.path.
try:
    from eliza_adapter.adhdbench import ElizaADHDBenchRunner  # noqa: F401
    __all__.append("ElizaADHDBenchRunner")
except ImportError:
    pass

# Optional: EVM bridge — only loaded when benchmarks.evm is on sys.path.
try:
    from eliza_adapter.evm import ElizaBridgeEVMExplorer  # noqa: F401
    __all__.append("ElizaBridgeEVMExplorer")
except ImportError:
    pass

# Optional: Experience bridge — only loaded when elizaos_experience_bench is on sys.path.
try:
    from eliza_adapter.experience import (  # noqa: F401
        ElizaBridgeExperienceRunner,
        ElizaExperienceConfig,
    )
    __all__.extend(["ElizaBridgeExperienceRunner", "ElizaExperienceConfig"])
except ImportError:
    pass

# Optional: Gauntlet bridge — only loaded when gauntlet.sdk is on sys.path.
try:
    from eliza_adapter.gauntlet import Agent as ElizaGauntletAgent  # noqa: F401
    __all__.append("ElizaGauntletAgent")
except ImportError:
    pass

# Optional: MINT bridge — only loaded when benchmarks.mint is on sys.path.
try:
    from eliza_adapter.mint import ElizaMINTAgent  # noqa: F401
    __all__.append("ElizaMINTAgent")
except ImportError:
    pass

# Trust bridge — only depends on the lightweight HTTP client, always importable.
from eliza_adapter.trust import ElizaBridgeTrustHandler  # noqa: F401  # noqa: E402
__all__.append("ElizaBridgeTrustHandler")

# WooBench bridge — only depends on the lightweight HTTP client, always importable.
from eliza_adapter.woobench import build_eliza_bridge_agent_fn  # noqa: F401  # noqa: E402
__all__.append("build_eliza_bridge_agent_fn")

# LifeOpsBench bridge — depends on the HTTP client. The MessageTurn type used
# in the agent_fn return is imported lazily inside the builder, so this module
# is importable even when the lifeops-bench package is not installed.
from eliza_adapter.lifeops_bench import (  # noqa: F401  # noqa: E402
    build_lifeops_bench_agent_fn,
    fetch_world_state,
    teardown_lifeops_session,
)
__all__.extend(
    ["build_lifeops_bench_agent_fn", "fetch_world_state", "teardown_lifeops_session"]
)

# Optional: Solana bridge — only loaded when benchmarks.solana + voyager are on sys.path.
try:
    from eliza_adapter.solana import ElizaBridgeSolanaExplorer  # noqa: F401
    __all__.append("ElizaBridgeSolanaExplorer")
except ImportError:
    pass
