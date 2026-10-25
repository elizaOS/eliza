"""LifeWorld calendar action semantics."""

from __future__ import annotations
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any
from .world import LifeWorld
from .entities import EntityKind
from .action_common import (
    UnsupportedAction,
    _details,
    _required,
    _shift_iso,
    _strict_positive_integer,
    _string_list,
    _synthetic_id,
    _try_parse_iso,
    _validated_json_value,
)


def _unsupported_no_effect(
    *,
    operation: str,
    reason: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return an explicit failure when LifeWorld cannot model an operation.

    A state-preserving result must never look like successful execution merely
    because ground-truth replay preserves the same hash. Modeled reads return
    their real snapshot data instead; unmodeled reads and writes use this
    failure shape so adapters, traces, and corpus audits can distinguish a
    genuine empty result from missing benchmark semantics.
    """
    result: dict[str, Any] = {
        "ok": False,
        "status": "unsupported",
        "noEffect": True,
        "operation": operation,
        "reason": reason,
    }
    if details:
        result.update(details)
    return result


def _h_calendar_create(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    event = world.create_calendar_event(
        event_id=kw["event_id"],
        calendar_id=kw["calendar_id"],
        title=kw["title"],
        start=kw["start"],
        end=kw["end"],
        description=kw.get("description", ""),
        location=kw.get("location"),
        attendees=kw.get("attendees"),
        all_day=kw.get("all_day", False),
        recurrence_rule=kw.get("recurrence_rule"),
    )
    return {"id": event.id, "title": event.title}


def _h_calendar_reschedule(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    event = world.move_event(kw["event_id"], start=kw["start"], end=kw["end"])
    return {"id": event.id, "start": event.start, "end": event.end}


def _h_calendar_cancel(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    event = world.cancel_event(kw["event_id"])
    return {"id": event.id, "status": event.status}


_CALENDAR_PREFERENCE_KEYS = frozenset(
    {
        "blackoutWindows",
        "category",
        "defaultDurationMinutes",
        "description",
        "digest",
        "intent",
        "minimumNoticeMinutes",
        "notificationStyle",
        "preferredEndLocal",
        "preferredStartLocal",
        "timeZone",
        "travelBufferMinutes",
        "workingDays",
    }
)


def _calendar_preferences_from_action(
    kw: dict[str, Any],
    details: dict[str, Any],
) -> dict[str, Any]:
    unknown_details = (
        set(details)
        - _CALENDAR_PREFERENCE_KEYS
        - {
            "calendar",
            "calendarId",
            "expectedVersion",
        }
    )
    if unknown_details:
        raise ValueError(
            f"CALENDAR/update_preferences has unknown fields: {sorted(unknown_details)}"
        )
    preferences: dict[str, Any] = {}
    for key in _CALENDAR_PREFERENCE_KEYS:
        if key in details:
            preferences[key] = _validated_json_value(
                details[key],
                field=f"details.{key}",
            )
        elif key in kw:
            preferences[key] = _validated_json_value(kw[key], field=key)
    if not preferences:
        raise ValueError("CALENDAR/update_preferences requires at least one preference")

    for field in ("preferredStartLocal", "preferredEndLocal"):
        value = preferences.get(field)
        if value is not None and (
            not isinstance(value, str)
            or re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value) is None
        ):
            raise ValueError(f"CALENDAR/update_preferences {field} must use HH:MM")
    for field in (
        "defaultDurationMinutes",
        "minimumNoticeMinutes",
        "travelBufferMinutes",
    ):
        value = preferences.get(field)
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int) or value < 0
        ):
            raise ValueError(
                f"CALENDAR/update_preferences {field} must be a non-negative integer"
            )
    return preferences


def _calendar_ids_from_action(
    world: LifeWorld,
    kw: dict[str, Any],
    details: dict[str, Any],
) -> list[str]:
    raw_many = kw.get("calendarIds", details.get("calendarIds"))
    if raw_many is not None:
        if not isinstance(raw_many, list) or not raw_many:
            raise ValueError("CALENDAR calendarIds must be a non-empty list")
        resolved: list[str] = []
        for index, raw in enumerate(raw_many):
            calendar_id = _resolve_calendar_id(world, raw)
            if calendar_id is None:
                raise KeyError(f"CALENDAR unknown calendarIds[{index}]: {raw!r}")
            if calendar_id not in resolved:
                resolved.append(calendar_id)
        return resolved
    raw_one = (
        kw.get("calendarId")
        or details.get("calendarId")
        or kw.get("calendar")
        or details.get("calendar")
    )
    if raw_one is not None:
        calendar_id = _resolve_calendar_id(world, raw_one)
        if calendar_id is None:
            raise KeyError(f"CALENDAR unknown calendar: {raw_one!r}")
        return [calendar_id]
    return sorted(world.calendars)


def _u_calendar(world: LifeWorld, kw: dict[str, Any], name: str) -> dict[str, Any]:
    """Dispatch the CALENDAR umbrella on `subaction`.

    Subactions:
        create_event, update_event, delete_event,
        propose_times, search_events, check_availability,
        next_event, update_preferences
    """
    sub = kw.get("subaction") or kw.get("action") or kw.get("operation")
    if not sub:
        sub = _required(kw, "subaction", action=name, sub="<missing>")
    details = _details(kw)
    if sub == "create_event":
        calendar_id = _resolve_calendar_id(
            world,
            details.get("calendarId")
            or kw.get("calendarId")
            or details.get("calendar_id")
            or kw.get("calendar_id")
            or details.get("calendar")
            or kw.get("calendar"),
        )
        if not calendar_id:
            calendar_id = _primary_calendar_id(world)
        start = (
            details.get("start")
            or kw.get("start")
            or details.get("startAt")
            or kw.get("startAt")
            or details.get("start_time")
            or kw.get("start_time")
        )
        end = (
            details.get("end")
            or kw.get("end")
            or details.get("endAt")
            or kw.get("endAt")
            or details.get("end_time")
            or kw.get("end_time")
        )
        if start and not end:
            end = _shift_iso(str(start), minutes=_duration_minutes(kw, details, 30))
        title = kw.get("title") or details.get("title") or "Untitled"
        if not calendar_id or not start or not end:
            raise KeyError(
                f"CALENDAR/create_event needs details.calendarId/start/end "
                f"(got details keys={sorted(details)})"
            )
        event_id = (
            kw.get("eventId")
            or details.get("eventId")
            or _synthetic_id(
                "event_auto", {"t": title, "s": start, "e": end, "c": calendar_id}
            )
        )
        if event_id in world.calendar_events:
            event = world.calendar_events[str(event_id)]
            return {"id": event.id, "title": event.title, "idempotent": True}
        event = world.create_calendar_event(
            event_id=event_id,
            calendar_id=calendar_id,
            title=title,
            start=start,
            end=end,
            description=details.get("description", ""),
            location=details.get("location"),
            attendees=details.get("attendees"),
            all_day=bool(details.get("all_day", False)),
            recurrence_rule=details.get("recurrence_rule"),
        )
        return {"id": event.id, "title": event.title}
    if sub == "update_event":
        updates = kw.get("updates") or details.get("updates") or {}
        if not isinstance(updates, dict):
            updates = {}
        requested_event_id = (
            details.get("eventId")
            or kw.get("eventId")
            or details.get("event_id")
            or kw.get("event_id")
            or details.get("id")
            or kw.get("id")
        )
        event = _find_calendar_event(
            world,
            event_id=requested_event_id,
            title=details.get("title")
            or kw.get("title")
            or updates.get("title")
            or details.get("eventTitle")
            or kw.get("eventTitle")
            or details.get("event_name")
            or kw.get("event_name")
            or (
                requested_event_id
                if isinstance(requested_event_id, str)
                and requested_event_id not in world.calendar_events
                else None
            ),
            date_hint=details.get("start")
            or kw.get("start")
            or details.get("startAt")
            or kw.get("startAt")
            or details.get("new_start")
            or kw.get("new_start")
            or details.get("newStart")
            or kw.get("newStart")
            or updates.get("start")
            or updates.get("new_start")
            or updates.get("newStart")
            or details.get("date")
            or kw.get("date")
            or details.get("when")
            or kw.get("when"),
            calendar_hint=details.get("calendarId")
            or kw.get("calendarId")
            or details.get("calendar_id")
            or kw.get("calendar_id")
            or details.get("calendar")
            or kw.get("calendar"),
        )
        if event is None:
            raise KeyError(
                f"{name}/{sub} missing required field 'eventId' in kwargs={sorted(kw)}"
            )
        explicit_start = (
            details.get("start")
            or kw.get("start")
            or details.get("startAt")
            or kw.get("startAt")
            or details.get("new_start")
            or kw.get("new_start")
            or details.get("newStart")
            or kw.get("newStart")
            or updates.get("start")
            or updates.get("new_start")
            or updates.get("newStart")
        )
        explicit_end = (
            details.get("end")
            or kw.get("end")
            or details.get("endAt")
            or kw.get("endAt")
            or details.get("new_end")
            or kw.get("new_end")
            or details.get("newEnd")
            or kw.get("newEnd")
            or updates.get("end")
            or updates.get("new_end")
            or updates.get("newEnd")
        )
        start = explicit_start or event.start
        if explicit_end:
            end = explicit_end
        elif explicit_start:
            end = _shift_iso(
                str(start),
                minutes=_duration_minutes(
                    kw, details, _calendar_event_duration_minutes(event, 60)
                ),
            )
        else:
            end = event.end
        patches: dict[str, Any] = {"start": start, "end": end}
        for source, aliases in {
            "title": ("newTitle", "new_title"),
            "description": ("newDescription", "new_description"),
            "location": ("newLocation", "new_location"),
            "attendees": ("attendees", "newAttendees", "new_attendees"),
            "status": ("status",),
            "all_day": ("all_day", "allDay"),
        }.items():
            for alias in aliases:
                if alias in updates:
                    patches[source] = updates[alias]
                    break
                if alias in details:
                    patches[source] = details[alias]
                    break
                if alias in kw:
                    patches[source] = kw[alias]
                    break
        if "attendees" in patches:
            patches["attendees"] = _string_list(patches["attendees"])
        event = world.update(EntityKind.CALENDAR_EVENT, event.id, **patches)
        return {
            "id": event.id,
            "title": event.title,
            "start": event.start,
            "end": event.end,
        }
    if sub == "delete_event":
        requested_event_id = (
            details.get("eventId")
            or kw.get("eventId")
            or details.get("event_id")
            or kw.get("event_id")
            or details.get("id")
            or kw.get("id")
        )
        event = _find_calendar_event(
            world,
            event_id=requested_event_id,
            title=details.get("title")
            or kw.get("title")
            or details.get("eventTitle")
            or kw.get("eventTitle")
            or details.get("event_name")
            or kw.get("event_name"),
            date_hint=details.get("date")
            or kw.get("date")
            or details.get("start")
            or kw.get("start")
            or details.get("startAt")
            or kw.get("startAt")
            or details.get("when")
            or kw.get("when"),
            calendar_hint=details.get("calendarId")
            or kw.get("calendarId")
            or details.get("calendar_id")
            or kw.get("calendar_id")
            or details.get("calendar")
            or kw.get("calendar"),
        )
        if event is None:
            if requested_event_id:
                return {
                    "ok": False,
                    "noEffect": True,
                    "missing_id": str(requested_event_id),
                    "subaction": sub,
                }
            raise KeyError(
                f"{name}/{sub} missing required field 'eventId' in kwargs={sorted(kw)}"
            )
        event = world.cancel_event(event.id)
        return {"id": event.id, "status": event.status}
    if sub == "check_availability":
        start = (
            kw.get("startAt")
            or details.get("startAt")
            or kw.get("start")
            or details.get("start")
            or kw.get("timeMin")
            or details.get("timeMin")
        )
        end = (
            kw.get("endAt")
            or details.get("endAt")
            or kw.get("end")
            or details.get("end")
            or kw.get("timeMax")
            or details.get("timeMax")
        )
        if not isinstance(start, str) or not isinstance(end, str):
            raise KeyError(
                f"{name}/{sub} requires startAt/endAt or start/end in kwargs={sorted(kw)}"
            )
        return {
            "subaction": sub,
            "ok": True,
            "events": _search_calendar_events(world, kw, details),
        }
    if sub in {"search_events", "next_event"}:
        return {
            "subaction": sub,
            "ok": True,
            "events": _search_calendar_events(world, kw, details),
        }
    if sub == "bulk_reschedule":
        return _unsupported_no_effect(
            operation=f"CALENDAR/{sub}",
            reason="LifeWorld has no atomic bulk-reschedule transaction",
            details={"events": _search_calendar_events(world, kw, details)},
        )
    if sub == "propose_times":
        window_start = (
            kw.get("windowStart")
            or details.get("windowStart")
            or kw.get("start")
            or details.get("start")
        )
        window_end = (
            kw.get("windowEnd")
            or details.get("windowEnd")
            or kw.get("end")
            or details.get("end")
        )
        if not isinstance(window_start, str) or not isinstance(window_end, str):
            raise KeyError("CALENDAR/propose_times requires windowStart/windowEnd")
        duration_minutes = _strict_positive_integer(
            kw.get("durationMinutes", details.get("durationMinutes")),
            field="CALENDAR/propose_times durationMinutes",
            default=30,
            maximum=24 * 60,
        )
        slot_count = _strict_positive_integer(
            kw.get("slotCount", details.get("slotCount")),
            field="CALENDAR/propose_times slotCount",
            default=3,
            maximum=50,
        )
        proposals = world.propose_calendar_times(
            window_start=window_start,
            window_end=window_end,
            duration_minutes=duration_minutes,
            slot_count=slot_count,
            calendar_ids=_calendar_ids_from_action(world, kw, details),
            time_zone=kw.get("timeZone") or details.get("timeZone"),
        )
        return {
            "ok": True,
            "effect": "none",
            "subaction": sub,
            "slots": [
                {
                    "id": proposal.id,
                    "start": proposal.start,
                    "end": proposal.end,
                    "durationMinutes": proposal.duration_minutes,
                    "calendarIds": proposal.calendar_ids,
                }
                for proposal in proposals
            ],
            "count": len(proposals),
            "requestedCount": slot_count,
        }
    if sub == "update_preferences":
        calendar_ids = _calendar_ids_from_action(world, kw, details)
        if len(calendar_ids) != 1:
            primary = _primary_calendar_id(world)
            if primary is None:
                raise ValueError(
                    "CALENDAR/update_preferences requires a target calendar"
                )
            calendar_ids = [primary]
        expected_version_raw = kw.get(
            "expectedVersion",
            details.get("expectedVersion"),
        )
        if expected_version_raw is not None and (
            isinstance(expected_version_raw, bool)
            or not isinstance(expected_version_raw, int)
            or expected_version_raw < 0
        ):
            raise ValueError(
                "CALENDAR/update_preferences expectedVersion must be a non-negative integer"
            )
        calendar, replayed = world.update_calendar_preferences(
            calendar_id=calendar_ids[0],
            preferences=_calendar_preferences_from_action(kw, details),
            expected_version=expected_version_raw,
        )
        return {
            "ok": True,
            "effect": "none" if replayed else "updated",
            "subaction": sub,
            "calendarId": calendar.id,
            "preferences": calendar.preferences,
            "version": calendar.preferences_version,
            "updatedAt": calendar.preferences_updated_at,
            "replayed": replayed,
        }
    raise UnsupportedAction(
        f"unsupported action in execute path: CALENDAR/{sub} — file gap in LIFEOPS_BENCH_GAPS.md"
    )


def _u_calendar_sources(
    world: LifeWorld,
    kw: dict[str, Any],
    name: str,
) -> dict[str, Any]:
    """Expose source-administration semantics without fabricating provider E2E.

    LifeWorld can enumerate its deterministic calendars, but it cannot perform
    OAuth, native permission grants, or external ICS fetches. Connect and write
    operations therefore return explicit pending/unsupported states. The
    runner-owned execution stamp marks every payload as deterministic, so these
    results can exercise planning without satisfying trusted-evidence gates.
    """
    operation = kw.get("operation") or kw.get("subaction")
    if operation not in {"list", "select", "deselect", "connect", "reconnect"}:
        raise KeyError(
            f"{name} requires operation=list|select|deselect|connect|reconnect"
        )

    def provider_name(source: str) -> str:
        return {
            "apple": "apple_calendar",
            "outlook": "microsoft",
        }.get(source, source)

    sources: list[dict[str, Any]] = []
    for calendar in sorted(
        world.calendars.values(),
        key=lambda item: (item.source, item.owner, item.id),
    ):
        provider = provider_name(calendar.source)
        account_id = _synthetic_id(
            "calendar_account",
            {"provider": provider, "owner": calendar.owner},
        )
        grant_id = f"simulated-grant:{provider}:{account_id}"
        sources.append(
            {
                "key": {
                    "provider": provider,
                    "side": "owner",
                    "grantId": grant_id,
                    "connectorAccountId": account_id,
                    "calendarId": calendar.id,
                },
                "accountEmail": calendar.owner,
                "summary": calendar.name,
                "primary": calendar.is_primary,
                "accessRole": "owner",
                "includeInFeed": True,
                "selectionVersion": 0,
                "health": {
                    "status": "fresh",
                    "visibility": "details",
                    "syncedAt": world.now_iso,
                },
            }
        )

    if operation == "list":
        return {
            "operation": operation,
            "snapshot": {
                "state": "complete" if sources else "unavailable",
                "observedAt": world.now_iso,
                "sources": sources,
            },
            "simulatedOnly": True,
            "providerReceipt": None,
        }

    provider = kw.get("provider")
    if provider not in {"google", "microsoft", "apple_calendar", "ics"}:
        raise KeyError(f"{name}/{operation} requires an exact provider")
    if operation in {"connect", "reconnect"}:
        if provider in {"google", "microsoft"}:
            state = "authorization_required"
            handoff = "external_oauth_required"
        elif provider == "apple_calendar":
            state = "permission_required"
            handoff = "native_device_permission_required"
        else:
            state = "configuration_required"
            handoff = "external_ics_fetch_required"
        return {
            "operation": operation,
            "connection": {
                "state": state,
                "provider": provider,
                "connected": False,
                "handoff": handoff,
            },
            "ok": False,
            "simulatedOnly": True,
            "providerReceipt": None,
        }

    required_identity = {
        "provider": provider,
        "grantId": kw.get("grantId"),
        "connectorAccountId": kw.get("connectorAccountId"),
        "calendarId": kw.get("calendarId"),
    }
    if (
        any(
            not isinstance(value, str) or not value
            for value in required_identity.values()
        )
        or not isinstance(kw.get("expectedVersion"), int)
        or kw["expectedVersion"] < 0
    ):
        raise KeyError(
            f"{name}/{operation} requires exact provider, grantId, "
            "connectorAccountId, calendarId, and non-negative expectedVersion"
        )
    target = next(
        (
            source
            for source in sources
            if source["key"]
            == {
                **required_identity,
                "side": "owner",
            }
        ),
        None,
    )
    return {
        "operation": operation,
        "ok": False,
        "error": (
            "deterministic_source_not_found"
            if target is None
            else "external_source_selection_required"
        ),
        "source": target,
        "changed": False,
        "simulatedOnly": True,
        "providerReceipt": None,
    }


def _primary_calendar_id(world: LifeWorld) -> str | None:
    primary = next((cal for cal in world.calendars.values() if cal.is_primary), None)
    if primary is not None:
        return primary.id
    first = next(iter(world.calendars.values()), None)
    return first.id if first is not None else None


def _resolve_calendar_id(world: LifeWorld, value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw in world.calendars:
            return raw
        lowered = raw.lower()
        if lowered in {"primary", "main", "default"}:
            return _primary_calendar_id(world)
        for calendar in world.calendars.values():
            if calendar.name.lower() == lowered:
                return calendar.id
            if _calendar_hint_matches(calendar.id, raw):
                return calendar.id
    return None


def _duration_minutes(
    kw: dict[str, Any], details: dict[str, Any], fallback: int
) -> int:
    raw = (
        details.get("duration_minutes")
        or kw.get("duration_minutes")
        or details.get("durationMinutes")
        or kw.get("durationMinutes")
        or kw.get("duration")
        or details.get("duration")
    )
    if isinstance(raw, (int, float)):
        return max(1, int(raw))
    if isinstance(raw, str):
        match = re.fullmatch(
            r"\s*(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)?\s*", raw
        )
        if match:
            value = int(match.group(1))
            unit = match.group(2) or "minutes"
            return max(1, value * 60 if unit.startswith("h") else value)
    hours = details.get("duration_hours") or kw.get("duration_hours")
    if isinstance(hours, (int, float)):
        return max(1, int(hours * 60))
    return fallback


def _calendar_event_duration_minutes(event: Any, fallback: int) -> int:
    start = _try_parse_iso(str(getattr(event, "start", "")))
    end = _try_parse_iso(str(getattr(event, "end", "")))
    if start is None or end is None:
        return fallback
    minutes = int((end - start).total_seconds() // 60)
    return max(1, minutes)


def _find_calendar_event(
    world: LifeWorld,
    *,
    event_id: Any = None,
    title: Any = None,
    date_hint: Any = None,
    calendar_hint: Any = None,
) -> Any:
    if isinstance(event_id, str) and event_id in world.calendar_events:
        return world.calendar_events[event_id]
    if isinstance(title, str) and title.strip():
        wanted = title.strip().lower()
        active_events = [
            event
            for event in world.calendar_events.values()
            if event.status != "cancelled"
            and _calendar_hint_matches(event.calendar_id, calendar_hint)
        ]
        matches = [
            event for event in active_events if event.title.strip().lower() == wanted
        ]
        if not matches:
            matches = [
                event
                for event in active_events
                if wanted in event.title.strip().lower()
                or event.title.strip().lower() in wanted
            ]
        if not matches:
            wanted_tokens = _meaningful_title_tokens(wanted)
            matches = [
                event
                for event in active_events
                if wanted_tokens
                and (
                    wanted_tokens.issubset(_meaningful_title_tokens(event.title))
                    or _meaningful_title_tokens(event.title).issubset(wanted_tokens)
                )
            ]
        if matches:
            hint = _parse_calendar_datetime_hint(date_hint, world.now_iso)
            if hint is None:
                hint = _try_parse_iso(world.now_iso)
            hint_date = hint.date() if hint is not None else None

            def rank(event: Any) -> tuple[int, float, int, str]:
                event_start = _try_parse_iso(str(event.start))
                same_day = (
                    0
                    if hint_date is not None
                    and event_start is not None
                    and event_start.date() == hint_date
                    else 1
                )
                distance = (
                    abs((event_start - hint).total_seconds())
                    if event_start is not None and hint is not None
                    else float("inf")
                )
                primary = 0 if event.calendar_id == "cal_primary" else 1
                return (same_day, distance, primary, event.id)

            return sorted(matches, key=rank)[0]
    return None


def _meaningful_title_tokens(value: Any) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", str(value).lower())
        if token not in {"a", "an", "and", "for", "of", "on", "the", "to"}
    }


def _calendar_hint_matches(calendar_id: str, hint: Any) -> bool:
    if not isinstance(hint, str) or not hint.strip():
        return True
    wanted = hint.strip().lower()
    if wanted == calendar_id.lower():
        return True
    normalized = re.sub(r"[^a-z0-9]+", "", wanted)
    calendar_normalized = re.sub(r"[^a-z0-9]+", "", calendar_id.lower())
    return normalized == calendar_normalized or calendar_normalized.endswith(normalized)


def _parse_calendar_datetime_hint(value: Any, now_iso: str) -> datetime | None:
    if isinstance(value, str):
        parsed = _try_parse_iso(value)
        if parsed is not None:
            return parsed
    parsed_date = _parse_calendar_date_hint(value, now_iso)
    if parsed_date is None:
        return None
    return datetime(
        parsed_date.year, parsed_date.month, parsed_date.day, tzinfo=timezone.utc
    )


def _parse_calendar_date_hint(value: Any, now_iso: str) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip().lower()
    parsed = _try_parse_iso(raw)
    if parsed is not None:
        return parsed.date()
    now = _try_parse_iso(now_iso)
    if now is None:
        return None
    if raw == "today":
        return now.date()
    if raw == "tomorrow":
        return (now + timedelta(days=1)).date()
    weekdays = {
        "monday": 0,
        "tuesday": 1,
        "wednesday": 2,
        "thursday": 3,
        "friday": 4,
        "saturday": 5,
        "sunday": 6,
    }
    match = re.search(
        r"\b(?P<modifier>this|next)?\s*"
        r"(?P<day>monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        raw,
    )
    if match is None:
        return None
    target = weekdays[match.group("day")]
    delta = (target - now.weekday()) % 7
    if delta == 0:
        delta = 7
    if match.group("modifier") == "next":
        delta += 7
    return (now + timedelta(days=delta)).date()


def _search_calendar_events(
    world: LifeWorld,
    kw: dict[str, Any],
    details: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    details = details or {}
    query_raw = (
        kw.get("query")
        or details.get("query")
        or kw.get("title")
        or details.get("title")
        or kw.get("event_name")
        or details.get("event_name")
        or ""
    )
    query = str(query_raw).strip().lower()
    date_raw = (
        kw.get("date") or details.get("date") or kw.get("when") or details.get("when")
    )
    parsed_date = _parse_calendar_date_hint(date_raw, world.now_iso)
    date_filter = parsed_date.isoformat() if parsed_date is not None else None
    calendar_hint = (
        kw.get("calendarId")
        or details.get("calendarId")
        or kw.get("calendar_id")
        or details.get("calendar_id")
        or kw.get("calendar")
        or details.get("calendar")
    )

    time_range = kw.get("time_range") or details.get("time_range") or {}
    if not isinstance(time_range, dict):
        time_range = {}
    start = (
        kw.get("start")
        or details.get("start")
        or kw.get("startAt")
        or details.get("startAt")
        or kw.get("timeMin")
        or details.get("timeMin")
        or kw.get("startDate")
        or details.get("startDate")
        or time_range.get("start")
    )
    end = (
        kw.get("end")
        or details.get("end")
        or kw.get("endAt")
        or details.get("endAt")
        or kw.get("timeMax")
        or details.get("timeMax")
        or kw.get("endDate")
        or details.get("endDate")
        or time_range.get("end")
    )

    def matches(event: Any) -> bool:
        if getattr(event, "status", None) == "cancelled":
            return False
        if not _calendar_hint_matches(getattr(event, "calendar_id", ""), calendar_hint):
            return False
        title = str(getattr(event, "title", "")).lower()
        if query and not (
            query in title
            or title in query
            or _meaningful_title_tokens(query).issubset(_meaningful_title_tokens(title))
            or _meaningful_title_tokens(title).issubset(_meaningful_title_tokens(query))
        ):
            return False
        event_start = str(getattr(event, "start", ""))
        event_end = str(getattr(event, "end", ""))
        if date_filter and event_start[:10] != date_filter:
            return False
        if isinstance(start, str) and event_end < start:
            return False
        if isinstance(end, str) and event_start > end:
            return False
        return True

    return [
        {
            "id": event.id,
            "calendar_id": event.calendar_id,
            "title": event.title,
            "start": event.start,
            "end": event.end,
            "status": event.status,
        }
        for event in sorted(
            (event for event in world.calendar_events.values() if matches(event)),
            key=lambda event: (event.start, event.id),
        )
    ]
