"""LifeWorld health action semantics."""

from __future__ import annotations
from datetime import timedelta
from typing import Any
from .world import LifeWorld
from .entities import EntityKind
from .action_common import (
    UnsupportedAction,
    _strict_positive_integer,
    _try_parse_iso,
    _validated_health_metric,
)

_SLEEP_SOURCE_PRIORITY = ("manual", "fitbit", "apple-health", "oura")


_ACTIVITY_SOURCE_PRIORITY = ("manual", "fitbit", "oura", "apple-health")


def _health_window_days(value: Any, *, default: int) -> int:
    return _strict_positive_integer(
        value,
        field="HEALTH days",
        default=default,
        maximum=3650,
    )


def _health_data_points(
    world: LifeWorld,
    *,
    metric_type: str | None,
    days: int,
) -> list[dict[str, Any]]:
    now = _try_parse_iso(world.now_iso)
    if now is None:
        raise ValueError(f"LifeWorld has invalid now_iso: {world.now_iso!r}")
    cutoff = now - timedelta(days=days)
    raw_metrics = []
    for metric in world.health_metrics.values():
        if metric_type is not None and metric.metric_type != metric_type:
            continue
        recorded = _try_parse_iso(metric.recorded_at)
        if recorded is None:
            raise ValueError(
                f"LifeWorld health metric {metric.id} has invalid recorded_at"
            )
        if recorded < cutoff or recorded > now:
            continue
        raw_metrics.append(metric)

    def source_rank(metric: Any) -> int:
        priorities = (
            _SLEEP_SOURCE_PRIORITY
            if metric.metric_type in {"sleep_hours", "sleep_quality"}
            else _ACTIVITY_SOURCE_PRIORITY
        )
        try:
            return priorities.index(metric.source)
        except ValueError:
            return -1

    # Connector mirrors can report the same observation. Exact timestamps,
    # rather than whole days, preserve legitimate intraday samples.
    best: dict[tuple[str, str], Any] = {}
    for metric in raw_metrics:
        key = (metric.metric_type, metric.recorded_at)
        existing = best.get(key)
        if existing is None or source_rank(metric) > source_rank(existing):
            best[key] = metric
    return [
        {
            "id": metric.id,
            "metric_type": metric.metric_type,
            "value": metric.value,
            "recorded_at": metric.recorded_at,
            "source": metric.source,
        }
        for metric in sorted(
            best.values(),
            key=lambda item: (item.recorded_at, item.id),
        )
    ]


def _health_statistics(
    data_points: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in data_points:
        grouped.setdefault(str(item["metric_type"]), []).append(item)
    summaries: dict[str, dict[str, Any]] = {}
    for metric_type, items in sorted(grouped.items()):
        values = [float(item["value"]) for item in items]
        first = values[0]
        last = values[-1]
        delta = last - first
        summaries[metric_type] = {
            "count": len(values),
            "average": sum(values) / len(values),
            "minimum": min(values),
            "maximum": max(values),
            "first": first,
            "latest": last,
            "delta": delta,
            "direction": "up" if delta > 0 else "down" if delta < 0 else "flat",
            "firstRecordedAt": items[0]["recorded_at"],
            "latestRecordedAt": items[-1]["recorded_at"],
        }
    return summaries


def _u_health(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Project or delete authoritative health readings from LifeWorld."""
    subaction = kw.get("subaction", "by_metric")
    if subaction not in {
        "by_metric",
        "delete_metric",
        "status",
        "summary",
        "today",
        "trend",
        "trends",
    }:
        raise UnsupportedAction(
            f"unsupported action in execute path: HEALTH/{subaction}"
        )

    if subaction == "delete_metric":
        metric_type = _validated_health_metric(kw.get("metric"), required=True)
        deleted_ids = sorted(
            metric.id
            for metric in world.health_metrics.values()
            if metric.metric_type == metric_type
        )
        for metric_id in deleted_ids:
            world.delete(EntityKind.HEALTH_METRIC, metric_id)
        return {
            "ok": True,
            "effect": "deleted" if deleted_ids else "none",
            "subaction": subaction,
            "metric": metric_type,
            "deletedIds": deleted_ids,
            "deletedCount": len(deleted_ids),
            "replayed": not deleted_ids,
        }

    metric_type = _validated_health_metric(
        kw.get("metric"),
        required=subaction in {"trend", "trends"},
    )
    days = _health_window_days(
        kw.get("days"),
        default=1 if subaction == "today" else 30,
    )
    data_points = _health_data_points(
        world,
        metric_type=metric_type,
        days=days,
    )
    sources = sorted({str(item["source"]) for item in data_points})
    result: dict[str, Any] = {
        "ok": True,
        "effect": "none",
        "subaction": subaction,
        "metric": metric_type or "all",
        "days": days,
        "data": data_points,
        "count": len(data_points),
        "source_used": (
            sources[0] if len(sources) == 1 else "multi" if sources else None
        ),
    }
    if subaction in {"status", "summary", "trend", "trends"}:
        result["statistics"] = _health_statistics(data_points)
    return result
