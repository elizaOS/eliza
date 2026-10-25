"""LifeWorld tasks action semantics."""

from __future__ import annotations
from datetime import date
from typing import Any
from ..action_lineage import scheduled_task_create_receipt_id, scheduled_task_trigger
from .world import LifeWorld
from .entities import EntityKind
from .entities import HealthMetric, Reminder, WorkoutRecord
from .action_common import (
    UnsupportedAction,
    _details,
    _required,
    _shift_iso,
    _strict_positive_integer,
    _synthetic_id,
    _try_parse_iso,
    _validated_health_metric,
    _validated_json_value,
)


def _h_reminder_create(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    reminder_id = (
        kw.get("reminder_id")
        or kw.get("reminderId")
        or kw.get("id")
        or _synthetic_id(
            "reminder_auto",
            {
                "l": kw.get("list_id") or kw.get("listId"),
                "t": kw.get("title"),
                "d": kw.get("due_at") or kw.get("dueAt") or kw.get("due"),
            },
        )
    )
    list_id = kw.get("list_id") or kw.get("listId") or "list_personal"
    reminder = world.create_reminder(
        reminder_id=reminder_id,
        list_id=list_id,
        title=kw["title"],
        notes=kw.get("notes", ""),
        due_at=kw.get("due_at") or kw.get("dueAt") or kw.get("due"),
        priority=kw.get("priority", "none"),
        tags=kw.get("tags"),
    )
    return {"id": reminder.id}


def _h_reminder_complete(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    reminder_id = (
        kw.get("reminder_id")
        or kw.get("reminderId")
        or kw.get("id")
        or kw.get("target")
    )
    if not isinstance(reminder_id, str) or not reminder_id:
        raise KeyError("REMINDER.complete needs reminder_id/reminderId/id/target")
    reminder = world.complete_reminder(reminder_id)
    return {"id": reminder.id, "completed_at": reminder.completed_at}


def _h_note_create(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    note = world.create_note(
        note_id=kw["note_id"],
        title=kw["title"],
        body_markdown=kw["body_markdown"],
        tags=kw.get("tags"),
        source=kw.get("source", "apple-notes"),
    )
    return {"id": note.id}


_LIFE_DEFINITION_FIELDS = frozenset(
    {
        "anchor",
        "appliesTo",
        "cadence",
        "dedupeKey",
        "defaultAfterLocal",
        "dueDay",
        "dueDaySemantic",
        "earliestLocal",
        "endLocal",
        "exampleLocal",
        "label",
        "latestLocal",
        "offsetMinutes",
        "policy",
        "requiresOverride",
        "rotations",
        "skipDates",
        "startLocal",
        "timeOfDay",
        "timezoneSemantic",
        "windowAfterMinutes",
    }
)


_LIFE_TASK_UPDATE_FIELDS = frozenset(
    {
        "active",
        "anchor",
        "cadence",
        "due",
        "dueAt",
        "due_at",
        "listId",
        "notes",
        "priority",
        "skipDates",
        "state",
        "timeOfDay",
        "title",
    }
)


def _life_schedule(details: dict[str, Any]) -> dict[str, Any]:
    return {
        field: _validated_json_value(details[field], field=f"details.{field}")
        for field in sorted(_LIFE_DEFINITION_FIELDS)
        if field in details
    }


def _life_task_by_reference(
    world: LifeWorld,
    *,
    target: Any,
    title: Any,
) -> Any:
    if isinstance(target, str) and target.strip():
        task = world.scheduled_tasks.get(target.strip())
        if task is not None:
            return task
    if not isinstance(title, str) or not title.strip():
        raise KeyError("LIFE operation requires target or title")
    matches = [
        task
        for task in world.scheduled_tasks.values()
        if task.prompt_instructions.casefold() == title.strip().casefold()
        and task.metadata.get("lifeDefinition") is True
    ]
    if not matches:
        raise KeyError(f"LIFE definition not found for title: {title!r}")
    if len(matches) > 1:
        raise ValueError(f"LIFE definition title is ambiguous: {title!r}")
    return matches[0]


def _life_expected_version(kw: dict[str, Any], current: int) -> None:
    raw = kw.get("expectedVersion")
    if raw is None:
        return
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 1:
        raise ValueError("LIFE expectedVersion must be a positive integer")
    if raw != current:
        raise ValueError(
            f"LIFE definition version conflict: expected {raw}, found {current}"
        )


def _ensure_life_definition(
    world: LifeWorld,
    *,
    title: str,
    detail_kind: str,
    list_id: str,
    due_at: str | None,
    details: dict[str, Any],
) -> tuple[Any | None, bool]:
    schedule = _life_schedule(details)
    if detail_kind != "alarm" and not schedule:
        return None, False
    definition_id_raw = details.get("definitionId")
    definition_id = (
        definition_id_raw.strip()
        if isinstance(definition_id_raw, str) and definition_id_raw.strip()
        else _synthetic_id(
            "life_definition",
            {
                "title": title,
                "kind": detail_kind,
                "listId": list_id,
                "due": due_at,
                "schedule": schedule,
            },
        )
    )
    trigger = dict(schedule)
    trigger["kind"] = "recurring" if schedule.get("cadence") else "once"
    if due_at is not None:
        trigger["atIso"] = due_at
    metadata = {
        "lifeDefinition": True,
        "version": 1,
        "definition": {
            "kind": detail_kind,
            "listId": list_id,
            **schedule,
        },
    }
    existing = world.scheduled_tasks.get(definition_id)
    if existing is not None:
        if (
            existing.kind != detail_kind
            or existing.prompt_instructions != title
            or existing.trigger != trigger
            or existing.metadata != metadata
            or existing.state != "active"
        ):
            raise ValueError(f"LIFE definition idempotency conflict: {definition_id}")
        return existing, True
    task = world.create_scheduled_task(
        task_id=definition_id,
        kind=detail_kind,
        prompt_instructions=title,
        trigger=trigger,
        metadata=metadata,
    )
    return task, False


def _u_life_create(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Create typed reminders, recurring definitions, workouts, and readings."""
    sub = _required(kw, "subaction", action=name, sub="<missing>")
    if sub != "create":
        raise UnsupportedAction(
            f"unsupported action in execute path: LIFE_CREATE/{sub}"
        )
    details = _details(kw)
    title_raw = kw.get("title") or details.get("title")
    if not isinstance(title_raw, str) or not title_raw.strip():
        raise ValueError("LIFE_CREATE title must be a non-empty string")
    title = title_raw.strip()
    detail_kind = details.get("kind") or kw.get("kind") or "reminder"
    if detail_kind in {"reminder", "alarm"}:
        list_id = (
            details.get("listId")
            or details.get("list_id")
            or kw.get("listId")
            or kw.get("list_id")
            or "list_personal"
        )
        if not isinstance(list_id, str) or list_id not in world.reminder_lists:
            raise KeyError(
                f"LIFE_CREATE references unknown reminder list {list_id!r} "
                f"(known: {sorted(world.reminder_lists)})"
            )
        due_at = (
            details.get("due")
            or details.get("due_at")
            or details.get("dueAt")
            or kw.get("due")
            or kw.get("due_at")
            or kw.get("dueAt")
        )
        if due_at is not None and (
            not isinstance(due_at, str) or _try_parse_iso(due_at) is None
        ):
            raise ValueError("LIFE_CREATE due must be a valid ISO date/time")
        schedule = _life_schedule(details)
        reminder_id = _synthetic_id(
            "reminder_auto",
            {
                "t": title,
                "l": list_id,
                "d": due_at,
                "kind": detail_kind,
                "schedule": schedule,
            },
        )
        candidate = Reminder(
            id=reminder_id,
            list_id=list_id,
            title=title,
            due_at=due_at,
            schedule=schedule,
        )
        reminder = world.reminders.get(reminder_id)
        replayed = reminder is not None
        if reminder is not None and reminder != candidate:
            raise ValueError(f"LIFE reminder idempotency conflict: {reminder_id}")
        if reminder is None:
            reminder = world.create_reminder(
                reminder_id=reminder_id,
                list_id=list_id,
                title=title,
                due_at=due_at,
                schedule=schedule,
            )
        definition, definition_replayed = _ensure_life_definition(
            world,
            title=title,
            detail_kind=str(detail_kind),
            list_id=list_id,
            due_at=due_at,
            details=details,
        )
        return {
            "id": reminder.id,
            "title": reminder.title,
            "definitionId": definition.id if definition is not None else None,
            "replayed": replayed and (definition is None or definition_replayed),
        }
    if detail_kind == "workout":
        duration_minutes = _strict_positive_integer(
            details.get("durationMinutes", details.get("duration_minutes")),
            field="LIFE_CREATE workout durationMinutes",
            default=1,
            maximum=24 * 60,
        )
        occurred_at = details.get("occurredAtIso") or world.now_iso
        if not isinstance(occurred_at, str) or _try_parse_iso(occurred_at) is None:
            raise ValueError("LIFE_CREATE workout occurredAtIso must be ISO date/time")
        workout_id = _synthetic_id(
            "workout",
            {
                "t": title,
                "d": details.get("distanceKm"),
                "m": duration_minutes,
                "o": occurred_at,
            },
        )
        activity_type = (
            details.get("workoutType")
            or details.get("activityType")
            or details.get("activity_type")
            or title
        )
        calories_raw = details.get("calories", details.get("kcal"))
        if calories_raw is not None and (
            isinstance(calories_raw, bool)
            or not isinstance(calories_raw, (int, float))
            or calories_raw < 0
        ):
            raise ValueError("LIFE_CREATE workout calories must be non-negative")
        calories = int(calories_raw) if calories_raw is not None else None
        distance_raw = details.get("distanceKm", details.get("distance_km"))
        if distance_raw is not None and (
            isinstance(distance_raw, bool)
            or not isinstance(distance_raw, (int, float))
            or distance_raw < 0
        ):
            raise ValueError("LIFE_CREATE workout distanceKm must be non-negative")
        distance_km = float(distance_raw) if distance_raw is not None else None
        candidate = WorkoutRecord(
            id=workout_id,
            activity_type=str(activity_type),
            duration_minutes=duration_minutes,
            calories=calories,
            recorded_at=occurred_at,
            distance_km=distance_km,
        )
        existing = world.workouts.get(workout_id)
        if existing is not None:
            if existing != candidate:
                raise ValueError(f"LIFE workout idempotency conflict: {workout_id}")
            return {"id": existing.id, "kind": "workout", "replayed": True}
        workout = world.log_workout(
            workout_id=workout_id,
            activity_type=str(activity_type),
            duration_minutes=duration_minutes,
            calories=calories,
            recorded_at=occurred_at,
            distance_km=distance_km,
        )
        return {"id": workout.id, "kind": "workout", "replayed": False}
    if detail_kind == "health_metric":
        metric_type = _validated_health_metric(
            _required(details, "metric", action=name, sub="create/health_metric"),
            required=True,
        )
        value_raw = _required(details, "value", action=name, sub="create/health_metric")
        if isinstance(value_raw, bool) or not isinstance(value_raw, (int, float)):
            raise ValueError("LIFE_CREATE health metric value must be numeric")
        value = float(value_raw)
        if value != value or abs(value) == float("inf"):
            raise ValueError("LIFE_CREATE health metric value must be finite")
        occurred_at = details.get("occurredAtIso") or world.now_iso
        if not isinstance(occurred_at, str) or _try_parse_iso(occurred_at) is None:
            raise ValueError(
                "LIFE_CREATE health metric occurredAtIso must be ISO date/time"
            )
        metric_id = _synthetic_id(
            "hm_auto",
            {"m": metric_type, "v": value, "o": occurred_at},
        )
        candidate = HealthMetric(
            id=metric_id,
            metric_type=metric_type,  # type: ignore[arg-type]
            value=value,
            recorded_at=occurred_at,
            source="manual",
        )
        existing = world.health_metrics.get(metric_id)
        if existing is not None:
            if existing != candidate:
                raise ValueError(
                    f"LIFE health metric idempotency conflict: {metric_id}"
                )
            return {
                "id": existing.id,
                "metric": existing.metric_type,
                "value": existing.value,
                "replayed": True,
            }
        metric = world.log_health_metric(
            metric_id=metric_id,
            metric_type=metric_type,
            value=value,
            recorded_at=occurred_at,
        )
        return {
            "id": metric.id,
            "metric": metric.metric_type,
            "value": metric.value,
            "replayed": False,
        }
    raise UnsupportedAction(
        f"unsupported action in execute path: LIFE_CREATE/create/{detail_kind}"
    )


def _u_life_complete(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    sub = kw.get("subaction", "complete")
    target = _required(kw, "target", action=name, sub=sub)
    if target.startswith("reminder_"):
        existing = world.reminders.get(target)
        if existing is None:
            raise KeyError(f"LIFE_COMPLETE references unknown reminder: {target}")
        operation_id = _synthetic_id(
            "life_operation", {"op": "complete", "target": target}
        )
        if existing.last_operation_id == operation_id:
            return {
                "id": existing.id,
                "completed_at": existing.completed_at,
                "replayed": True,
            }
        reminder = world.complete_reminder(target)
        reminder = world.update(
            EntityKind.REMINDER,
            reminder.id,
            version=reminder.version + 1,
            last_operation_id=operation_id,
        )
        return {
            "id": reminder.id,
            "completed_at": reminder.completed_at,
            "replayed": False,
        }
    raise UnsupportedAction(
        f"unsupported action in execute path: LIFE_COMPLETE/{target} — only reminder_* targets supported"
    )


def _u_life_snooze(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    sub = kw.get("subaction", "snooze")
    target = _required(kw, "target", action=name, sub=sub)
    minutes = int(_required(kw, "minutes", action=name, sub=sub))
    if not target.startswith("reminder_"):
        raise UnsupportedAction(
            f"unsupported action in execute path: LIFE_SNOOZE/{target} — only reminder_* targets supported"
        )
    existing = world.reminders.get(target)
    if existing is None:
        raise KeyError(f"LIFE_SNOOZE references unknown reminder: {target}")
    base = existing.due_at or world.now_iso
    operation_id = _synthetic_id(
        "life_operation",
        {"op": "snooze", "target": target, "minutes": minutes},
    )
    if existing.last_operation_id == operation_id:
        return {"id": existing.id, "due_at": existing.due_at, "replayed": True}
    new_due = _shift_iso(base, minutes=minutes)
    reminder = world.snooze_reminder(target, new_due_at=new_due)
    reminder = world.update(
        EntityKind.REMINDER,
        reminder.id,
        version=reminder.version + 1,
        last_operation_id=operation_id,
    )
    return {"id": reminder.id, "due_at": reminder.due_at, "replayed": False}


def _u_life_review(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """LIFE_REVIEW stamps last_reviewed_at on the target list (side-effect).

    Even though the primary purpose is a read/listing operation, a review call
    writes a ``last_reviewed_at`` timestamp to the reminder list so that
    subsequent review cadence queries can tell when the list was last checked.
    This is the mutation that makes LIFE_REVIEW a "read_with_side_effects"
    scenario rather than a pure read.
    """
    sub = kw.get("subaction", "review")
    list_id = kw.get("list_id") or kw.get("listId")
    if list_id is not None:
        if not isinstance(list_id, str) or list_id not in world.reminder_lists:
            raise KeyError(f"LIFE_REVIEW references unknown reminder list: {list_id!r}")
        current = world.reminder_lists[list_id]
        if current.last_reviewed_at == world.now_iso:
            return {
                "subaction": sub,
                "ok": True,
                "list_id": list_id,
                "last_reviewed_at": current.last_reviewed_at,
                "replayed": True,
            }
        updated = world.touch_reminder_list_reviewed(list_id)
        return {
            "subaction": sub,
            "ok": True,
            "list_id": list_id,
            "last_reviewed_at": updated.last_reviewed_at,
            "replayed": False,
        }
    for lid in list(world.reminder_lists):
        if world.reminder_lists[lid].last_reviewed_at != world.now_iso:
            world.touch_reminder_list_reviewed(lid)
    return {
        "subaction": sub,
        "ok": True,
        "last_reviewed_at": world.now_iso,
    }


def _u_life_delete(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Delete reminders or retain an idempotent tombstone for definitions."""
    target = kw.get("target")
    if (
        isinstance(target, str)
        and target.startswith("reminder_")
        and target in world.reminders
    ):
        world.delete(EntityKind.REMINDER, target)
        return {"id": target, "deleted": True, "replayed": False}
    task = _life_task_by_reference(world, target=target, title=kw.get("title"))
    if task.state == "deleted":
        return {"id": task.id, "deleted": True, "replayed": True}
    version = int(task.metadata.get("version", 1))
    _life_expected_version(kw, version)
    metadata = {**task.metadata, "version": version + 1, "deletedAt": world.now_iso}
    deleted = world.update_scheduled_task(task.id, state="deleted", metadata=metadata)
    return {"id": deleted.id, "deleted": True, "replayed": False}


def _u_life_update(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Apply versioned updates to reminders or scheduler-backed definitions."""
    updates_raw = kw.get("updates")
    updates = updates_raw if isinstance(updates_raw, dict) else _details(kw)
    if not updates:
        raise ValueError("LIFE_UPDATE requires a non-empty updates/details object")
    unknown = set(updates) - _LIFE_TASK_UPDATE_FIELDS
    if unknown:
        raise ValueError(f"LIFE_UPDATE has unknown fields: {sorted(unknown)}")
    normalized = {
        key: _validated_json_value(value, field=f"updates.{key}")
        for key, value in updates.items()
    }
    target = kw.get("target")
    if isinstance(target, str) and target in world.reminders:
        reminder = world.reminders[target]
        _life_expected_version(kw, reminder.version)
        patches: dict[str, Any] = {}
        aliases = {
            "title": "title",
            "notes": "notes",
            "priority": "priority",
            "listId": "list_id",
            "due": "due_at",
            "dueAt": "due_at",
            "due_at": "due_at",
        }
        for source, destination in aliases.items():
            if source in normalized:
                patches[destination] = normalized[source]
        if "list_id" in patches and patches["list_id"] not in world.reminder_lists:
            raise KeyError(
                f"LIFE_UPDATE references unknown reminder list: {patches['list_id']!r}"
            )
        if "due_at" in patches and (
            not isinstance(patches["due_at"], str)
            or _try_parse_iso(patches["due_at"]) is None
        ):
            raise ValueError("LIFE_UPDATE due must be a valid ISO date/time")
        operation_id = _synthetic_id(
            "life_operation",
            {"op": "update", "target": target, "updates": normalized},
        )
        if reminder.last_operation_id == operation_id:
            return {"id": reminder.id, "version": reminder.version, "replayed": True}
        updated = world.update(
            EntityKind.REMINDER,
            reminder.id,
            **patches,
            version=reminder.version + 1,
            last_operation_id=operation_id,
        )
        return {"id": updated.id, "version": updated.version, "replayed": False}

    task = _life_task_by_reference(
        world,
        target=target,
        title=kw.get("title"),
    )
    version = int(task.metadata.get("version", 1))
    _life_expected_version(kw, version)
    definition = dict(task.metadata.get("definition") or {})
    definition.update(normalized)
    trigger = dict(task.trigger)
    for field in ("anchor", "cadence", "timeOfDay"):
        if field in normalized:
            trigger[field] = normalized[field]
    due = normalized.get(
        "due",
        normalized.get("dueAt", normalized.get("due_at")),
    )
    if due is not None:
        if not isinstance(due, str) or _try_parse_iso(due) is None:
            raise ValueError("LIFE_UPDATE due must be a valid ISO date/time")
        trigger["atIso"] = due
    metadata = {**task.metadata, "definition": definition}
    task_patches: dict[str, Any] = {"trigger": trigger}
    if "title" in normalized:
        title = normalized["title"]
        if not isinstance(title, str) or not title.strip():
            raise ValueError("LIFE_UPDATE title must be a non-empty string")
        task_patches["prompt_instructions"] = title.strip()
    if "priority" in normalized:
        priority = normalized["priority"]
        if priority not in {"low", "medium", "normal", "high"}:
            raise ValueError("LIFE_UPDATE priority is invalid")
        task_patches["priority"] = priority
    if "state" in normalized:
        state = normalized["state"]
        if not isinstance(state, str) or not state:
            raise ValueError("LIFE_UPDATE state must be a non-empty string")
        task_patches["state"] = state
    if "active" in normalized:
        if not isinstance(normalized["active"], bool):
            raise ValueError("LIFE_UPDATE active must be boolean")
        task_patches["state"] = "active" if normalized["active"] else "paused"
    candidate_metadata = {**metadata, "version": version + 1}
    unchanged = (
        all(getattr(task, field) == value for field, value in task_patches.items())
        and metadata == task.metadata
    )
    if unchanged:
        return {"id": task.id, "version": version, "replayed": True}
    task_patches["metadata"] = candidate_metadata
    updated = world.update_scheduled_task(task.id, **task_patches)
    return {"id": updated.id, "version": version + 1, "replayed": False}


def _u_life_skip(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Persist a dated occurrence skip or a structural scheduler skip."""
    details = _details(kw)
    target = kw.get("target")
    title = kw.get("title")
    skip_date = details.get("skipDate") or kw.get("skipDate")
    reason = kw.get("reason") or details.get("reason") or "owner_request"
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("LIFE_SKIP reason must be a non-empty string")
    task = _life_task_by_reference(world, target=target, title=title)
    version = int(task.metadata.get("version", 1))
    _life_expected_version(kw, version)
    metadata = dict(task.metadata)
    if skip_date is not None:
        if not isinstance(skip_date, str):
            raise ValueError("LIFE_SKIP skipDate must be YYYY-MM-DD")
        try:
            date.fromisoformat(skip_date)
        except ValueError as exc:
            raise ValueError("LIFE_SKIP skipDate must be YYYY-MM-DD") from exc
        skip_dates = list(metadata.get("skipDates") or [])
        if skip_date in skip_dates:
            return {"id": task.id, "skipDate": skip_date, "replayed": True}
        skip_dates.append(skip_date)
        metadata["skipDates"] = sorted(skip_dates)
        next_state = task.state
    else:
        skip_key = _synthetic_id(
            "life_skip",
            {"target": task.id, "reason": reason.strip()},
        )
        if metadata.get("lastSkipKey") == skip_key and task.state == "skipped":
            return {"id": task.id, "reason": reason.strip(), "replayed": True}
        metadata["lastSkipKey"] = skip_key
        metadata["skipReason"] = reason.strip()
        next_state = "skipped"
    metadata["version"] = version + 1
    updated = world.update_scheduled_task(
        task.id,
        state=next_state,
        metadata=metadata,
    )
    return {
        "id": updated.id,
        "skipDate": skip_date,
        "reason": reason.strip(),
        "version": version + 1,
        "replayed": False,
    }


def _scheduled_task_id(kw: dict[str, Any]) -> str | None:
    raw = (
        kw.get("taskId")
        or kw.get("task_id")
        or kw.get("id")
        or kw.get("target")
        or kw.get("scheduledTaskId")
        or kw.get("scheduled_task_id")
    )
    return raw if isinstance(raw, str) and raw.strip() else None


def _scheduled_task_trigger(kw: dict[str, Any]) -> dict[str, Any]:
    return scheduled_task_trigger(kw)


def _scheduled_task_patches(
    kw: dict[str, Any], *, include_identity: bool = True
) -> dict[str, Any]:
    patches: dict[str, Any] = {}
    if include_identity:
        kind = kw.get("kind")
        if isinstance(kind, str) and kind:
            patches["kind"] = kind
        prompt = (
            kw.get("promptInstructions")
            or kw.get("prompt_instructions")
            or kw.get("instructions")
            or kw.get("title")
        )
        if isinstance(prompt, str):
            patches["prompt_instructions"] = prompt
        trigger = _scheduled_task_trigger(kw)
        if trigger:
            patches["trigger"] = trigger

    alias_groups = {
        "output": ("output",),
        "subject": ("subject",),
        "priority": ("priority",),
        "should_fire": ("shouldFire", "should_fire"),
        "completion_check": ("completionCheck", "completion_check"),
        "pipeline": ("pipeline",),
        "metadata": ("metadata",),
        "state": ("state", "status"),
        "respects_global_pause": ("respectsGlobalPause", "respects_global_pause"),
    }
    for field, aliases in alias_groups.items():
        for alias in aliases:
            if alias not in kw:
                continue
            value = kw[alias]
            if field in {
                "output",
                "subject",
                "should_fire",
                "completion_check",
                "pipeline",
                "metadata",
            }:
                if isinstance(value, dict):
                    patches[field] = dict(value)
                elif value is None:
                    patches[field] = None
            elif field == "respects_global_pause":
                patches[field] = bool(value)
            else:
                patches[field] = value
            break
    return patches


def _u_scheduled_task_mutate(
    world: LifeWorld, kw: dict[str, Any], name: str
) -> dict[str, Any]:
    """Apply SCHEDULED_TASK_UPDATE/SNOOZE to an existing scheduled task."""
    task_id = _scheduled_task_id(kw)
    if not task_id:
        raise KeyError(f"{name} needs taskId/task_id/id/target")
    existing = world.scheduled_tasks.get(task_id)
    if existing is None:
        raise KeyError(f"{name} target does not exist: {task_id}")

    if name.endswith("SNOOZE"):
        minutes_raw = (
            kw.get("minutes") or kw.get("durationMinutes") or kw.get("duration")
        )
        minutes = int(minutes_raw) if isinstance(minutes_raw, (int, float, str)) else 0
        trigger = dict(existing.trigger)
        base = str(trigger.get("atIso") or trigger.get("at_iso") or world.now_iso)
        trigger["atIso"] = (
            kw.get("until")
            or kw.get("untilIso")
            or kw.get("until_iso")
            or _shift_iso(base, minutes=minutes)
        )
        metadata = dict(existing.metadata)
        metadata.update({"snoozedMinutes": minutes, "lastMutation": name})
        updated = world.update_scheduled_task(
            task_id,
            trigger=trigger,
            state="snoozed",
            metadata=metadata,
        )
        return {"id": updated.id, "state": updated.state, "trigger": updated.trigger}

    updates = kw.get("updates") or _details(kw)
    if not isinstance(updates, dict):
        updates = {}
    patches = _scheduled_task_patches({**kw, **updates})
    metadata = dict(existing.metadata)
    metadata["lastMutation"] = name
    patches["metadata"] = {**metadata, **dict(patches.get("metadata") or {})}
    updated = world.update_scheduled_task(task_id, **patches)
    return {"id": updated.id, "state": updated.state}


_SCHEDULED_TASK_STATE_BY_ACTION: dict[str, str] = {
    "SCHEDULED_TASKS_ACKNOWLEDGE": "acknowledged",
    "SCHEDULED_TASKS_CANCEL": "cancelled",
    "SCHEDULED_TASKS_COMPLETE": "completed",
    "SCHEDULED_TASKS_DISMISS": "dismissed",
    "SCHEDULED_TASKS_REOPEN": "active",
    "SCHEDULED_TASKS_SKIP": "skipped",
}


def _u_scheduled_task_state(
    world: LifeWorld, kw: dict[str, Any], name: str
) -> dict[str, Any]:
    task_id = _scheduled_task_id(kw)
    if not task_id:
        raise KeyError(f"{name} needs taskId/task_id/id/target")
    existing = world.scheduled_tasks.get(task_id)
    if existing is None:
        raise KeyError(f"{name} target does not exist: {task_id}")
    state = _SCHEDULED_TASK_STATE_BY_ACTION[name]
    metadata = dict(existing.metadata)
    metadata["lastMutation"] = name
    task = world.update_scheduled_task(task_id, state=state, metadata=metadata)
    return {"id": task.id, "state": task.state}


def _u_scheduled_tasks_readonly(
    world: LifeWorld, kw: dict[str, Any], name: str
) -> dict[str, Any]:
    task_id = _scheduled_task_id(kw)
    tasks = list(world.scheduled_tasks.values())
    if task_id:
        tasks = [task for task in tasks if task.id == task_id]
    kind = kw.get("kind")
    if isinstance(kind, str) and kind:
        tasks = [task for task in tasks if task.kind == kind]
    state = kw.get("state") or kw.get("status")
    if isinstance(state, str) and state:
        tasks = [task for task in tasks if task.state == state]
    return {
        "subaction": kw.get("subaction") or kw.get("action") or name,
        "ok": True,
        "tasks": [
            {
                "id": task.id,
                "kind": task.kind,
                "state": task.state,
                "trigger": task.trigger,
                "promptInstructions": task.prompt_instructions,
            }
            for task in sorted(tasks, key=lambda item: item.id)
        ],
    }


def _u_scheduled_tasks(
    world: LifeWorld, kw: dict[str, Any], name: str
) -> dict[str, Any]:
    op = str(kw.get("operation") or kw.get("action") or kw.get("subaction") or "list")
    op = {
        "ack": "acknowledge",
        "create_task": "create",
        "list_tasks": "list",
    }.get(op, op)
    if op == "create":
        return _u_scheduled_task_create(world, kw, "SCHEDULED_TASK_CREATE")
    if op in {"update", "snooze"}:
        return _u_scheduled_task_mutate(world, kw, f"SCHEDULED_TASK_{op.upper()}")
    state_action = {
        "acknowledge": "SCHEDULED_TASKS_ACKNOWLEDGE",
        "cancel": "SCHEDULED_TASKS_CANCEL",
        "complete": "SCHEDULED_TASKS_COMPLETE",
        "dismiss": "SCHEDULED_TASKS_DISMISS",
        "reopen": "SCHEDULED_TASKS_REOPEN",
        "skip": "SCHEDULED_TASKS_SKIP",
    }.get(op)
    if state_action is not None:
        return _u_scheduled_task_state(world, kw, state_action)
    if op in {"get", "history", "list"}:
        return _u_scheduled_tasks_readonly(world, kw, name)
    raise UnsupportedAction(
        f"unsupported action in execute path: SCHEDULED_TASKS/{op} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


def _u_scheduled_task_create(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """SCHEDULED_TASK_CREATE — model the production task primitive directly."""
    trigger = _scheduled_task_trigger(kw)
    prompt = str(
        kw.get("promptInstructions")
        or kw.get("prompt_instructions")
        or kw.get("instructions")
        or kw.get("title")
        or "Scheduled task"
    )
    task_id = _scheduled_task_id(kw) or scheduled_task_create_receipt_id(kw)
    if task_id in world.scheduled_tasks:
        task = world.scheduled_tasks[task_id]
        return {"id": task.id, "kind": task.kind, "idempotent": True}
    task = world.create_scheduled_task(
        task_id=task_id,
        kind=str(kw.get("kind") or "reminder"),
        prompt_instructions=prompt,
        trigger=trigger,
        **_scheduled_task_patches(kw, include_identity=False),
    )
    return {"id": task.id, "kind": task.kind, "state": task.state}
