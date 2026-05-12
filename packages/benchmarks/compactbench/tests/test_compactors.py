"""Tests for the CompactBench Compactor subclasses.

These do not invoke the TS bridge — they monkeypatch
``run_ts_compactor`` so we can assert the strategy name being requested
and the artifact translation. CompactBench's ``Provider`` interface is
also stubbed; nothing here hits a real model.
"""

from __future__ import annotations

import json
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
    assert captured["options"]["preserveTailMessages"] == 0
    assert captured["options"]["targetTokens"] == 500
    assert artifact.summary_text == "Alice is the user"
    assert "user is named Alice" in artifact.structured_state.immutable_facts
    assert artifact.structured_state.entity_map == {"alice": "user"}
    assert artifact.method_metadata["agent_label"] == "eliza"
    assert artifact.method_metadata["adapter"] == "eliza_compactbench"
    assert artifact.method_metadata["compaction_strategy"] == "hybrid-ledger"
    assert artifact.method_metadata["provider"] == "stub"
    assert artifact.method_metadata["model"] == "gpt-oss-120b"
    assert artifact.method_metadata["input_turn_count"] == 3
    assert artifact.method_metadata["input_token_estimate"] > 0
    assert artifact.method_metadata["output_token_estimate"] > 0


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
        captured["transcript"] = transcript
        return {
            "schemaVersion": "1.0.0",
            "summaryText": "second cycle",
            "structured_state": {
                "immutable_facts": ["alice is the user"],
                "locked_decisions": ["use kebab-case"],
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
    first = await compactor.compact(_build_transcript())
    await compactor.compact(_build_transcript(), previous_artifact=first)

    # Both channels must carry the prior artifact: structured under
    # options.previousArtifact (for any TS strategy that wants the typed
    # shape) and rendered as a string under transcript.metadata.priorLedger
    # (the channel hybrid-ledger actually reads from).
    assert "previousArtifact" in captured["options"]
    assert captured["options"]["previousArtifact"]["summaryText"] == "second cycle"
    metadata = captured["transcript"].get("metadata") or {}
    assert "priorLedger" in metadata
    prior_ledger = metadata["priorLedger"]
    assert isinstance(prior_ledger, str)
    assert "alice is the user" in prior_ledger
    assert "use kebab-case" in prior_ledger
    assert "alice: user" in prior_ledger


async def test_compactor_omits_metadata_on_first_cycle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """First-cycle calls must NOT carry a priorLedger — there is no prior
    artifact yet, and emitting an empty one would confuse the TS prompt.
    """
    captured: dict[str, Any] = {}

    def fake_run(strategy: str, transcript: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        captured["transcript"] = transcript
        return {
            "schemaVersion": "1.0.0",
            "summaryText": "x",
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
    await compactor.compact(_build_transcript())
    assert "metadata" not in captured["transcript"]


async def test_compactor_handles_empty_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_run(strategy: str, transcript: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        captured["transcript"] = transcript
        return {
            "schemaVersion": "1.0.0",
            "summaryText": "",
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
            "methodMetadata": {"replacement_message_count": 0},
        }

    monkeypatch.setattr(eliza_compactors, "run_ts_compactor", fake_run)
    compactor = eliza_compactors.NaiveSummaryCompactor(
        provider=_StubProvider(), model="gpt-oss-120b"
    )
    artifact = await compactor.compact(Transcript(turns=[]))
    assert captured["transcript"]["turns"] == []
    assert artifact.summary_text == ""
    assert artifact.method_metadata.get("replacement_message_count") == 0


def test_previous_artifact_to_prior_ledger_renders_all_sections() -> None:
    """The string ledger must include every populated section of the
    structured state plus the summary text. Missing sections must be
    omitted (not rendered as empty headers).
    """
    from compactbench.contracts import CompactionArtifact, StructuredState

    state = StructuredState(
        immutable_facts=["alice is engineer"],
        locked_decisions=["ship monday"],
        deferred_items=["pick scope"],
        forbidden_behaviors=["no fallbacks"],
        entity_map={"alice": "engineer"},
        unresolved_items=["estimate eta"],
    )
    artifact = CompactionArtifact(
        schemaVersion="1.0.0",
        summaryText="status: planning sprint 4",
        structured_state=state,
        selectedSourceTurnIds=[0, 1],
        warnings=[],
        methodMetadata={},
    )
    rendered = eliza_compactors._previous_artifact_to_prior_ledger(artifact)
    assert "# summary" in rendered
    assert "status: planning sprint 4" in rendered
    assert "# immutable_facts" in rendered and "alice is engineer" in rendered
    assert "# locked_decisions" in rendered and "ship monday" in rendered
    assert "# deferred_items" in rendered and "pick scope" in rendered
    assert "# forbidden_behaviors" in rendered and "no fallbacks" in rendered
    assert "# unresolved_items" in rendered and "estimate eta" in rendered
    assert "# entity_map" in rendered and "alice: engineer" in rendered

    empty_artifact = CompactionArtifact(
        schemaVersion="1.0.0",
        summaryText="",
        structured_state=StructuredState(),
        selectedSourceTurnIds=[],
        warnings=[],
        methodMetadata={},
    )
    assert eliza_compactors._previous_artifact_to_prior_ledger(empty_artifact) == ""


async def test_compactor_writes_redacted_trace_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    trace_path = tmp_path / "compactions.jsonl"
    monkeypatch.setenv("ELIZA_COMPACTBENCH_TRAJECTORY_JSONL", str(trace_path))

    def fake_run(strategy: str, transcript: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        assert strategy == "naive-summary"
        return {
            "schemaVersion": "1.0.0",
            "summaryText": "secret csk-redaction-test-token-000000000000",
            "structured_state": {
                "immutable_facts": ["user has a fake key csk-redaction-test-token-000000000000"],
                "locked_decisions": [],
                "deferred_items": [],
                "forbidden_behaviors": [],
                "entity_map": {},
                "unresolved_items": [],
            },
            "selectedSourceTurnIds": [0, 1],
            "warnings": [],
            "methodMetadata": {},
        }

    monkeypatch.setattr(eliza_compactors, "run_ts_compactor", fake_run)
    compactor = eliza_compactors.NaiveSummaryCompactor(
        provider=_StubProvider(), model="gpt-oss-120b"
    )

    await compactor.compact(_build_transcript())

    record = json.loads(trace_path.read_text(encoding="utf-8").strip())
    assert record["agent_label"] == "eliza"
    assert record["strategy"] == "naive-summary"
    assert record["metadata"]["trace_schema_version"] == "eliza_compactbench_trace_v1"
    serialized = json.dumps(record, sort_keys=True)
    assert "csk-redaction-test" not in serialized
    assert "[REDACTED]" in serialized
