"""Type definitions for WooBench benchmark."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class PersonaArchetype(Enum):
    TRUE_BELIEVER = "true_believer"
    SKEPTIC = "skeptic"
    CURIOUS_NEWBIE = "curious_newbie"
    TIME_WASTER = "time_waster"
    SCAMMER = "scammer"
    EMOTIONAL_CRISIS = "emotional_crisis"
    REPEAT_CUSTOMER = "repeat_customer"
    ANTAGONIST = "antagonist"


class ReadingSystem(Enum):
    TAROT = "tarot"
    ICHING = "iching"
    ASTROLOGY = "astrology"
    CROSS_SYSTEM = "cross_system"


class MatchResult(Enum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    NEUTRAL = "neutral"


@dataclass
class BirthData:
    year: int
    month: int
    day: int
    hour: int = 12
    minute: int = 0
    latitude: float = 0.0
    longitude: float = 0.0
    timezone: float = 0.0


@dataclass
class HiddenContext:
    """The real story behind the persona that a good reading should discover."""
    life_situation: str
    key_themes: list[str]
    emotional_state: str
    specific_details: list[str]
    trigger_words: list[str]        # Words that make the persona open up
    resistance_topics: list[str]    # Topics they avoid or deflect


@dataclass
class PaymentExpectation:
    """Expected payment behavior for a scenario."""
    min_acceptable_amount: float
    max_acceptable_amount: float
    expected_free_previews: int     # how many free reveals before payment
    persona_will_pay: bool          # based on payment_willingness threshold


@dataclass
class RevenueResult:
    """Revenue outcome for a scenario."""
    amount_earned: float
    payment_requested: bool
    payment_received: bool
    turns_to_payment: int           # -1 if no payment
    free_reveals_given: int
    scam_resisted: bool             # held firm against free-reading requests


@dataclass
class ResponseNode:
    """A node in the branching conversation tree."""
    id: str
    condition: str                  # Natural language condition for LLM to evaluate
    positive_response: str          # If condition matches hidden context
    negative_response: str          # If it doesn't
    neutral_response: str           # If ambiguous
    points_if_positive: float = 0.0
    points_if_negative: float = 0.0
    follow_up_nodes: list[str] = field(default_factory=list)
    opens_up: bool = False
    disengages: bool = False
    escalates: bool = False


@dataclass
class ResponseTree:
    nodes: list[ResponseNode]
    entry_node_id: str              # Which node to start with


@dataclass
class ScenarioScoring:
    max_score: float
    categories: dict[str, float]    # category_name -> max_points


@dataclass
class Persona:
    id: str
    name: str
    archetype: PersonaArchetype
    background: str
    hidden_context: HiddenContext
    engagement_style: str           # "verbose", "terse", "emotional", "analytical"
    payment_willingness: float      # 0-1
    patience: int                   # max turns before disengaging
    birth_data: Optional[BirthData] = None
    max_payment: float = 5.0        # max USDC they'd pay
    haggle_tendency: float = 0.0    # 0-1


@dataclass
class Scenario:
    id: str
    name: str
    persona: Persona
    system: ReadingSystem
    opening: str                    # Opening message from user
    scoring: ScenarioScoring
    response_tree: ResponseTree
    max_turns: int = 30
    description: str = ""


@dataclass
class TurnEvaluation:
    turn_number: int
    agent_message: str
    persona_response: str
    match_result: MatchResult
    score: float
    node_id: str
    opens_up: bool
    notes: str = ""


@dataclass
class ScenarioResult:
    scenario_id: str
    turns: list[TurnEvaluation]
    total_score: float
    max_possible_score: float
    score_by_category: dict[str, float]
    conversation_length: int
    persona_engaged: bool           # Did persona stay engaged through the end?
    payment_converted: bool         # Did agent successfully monetize?
    crisis_handled: bool            # If crisis persona, was it handled correctly?
    notes: str = ""
    revenue: RevenueResult = field(default_factory=lambda: RevenueResult(0, False, False, -1, 0, True))


@dataclass
class BenchmarkResult:
    scenarios: list[ScenarioResult]
    overall_score: float
    score_by_system: dict[str, float]
    score_by_archetype: dict[str, float]
    revenue_efficiency: float
    engagement_depth: float
    resilience_score: float
    model_name: str
    timestamp: str
    total_revenue: float = 0.0
    scam_resistance_rate: float = 0.0
