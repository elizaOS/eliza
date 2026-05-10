"""Tests for the LifeWorld in-memory database and its fixture generators."""

from __future__ import annotations

from pathlib import Path

import pytest

from eliza_lifeops_bench.lifeworld import (
    EntityKind,
    LifeWorld,
    WorldGenerator,
    WorldSnapshot,
    world_state_hash,
)
from eliza_lifeops_bench.lifeworld.entities import (
    Calendar,
    CalendarEvent,
    ChatMessage,
    Contact,
    Conversation,
    EmailMessage,
    EmailThread,
    FinancialAccount,
    FinancialTransaction,
    HealthMetric,
    LocationPoint,
    Note,
    Reminder,
    ReminderList,
    Subscription,
)
from eliza_lifeops_bench.lifeworld.snapshots import (
    SNAPSHOT_SPECS,
    build_world_for,
    snapshots_dir,
    write_snapshot,
)

# Anchor every test that builds a world to the same in-world clock so
# wall-clock time has no influence on results.
NOW_ISO = "2026-05-10T12:00:00Z"


# --------------------------------------------------------------- determinism


def test_generator_is_deterministic_across_calls() -> None:
    h1 = WorldGenerator(seed=42, now_iso=NOW_ISO, scale="small").generate_default_world().state_hash()
    h2 = WorldGenerator(seed=42, now_iso=NOW_ISO, scale="small").generate_default_world().state_hash()
    assert h1 == h2


def test_different_seeds_produce_different_hashes() -> None:
    h1 = WorldGenerator(seed=1, now_iso=NOW_ISO, scale="small").generate_default_world().state_hash()
    h2 = WorldGenerator(seed=2, now_iso=NOW_ISO, scale="small").generate_default_world().state_hash()
    assert h1 != h2


def test_different_now_iso_produces_different_hash() -> None:
    h1 = WorldGenerator(seed=42, now_iso=NOW_ISO, scale="small").generate_default_world().state_hash()
    h2 = WorldGenerator(
        seed=42, now_iso="2026-01-01T00:00:00Z", scale="small"
    ).generate_default_world().state_hash()
    assert h1 != h2


def test_world_state_hash_helper_matches_method() -> None:
    world = WorldGenerator(seed=7, now_iso=NOW_ISO, scale="tiny").generate_default_world()
    assert world_state_hash(world) == world.state_hash()


# ---------------------------------------------------------- snapshot/restore


def test_snapshot_roundtrip_preserves_hash() -> None:
    world = WorldGenerator(seed=42, now_iso=NOW_ISO, scale="small").generate_default_world()
    h_before = world.state_hash()
    snap = world.snapshot()
    # Restore into a fresh world.
    other = LifeWorld(seed=0, now_iso="1970-01-01T00:00:00Z")
    other.restore(snap)
    assert other.state_hash() == h_before
    # Restore in-place.
    world.restore(snap)
    assert world.state_hash() == h_before


def test_json_roundtrip_preserves_hash() -> None:
    world = WorldGenerator(seed=42, now_iso=NOW_ISO, scale="small").generate_default_world()
    blob = world.to_json()
    other = LifeWorld.from_json(blob)
    assert other.state_hash() == world.state_hash()


def test_state_hash_independent_of_insertion_order() -> None:
    # Insert two contacts in two orders into otherwise empty worlds.
    a = LifeWorld(seed=1, now_iso=NOW_ISO)
    b = LifeWorld(seed=1, now_iso=NOW_ISO)
    c1 = Contact(
        id="c1", display_name="A B", given_name="A", family_name="B",
        primary_email="a@b.test",
    )
    c2 = Contact(
        id="c2", display_name="C D", given_name="C", family_name="D",
        primary_email="c@d.test",
    )
    a.add(EntityKind.CONTACT, c1)
    a.add(EntityKind.CONTACT, c2)
    b.add(EntityKind.CONTACT, c2)
    b.add(EntityKind.CONTACT, c1)
    assert a.state_hash() == b.state_hash()


# ----------------------------------------------------------- mutation effects


def test_mutation_changes_hash_then_restore_reverts() -> None:
    world = WorldGenerator(seed=42, now_iso=NOW_ISO, scale="small").generate_default_world()
    snap = world.snapshot()
    h_before = world.state_hash()

    # Send a brand-new email — pick a participant from existing contacts.
    contact = next(iter(world.contacts.values()))
    world.send_email(
        message_id="email_test_send",
        thread_id="thread_test_send",
        from_email="owner@example.test",
        to_emails=[contact.primary_email],
        subject="Test mutation",
        body_plain="hello",
    )
    h_after = world.state_hash()
    assert h_after != h_before

    world.restore(snap)
    assert world.state_hash() == h_before


