"""WooBench persona definitions for mystical reading benchmark scenarios."""

from .true_believer import create_true_believer_tarot
from .skeptic import create_skeptic_tarot
from .curious_newbie import create_curious_newbie_iching
from .time_waster import create_time_waster_tarot
from .scammer import create_scammer_astrology, create_scammer_tarot
from .emotional_crisis import create_emotional_crisis_tarot, create_emotional_crisis_iching
from .repeat_customer import create_repeat_customer_astrology, create_repeat_customer_tarot
from .antagonist import create_antagonist_tarot, create_antagonist_iching

ALL_PERSONAS = [
    create_true_believer_tarot,
    create_skeptic_tarot,
    create_curious_newbie_iching,
    create_time_waster_tarot,
    create_scammer_astrology,
    create_scammer_tarot,
    create_emotional_crisis_tarot,
    create_emotional_crisis_iching,
    create_repeat_customer_astrology,
    create_repeat_customer_tarot,
    create_antagonist_tarot,
    create_antagonist_iching,
]

__all__ = [
    "create_true_believer_tarot",
    "create_skeptic_tarot",
    "create_curious_newbie_iching",
    "create_time_waster_tarot",
    "create_scammer_astrology",
    "create_scammer_tarot",
    "create_emotional_crisis_tarot",
    "create_emotional_crisis_iching",
    "create_repeat_customer_astrology",
    "create_repeat_customer_tarot",
    "create_antagonist_tarot",
    "create_antagonist_iching",
    "ALL_PERSONAS",
]
