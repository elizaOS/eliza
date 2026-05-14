"""CompactBench-compatible Compactor classes for elizaOS strategies.

Each class is a thin Python adapter over :func:`eliza_compactbench.bridge.run_ts_compactor`.
The actual compaction logic lives in TypeScript in
``packages/agent/src/runtime/conversation-compactor.ts``; this layer
translates the Python-side ``Transcript`` / ``CompactionArtifact``
contracts to and from JSON the bridge can carry.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import time
from typing import Any, ClassVar

from compactbench.compactors.base import Compactor
from compactbench.contracts import CompactionArtifact, StructuredState, Transcript
from compactbench.providers import Provider

from eliza_compactbench.bridge import run_ts_compactor


_SECRET_RE = re.compile(
    r"(?i)\b((?:sk|csk)-[a-z0-9_-]{12,}|password\s*[:=]\s*[^\s,;]+|api[_ -]?key\s*[:=]\s*[^\s,;]+)"
)


def _transcript_to_dict(
    transcript: Transcript,
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Serialize a CompactBench :class:`Transcript` for the TS bridge.

    The bridge accepts either a CompactBench-shaped ``{turns}`` payload or
    an elizaOS-shaped ``{messages, metadata}`` payload. We always emit the
    ``turns`` shape to preserve the source turn ids; ``metadata`` is
    forwarded as a top-level field so the TS adapter can attach it to the
    converted transcript.
    """
    if not isinstance(transcript, Transcript):
        raise TypeError(
            f"Expected compactbench.contracts.Transcript, got {type(transcript).__name__}"
        )
    payload: dict[str, Any] = {
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
    if metadata:
        payload["metadata"] = dict(metadata)
    return payload


def _previous_artifact_to_prior_ledger(artifact: CompactionArtifact) -> str:
    """Render a previous artifact as a string ledger.

    The hybrid-ledger compactor reads ``transcript.metadata.priorLedger``
    (a single string) and prepends it to its prompt so the model can
    extend rather than discard prior state. Other strategies ignore it.
    Format mirrors the six-section structured state plus the summary text
    so the prompt has all the carry-channel data.
    """
    state = artifact.structured_state
    sections: list[str] = []
    if artifact.summary_text:
        sections.append(f"# summary\n{artifact.summary_text}")
    if state.immutable_facts:
        sections.append(
            "# immutable_facts\n" + "\n".join(f"- {x}" for x in state.immutable_facts)
        )
    if state.locked_decisions:
        sections.append(
            "# locked_decisions\n" + "\n".join(f"- {x}" for x in state.locked_decisions)
        )
    if state.deferred_items:
        sections.append(
            "# deferred_items\n" + "\n".join(f"- {x}" for x in state.deferred_items)
        )
    if state.forbidden_behaviors:
        sections.append(
            "# forbidden_behaviors\n"
            + "\n".join(f"- {x}" for x in state.forbidden_behaviors)
        )
    if state.unresolved_items:
        sections.append(
            "# unresolved_items\n"
            + "\n".join(f"- {x}" for x in state.unresolved_items)
        )
    if state.entity_map:
        rows = "\n".join(f"- {k}: {v}" for k, v in state.entity_map.items())
        sections.append(f"# entity_map\n{rows}")
    return "\n\n".join(sections)


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


def _estimate_tokens(text: str) -> int:
    return max(0, (len(text) + 3) // 4)


def _transcript_text(transcript: Transcript) -> str:
    return "\n".join(f"{turn.role.value}: {turn.content}" for turn in transcript.turns)


def _artifact_text(artifact: CompactionArtifact) -> str:
    return json.dumps(
        artifact.model_dump(by_alias=True),
        ensure_ascii=False,
        sort_keys=True,
    )


def _provider_label(provider: Provider) -> str:
    raw = getattr(provider, "key", None) or getattr(provider, "name", None)
    return str(raw) if raw else type(provider).__name__


def _redact(value: Any) -> Any:
    if isinstance(value, str):
        return _SECRET_RE.sub("[REDACTED]", value)
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _redact(item) for key, item in value.items()}
    return value


def _trace_path() -> Path | None:
    explicit = os.environ.get("ELIZA_COMPACTBENCH_TRAJECTORY_JSONL", "").strip()
    if explicit:
        return Path(explicit)
    run_dir = os.environ.get("BENCHMARK_RUN_DIR", "").strip()
    if run_dir:
        return Path(run_dir) / "compactbench-compactions.jsonl"
    return None


def _write_compaction_trace(record: dict[str, Any]) -> None:
    path = _trace_path()
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(_redact(record), ensure_ascii=False, sort_keys=True) + "\n")


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
        options: dict[str, Any] = {
            "summarizationModel": self.model,
            # The TS compactor contract returns only replacement messages; the
            # real elizaOS runtime appends its preserved tail separately. In
            # CompactBench there is no runtime tail, only the artifact, so the
            # benchmark adapter must compact the full transcript into the
            # artifact to avoid hiding late-turn overrides from the scorer.
            "preserveTailMessages": 0,
        }
        if config:
            options.update(config)
        # The hybrid-ledger TS compactor reads `transcript.metadata.priorLedger`
        # (a string ledger) and extends it. Other strategies ignore it.
        # Forward `previous_artifact` through both channels so:
        #   - the metadata.priorLedger string reaches hybrid-ledger
        #   - the structured artifact is available under options for any
        #     future strategy that wants the typed shape (and so test code
        #     can assert it is forwarded).
        metadata: dict[str, Any] | None = None
        if previous_artifact is not None:
            options["previousArtifact"] = previous_artifact.model_dump(by_alias=True)
            metadata = {"priorLedger": _previous_artifact_to_prior_ledger(previous_artifact)}

        bridge_transcript = _transcript_to_dict(transcript, metadata=metadata)
        started = time.monotonic()
        payload = run_ts_compactor(
            self.strategy,
            bridge_transcript,
            options,
        )
        elapsed_ms = round((time.monotonic() - started) * 1000.0, 2)
        artifact = _artifact_from_dict(payload)
        input_text = _transcript_text(transcript)
        output_text = _artifact_text(artifact)
        harness_metadata = {
            "agent_label": "eliza",
            "adapter": "eliza_compactbench",
            "compaction_strategy": self.strategy,
            "compactor_name": self.name,
            "compactor_version": self.version,
            "provider": _provider_label(self.provider),
            "model": self.model,
            "target_tokens": options.get("targetTokens"),
            "preserve_tail_messages": options.get("preserveTailMessages"),
            "input_turn_count": len(transcript.turns),
            "input_chars": len(input_text),
            "input_token_estimate": _estimate_tokens(input_text),
            "output_chars": len(output_text),
            "output_token_estimate": _estimate_tokens(output_text),
            "selected_source_turn_count": len(artifact.selected_source_turn_ids),
            "previous_artifact_present": previous_artifact is not None,
            "prior_ledger_present": bool(metadata and metadata.get("priorLedger")),
            "bridge_latency_ms": elapsed_ms,
            "trace_schema_version": "eliza_compactbench_trace_v1",
        }
        artifact.method_metadata.update(harness_metadata)
        _write_compaction_trace(
            {
                "schema_version": "eliza_compactbench_trace_v1",
                "agent_label": "eliza",
                "strategy": self.strategy,
                "provider": harness_metadata["provider"],
                "model": self.model,
                "started_at_unix_ms": int((time.time() - elapsed_ms / 1000.0) * 1000),
                "latency_ms": elapsed_ms,
                "options": options,
                "metadata": harness_metadata,
                "transcript": bridge_transcript,
                "artifact": artifact.model_dump(by_alias=True),
            }
        )
        return artifact


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