def test_send_email_creates_thread_if_missing() -> None:
    world = LifeWorld(seed=1, now_iso=NOW_ISO)
    world.send_email(
        message_id="m1",
        thread_id="t1",
        from_email="me@x.test",
        to_emails=["a@x.test"],
        subject="hi",
        body_plain="body",
    )
    assert "t1" in world.email_threads
    assert world.email_threads["t1"].message_ids == ["m1"]


def test_send_email_appends_to_existing_thread() -> None:
    world = LifeWorld(seed=1, now_iso=NOW_ISO)
    world.send_email(
        message_id="m1", thread_id="t1", from_email="me@x.test",
        to_emails=["a@x.test"], subject="hi", body_plain="body",
    )
    world.send_email(
        message_id="m2", thread_id="t1", from_email="me@x.test",
        to_emails=["a@x.test"], subject="hi", body_plain="follow-up",
    )
    assert world.email_threads["t1"].message_ids == ["m1", "m2"]


# --------------------------------------------------------- scale population


def test_small_scale_populates_every_entity_kind() -> None:
    world = WorldGenerator(seed=42, now_iso=NOW_ISO, scale="small").generate_default_world()
    counts = world.counts()
    for kind in EntityKind:
        assert counts[kind.value] > 0, f"{kind.value} was not populated at scale=small"


# ----------------------------------------------------- CRUD per-entity-kind

def _seed_one_of_every_kind(world: LifeWorld) -> None:
    """Seed the minimum entities each CRUD test below needs."""
    world.add(
        EntityKind.CONTACT,
        Contact(
            id="ct1", display_name="X Y", given_name="X", family_name="Y",
            primary_email="x@y.test",
        ),
    )
    world.add(
        EntityKind.EMAIL,
        EmailMessage(
            id="em1", thread_id="th1", folder="inbox", from_email="a@b.test",
            to_emails=["c@d.test"], cc_emails=[], subject="hi", body_plain="body",
            sent_at=NOW_ISO, received_at=NOW_ISO,
        ),
    )
    world.add(
        EntityKind.EMAIL_THREAD,
        EmailThread(
            id="th1", subject="hi", message_ids=["em1"],
            participants=["a@b.test", "c@d.test"], last_activity_at=NOW_ISO,
        ),
    )
    world.add(
        EntityKind.CONVERSATION,
        Conversation(
            id="cv1", channel="imessage", participants=["+1000", "+2000"],
            title=None, last_activity_at=NOW_ISO, is_group=False,
        ),
    )
    world.add(
        EntityKind.CHAT_MESSAGE,
        ChatMessage(
            id="cm1", channel="imessage", conversation_id="cv1",
            from_handle="+1000", to_handles=["+2000"], text="hey",
            sent_at=NOW_ISO,
        ),
    )
    world.add(
        EntityKind.CALENDAR,
        Calendar(
            id="cal1", name="Personal", color="#000", owner="me@x.test",
            source="google", is_primary=True,
        ),
    )
    world.add(
        EntityKind.CALENDAR_EVENT,
        CalendarEvent(
            id="ev1", calendar_id="cal1", title="Sync",
            description="", location=None, start=NOW_ISO, end=NOW_ISO,
        ),
    )
    world.add(
        EntityKind.REMINDER_LIST,
        ReminderList(id="rl1", name="Inbox"),
    )
    world.add(
        EntityKind.REMINDER,
        Reminder(id="re1", list_id="rl1", title="todo"),
    )
    world.add(
        EntityKind.NOTE,
        Note(
            id="no1", title="t", body_markdown="b",
            created_at=NOW_ISO, updated_at=NOW_ISO,
        ),
    )
    world.add(
        EntityKind.ACCOUNT,
        FinancialAccount(
            id="ac1", institution="Bank", account_type="checking",
            balance_cents=10000, currency="USD", last4="1234",
        ),
    )
    world.add(
        EntityKind.TRANSACTION,
        FinancialTransaction(
            id="tx1", account_id="ac1", amount_cents=-100, currency="USD",
            merchant="X", category="other", description="thing",
            posted_at=NOW_ISO,
        ),
    )
    world.add(
        EntityKind.SUBSCRIPTION,
        Subscription(
            id="su1", name="Sub", monthly_cents=999, billing_day=15,
            next_charge_at=NOW_ISO,
        ),
    )
    world.add(
        EntityKind.HEALTH_METRIC,
        HealthMetric(id="hm1", metric_type="steps", value=10000.0, recorded_at=NOW_ISO),
    )
    world.add(
        EntityKind.LOCATION_POINT,
        LocationPoint(
            id="lp1", latitude=37.7, longitude=-122.4, label="Home",
            recorded_at=NOW_ISO,
        ),
    )


