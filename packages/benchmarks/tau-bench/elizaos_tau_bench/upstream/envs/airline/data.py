from __future__ import annotations

from copy import deepcopy
from typing import Any


_DATA: dict[str, Any] = {
    "users": {
        "mia_li_3668": {
            "name": {"first_name": "Mia", "last_name": "Li"},
            "dob": "1990-04-05",
            "payment_methods": {
                "certificate_7504069": {"source": "certificate", "amount": 250},
                "credit_card_4421486": {"source": "credit_card", "brand": "visa", "last_four": "7447"},
            },
            "reservations": [],
        },
        "olivia_gonzalez_2305": {
            "name": {"first_name": "Olivia", "last_name": "Gonzalez"},
            "dob": "1988-02-14",
            "payment_methods": {"credit_card_8712001": {"source": "credit_card", "brand": "visa", "last_four": "8712"}},
            "reservations": ["Z7GOZK"],
        },
    },
    "reservations": {
        "Z7GOZK": {
            "reservation_id": "Z7GOZK",
            "user_id": "olivia_gonzalez_2305",
            "origin": "EWR",
            "destination": "DFW",
            "flight_type": "round_trip",
            "cabin": "basic_economy",
            "flights": [
                {"flight_number": "HAT210", "date": "2024-05-21", "price": 180},
                {"flight_number": "HAT211", "date": "2024-05-21", "price": 180},
            ],
            "payment_history": [{"payment_id": "credit_card_8712001", "amount": 360}],
            "created_at": "2024-05-01T10:00:00",
            "total_baggages": 0,
            "nonfree_baggages": 0,
            "insurance": "yes",
            "status": "confirmed",
        }
    },
    "flights": {
        "HAT136": {
            "flight_number": "HAT136",
            "origin": "JFK",
            "destination": "ORD",
            "scheduled_departure_time_est": "2024-05-20 12:00:00",
            "scheduled_arrival_time_est": "2024-05-20 14:00:00",
            "dates": {"2024-05-20": {"status": "available", "available_seats": {"basic_economy": 5, "economy": 5, "business": 2}, "prices": {"basic_economy": 100, "economy": 125, "business": 300}}},
        },
        "HAT039": {
            "flight_number": "HAT039",
            "origin": "ORD",
            "destination": "SEA",
            "scheduled_departure_time_est": "2024-05-20 15:00:00",
            "scheduled_arrival_time_est": "2024-05-20 18:00:00",
            "dates": {"2024-05-20": {"status": "available", "available_seats": {"basic_economy": 5, "economy": 5, "business": 2}, "prices": {"basic_economy": 110, "economy": 130, "business": 320}}},
        },
    },
}


def load_data() -> dict[str, Any]:
    return deepcopy(_DATA)
