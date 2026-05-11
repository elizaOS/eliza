"""Benchmark adapter for the OpenClaw CLI agent.

OpenClaw is a stateless CLI rather than a long-running HTTP server, so this
adapter wraps ``openclaw agent --json --message <text>`` instead of opening
an HTTP socket. Per-benchmark factory functions mirror the eliza_adapter
shape so existing benchmark runners can swap agent backends.
"""

from openclaw_adapter.client import MessageResponse, OpenClawClient
from openclaw_adapter.server_manager import OpenClawCLIManager

__all__ = [
    "MessageResponse",
    "OpenClawClient",
    "OpenClawCLIManager",
]

# Per-benchmark factories — imported eagerly because they have no optional
# external runtime deps. The lifeops_bench builder lazily imports its
# MessageTurn dataclass at call time so this module stays importable when
# the lifeops-bench package is not present.
from openclaw_adapter.clawbench import build_clawbench_agent_fn  # noqa: E402
from openclaw_adapter.bfcl import build_bfcl_agent_fn  # noqa: E402
from openclaw_adapter.lifeops_bench import build_lifeops_bench_agent_fn  # noqa: E402

__all__.extend(
    [
        "build_clawbench_agent_fn",
        "build_bfcl_agent_fn",
        "build_lifeops_bench_agent_fn",
    ]
)