@pytest.mark.parametrize("kind,entity_id,patch_field,patch_value", [
    (EntityKind.CONTACT, "ct1", "importance", 9),
    (EntityKind.EMAIL, "em1", "is_read", True),
    (EntityKind.EMAIL_THREAD, "th1", "subject", "renamed"),
    (EntityKind.CHAT_MESSAGE, "cm1", "text", "edited"),
    (EntityKind.CONVERSATION, "cv1", "title", "named"),
    (EntityKind.CALENDAR_EVENT, "ev1", "title", "Renamed"),
    (EntityKind.CALENDAR, "cal1", "name", "Renamed"),
    (EntityKind.REMINDER, "re1", "title", "renamed"),
    (EntityKind.REMINDER_LIST, "rl1", "name", "Inbox 2"),
    (EntityKind.NOTE, "no1", "title", "renamed"),
    (EntityKind.TRANSACTION, "tx1", "merchant", "Y"),
    (EntityKind.ACCOUNT, "ac1", "balance_cents", 99999),
    (EntityKind.SUBSCRIPTION, "su1", "monthly_cents", 1999),
    (EntityKind.HEALTH_METRIC, "hm1", "value", 5000.0),
    (EntityKind.LOCATION_POINT, "lp1", "label", "Office"),
])
def test_crud_methods_per_entity_kind(
    kind: EntityKind, entity_id: str, patch_field: str, patch_value: object
) -> None:
    world = LifeWorld(seed=1, now_iso=NOW_ISO)
    _seed_one_of_every_kind(world)
    fetched = world.get(kind, entity_id)
    assert fetched is not None, f"missing seeded {kind.value}"
    updated = world.update(kind, entity_id, **{patch_field: patch_value})
    assert getattr(updated, patch_field) == patch_value
    world.delete(kind, entity_id)
    assert world.get(kind, entity_id) is None


def test_update_unknown_field_raises() -> None:
    world = LifeWorld(seed=1, now_iso=NOW_ISO)
    _seed_one_of_every_kind(world)
    with pytest.raises(ValueError, match="unknown fields"):
        world.update(EntityKind.CONTACT, "ct1", nonexistent="x")


def test_add_with_wrong_type_raises() -> None:
    world = LifeWorld(seed=1, now_iso=NOW_ISO)
    note = Note(id="n", title="t", body_markdown="", created_at=NOW_ISO, updated_at=NOW_ISO)
    with pytest.raises(TypeError):
        world.add(EntityKind.CONTACT, note)


def test_delete_missing_raises() -> None:
    world = LifeWorld(seed=1, now_iso=NOW_ISO)
    with pytest.raises(KeyError):
        world.delete(EntityKind.CONTACT, "missing")


# ------------------------------------------------------ snapshot CLI on disk


def test_write_snapshot_to_tmp(tmp_path: Path) -> None:
    spec = SNAPSHOT_SPECS[0]  # tiny_seed_42
    target = tmp_path / "snapshots"
    json_path, state_hash = write_snapshot(spec, target)
    assert json_path.exists()
    assert (target / f"{spec.name}.meta.json").exists()
    # Reloading from disk must reproduce the same hash.
    reloaded = LifeWorld.from_json(json_path.read_text(encoding="utf-8"))
    assert reloaded.state_hash() == state_hash


def test_snapshots_dir_default_under_package() -> None:
    p = snapshots_dir()
    # The package root is .../packages/benchmarks/lifeops-bench
    assert p.name == "snapshots"
    assert p.parent.name == "data"
    assert p.parent.parent.name == "lifeops-bench"


def test_predefined_snapshots_build_and_hash() -> None:
    for spec in SNAPSHOT_SPECS:
        world = build_world_for(spec)
        # state hash is a stable 64-char hex digest.
        h = world.state_hash()
        assert isinstance(h, str)
        assert len(h) == 64
        # generate again — must match.
        world2 = build_world_for(spec)
        assert world2.state_hash() == h


def test_world_snapshot_dataclass_is_hashable_via_dict() -> None:
    world = WorldGenerator(seed=3, now_iso=NOW_ISO, scale="tiny").generate_default_world()
    snap: WorldSnapshot = world.snapshot()
    # Snapshot is frozen but `stores` is a mutable dict — the contract is
    # that the snapshot is a *deep copy* such that mutating the world
    # afterwards does not affect the snapshot's contents.
    counts_before = sum(len(v) for v in snap.stores.values())
    contact = Contact(
        id="extra", display_name="X Y", given_name="X", family_name="Y",
        primary_email="extra@x.test",
    )
    world.add(EntityKind.CONTACT, contact)
    counts_after_in_snapshot = sum(len(v) for v in snap.stores.values())
    assert counts_after_in_snapshot == counts_before
