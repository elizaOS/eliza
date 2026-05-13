"""Tests for the Hermes CompactBench adapter."""

from __future__ import annotations

import json
from typing import Any

import pytest
from compactbench.contracts import CompactionArtifact, StructuredState, Transcript, Turn, TurnRole

from hermes_adapter.client import MessageResponse
from hermes_compactbench.compactors import HermesNativeToolCompactor


class _StubProvider:
    key = "stub"

    async def complete(self, _request: Any) -> Any:
        raise RuntimeError("provider should not be called")


class _FakeHermesClient:
    provider = "cerebras"

    def __init__(self, response: MessageResponse) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    def send_message(self, text: str, context: dict[str, object]) -> MessageResponse:
        self.calls.append({"text": text, "context": context})
        return self.response


def _transcript() -> Transcript:
    return Transcript(
        turns=[
            Turn(id=0, role=TurnRole.SYSTEM, content="Be precise."),
            Turn(id=1, role=TurnRole.USER, content="My project codename is ORCHID-17."),
            Turn(id=2, role=TurnRole.ASSISTANT, content="Noted."),
        ]
    )


def _tool_response(arguments: dict[str, Any]) -> MessageResponse:
    return MessageResponse(
        text="",
        thought=None,
        actions=["emit_compaction_artifact"],
        params={
            "tool_calls": [
                {
                    "id": "call_1",
                    "name": "emit_compaction_artifact",
                    "arguments": json.dumps(arguments),
                }
            ],
            "usage": {"prompt_tokens": 100, "completion_tokens": 30, "total_tokens": 130},
        },
    )


async def test_hermes_compactor_requires_native_tool_call_and_preserves_metadata() -> None:
    client = _FakeHermesClient(
        _tool_response(
            {
                "summary_text": "The user project codename is ORCHID-17.",
                "immutable_facts": ["project codename is ORCHID-17"],
                "locked_decisions": [],
                "deferred_items": [],
                "forbidden_behaviors": [],
                "entity_map": {"ORCHID-17": "project codename"},
                "unresolved_items": [],
                "selected_source_turn_ids": [1],
                "warnings": [],
            }
        )
    )
    compactor = HermesNativeToolCompactor(
        provider=_StubProvider(),
        model="gpt-oss-120b",
        client=client,  # type: ignore[arg-type]
    )

    artifact = await compactor.compact(_transcript())

    assert artifact.summary_text == "The user project codename is ORCHID-17."
    assert artifact.structured_state.immutable_facts == ["project codename is ORCHID-17"]
    assert artifact.selected_source_turn_ids == [1]
    assert artifact.method_metadata["agent_family"] == "hermes"
    assert artifact.method_metadata["adapter"] == "hermes-adapter"
    assert artifact.method_metadata["native_tool_calls"] is True
    assert artifact.method_metadata["tool_call_count"] == 1
    call = client.calls[0]
    assert call["context"]["tool_choice"] == "required"
    assert call["context"]["tools"][0]["function"]["name"] == "emit_compaction_artifact"
    messages = call["context"]["messages"]
    assert messages[0]["role"] == "system"
    assert "ORCHID-17" in messages[1]["content"]


async def test_hermes_compactor_threads_previous_artifact() -> None:
    previous = CompactionArtifact(
        schemaVersion="1.0.0",
        summaryText="Earlier summary",
        structured_state=StructuredState(
            immutable_facts=["Use ORCHID-17"],
            locked_decisions=["Prefer short answers"],
            deferred_items=[],
            forbidden_behaviors=[],
            entity_map={"ORCHID-17": "codename"},
            unresolved_items=[],
        ),
        selectedSourceTurnIds=[0],
        warnings=[],
        methodMetadata={},
    )
    client = _FakeHermesClient(
        _tool_response(
            {
                "summary_text": "Updated summary",
                "immutable_facts": ["Use ORCHID-17"],
                "locked_decisions": ["Prefer short answers"],
                "deferred_items": [],
                "forbidden_behaviors": [],
                "entity_map": {"ORCHID-17": "codename"},
                "unresolved_items": [],
                "selected_source_turn_ids": [0, 1],
                "warnings": [],
            }
        )
    )
    compactor = HermesNativeToolCompactor(
        provider=_StubProvider(),
        model="gpt-oss-120b",
        client=client,  # type: ignore[arg-type]
    )

    await compactor.compact(_transcript(), previous_artifact=previous)

    user_payload = client.calls[0]["context"]["messages"][1]["content"]
    assert "previous_artifact" in user_payload
    assert "Prefer short answers" in user_payload


async def test_hermes_compactor_rejects_text_only_response() -> None:
    client = _FakeHermesClient(
        MessageResponse(
            text='{"summary_text":"text fallback should not pass"}',
            thought=None,
            actions=[],
            params={},
        )
    )
    compactor = HermesNativeToolCompactor(
        provider=_StubProvider(),
        model="gpt-oss-120b",
        client=client,  # type: ignore[arg-type]
    )

    with pytest.raises(RuntimeError, match="native tool_calls"):
        await compactor.compact(_transcript())
