from __future__ import annotations

from copy import deepcopy
from typing import Any


_DATA: dict[str, Any] = {
    "users": {
        "yusuf_rossi_9620": {
            "name": {"first_name": "Yusuf", "last_name": "Rossi"},
            "email": "yusuf.rossi@example.com",
            "address": {
                "address1": "100 Market St",
                "city": "Philadelphia",
                "state": "PA",
                "zip": "19122",
            },
            "payment_methods": {
                "credit_card_9513926": {
                    "source": "credit_card",
                    "brand": "visa",
                    "last_four": "9513",
                }
            },
            "orders": ["#W2378156"],
        }
    },
    "orders": {
        "#W2378156": {
            "order_id": "#W2378156",
            "user_id": "yusuf_rossi_9620",
            "status": "delivered",
            "items": [
                {
                    "item_id": "1151293680",
                    "product_id": "1656367028",
                    "name": "Mechanical Keyboard",
                    "options": {
                        "switches": "tactile",
                        "backlight": "RGB",
                        "size": "full size",
                    },
                    "price": 89.99,
                },
                {
                    "item_id": "4983901480",
                    "product_id": "4896585277",
                    "name": "Smart Thermostat",
                    "options": {"compatibility": "Apple HomeKit"},
                    "price": 119.99,
                },
            ],
        }
    },
    "products": {
        "1656367028": {
            "product_id": "1656367028",
            "name": "Mechanical Keyboard",
            "variants": {
                "1151293680": {
                    "available": False,
                    "price": 89.99,
                    "options": {
                        "switches": "tactile",
                        "backlight": "RGB",
                        "size": "full size",
                    },
                },
                "7706410293": {
                    "available": True,
                    "price": 94.99,
                    "options": {
                        "switches": "clicky",
                        "backlight": "RGB",
                        "size": "full size",
                    },
                },
            },
        },
        "4896585277": {
            "product_id": "4896585277",
            "name": "Smart Thermostat",
            "variants": {
                "4983901480": {
                    "available": False,
                    "price": 119.99,
                    "options": {"compatibility": "Apple HomeKit"},
                },
                "7747408585": {
                    "available": True,
                    "price": 129.99,
                    "options": {"compatibility": "Google Home"},
                },
            },
        },
    },
}


def load_data() -> dict[str, Any]:
    return deepcopy(_DATA)
