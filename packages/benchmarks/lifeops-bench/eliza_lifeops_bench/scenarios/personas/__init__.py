"""Issue #12186 persona scenario packs.

Five persona axes, each a 30-static + 18-live = 48-scenario pack built
programmatically from ``_persona_specs.py`` (mirrors the proven
``scenarios/expanded`` builder). Total: **240** new base scenarios.

Splice into the corpus via ``scenarios/__init__.py`` (``PERSONA_SCENARIOS``
is added to ``CORE_SCENARIOS``).
"""

from __future__ import annotations

from ...types import Scenario
from ._persona_specs import PERSONA_AREA_SPECS, build_persona_area
from .schema_check import check_action_shape, check_scenario_actions

ADHD_SCENARIOS: list[Scenario] = build_persona_area(PERSONA_AREA_SPECS[0])
NIGHT_OWL_SCENARIOS: list[Scenario] = build_persona_area(PERSONA_AREA_SPECS[1])
TRAVEL_SCENARIOS: list[Scenario] = build_persona_area(PERSONA_AREA_SPECS[2])
HIGH_COMMS_SCENARIOS: list[Scenario] = build_persona_area(PERSONA_AREA_SPECS[3])
LOW_ENERGY_SCENARIOS: list[Scenario] = build_persona_area(PERSONA_AREA_SPECS[4])

PERSONA_SCENARIOS: list[Scenario] = [
    *ADHD_SCENARIOS,
    *NIGHT_OWL_SCENARIOS,
    *TRAVEL_SCENARIOS,
    *HIGH_COMMS_SCENARIOS,
    *LOW_ENERGY_SCENARIOS,
]

__all__ = [
    "ADHD_SCENARIOS",
    "HIGH_COMMS_SCENARIOS",
    "LOW_ENERGY_SCENARIOS",
    "NIGHT_OWL_SCENARIOS",
    "PERSONA_SCENARIOS",
    "TRAVEL_SCENARIOS",
    "check_action_shape",
    "check_scenario_actions",
]
