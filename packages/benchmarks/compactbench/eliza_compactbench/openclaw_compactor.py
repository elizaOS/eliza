"""OpenClaw CompactBench adapter status.

OpenClaw has a real runtime compaction feature in its session engine, but the
public CLI exposed to this benchmark lane is a one-shot ``agent --message``
entry point. It does not expose a native CompactBench-compatible compactor API
that accepts a transcript and returns a replacement summary artifact.

This module deliberately fails closed. It gives the orchestrator and tests a
real importable OpenClaw method label without silently routing to elizaOS
compactors or to a generic summarizer.
"""

from __future__ import annotations

from typing import Any, ClassVar

from compactbench.compactors.base import Compactor
from compactbench.contracts import CompactionArtifact, Transcript
from compactbench.providers import Provider


class OpenClawCompactionUnsupportedError(RuntimeError):
    """Raised when a benchmark asks for OpenClaw compaction through an unsupported path."""


def openclaw_compaction_status() -> dict[str, object]:
    """Return the explicit status surfaced by the runner and tests."""

    return {
        "agent": "openclaw",
        "benchmark": "compactbench",
        "path_label": "openclaw-cli-one-shot",
        "supported": False,
        "native_openai_tool_calls": False,
        "reason": (
            "OpenClaw's documented CLI accepts a single --message turn and "
            "does not expose a transcript-in/artifact-out native compaction "
            "API. Cross-agent CompactBench rows must stay gated until such "
            "an API is available."
        ),
        "no_oracle_fallback": True,
        "no_eliza_fallback": True,
    }


class OpenClawNativeCompactor(Compactor):
    """CompactBench method label for OpenClaw's missing native compactor API."""

    name: ClassVar[str] = "openclaw-native-compaction-unsupported"
    version: ClassVar[str] = "0.1.0"

    def __init__(self, provider: Provider, model: str) -> None:
        super().__init__(provider, model)

    async def compact(
        self,
        transcript: Transcript,
        config: dict[str, Any] | None = None,
        previous_artifact: CompactionArtifact | None = None,
    ) -> CompactionArtifact:
        del transcript, config, previous_artifact
        status = openclaw_compaction_status()
        raise OpenClawCompactionUnsupportedError(str(status["reason"]))


__all__ = [
    "OpenClawCompactionUnsupportedError",
    "OpenClawNativeCompactor",
    "openclaw_compaction_status",
]
