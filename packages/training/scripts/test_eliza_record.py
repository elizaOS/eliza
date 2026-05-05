"""Unit tests for scripts/lib/eliza_record.py.

Covers the canonical record's `is_valid()` contract — both happy path
and every named failure mode — plus the `build()` convenience helper
and round-trip JSON serialization. CPU-only; consumed by the pre-flight
gate (scripts/preflight.sh check #2).
"""

from __future__ import annotations

import json

import pytest

from scripts.lib.eliza_record import (
    ACTION_REPLY,
    ACTION_RESPOND,
    ElizaRecord,
    build,
    stable_id,
)


def _good_record(**overrides) -> ElizaRecord:
    """Construct a record that passes is_valid() unless overridden."""
    base = dict(
        roomName="room-abc",
        agentId="agent",
        memoryEntries=[{"role": "user", "speaker": "u", "content": "hi", "channel": "dm"}],
        currentMessage={"role": "user", "speaker": "u", "content": "hello", "channel": "dm"},
        expectedResponse="thought: greet\ntext: hi back",
        availableActions=[ACTION_REPLY],
        metadata={
            "task_type": "casual_reply",
            "source_dataset": "her_001",
            "license": "MIT",
            "split": "train",
        },
    )
    base.update(overrides)
    return ElizaRecord(**base)


# ─────────────────────────── happy path ────────────────────────────


def test_is_valid_happy_path():
    rec = _good_record()
    ok, why = rec.is_valid()
    assert ok is True, why
    assert why == ""


def test_to_dict_round_trip():
    rec = _good_record()
    blob = rec.to_dict()
    assert set(blob.keys()) == {
        "roomName", "agentId", "memoryEntries", "currentMessage",
        "expectedResponse", "availableActions", "metadata",
    }
    # to_jsonl() is parseable JSON
    parsed = json.loads(rec.to_jsonl())
    assert parsed == blob


# ─────────────────────────── negative cases ────────────────────────


def test_missing_roomname():
    rec = _good_record(roomName="")
    ok, why = rec.is_valid()
    assert not ok
    assert "roomName" in why


def test_missing_agentid():
    rec = _good_record(agentId="")
    ok, why = rec.is_valid()
    assert not ok
    assert "agentId" in why


def test_missing_currentmessage_content():
    rec = _good_record(currentMessage={"role": "user", "speaker": "u", "content": ""})
    ok, why = rec.is_valid()
    assert not ok
    assert "currentMessage" in why


def test_currentmessage_not_a_dict():
    # The dataclass type allows anything; is_valid() must defend.
    rec = _good_record(currentMessage="oops")  # type: ignore[arg-type]
    ok, why = rec.is_valid()
    assert not ok
    assert "currentMessage" in why


def test_missing_expectedresponse():
    rec = _good_record(expectedResponse="")
    ok, why = rec.is_valid()
    assert not ok
    assert "expectedResponse" in why


def test_missing_metadata_task_type():
    md = {"source_dataset": "her_001", "license": "MIT", "split": "train"}
    rec = _good_record(metadata=md)
    ok, why = rec.is_valid()
    assert not ok
    assert "task_type" in why


def test_missing_metadata_source_dataset():
    md = {"task_type": "casual_reply", "license": "MIT", "split": "train"}
    rec = _good_record(metadata=md)
    ok, why = rec.is_valid()
    assert not ok
    assert "source_dataset" in why


# ─────────────────────────── helpers ────────────────────────────


def test_build_sets_required_metadata():
    rec = build(
        roomName="r1",
        agentId="agent",
        expectedResponse="thought: x\ntext: y",
        task_type="casual_reply",
        source_dataset="her_001",
        currentMessage={"role": "user", "speaker": "u", "content": "hello"},
    )
    ok, why = rec.is_valid()
    assert ok, why
    assert rec.metadata["task_type"] == "casual_reply"
    assert rec.metadata["source_dataset"] == "her_001"
    assert rec.metadata["license"] == "unknown"
    assert rec.metadata["split"] == "train"


def test_build_extra_metadata_merges():
    rec = build(
        roomName="r1",
        agentId="agent",
        expectedResponse="thought: x\ntext: y",
        task_type="casual_reply",
        source_dataset="her_001",
        currentMessage={"role": "user", "speaker": "u", "content": "hi"},
        extra_metadata={"scenario_category": "greeting", "language": "en"},
    )
    assert rec.metadata["scenario_category"] == "greeting"
    assert rec.metadata["language"] == "en"
    assert rec.metadata["task_type"] == "casual_reply"


def test_stable_id_deterministic():
    a = stable_id("foo", "bar", 1)
    b = stable_id("foo", "bar", 1)
    c = stable_id("foo", "bar", 2)
    assert a == b
    assert a != c
    assert len(a) == 24


@pytest.mark.parametrize("action", [ACTION_RESPOND, ACTION_REPLY])
def test_actions_in_record(action):
    rec = _good_record(availableActions=[action])
    ok, _ = rec.is_valid()
    assert ok
    assert action in rec.availableActions
