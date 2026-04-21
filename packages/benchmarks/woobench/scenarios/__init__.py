"""WooBench scenario definitions — pre-built branching conversation trees.

Each scenario pairs a persona archetype with a divination system and defines
a ResponseTree that drives the evaluator's branching conversation logic.
"""

from .tarot_scenarios import TAROT_SCENARIOS
from .iching_scenarios import ICHING_SCENARIOS
from .astrology_scenarios import ASTROLOGY_SCENARIOS

ALL_SCENARIOS = TAROT_SCENARIOS + ICHING_SCENARIOS + ASTROLOGY_SCENARIOS

SCENARIOS_BY_ID = {s.id: s for s in ALL_SCENARIOS}

SCENARIOS_BY_SYSTEM = {
    "tarot": TAROT_SCENARIOS,
    "iching": ICHING_SCENARIOS,
    "astrology": ASTROLOGY_SCENARIOS,
}

SCENARIOS_BY_ARCHETYPE: dict[str, list] = {}
for _scenario in ALL_SCENARIOS:
    _key = _scenario.persona.archetype.value
    SCENARIOS_BY_ARCHETYPE.setdefault(_key, []).append(_scenario)

__all__ = [
    "ALL_SCENARIOS",
    "SCENARIOS_BY_ID",
    "SCENARIOS_BY_SYSTEM",
    "SCENARIOS_BY_ARCHETYPE",
    "TAROT_SCENARIOS",
    "ICHING_SCENARIOS",
    "ASTROLOGY_SCENARIOS",
]
