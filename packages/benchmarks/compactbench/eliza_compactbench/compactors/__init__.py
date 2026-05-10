"""CompactBench-compatible Compactor classes for elizaOS strategies.

Each class is a thin Python adapter over :func:`eliza_compactbench.bridge.run_ts_compactor`.
The actual compaction logic lives in TypeScript in
``packages/agent/src/runtime/conversation-compactor.ts``; this layer
translates the Python-side ``Transcript`` / ``CompactionArtifact``
contracts to and from JSON the bridge can carry.
"""

from __future__ import annotations

from typing import Any, ClassVar

from compactbench.compactors.base import Compactor
from compactbench.contracts import CompactionArtifact, StructuredState, Transcript
from compactbench.providers import Provider

from eliza_compactbench.bridge import run_ts_compactor


def _transcript_to_dict(transcript: Transcript) -> dict[str, Any]:
    """Serialize a CompactBench :class:`Transcript` for the TS bridge."""
    if not isinstance(transcript, Transcript):
        raise TypeError(
            f"Expected compactbench.contracts.Transcript, got {type(transcript).__name__}"
        )
    return {
        "turns": [
            {
                "id": turn.id,
                "role": turn.role.value,
                "content": turn.content,
                "tags": list(turn.tags),
            }
            for turn in transcript.turns
        ]
    }


def _artifact_from_dict(payload: dict[str, Any]) -> CompactionArtifact:
    """Coerce the bridge's JSON output into a typed :class:`CompactionArtifact`."""
    structured = payload.get("structured_state") or {}
    state = StructuredState(
        immutable_facts=list(structured.get("immutable_facts") or []),
        locked_decisions=list(structured.get("locked_decisions") or []),
        deferred_items=list(structured.get("deferred_items") or []),
        forbidden_behaviors=list(structured.get("forbidden_behaviors") or []),
        entity_map=dict(structured.get("entity_map") or {}),
        unresolved_items=list(structured.get("unresolved_items") or []),
    )
    return CompactionArtifact(
        schemaVersion=payload.get("schemaVersion", "1.0.0"),
        summaryText=payload.get("summaryText", ""),
        structured_state=state,
        selectedSourceTurnIds=list(payload.get("selectedSourceTurnIds") or []),
        warnings=list(payload.get("warnings") or []),
        methodMetadata=dict(payload.get("methodMetadata") or {}),
    )


class _ElizaTSCompactor(Compactor):
    """Common base for all TS-backed elizaOS compactors."""

    strategy: ClassVar[str]

    def __init__(self, provider: Provider, model: str) -> None:
        super().__init__(provider, model)

    async def compact(
        self,
        transcript: Transcript,
        config: dict[str, Any] | None = None,
        previous_artifact: CompactionArtifact | None = None,
    ) -> CompactionArtifact:
        if not getattr(self, "strategy", None):
            raise NotImplementedError(
                f"{type(self).__name__} must set the class-level 'strategy' attribute"
            )
        options: dict[str, Any] = {"summarizationModel": self.model}
        if config:
            options.update(config)
        # TS strategies that accumulate state on drift cycles will accept the
        # previous artifact under "previousArtifact"; stateless ones ignore it.
        if previous_artifact is not None:
            options["previousArtifact"] = previous_artifact.model_dump(by_alias=True)

        payload = run_ts_compactor(
            self.strategy,
            _transcript_to_dict(transcript),
            options,
        )
        return _artifact_from_dict(payload)


class NaiveSummaryCompactor(_ElizaTSCompactor):
    """Single-pass natural-language summary."""

    name: ClassVar[str] = "elizaos-naive-summary"
    version: ClassVar[str] = "0.1.0"
    strategy: ClassVar[str] = "naive-summary"


class StructuredStateCompactor(_ElizaTSCompactor):
    """Six-section structured state extraction (the CompactBench schema)."""

    name: ClassVar[str] = "elizaos-structured-state"
    version: ClassVar[str] = "0.1.0"
    strategy: ClassVar[str] = "structured-state"


class HierarchicalSummaryCompactor(_ElizaTSCompactor):
    """Two-pass hierarchical summary (chunk-level then global)."""

    name: ClassVar[str] = "elizaos-hierarchical-summary"
    version: ClassVar[str] = "0.1.0"
    strategy: ClassVar[str] = "hierarchical-summary"


class HybridLedgerCompactor(_ElizaTSCompactor):
    """Hybrid summary + structured ledger that accumulates across drift cycles."""

    name: ClassVar[str] = "elizaos-hybrid-ledger"
    version: ClassVar[str] = "0.1.0"
    strategy: ClassVar[str] = "hybrid-ledger"


class PromptStrippingPassthroughCompactor(_ElizaTSCompactor):
    """Baseline: existing regex-based prompt-compaction helpers from
    ``packages/agent/src/runtime/prompt-compaction.ts`` applied to the
    serialized transcript. Expected to score poorly — that is the point.
    """

    name: ClassVar[str] = "elizaos-prompt-stripping-passthrough"
    version: ClassVar[str] = "0.1.0"
    strategy: ClassVar[str] = "prompt-stripping-passthrough"


__all__ = [
    "HierarchicalSummaryCompactor",
    "HybridLedgerCompactor",
    "NaiveSummaryCompactor",
    "PromptStrippingPassthroughCompactor",
    "StructuredStateCompactor",
]
