"""Exercises focus enforcement and travel offers against persisted LifeWorld state.

The tests use canonical snapshots and action replay so state transitions,
idempotency, empty projections, and cross-domain identifier tampering are real.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from eliza_lifeops_bench.corpus_audit import build_corpus_audit
from eliza_lifeops_bench.lifeworld.entities import FocusBlock, TravelHold
from eliza_lifeops_bench.lifeworld.world import LifeWorld
from eliza_lifeops_bench.runner import _execute_action
from eliza_lifeops_bench.types import Action

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_PATH = PACKAGE_ROOT / "data" / "snapshots" / "medium_seed_2026.json"


def _world() -> LifeWorld:
    return LifeWorld.from_json(SNAPSHOT_PATH.read_text(encoding="utf-8"))


def _run(world: LifeWorld, name: str, **kwargs: object) -> dict[str, object]:
    return _execute_action(Action(name=name, kwargs=kwargs), world)


def test_seeded_focus_and_travel_projections_preserve_authoritative_state() -> None:
    world = _world()
    before_hash = world.state_hash()
    before_revision = world.mutation_revision

    status = _run(
        world,
        "BLOCK_STATUS",
        subaction="status",
        ruleId="focus_seed_twitter",
    )
    listed = _run(
        world,
        "BLOCK_LIST_ACTIVE",
        subaction="list_active",
        includeScheduled=True,
    )
    search = _run(
        world,
        "BOOK_TRAVEL",
        subaction="search",
        origin="SFO",
        destination="JFK",
        departureDate="2026-05-15",
        returnDate="2026-05-18",
    )
    prepared = _run(
        world,
        "BOOK_TRAVEL",
        subaction="prepare",
        destination="NYC",
        hotelCheckIn="2026-05-15",
    )

    assert status["found"] is True
    assert status["block"]["id"] == "focus_seed_twitter"  # type: ignore[index]
    assert any(
        block["id"] == "focus_seed_twitter"  # type: ignore[index]
        for block in listed["blocks"]  # type: ignore[union-attr]
    )
    assert search["count"] == 1
    assert search["offers"][0]["id"] == "travel_offer_flight_00"  # type: ignore[index]
    assert prepared["offers"][0]["kind"] == "hotel"  # type: ignore[index]
    assert world.state_hash() == before_hash
    assert world.mutation_revision == before_revision


def test_focus_permission_enforcement_and_replay_are_durable() -> None:
    world = _world()
    permission_args = {
        "subaction": "request_permission",
        "hostnames": ["research.example.test"],
        "reason": "protected study session",
        "mode": "harsh",
        "noBypass": True,
    }
    before_revision = world.mutation_revision
    requested = _run(world, "BLOCK_REQUEST_PERMISSION", **permission_args)
    assert requested["effect"] == "applied"
    assert world.mutation_revision == before_revision + 1

    requested_hash = world.state_hash()
    replayed_request = _run(
        world,
        "BLOCK_REQUEST_PERMISSION",
        **permission_args,
    )
    assert replayed_request["effect"] == "none"
    assert replayed_request["replayed"] is True
    assert world.state_hash() == requested_hash

    block_args = {
        "subaction": "block",
        "hostnames": ["research.example.test"],
        "durationMinutes": 45,
        "mode": "harsh",
        "confirmed": True,
    }
    enforced = _run(world, "BLOCK_BLOCK", **block_args)
    block_id = enforced["block"]["id"]  # type: ignore[index]
    request_id = requested["request"]["id"]  # type: ignore[index]
    assert enforced["effect"] == "applied"
    assert isinstance(world.focus_blocks[block_id], FocusBlock)
    assert world.focus_blocks[block_id].permission_request_id == request_id
    assert world.focus_permission_requests[request_id].status == "approved"

    enforced_hash = world.state_hash()
    replayed_block = _run(world, "BLOCK_BLOCK", **block_args)
    assert replayed_block["effect"] == "none"
    assert replayed_block["replayed"] is True
    assert world.state_hash() == enforced_hash
    replayed_after_approval = _run(
        world,
        "BLOCK_REQUEST_PERMISSION",
        **permission_args,
    )
    assert replayed_after_approval["request"]["status"] == "approved"  # type: ignore[index]
    assert world.state_hash() == enforced_hash


def test_release_and_unblock_apply_once_to_matching_seeded_rules() -> None:
    world = _world()
    initial_hash = world.state_hash()
    released = _run(
        world,
        "BLOCK_RELEASE",
        subaction="release",
        hostnames=["twitter.com"],
        reason="owner override",
        confirmed=True,
    )
    assert released["effect"] == "applied"
    assert [item["id"] for item in released["released"]] == [  # type: ignore[index]
        "focus_seed_twitter"
    ]
    assert world.focus_blocks["focus_seed_twitter"].status == "released"
    assert world.focus_blocks["focus_seed_reddit"].status == "active"
    assert world.state_hash() != initial_hash

    released_hash = world.state_hash()
    replayed = _run(
        world,
        "BLOCK_RELEASE",
        subaction="release",
        hostnames=["twitter.com"],
        reason="owner override",
        confirmed=True,
    )
    assert replayed["effect"] == "none"
    assert replayed["replayed"] is True
    assert world.state_hash() == released_hash

    unblocked = _run(
        world,
        "BLOCK_UNBLOCK",
        subaction="unblock",
        packageNames=["com.king.candycrushsaga"],
        confirmed=True,
    )
    assert unblocked["effect"] == "applied"
    assert world.focus_blocks["focus_seed_candy"].status == "released"


def test_focus_operations_fail_closed_on_invalid_or_cross_domain_targets() -> None:
    world = _world()
    with pytest.raises(ValueError, match="invalid hostnames"):
        _run(
            world,
            "BLOCK_BLOCK",
            subaction="block",
            hostnames=["https://example.test/path"],
        )
    with pytest.raises(PermissionError, match="confirmed=True"):
        _run(
            world,
            "BLOCK_UNBLOCK",
            subaction="unblock",
            hostnames=["twitter.com"],
        )
    with pytest.raises(KeyError, match="matched no focus rules"):
        _run(
            world,
            "BLOCK_RELEASE",
            subaction="release",
            hostnames=["absent.example.test"],
            confirmed=True,
        )
    with pytest.raises(KeyError, match="focus block not found"):
        _run(
            world,
            "BLOCK_RELEASE",
            subaction="release",
            ruleId="travel_offer_flight_00",
            confirmed=True,
        )

    _run(
        world,
        "BLOCK_BLOCK",
        subaction="block",
        ruleId="owner_rule",
        hostnames=["one.example.test"],
        confirmed=True,
    )
    with pytest.raises(ValueError, match="idempotency conflict"):
        _run(
            world,
            "BLOCK_BLOCK",
            subaction="block",
            ruleId="owner_rule",
            hostnames=["two.example.test"],
            confirmed=True,
        )


def test_travel_hold_persists_once_and_rejects_tampering() -> None:
    world = _world()
    search_hash = world.state_hash()
    empty = _run(
        world,
        "BOOK_TRAVEL",
        subaction="search",
        origin="SFO",
        destination="MIA",
        departureDate="2026-05-15",
    )
    assert empty["count"] == 0
    assert empty["offers"] == []
    assert world.state_hash() == search_hash

    hold_args = {
        "subaction": "hold",
        "holdId": "owner_hold",
        "origin": "SFO",
        "destination": "NRT",
        "departureDate": "2026-05-13",
        "passengers": [{"type": "adult"}],
        "approval": {"required": True, "queue": "owner"},
    }
    held = _run(world, "BOOK_TRAVEL", **hold_args)
    assert held["effect"] == "applied"
    assert isinstance(world.travel_holds["owner_hold"], TravelHold)
    assert world.travel_holds["owner_hold"].status == "awaiting_approval"
    assert world.travel_holds["owner_hold"].offer_id == "travel_offer_flight_05"

    held_hash = world.state_hash()
    replayed = _run(world, "BOOK_TRAVEL", **hold_args)
    assert replayed["effect"] == "none"
    assert replayed["replayed"] is True
    assert world.state_hash() == held_hash

    with pytest.raises(ValueError, match="idempotency conflict"):
        _run(
            world,
            "BOOK_TRAVEL",
            subaction="hold",
            holdId="owner_hold",
            origin="JFK",
            destination="LHR",
            departureDate="2026-05-14",
            approval={"required": True, "queue": "owner"},
        )
    with pytest.raises(LookupError, match="matched no available offer"):
        _run(
            world,
            "BOOK_TRAVEL",
            subaction="hold",
            offerId="travel_offer_hotel_00",
            origin="SFO",
            destination="JFK",
            departureDate="2026-05-15",
        )
    with pytest.raises(ValueError, match="invalid date"):
        _run(
            world,
            "BOOK_TRAVEL",
            subaction="search",
            origin="SFO",
            destination="JFK",
            departureDate="2026-02-30",
        )


def test_focus_and_travel_state_round_trip_with_typed_entities() -> None:
    world = _world()
    _run(
        world,
        "BLOCK_BLOCK",
        subaction="block",
        hostnames=["docs.example.test"],
        durationMinutes=30,
        confirmed=True,
    )
    _run(
        world,
        "BOOK_TRAVEL",
        subaction="hold",
        origin="JFK",
        destination="LHR",
        departureDate="2026-05-14",
        approval={"required": True},
    )
    restored = LifeWorld.from_json(world.to_json())
    assert restored.state_hash() == world.state_hash()
    assert all(isinstance(item, FocusBlock) for item in restored.focus_blocks.values())
    assert all(isinstance(item, TravelHold) for item in restored.travel_holds.values())


def test_corpus_audit_classifies_all_103_former_focus_and_travel_gaps() -> None:
    audit = build_corpus_audit()
    owned_prefixes = ("BLOCK", "BOOK_TRAVEL")
    gaps = [
        item
        for item in audit["noEffectGaps"]["occurrences"]
        if item["operation"].startswith(owned_prefixes)
    ]
    mutations = [
        item
        for item in audit["modeledMutationOccurrences"]
        if item["operation"].startswith(owned_prefixes)
    ]
    projections = [
        item
        for item in audit["modeledNoMutationOccurrences"]
        if item["operation"].startswith(owned_prefixes)
    ]

    assert gaps == []
    assert len(mutations) == 80
    assert Counter(item["operation"] for item in mutations) == {
        "BLOCK/block": 18,
        "BLOCK_BLOCK/block": 42,
        "BLOCK_RELEASE/release": 4,
        "BLOCK_REQUEST_PERMISSION/request_permission": 7,
        "BLOCK_UNBLOCK/unblock": 4,
        "BOOK_TRAVEL/hold": 5,
    }
    assert len(projections) == 23
    assert Counter(item["operation"] for item in projections) == {
        "BLOCK_LIST_ACTIVE/list_active": 4,
        "BLOCK_STATUS/status": 6,
        "BOOK_TRAVEL/prepare": 7,
        "BOOK_TRAVEL/search": 6,
    }
    assert audit["unclassifiedSuccessfulNoEffects"] == []
    assert audit["executionErrors"] == []
