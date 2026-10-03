"""Live (dual-agent) LifeOpsBench scenarios.

Each domain module exports ``LIVE_<DOMAIN>_SCENARIOS``. ``ALL_LIVE_SCENARIOS``
aggregates every domain's list. Live scenarios are marked
``mode == ScenarioMode.LIVE``, carry empty ``ground_truth_actions`` (the
LLM-driven judge replaces scripted action checks), and define
``success_criteria`` + ``world_assertions`` that the judge uses as
evidence.

Wave 2B baseline: 15 hand-authored scenarios across all 10 domains. The
framework is ready to scale to 250 by adding more entries to each
domain module — no new plumbing required.
"""

from __future__ import annotations

from ...types import Domain, Scenario
from .adhd_capture import LIVE_ADHD_CAPTURE_SCENARIOS
from .adhd_followthrough import LIVE_ADHD_FOLLOWTHROUGH_SCENARIOS
from .calendar import LIVE_CALENDAR_SCENARIOS
from .comms_flood_triage import LIVE_COMMS_FLOOD_TRIAGE_SCENARIOS
from .contacts import LIVE_CONTACTS_SCENARIOS
from .finance import LIVE_FINANCE_SCENARIOS
from .focus import LIVE_FOCUS_SCENARIOS
from .health import LIVE_HEALTH_SCENARIOS
from .low_activation import LIVE_LOW_ACTIVATION_SCENARIOS
from .mail import LIVE_MAIL_SCENARIOS
from .messages import LIVE_MESSAGES_SCENARIOS
from .neurotypical_control import LIVE_NEUROTYPICAL_CONTROL_SCENARIOS
from .night_owl_anchored_day import LIVE_NIGHT_OWL_ANCHORED_DAY_SCENARIOS
from .reminders import LIVE_REMINDERS_SCENARIOS
from .shift_rotation import LIVE_SHIFT_ROTATION_SCENARIOS
from .sleep import LIVE_SLEEP_SCENARIOS
from .travel import LIVE_TRAVEL_SCENARIOS
from .traveler_timezone import LIVE_TRAVELER_TIMEZONE_SCENARIOS

ALL_LIVE_SCENARIOS: list[Scenario] = [
    *LIVE_ADHD_CAPTURE_SCENARIOS,
    *LIVE_ADHD_FOLLOWTHROUGH_SCENARIOS,
    *LIVE_CALENDAR_SCENARIOS,
    *LIVE_COMMS_FLOOD_TRIAGE_SCENARIOS,
    *LIVE_MAIL_SCENARIOS,
    *LIVE_MESSAGES_SCENARIOS,
    *LIVE_NEUROTYPICAL_CONTROL_SCENARIOS,
    *LIVE_NIGHT_OWL_ANCHORED_DAY_SCENARIOS,
    *LIVE_REMINDERS_SCENARIOS,
    *LIVE_FINANCE_SCENARIOS,
    *LIVE_SHIFT_ROTATION_SCENARIOS,
    *LIVE_TRAVEL_SCENARIOS,
    *LIVE_TRAVELER_TIMEZONE_SCENARIOS,
    *LIVE_LOW_ACTIVATION_SCENARIOS,
    *LIVE_SLEEP_SCENARIOS,
    *LIVE_FOCUS_SCENARIOS,
    *LIVE_HEALTH_SCENARIOS,
    *LIVE_CONTACTS_SCENARIOS,
]

LIVE_SCENARIOS_BY_ID: dict[str, Scenario] = {s.id: s for s in ALL_LIVE_SCENARIOS}

LIVE_SCENARIOS_BY_DOMAIN: dict[Domain, list[Scenario]] = {}
for _scenario in ALL_LIVE_SCENARIOS:
    LIVE_SCENARIOS_BY_DOMAIN.setdefault(_scenario.domain, []).append(_scenario)

__all__ = [
    "ALL_LIVE_SCENARIOS",
    "LIVE_ADHD_CAPTURE_SCENARIOS",
    "LIVE_ADHD_FOLLOWTHROUGH_SCENARIOS",
    "LIVE_CALENDAR_SCENARIOS",
    "LIVE_COMMS_FLOOD_TRIAGE_SCENARIOS",
    "LIVE_CONTACTS_SCENARIOS",
    "LIVE_FINANCE_SCENARIOS",
    "LIVE_FOCUS_SCENARIOS",
    "LIVE_HEALTH_SCENARIOS",
    "LIVE_LOW_ACTIVATION_SCENARIOS",
    "LIVE_MAIL_SCENARIOS",
    "LIVE_MESSAGES_SCENARIOS",
    "LIVE_NEUROTYPICAL_CONTROL_SCENARIOS",
    "LIVE_NIGHT_OWL_ANCHORED_DAY_SCENARIOS",
    "LIVE_REMINDERS_SCENARIOS",
    "LIVE_SCENARIOS_BY_DOMAIN",
    "LIVE_SCENARIOS_BY_ID",
    "LIVE_SHIFT_ROTATION_SCENARIOS",
    "LIVE_SLEEP_SCENARIOS",
    "LIVE_TRAVEL_SCENARIOS",
    "LIVE_TRAVELER_TIMEZONE_SCENARIOS",
]
