"""Exercises MESSAGE and ENTITY operations against real, restartable LifeWorld state.

The corpus-shaped matrix uses every distinct authored kwargs shape; focused
fixtures prove filtering, privacy, idempotency, and serialization invariants.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from eliza_lifeops_bench.corpus_audit import (
    _expected_modeled_mutation,
    _operation_key,
    build_corpus_audit,
)
from eliza_lifeops_bench.lifeworld.entities import (
    ChatMessage,
    Contact,
    Conversation,
    EmailMessage,
    EntityKind,
)
from eliza_lifeops_bench.lifeworld.world import LifeWorld
from eliza_lifeops_bench.runner import _execute_action
from eliza_lifeops_bench.scenarios import CORE_SCENARIOS
from eliza_lifeops_bench.types import Action, ScenarioMode

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SNAPSHOTS = {
    42: PACKAGE_ROOT / "data" / "snapshots" / "tiny_seed_42.json",
    2026: PACKAGE_ROOT / "data" / "snapshots" / "medium_seed_2026.json",
}
FORMER_GAP_OPERATIONS = {
    "MESSAGE/draft_reply",
    "MESSAGE/list_channels",
    "MESSAGE/read_channel",
    "MESSAGE/read_with_contact",
    "MESSAGE/search_inbox",
    "MESSAGE/triage",
    "ENTITY/list",
    "ENTITY/log_interaction",
}


def _was_former_gap(action: Action) -> bool:
    operation = _operation_key(action)
    if operation not in FORMER_GAP_OPERATIONS:
        return False
    if operation == "MESSAGE/draft_reply":
        return action.kwargs.get("source") != "gmail"
    return True


def _corpus_cases() -> list[tuple[int, str, Action]]:
    cases: dict[str, tuple[int, str, Action]] = {}
    for scenario in CORE_SCENARIOS:
        if scenario.mode is not ScenarioMode.STATIC:
            continue
        for action in scenario.ground_truth_actions:
            if not _was_former_gap(action):
                continue
            key = json.dumps(
                {
                    "seed": scenario.world_seed,
                    "now": scenario.now_iso,
                    "name": action.name,
                    "kwargs": action.kwargs,
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            cases[key] = (scenario.world_seed, scenario.now_iso, action)
    return list(cases.values())


CORPUS_CASES = _corpus_cases()


@pytest.fixture(scope="module")
def base_worlds() -> dict[int, LifeWorld]:
    return {
        seed: LifeWorld.from_json(path.read_text(encoding="utf-8"))
        for seed, path in SNAPSHOTS.items()
    }


@pytest.mark.parametrize(
    ("seed", "now_iso", "action"),
    CORPUS_CASES,
    ids=lambda value: value.name if isinstance(value, Action) else str(value),
)
def test_every_distinct_corpus_shape_has_real_semantics(
    base_worlds: dict[int, LifeWorld],
    seed: int,
    now_iso: str,
    action: Action,
) -> None:
    world = base_worlds[seed].fork(now_iso=now_iso)
    revision = world.mutation_revision

    result = _execute_action(action, world)

    assert result["ok"] is True
    assert result.get("noEffect") is not True
    expects_mutation = _expected_modeled_mutation(action, _operation_key(action))
    assert (world.mutation_revision != revision) is expects_mutation
    if expects_mutation:
        assert result["effect"] != "none"
    else:
        assert result["effect"] == "none"


@pytest.mark.parametrize(
    ("seed", "now_iso", "action"),
    [
        case
        for case in CORPUS_CASES
        if _expected_modeled_mutation(case[2], _operation_key(case[2]))
    ],
    ids=lambda value: value.name if isinstance(value, Action) else str(value),
)
def test_every_mutating_corpus_shape_is_idempotent(
    base_worlds: dict[int, LifeWorld],
    seed: int,
    now_iso: str,
    action: Action,
) -> None:
    world = base_worlds[seed].fork(now_iso=now_iso)
    first = _execute_action(action, world)
    revision = world.mutation_revision

    replay = _execute_action(action, world)

    assert replay["id"] == first["id"]
    assert replay["replayed"] is True
    assert world.mutation_revision == revision


def _message_world() -> LifeWorld:
    world = LifeWorld(seed=9, now_iso="2026-05-10T12:00:00Z")
    world.add(
        EntityKind.CONTACT,
        Contact(
            id="contact_alex",
            display_name="Alex Carter",
            given_name="Alex",
            family_name="Carter",
            primary_email="alex@example.test",
            phones=["+14155550100"],
            company="Acme Corp",
            relationship="family",
            tags=["friend", "supplier"],
        ),
    )
    world.add(
        EntityKind.CONTACT,
        Contact(
            id="contact_blank",
            display_name="Blair Carter",
            given_name="Blair",
            family_name="Carter",
            primary_email="",
            phones=[],
            company=None,
            relationship="work",
            tags=["work"],
            notes=None,
        ),
    )
    world.add(
        EntityKind.EMAIL,
        EmailMessage(
            id="email_match",
            thread_id="thread_match",
            folder="inbox",
            from_email="boss@example.test",
            to_emails=["owner@example.test"],
            cc_emails=[],
            subject="Q2 Financial Report",
            body_plain="Pending approval for Project Alpha.",
            sent_at="2026-05-10T09:00:00Z",
            received_at="2026-05-10T09:00:10Z",
            is_read=False,
            is_starred=True,
        ),
    )
    world.add(
        EntityKind.EMAIL,
        EmailMessage(
            id="email_old",
            thread_id="thread_old",
            folder="inbox",
            from_email="boss@example.test",
            to_emails=["owner@example.test"],
            cc_emails=[],
            subject="Q2 Financial Report",
            body_plain="Old pending approval.",
            sent_at="2026-04-01T09:00:00Z",
            received_at="2026-04-01T09:00:10Z",
            is_read=False,
        ),
    )
    world.add(
        EntityKind.CONVERSATION,
        Conversation(
            id="conv_signal",
            channel="signal",
            participants=["owner@example.test", "alex@example.test"],
            title=None,
            last_activity_at="2026-05-10T10:00:00Z",
        ),
    )
    world.add(
        EntityKind.CHAT_MESSAGE,
        ChatMessage(
            id="chat_dentist",
            channel="signal",
            conversation_id="conv_signal",
            from_handle="alex@example.test",
            to_handles=["owner@example.test"],
            text="Dentist moved to tomorrow.",
            sent_at="2026-05-10T10:00:00Z",
            is_read=False,
        ),
    )
    return world


def test_search_parses_structural_query_clauses_and_inclusive_dates() -> None:
    world = _message_world()
    revision = world.mutation_revision
    result = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "search_inbox",
                "source": "gmail",
                "query": 'from:boss@example.test subject:"Q2 Financial Report" is:unread pending',
                "since": "2026-05-10",
                "until": "2026-05-10",
            },
        ),
        world,
    )

    assert [item["id"] for item in result["results"]] == ["email_match"]
    assert world.mutation_revision == revision


def test_cross_channel_projections_filter_source_contact_date_and_limit() -> None:
    world = _message_world()
    search = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "search_inbox",
                "source": "signal",
                "query": "dentist tomorrow",
                "since": "2026-05-10",
                "until": "2026-05-10",
            },
        ),
        world,
    )
    contact = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "read_with_contact",
                "source": "signal",
                "contact": "contact_alex",
                "limit": 1,
            },
        ),
        world,
    )
    channel = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "read_channel",
                "source": "signal",
                "roomId": "conv_signal",
                "from": "2026-05-10T09:00:00Z",
                "until": "2026-05-10T11:00:00Z",
            },
        ),
        world,
    )
    channels = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={"operation": "list_channels", "source": "signal", "limit": 1},
        ),
        world,
    )

    assert [item["id"] for item in search["results"]] == ["chat_dentist"]
    assert [item["id"] for item in contact["messages"]] == ["chat_dentist"]
    assert [item["id"] for item in channel["messages"]] == ["chat_dentist"]
    assert channels["channels"][0]["id"] == "conv_signal"
    assert channels["channels"][0]["unreadCount"] == 1


def test_chat_draft_is_persisted_but_never_sent_and_survives_restart() -> None:
    world = _message_world()
    outgoing_before = sum(
        message.is_outgoing for message in world.chat_messages.values()
    )
    result = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "draft_reply",
                "source": "signal",
                "recipient": "Alex Carter",
                "message": "Can you cover pickup?",
                "requiresConfirmation": True,
                "privacyConstraints": ["omit_child_statement"],
                "tone": "factual",
            },
        ),
        world,
    )

    assert result["sent"] is False
    assert result["status"] == "draft"
    assert (
        sum(message.is_outgoing for message in world.chat_messages.values())
        == outgoing_before
    )
    draft = world.chat_drafts[result["id"]]
    assert draft.text == "Can you cover pickup?"
    assert draft.privacy_constraints == ["omit_child_statement"]

    restored = LifeWorld.from_json(world.to_json())
    assert restored.state_hash() == world.state_hash()
    assert restored.chat_drafts[result["id"]] == draft
    assert (
        sum(message.is_outgoing for message in restored.chat_messages.values())
        == outgoing_before
    )


def test_triage_policy_and_read_projection_are_structurally_distinct() -> None:
    world = _message_world()
    revision = world.mutation_revision
    projection = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={"operation": "triage", "source": "gmail", "folder": "inbox"},
        ),
        world,
    )
    assert projection["effect"] == "none"
    assert projection["counts"] == {
        "starred": 1,
        "unread": 1,
        "totalConsidered": 2,
    }
    assert world.mutation_revision == revision

    policy = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "triage",
                "sources": ["signal", "gmail"],
                "content": "Batch normal messages and surface owner-selected exceptions.",
            },
        ),
        world,
    )
    stored = world.message_triage_policies[policy["id"]]
    assert stored.sources == ["signal", "gmail"]
    assert stored.version == 1
    assert stored.created_at == world.now_iso
    assert policy["replayed"] is False
    restored = LifeWorld.from_json(world.to_json())
    assert restored.message_triage_policies[policy["id"]] == stored


@pytest.mark.parametrize(
    ("kwargs", "expected_ids"),
    [
        (
            {"intent": "list contacts whose family name is Carter", "name": "Carter"},
            ["contact_alex", "contact_blank"],
        ),
        ({"intent": "list contacts missing email"}, ["contact_blank"]),
        ({"intent": "list contacts where company is Acme Corp"}, ["contact_alex"]),
        (
            {"intent": "list contacts where email ends with @example.test"},
            ["contact_alex"],
        ),
        (
            {"intent": "list contacts where notes are empty"},
            ["contact_alex", "contact_blank"],
        ),
        (
            {"intent": "list contacts where phone starts with +1415"},
            ["contact_alex"],
        ),
        (
            {"intent": "list contacts where relationship is family"},
            ["contact_alex"],
        ),
        ({"intent": "list contacts with friend tag"}, ["contact_alex"]),
        ({"intent": "list contacts with supplier tag"}, ["contact_alex"]),
        ({"intent": "list contacts with work tag"}, ["contact_blank"]),
        ({"intent": "list family contacts missing phone"}, []),
    ],
)
def test_entity_list_supports_every_authored_filter_shape(
    kwargs: dict[str, Any],
    expected_ids: list[str],
) -> None:
    world = _message_world()
    result = _execute_action(
        Action(name="ENTITY", kwargs={"subaction": "list", **kwargs}),
        world,
    )

    assert [item["id"] for item in result["entities"]] == expected_ids
    assert result["effect"] == "none"


def test_interaction_log_persists_exact_receipt_and_survives_restart() -> None:
    world = _message_world()
    result = _execute_action(
        Action(
            name="ENTITY",
            kwargs={
                "subaction": "log_interaction",
                "entityId": "contact_alex",
                "name": "Historical Alias",
                "notes": "Discussed the Q3 partnership.",
                "channel": "signal",
                "occurredAt": "2026-05-10T08:30:00Z",
            },
        ),
        world,
    )

    record = world.interaction_records[result["id"]]
    assert record.entity_id == "contact_alex"
    assert record.subject_name == "Historical Alias"
    assert record.source_name_mismatch is True
    assert record.occurred_at == "2026-05-10T08:30:00Z"
    assert result["createdAt"] == world.now_iso

    restored = LifeWorld.from_json(world.to_json())
    assert restored.interaction_records[result["id"]] == record
    assert restored.state_hash() == world.state_hash()


def test_no_store_interaction_enforces_privacy_without_leaking_notes() -> None:
    world = _message_world()
    revision = world.mutation_revision
    result = _execute_action(
        Action(
            name="ENTITY",
            kwargs={
                "subaction": "log_interaction",
                "entityId": "contact_alex",
                "notes": "Do not persist this private detail.",
                "storeAllowed": False,
            },
        ),
        world,
    )

    assert result["persisted"] is False
    assert result["privacyGuard"] == "storage_prohibited"
    assert "notes" not in result
    assert len(result["noteDigest"]) == 64
    assert world.interaction_records == {}
    assert world.mutation_revision == revision


@pytest.mark.parametrize(
    ("action", "error"),
    [
        (
            Action(
                name="MESSAGE",
                kwargs={"operation": "search_inbox", "source": "gmail", "query": ""},
            ),
            ValueError,
        ),
        (
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "search_inbox",
                    "source": "gmail",
                    "query": "report",
                    "since": "not-a-date",
                },
            ),
            ValueError,
        ),
        (
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_channel",
                    "source": "carrier-pigeon",
                    "roomId": "conv_signal",
                },
            ),
            ValueError,
        ),
        (
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_channel",
                    "source": "signal",
                    "roomId": "missing",
                },
            ),
            KeyError,
        ),
        (
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_with_contact",
                    "source": "signal",
                    "contact": "contact_missing",
                },
            ),
            KeyError,
        ),
        (
            Action(
                name="MESSAGE",
                kwargs={"operation": "draft_reply", "source": "signal"},
            ),
            KeyError,
        ),
        (
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "list",
                    "intent": "guess who I probably mean",
                },
            ),
            ValueError,
        ),
        (
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "log_interaction",
                    "entityId": "contact_missing",
                    "notes": "hello",
                },
            ),
            KeyError,
        ),
        (
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "log_interaction",
                    "entityId": "contact_alex",
                    "notes": "",
                },
            ),
            ValueError,
        ),
    ],
)
def test_invalid_message_and_entity_inputs_fail_observably(
    action: Action,
    error: type[Exception],
) -> None:
    with pytest.raises(error):
        _execute_action(action, _message_world())


def test_corpus_audit_classifies_every_former_gap_without_exempting_failures() -> None:
    audit = build_corpus_audit()
    gaps = audit["noEffectGaps"]["occurrences"]
    assert not any(item["operation"] in FORMER_GAP_OPERATIONS for item in gaps)

    expected = {
        (scenario.id, index)
        for scenario in CORE_SCENARIOS
        if scenario.mode is ScenarioMode.STATIC
        for index, action in enumerate(scenario.ground_truth_actions)
        if _was_former_gap(action)
    }
    classified = {
        (item["scenarioId"], item["actionIndex"])
        for collection in (
            audit["modeledNoMutationOccurrences"],
            audit["modeledMutationOccurrences"],
        )
        for item in collection
        if _was_former_gap(
            Action(
                name=item["action"]["name"],
                kwargs=item["action"]["kwargs"],
            )
        )
    }
    assert classified == expected
    assert audit["unclassifiedSuccessfulNoEffects"] == []
    assert audit["executionErrors"] == []
