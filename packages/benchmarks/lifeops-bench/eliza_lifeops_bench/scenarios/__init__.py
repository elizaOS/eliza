"""LifeOpsBench scenario registry.

Hand-authored scenarios are organized one module per Domain. Each
module exports a single ``<DOMAIN>_SCENARIOS`` list. This module
aggregates them into the public ``ALL_SCENARIOS`` registry plus the
two index dicts.

The two original smoke scenarios (``smoke_static_calendar_01`` and
``smoke_live_mail_01``) are kept at the front of the list for back-compat
with the scaffold test that imports them by id.
"""

from __future__ import annotations

from ..types import Domain, Scenario
from ._smoke_scenarios import SMOKE_SCENARIOS
from .calendar import CALENDAR_SCENARIOS
from .contacts import CONTACTS_SCENARIOS
from .finance import FINANCE_SCENARIOS
from .focus import FOCUS_SCENARIOS
from .health import HEALTH_SCENARIOS
from .mail import MAIL_SCENARIOS
from .messages import MESSAGES_SCENARIOS
from .reminders import REMINDERS_SCENARIOS
from .sleep import SLEEP_SCENARIOS
from .travel import TRAVEL_SCENARIOS

ALL_SCENARIOS: list[Scenario] = [
    *SMOKE_SCENARIOS,
    *CALENDAR_SCENARIOS,
    *MAIL_SCENARIOS,
    *MESSAGES_SCENARIOS,
    *CONTACTS_SCENARIOS,
    *REMINDERS_SCENARIOS,
    *FINANCE_SCENARIOS,
    *TRAVEL_SCENARIOS,
    *HEALTH_SCENARIOS,
    *SLEEP_SCENARIOS,
    *FOCUS_SCENARIOS,
]

SCENARIOS_BY_ID: dict[str, Scenario] = {s.id: s for s in ALL_SCENARIOS}

SCENARIOS_BY_DOMAIN: dict[Domain, list[Scenario]] = {}
for _scenario in ALL_SCENARIOS:
    SCENARIOS_BY_DOMAIN.setdefault(_scenario.domain, []).append(_scenario)

__all__ = [
    "ALL_SCENARIOS",
    "CALENDAR_SCENARIOS",
    "CONTACTS_SCENARIOS",
    "FINANCE_SCENARIOS",
    "FOCUS_SCENARIOS",
    "HEALTH_SCENARIOS",
    "MAIL_SCENARIOS",
    "MESSAGES_SCENARIOS",
    "REMINDERS_SCENARIOS",
    "SCENARIOS_BY_DOMAIN",
    "SCENARIOS_BY_ID",
    "SLEEP_SCENARIOS",
    "SMOKE_SCENARIOS",
    "TRAVEL_SCENARIOS",
]
