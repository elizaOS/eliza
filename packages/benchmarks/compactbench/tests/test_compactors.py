"""Tests for the CompactBench Compactor subclasses.

These do not invoke the TS bridge — they monkeypatch
``run_ts_compactor`` so we can assert the strategy name being requested
and the artifact translation. CompactBench's ``Provider`` interface is
also stubbed; nothing here hits a real model.
"""

from __future__ import annotations

from typing import Any

import pytest
from compactbench.contracts import Transcript, Turn, TurnRole

from eliza_compactbench import compactors as eliza_compactors


class _StubProvider:
    """Minimal stand-in for ``compactbench.providers.Provider``."""

    key = "stub"

    async def complete(self, _request: Any) -> Any:
        raise RuntimeError("StubProvider should not be called from these tests")


def _build_transcript() -> Transcript:
    return Transcript(
        turns=[
            Turn(id=0, role=TurnRole.SYSTEM, content="be helpful"),
            Turn(id=1, role=TurnRole.USER, content="my name is Alice"),
            Turn(id=2, role=TurnRole.ASSISTANT, content="nice to meet you"),
        ]
    )


@pytest.mark.parametrize(
    "cls,expected_strategy,expected_name",
    [
        (eliza_compactors.NaiveSummaryCompactor, "naive-summary", "elizaos-naive-summary"),
        (
            eliza_compactors.StructuredStateCompactor,
            "structured-state",
            "elizaos-structured-state",
        ),
        (
            eliza_compactors.HierarchicalSummaryCompactor,
            "hierarchical-summary",
            "elizaos-hierarchical-summary",
        ),
        (
            eliza_compactors.HybridLedgerCompactor,
            "hybrid-ledger",
            "elizaos-hybrid-ledger",
        ),
        (
            eliza_compactors.PromptStrippingPassthroughCompactor,
            "prompt-stripping-passthrough",
            "elizaos-prompt-stripping-passthrough",
        ),
    ],
)
def test_compactor_class_metadata(
    cls: type, expected_strategy: str, expected_name: str
) -> None:
    assert cls.name == expected_name
    assert cls.strategy == expected_strategy
    assert cls.version == "0.1.0"


async def test_compactor_invokes_bridge_with_correct_strategy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_run(strategy: str, transcript: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        captured["strategy"] = strategy
        captured["transcript"] = transcript
        captured["options"] = options
        return {
            "schemaVersion": "1.0.0",
            "summaryText": "Alice is the user",
            "structured_state": {
                "immutable_facts": ["user is named Alice"],
                "locked_decisions": [],
                "deferred_items": [],
                "forbidden_behaviors": [],
                "entity_map": {"alice": "user"},
                "unresolved_items": [],
            },
            "selectedSourceTurnIds": [],
            "warnings": [],
            "methodMetadata": {},
        }

    monkeypatch.setattr(eliza_compactors, "run_ts_compactor", fake_run)

    compactor = eliza_compactors.HybridLedgerCompactor(
        provider=_StubProvider(), model="gpt-oss-120b"
    )
    artifact = await compactor.compact(_build_transcript(), config={"targetTokens": 500})

    assert captured["strategy"] == "hybrid-ledger"
    assert captured["transcript"]["turns"][1]["content"] == "my name is Alice"
    assert captured["options"]["summarizationModel"] == "gpt-oss-120b"
    assert captured["options"]["targetTokens"] == 500
    assert artifact.summary_text == "Alice is the user"
    assert "user is named Alice" in artifact.structured_state.immutable_facts
    assert artifact.structured_state.entity_map == {"alice": "user"}


async def test_compactor_rejects_non_transcript() -> None:
    compactor = eliza_compactors.NaiveSummaryCompactor(
        provider=_StubProvider(), model="gpt-oss-120b"
    )
    with pytest.raises(TypeError):
        await compactor.compact(transcript="not a transcript")  # type: ignore[arg-type]


async def test_compactor_forwards_previous_artifact_for_drift(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_run(strategy: str, transcript: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        captured["options"] = options
        return {
            "schemaVersion": "1.0.0",
            "summaryText": "second cycle",
            "structured_state": {
                "immutable_facts": [],
                "locked_decisions": [],
                "deferred_items": [],
                "forbidden_behaviors": [],
                "entity_map": {},
                "unresolved_items": [],
            },
            "selectedSourceTurnIds": [],
            "warnings": [],
            "methodMetadata": {},
        }

    monkeypatch.setattr(eliza_compactors, "run_ts_compactor", fake_run)

    compactor = eliza_compactors.HybridLedgerCompactor(
        provider=_StubProvider(), model="gpt-oss-120b"
    )
    first = await compactor.compact(_build_transcript())
    await compactor.compact(_build_transcript(), previous_artifact=first)

    assert "previousArtifact" in captured["options"]
    assert captured["options"]["previousArtifact"]["summaryText"] == "second cycle"
