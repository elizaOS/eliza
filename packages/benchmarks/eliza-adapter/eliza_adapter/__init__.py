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
