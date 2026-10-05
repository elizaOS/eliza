"""LifeWorld travel action semantics."""

from __future__ import annotations
import re
from copy import deepcopy
from datetime import date
from typing import Any
from .world import LifeWorld
from .entities import TravelOffer
from .action_common import UnsupportedAction, _synthetic_id

_DATE_ONLY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _travel_code(value: Any, *, field: str, required: bool) -> str | None:
    if value is None or value == "":
        if required:
            raise KeyError(f"BOOK_TRAVEL requires {field}")
        return None
    if (
        not isinstance(value, str)
        or re.fullmatch(r"[A-Za-z]{3}", value.strip()) is None
    ):
        raise ValueError(f"BOOK_TRAVEL {field} must be a three-letter location code")
    return value.strip().upper()


def _travel_date_window(
    value: Any,
    *,
    field: str,
    required: bool,
) -> tuple[date, date] | None:
    if value is None or value == "":
        if required:
            raise KeyError(f"BOOK_TRAVEL requires {field}")
        return None
    if not isinstance(value, str):
        raise ValueError(f"BOOK_TRAVEL {field} must be an ISO date or date range")
    parts = value.strip().split("/")
    if len(parts) not in {1, 2} or any(
        _DATE_ONLY_RE.fullmatch(part) is None for part in parts
    ):
        raise ValueError(f"BOOK_TRAVEL {field} must be YYYY-MM-DD[/YYYY-MM-DD]")
    try:
        parsed = [date.fromisoformat(part) for part in parts]
    except ValueError as exc:
        raise ValueError(f"BOOK_TRAVEL {field} contains an invalid date") from exc
    start, end = parsed[0], parsed[-1]
    if start > end:
        raise ValueError(f"BOOK_TRAVEL {field} range starts after it ends")
    return start, end


def _travel_date_matches(value: str | None, window: tuple[date, date] | None) -> bool:
    if window is None:
        return True
    if value is None or _DATE_ONLY_RE.fullmatch(value) is None:
        return False
    parsed = date.fromisoformat(value)
    return window[0] <= parsed <= window[1]


def _travel_offer_projection(offer: TravelOffer) -> dict[str, Any]:
    return {
        "id": offer.id,
        "kind": offer.kind,
        "provider": offer.provider,
        "origin": offer.origin,
        "destination": offer.destination,
        "departureDate": offer.departure_date,
        "returnDate": offer.return_date,
        "hotelCheckIn": offer.hotel_check_in,
        "priceCents": offer.price_cents,
        "currency": offer.currency,
        "metadata": deepcopy(offer.metadata),
    }


def _travel_passenger_count(value: Any) -> int:
    if value is None:
        return 1
    if isinstance(value, bool):
        raise ValueError("BOOK_TRAVEL passengers must be a positive count or list")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError("BOOK_TRAVEL passengers must be positive")
        return value
    if isinstance(value, list):
        if not value or any(not isinstance(item, dict) for item in value):
            raise ValueError("BOOK_TRAVEL passengers must be a non-empty object list")
        return len(value)
    raise ValueError("BOOK_TRAVEL passengers must be a positive count or list")


