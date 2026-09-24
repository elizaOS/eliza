"""Exercises calendar, life, health, and money semantics against real LifeWorld state.

The cases cover seeded projections, version conflicts, retries, and destructive
confirmation without replacing the in-memory database with mocks.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from eliza_lifeops_bench.corpus_audit import build_corpus_audit
from eliza_lifeops_bench.lifeworld.generators import WorldGenerator
from eliza_lifeops_bench.lifeworld.world import LifeWorld
from eliza_lifeops_bench.runner import _execute_action
from eliza_lifeops_bench.scenarios import CORE_SCENARIOS
from eliza_lifeops_bench.scorer import (
    _action_is_hash_inert,
    _is_read_only_action,
)
from eliza_lifeops_bench.types import Action

NOW = "2026-05-10T12:00:00Z"
PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _world(*, scale: str = "tiny", seed: int = 42) -> LifeWorld:
    return WorldGenerator(
        seed=seed,
        now_iso=NOW,
        scale=scale,  # type: ignore[arg-type]
    ).generate_default_world()


def _medium_snapshot() -> LifeWorld:
    return LifeWorld.from_json(
        (PACKAGE_ROOT / "data/snapshots/medium_seed_2026.json").read_text(
            encoding="utf-8"
        )
    )


def test_calendar_preferences_are_versioned_and_replay_safe() -> None:
    world = _world()
    action = Action(
        name="CALENDAR",
        kwargs={
            "subaction": "update_preferences",
            "calendarId": "cal_primary",
            "expectedVersion": 0,
            "preferredStartLocal": "09:00",
            "preferredEndLocal": "17:00",
            "timeZone": "UTC",
        },
    )

    first = _execute_action(action, world)
    first_revision = world.mutation_revision
    replay = _execute_action(
        Action(
            name="CALENDAR",
            kwargs={**action.kwargs, "expectedVersion": 1},
        ),
        world,
    )

    assert first["effect"] == "updated"
    assert first["version"] == 1
    assert replay["replayed"] is True
    assert world.mutation_revision == first_revision
    with pytest.raises(ValueError, match="version conflict"):
        _execute_action(action, world)


def test_calendar_proposals_avoid_events_and_respect_preferences() -> None:
    world = _world()
    _execute_action(
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "update_preferences",
                "calendarId": "cal_primary",
                "preferredStartLocal": "09:00",
                "preferredEndLocal": "12:00",
                "timeZone": "UTC",
            },
        ),
        world,
    )
    world.create_calendar_event(
        event_id="event_conflict",
        calendar_id="cal_primary",
        title="Existing meeting",
        start="2026-05-11T09:00:00Z",
        end="2026-05-11T10:00:00Z",
    )
    revision = world.mutation_revision

    result = _execute_action(
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "propose_times",
                "calendarId": "cal_primary",
                "windowStart": "2026-05-11T08:00:00Z",
                "windowEnd": "2026-05-11T12:00:00Z",
                "durationMinutes": 60,
                "slotCount": 3,
            },
        ),
        world,
    )

    assert result["count"] == 3
    assert result["slots"][0]["start"] == "2026-05-11T10:00:00Z"
    assert all(slot["end"] <= "2026-05-11T12:00:00Z" for slot in result["slots"])
    assert world.mutation_revision == revision


@pytest.mark.parametrize(
    "kwargs",
    [
        {
            "subaction": "propose_times",
            "windowStart": "2026-05-11T12:00:00Z",
            "windowEnd": "2026-05-11T10:00:00Z",
        },
        {
            "subaction": "propose_times",
            "windowStart": "2026-05-11T10:00:00Z",
            "windowEnd": "2026-05-11T12:00:00Z",
            "slotCount": 0,
        },
        {
            "subaction": "update_preferences",
            "details": {"mysteryField": True},
        },
    ],
)
def test_calendar_rejects_invalid_projection_and_preference_inputs(
    kwargs: dict[str, object],
) -> None:
    with pytest.raises((KeyError, ValueError)):
        _execute_action(Action(name="CALENDAR", kwargs=kwargs), _world())


def test_seeded_life_definition_update_has_optimistic_concurrency() -> None:
    world = _world()
    first = _execute_action(
        Action(
            name="LIFE_UPDATE",
            kwargs={
                "subaction": "update",
                "title": "Bedtime",
                "expectedVersion": 1,
                "details": {"timeOfDay": "22:30"},
            },
        ),
        world,
    )
    task = world.scheduled_tasks["life_definition_bedtime"]
    revision = world.mutation_revision
    replay = _execute_action(
        Action(
            name="LIFE_UPDATE",
            kwargs={
                "subaction": "update",
                "target": task.id,
                "expectedVersion": 2,
                "updates": {"timeOfDay": "22:30"},
            },
        ),
        world,
    )

    assert first == {"id": task.id, "version": 2, "replayed": False}
    assert task.trigger["timeOfDay"] == "22:30"
    assert replay["replayed"] is True
    assert world.mutation_revision == revision
    with pytest.raises(ValueError, match="version conflict"):
        _execute_action(
            Action(
                name="LIFE_UPDATE",
                kwargs={
                    "subaction": "update",
                    "target": task.id,
                    "expectedVersion": 1,
                    "updates": {"timeOfDay": "23:00"},
                },
            ),
            world,
        )


def test_life_skip_and_definition_delete_are_idempotent() -> None:
    world = _world()
    skip = Action(
        name="LIFE_SKIP",
        kwargs={
            "subaction": "skip",
            "title": "Bedtime",
            "details": {"skipDate": "2026-05-11"},
        },
    )
    first_skip = _execute_action(skip, world)
    skip_revision = world.mutation_revision
    replay_skip = _execute_action(skip, world)

    delete = Action(
        name="LIFE_DELETE",
        kwargs={
            "subaction": "delete",
            "kind": "definition",
            "title": "Afternoon Nap",
        },
    )
    first_delete = _execute_action(delete, world)
    delete_revision = world.mutation_revision
    replay_delete = _execute_action(delete, world)

    assert first_skip["replayed"] is False
    assert replay_skip["replayed"] is True
    assert world.scheduled_tasks["life_definition_bedtime"].metadata["skipDates"] == [
        "2026-05-11"
    ]
    assert skip_revision < delete_revision
    assert first_delete["replayed"] is False
    assert replay_delete["replayed"] is True
    assert world.mutation_revision == delete_revision
    assert world.scheduled_tasks["life_definition_afternoon_nap"].state == "deleted"


def test_recurring_life_create_persists_one_definition_on_retry() -> None:
    world = _world()
    action = Action(
        name="LIFE_CREATE",
        kwargs={
            "subaction": "create",
            "title": "Take medication",
            "details": {
                "kind": "alarm",
                "listId": "list_personal",
                "cadence": "daily",
                "timeOfDay": "08:00",
                "dedupeKey": "daily-medication",
            },
        },
    )
    first = _execute_action(action, world)
    revision = world.mutation_revision
    replay = _execute_action(action, world)

    assert first["definitionId"] is not None
    assert replay["replayed"] is True
    assert world.mutation_revision == revision
    definitions = [
        task
        for task in world.scheduled_tasks.values()
        if task.prompt_instructions == "Take medication"
    ]
    assert len(definitions) == 1


def test_expanded_scenarios_update_the_task_created_in_the_same_flow() -> None:
    scenario = next(
        item
        for item in CORE_SCENARIOS
        if item.id == "expanded.health_sleep_circadian.01.primary"
    )
    world = _medium_snapshot().fork(now_iso=scenario.now_iso)
    results = [
        _execute_action(action, world) for action in scenario.ground_truth_actions
    ]
    target = scenario.ground_truth_actions[-1].kwargs["target"]

    assert target in world.scheduled_tasks
    assert world.scheduled_tasks[target].priority == "low"
    assert results[-1]["replayed"] is False


def test_health_trend_projects_seeded_statistics_without_mutation() -> None:
    world = _world()
    revision = world.mutation_revision
    result = _execute_action(
        Action(
            name="HEALTH",
            kwargs={"subaction": "trend", "metric": "sleep_hours", "days": 7},
        ),
        world,
    )

    summary = result["statistics"]["sleep_hours"]
    assert result["count"] == 7
    assert summary["count"] == 7
    assert summary["minimum"] <= summary["average"] <= summary["maximum"]
    assert summary["direction"] in {"up", "down", "flat"}
    assert world.mutation_revision == revision


def test_health_metric_deletion_mutates_seed_data_and_replays_safely() -> None:
    world = _world()
    action = Action(
        name="HEALTH",
        kwargs={"subaction": "delete_metric", "metric": "sleep_quality"},
    )
    first = _execute_action(action, world)
    revision = world.mutation_revision
    replay = _execute_action(action, world)

    assert first["deletedCount"] == 7
    assert not any(
        metric.metric_type == "sleep_quality"
        for metric in world.health_metrics.values()
    )
    assert replay["deletedCount"] == 0
    assert replay["replayed"] is True
    assert world.mutation_revision == revision


@pytest.mark.parametrize(
    "kwargs",
    [
        {"subaction": "trend", "metric": "unknown_metric", "days": 7},
        {"subaction": "trend", "metric": "steps", "days": 0},
        {"subaction": "delete_metric"},
    ],
)
def test_health_rejects_invalid_metric_requests(kwargs: dict[str, object]) -> None:
    with pytest.raises((KeyError, ValueError)):
        _execute_action(Action(name="HEALTH", kwargs=kwargs), _world())


def test_money_projections_use_seeded_accounts_transactions_and_subscriptions() -> None:
    world = _medium_snapshot()
    revision = world.mutation_revision
    dashboard = _execute_action(
        Action(
            name="MONEY_DASHBOARD",
            kwargs={"subaction": "dashboard", "windowDays": 30},
        ),
        world,
    )
    recurring = _execute_action(
        Action(
            name="MONEY_RECURRING_CHARGES",
            kwargs={"subaction": "recurring_charges", "windowDays": 180},
        ),
        world,
    )
    status = _execute_action(
        Action(
            name="MONEY_SUBSCRIPTION_STATUS",
            kwargs={
                "subaction": "subscription_status",
                "serviceName": "Amazon Prime",
            },
        ),
        world,
    )
    audit = _execute_action(
        Action(
            name="MONEY_SUBSCRIPTION_AUDIT",
            kwargs={"subaction": "audit", "queryWindowDays": 365},
        ),
        world,
    )

    assert dashboard["accountCount"] == len(world.accounts)
    assert dashboard["transactionCount"] > 0
    assert dashboard["balancesByCurrency"]["USD"] > 0
    assert recurring["count"] > 0
    assert status["subscription"]["name"] == "Amazon Prime"
    assert audit["activeCount"] > 0
    assert audit["monthlyActiveCents"] > 0
    assert world.mutation_revision == revision


def test_subscription_cancel_requires_confirmation_and_is_idempotent() -> None:
    world = _medium_snapshot()
    unconfirmed = _execute_action(
        Action(
            name="MONEY_SUBSCRIPTION_CANCEL",
            kwargs={
                "subaction": "cancel",
                "serviceName": "Disney+",
                "serviceSlug": "disney-plus",
                "confirmed": False,
            },
        ),
        world,
    )
    assert unconfirmed["status"] == "confirmation_required"
    subscription = next(
        item for item in world.subscriptions.values() if item.name == "Disney+"
    )
    assert subscription.status == "active"

    action = Action(
        name="MONEY_SUBSCRIPTION_CANCEL",
        kwargs={
            "subaction": "cancel",
            "serviceName": "Disney+",
            "serviceSlug": "disney-plus",
            "confirmed": True,
        },
    )
    first = _execute_action(action, world)
    revision = world.mutation_revision
    replay = _execute_action(action, world)

    assert first["status"] == "cancelled"
    assert first["replayed"] is False
    assert replay["replayed"] is True
    assert world.mutation_revision == revision


@pytest.mark.parametrize(
    "action",
    [
        Action(
            name="MONEY_DASHBOARD",
            kwargs={"subaction": "dashboard", "windowDays": 0},
        ),
        Action(
            name="MONEY_SPENDING_SUMMARY",
            kwargs={
                "subaction": "spending_summary",
                "windowDays": 30,
                "groupBy": "unsupported",
            },
        ),
        Action(
            name="MONEY_SUBSCRIPTION_CANCEL",
            kwargs={
                "subaction": "cancel",
                "serviceName": "Netflix",
                "confirmed": "yes",
            },
        ),
    ],
)
def test_money_rejects_invalid_windows_groups_and_confirmation(
    action: Action,
) -> None:
    with pytest.raises(ValueError):
        _execute_action(action, _medium_snapshot())


def test_family_actions_have_correct_hash_classification() -> None:
    reads = [
        Action(name="CALENDAR", kwargs={"subaction": "propose_times"}),
        Action(name="HEALTH", kwargs={"subaction": "trend"}),
        Action(name="HEALTH", kwargs={"subaction": "summary"}),
        Action(name="MONEY", kwargs={"subaction": "dashboard"}),
    ]
    writes = [
        Action(name="CALENDAR", kwargs={"subaction": "update_preferences"}),
        Action(name="LIFE", kwargs={"subaction": "update"}),
        Action(name="LIFE", kwargs={"subaction": "skip"}),
        Action(name="HEALTH", kwargs={"subaction": "delete_metric"}),
    ]

    assert all(_is_read_only_action(action) for action in reads)
    assert all(_action_is_hash_inert(action) for action in reads)
    assert all(not _is_read_only_action(action) for action in writes)
    assert all(not _action_is_hash_inert(action) for action in writes)


def test_corpus_audit_has_no_gaps_or_execution_errors() -> None:
    audit = build_corpus_audit()

    assert audit["noEffectGaps"]["actionOccurrenceCount"] == 0
    assert audit["unclassifiedSuccessfulNoEffects"] == []
    assert audit["executionErrors"] == []
