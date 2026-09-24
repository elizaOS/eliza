"""
Disruption injection for P4 / P7 / P8 / P9 / P10.

Each REALM task instance may carry a ``disruption_scenarios`` list copied
from the upstream JSON. This module applies a single disruption to the
live instance state mid-run and returns the modified instance, so the
agent harness can re-prompt the agent with the new constraints and
record a replanning attempt.

The supported disruption types mirror upstream
``evaluation/task_definitions.DisruptionType``:

    machine_breakdown    P11/P10  – disable machine for ``duration``
    traffic_delay        P4       – add delay to a route
    road_closure         P4/P8    – remove a route entirely for ``duration``
    flight_delay         P9       – delay a flight arrival
    resource_shortage    P7/P10   – reduce a resource by ``shortage`` ratio
    weather_event        P7       – block transport to a region
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Disruption:
    type: str
    payload: dict[str, Any]

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Disruption":
        t = raw.get("type")
        if hasattr(t, "value"):  # upstream Enum
            t = t.value  # type: ignore[union-attr]
        return cls(type=str(t or "unknown"), payload=dict(raw))


def apply_disruption(instance: dict[str, Any], disruption: Disruption) -> dict[str, Any]:
    """Return a deep-copied instance with the disruption applied.

    Falls back to "no change" + a logged warning for unknown disruption
    types, which keeps the runner resilient to upstream schema drift.
    """
    new_instance = copy.deepcopy(instance)
    t = disruption.type
    p = disruption.payload

    if t == "machine_breakdown":
        # Mark a machine offline for ``duration`` time units.
        mid = p.get("machine_id")
        duration = p.get("duration", 0)
        downtime = new_instance.setdefault("machine_downtime", {})
        downtime[str(mid)] = downtime.get(str(mid), 0) + duration

    elif t == "traffic_delay":
        # Add delay to a single route in ``distances`` / ``travel_times``.
        route = p.get("route")
        delay = p.get("delay", 0)
        for field in ("distances", "travel_times"):
            d = new_instance.get(field)
            if isinstance(d, dict) and route in d:
                d[route] = d[route] + delay
                rev = "-".join(reversed(route.split("-")))
                if rev in d:
                    d[rev] = d[rev] + delay

    elif t == "road_closure":
        # Remove a route from the distance / travel_time matrix.
        route = p.get("route")
        for field in ("distances", "travel_times"):
            d = new_instance.get(field)
            if isinstance(d, dict) and route in d:
                d[route] = float("inf")
                rev = "-".join(reversed(route.split("-")))
                if rev in d:
                    d[rev] = float("inf")
        closed = new_instance.setdefault("blocked_routes", [])
        if route not in closed:
            closed.append(route)

    elif t == "flight_delay":
        flight = p.get("flight")
        delay = p.get("delay", 0)
        flights = new_instance.get("flight_schedules") or new_instance.get("constraints", {}).get(
            "flights"
        )
        if isinstance(flights, dict) and flight in flights:
            # Best-effort: append "+Nm" annotation so the agent prompt
            # carries the disruption forward. Numeric times left intact
            # because schedules are typically HH:MM strings here.
            flights[flight] = f"{flights[flight]} (+{delay}min)"
        new_instance.setdefault("flight_delays", []).append({"flight": flight, "delay": delay})

    elif t == "resource_shortage":
        resource = p.get("resource") or p.get("component")
        shortage = float(p.get("shortage", 0))
        # P7-style: ``resources`` is a dict of name->amount.
        resources = new_instance.get("resources")
        if isinstance(resources, dict) and resource in resources:
            resources[resource] = resources[resource] * (1.0 - shortage)
        # P10-style: ``suppliers[i].capacity`` for a component.
        for sup in new_instance.get("suppliers", []) or []:
            if "capacity" in sup:
                sup["capacity"] = int(sup["capacity"] * (1.0 - shortage))

    elif t == "weather_event":
        region = p.get("region")
        for r in new_instance.get("regions", []) or []:
            if r.get("id") == region:
                r["transport_blocked"] = True

    else:
        logger.warning("[disruption] Unknown type %r; passing through", t)

    new_instance.setdefault("applied_disruptions", []).append({"type": t, **p})
    return new_instance


def first_disruption(instance: dict[str, Any]) -> Disruption | None:
    """Return the first disruption scenario from the instance, if any."""
    raw = instance.get("disruption_scenarios") or []
    if not raw:
        return None
    return Disruption.from_dict(raw[0])