def _u_book_travel(world: LifeWorld, kw: dict[str, Any], _name: str) -> dict[str, Any]:
    """Project provider offers and persist approval-gated holds without booking."""
    subaction = kw.get("subaction") or kw.get("action") or "search"
    if subaction not in {"search", "prepare", "hold", "book", "cancel"}:
        raise UnsupportedAction(
            f"unsupported action in execute path: BOOK_TRAVEL/{subaction}"
        )
    if subaction in {"book", "cancel"}:
        raise UnsupportedAction(
            f"BOOK_TRAVEL/{subaction} crosses the external booking boundary; "
            "LifeWorld supports offer search and pre-booking holds only"
        )
    hotel_check_in_raw = kw.get("hotelCheckIn") or kw.get("hotel_check_in")
    kind = "hotel" if hotel_check_in_raw is not None else "flight"
    destination = _travel_code(
        kw.get("destination"),
        field="destination",
        required=True,
    )
    origin = _travel_code(
        kw.get("origin"),
        field="origin",
        required=kind == "flight",
    )
    departure_window = _travel_date_window(
        kw.get("departureDate") or kw.get("departure_date"),
        field="departureDate",
        required=kind == "flight",
    )
    return_window = _travel_date_window(
        kw.get("returnDate") or kw.get("return_date"),
        field="returnDate",
        required=False,
    )
    hotel_window = _travel_date_window(
        hotel_check_in_raw,
        field="hotelCheckIn",
        required=kind == "hotel",
    )
    if destination is None:
        raise KeyError("BOOK_TRAVEL requires destination")

    offers = [
        offer
        for offer in world.travel_offers.values()
        if offer.kind == kind
        and offer.destination == destination
        and (origin is None or offer.origin == origin)
        and _travel_date_matches(offer.departure_date, departure_window)
        and _travel_date_matches(offer.return_date, return_window)
        and _travel_date_matches(offer.hotel_check_in, hotel_window)
    ]
    offers.sort(key=lambda offer: (offer.price_cents, offer.id))

    requested_offer_id = kw.get("offerId") or kw.get("offer_id")
    if requested_offer_id is not None and (
        not isinstance(requested_offer_id, str) or not requested_offer_id.strip()
    ):
        raise ValueError("BOOK_TRAVEL offerId must be a non-empty string")
    if isinstance(requested_offer_id, str):
        offers = [offer for offer in offers if offer.id == requested_offer_id.strip()]

    operation = f"BOOK_TRAVEL/{subaction}"
    if subaction in {"search", "prepare"}:
        return {
            "ok": True,
            "effect": "none",
            "operation": operation,
            "query": {
                "kind": kind,
                "origin": origin,
                "destination": destination,
                "departureDate": (kw.get("departureDate") or kw.get("departure_date")),
                "returnDate": kw.get("returnDate") or kw.get("return_date"),
                "hotelCheckIn": hotel_check_in_raw,
            },
            "count": len(offers),
            "offers": [_travel_offer_projection(offer) for offer in offers],
        }

    if not offers:
        raise LookupError("BOOK_TRAVEL/hold matched no available offer")
    approval_raw = kw.get("approval", {})
    if approval_raw is None:
        approval_raw = {}
    if not isinstance(approval_raw, dict):
        raise ValueError("BOOK_TRAVEL approval must be an object")
    approval_required = approval_raw.get("required", True)
    if not isinstance(approval_required, bool):
        raise ValueError("BOOK_TRAVEL approval.required must be a boolean")
    approval_queue = approval_raw.get("queue")
    if approval_queue is not None and (
        not isinstance(approval_queue, str) or not approval_queue.strip()
    ):
        raise ValueError("BOOK_TRAVEL approval.queue must be a non-empty string")
    passengers = _travel_passenger_count(kw.get("passengers"))
    selected = offers[0]
    hold_id_raw = kw.get("holdId") or kw.get("hold_id")
    if hold_id_raw is not None and (
        not isinstance(hold_id_raw, str) or not hold_id_raw.strip()
    ):
        raise ValueError("BOOK_TRAVEL holdId must be a non-empty string")
    hold_id = (
        hold_id_raw.strip()
        if isinstance(hold_id_raw, str)
        else _synthetic_id(
            "travel_hold",
            {
                "offerId": selected.id,
                "passengers": passengers,
                "approvalRequired": approval_required,
                "approvalQueue": approval_queue,
            },
        )
    )
    hold, replayed = world.create_travel_hold(
        hold_id=hold_id,
        offer=selected,
        passengers=passengers,
        approval_required=approval_required,
        approval_queue=(
            approval_queue.strip() if isinstance(approval_queue, str) else None
        ),
    )
    return {
        "ok": True,
        "effect": "none" if replayed else "applied",
        "operation": operation,
        "replayed": replayed,
        "hold": {
            "id": hold.id,
            "offerId": hold.offer_id,
            "kind": hold.kind,
            "origin": hold.origin,
            "destination": hold.destination,
            "departureDate": hold.departure_date,
            "returnDate": hold.return_date,
            "hotelCheckIn": hold.hotel_check_in,
            "passengers": hold.passengers,
            "status": hold.status,
            "approvalRequired": hold.approval_required,
            "approvalQueue": hold.approval_queue,
            "createdAt": hold.created_at,
        },
    }
