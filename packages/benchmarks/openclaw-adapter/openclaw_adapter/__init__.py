"""Benchmark adapter for the OpenClaw CLI agent.

Drop-in equivalent of :mod:`eliza_adapter` and :mod:`hermes_adapter` so the
tri-agent benchmarking harness can swap between elizaOS, OpenClaw, and
hermes-agent without per-benchmark plumbing.

OpenClaw is a stateless Node.js CLI rather than a long-running HTTP server,
so this adapter wraps ``openclaw agent --local --json --message <text>`` and
maps the JSON output into a :class:`MessageResponse` whose shape matches the
two sibling adapters.
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
from openclaw_adapter.bfcl import build_bfcl_agent_fn  # noqa: E402
from openclaw_adapter.clawbench import build_clawbench_agent_fn  # noqa: E402
from openclaw_adapter.lifeops_bench import build_lifeops_bench_agent_fn  # noqa: E402
from openclaw_adapter.swe_bench import build_swe_bench_agent_fn  # noqa: E402
from openclaw_adapter.terminal_bench import (  # noqa: E402
    OpenClawTerminalAgent,
    build_terminal_bench_agent_fn,
)

__all__.extend(
    [
        "build_bfcl_agent_fn",
        "build_clawbench_agent_fn",
        "build_lifeops_bench_agent_fn",
        "build_swe_bench_agent_fn",
        "build_terminal_bench_agent_fn",
        "OpenClawTerminalAgent",
    ]
)
