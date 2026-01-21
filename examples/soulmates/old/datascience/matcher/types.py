from __future__ import annotations

from typing import Dict, List, Literal, Tuple, TypedDict, Union

Domain = Literal["dating", "business", "friendship"]
Role = Literal["agent", "user"]
City = Literal["San Francisco", "New York"]
Build = Literal["thin", "fit", "average", "above_average", "overweight"]

LifeGoalIntent = Literal["yes", "no", "open", "unsure"]
KidsIntent = Literal["yes", "no", "open", "unsure"]
KidsTimeline = Literal["soon", "later", "unsure"]

LoveNeed = Literal["touch", "words", "time", "acts", "gifts", "texting"]
TextingFrequency = Literal["low", "medium", "high", "unsure"]

MonogamyPref = Literal["yes", "no", "flexible", "unsure"]
LibidoLevel = Literal["low", "medium", "high", "unsure"]

IntellectStyle = Literal["academic", "creative", "practical", "balanced", "unsure"]
CuriosityLevel = Literal["low", "medium", "high", "unsure"]

ConflictStyle = Literal["avoidant", "direct", "collaborative", "unsure"]
OpennessLevel = Literal["low", "medium", "high", "unsure"]
ReassuranceNeed = Literal["low", "medium", "high", "unsure"]

Belief = Literal["religious", "spiritual", "agnostic", "atheist", "unsure"]
PracticeLevel = Literal["low", "medium", "high", "unsure"]

SpenderSaver = Literal["spender", "balanced", "saver", "unsure"]
RiskTolerance = Literal["low", "medium", "high", "unsure"]
DebtComfort = Literal["low", "medium", "high", "unsure"]


class Appearance(TypedDict, total=False):
    attractiveness: int  # 1-10
    build: Build
    hairColor: str
    eyeColor: str
    skinTone: int  # 1-10
    ethnicity: str
    perceivedGender: int  # 1-10 (1=masculine, 10=feminine)
    distinctiveFeatures: List[str]


class Location(TypedDict):
    city: str
    neighborhood: str
    country: str


class Required(TypedDict):
    name: str
    age: int
    location: Location


JSONValue = Union[str, int, float, bool, List[str]]


class Evidence(TypedDict):
    conversationId: str
    turnIds: List[str]


class Fact(TypedDict):
    factId: str
    type: str
    key: str
    value: JSONValue
    confidence: float
    evidence: Evidence


class Turn(TypedDict):
    turnId: str
    role: Role
    text: str


class Conversation(TypedDict):
    conversationId: str
    scenario: str
    turns: List[Turn]


class LifeGoals(TypedDict, total=False):
    marriageIntent: LifeGoalIntent
    kidsIntent: KidsIntent
    kidsTimeline: KidsTimeline
    mustMatch: bool
    importance: int  # 1-10


class LoveNeeds(TypedDict, total=False):
    primaryNeeds: List[LoveNeed]
    textingFrequency: TextingFrequency
    mustMatch: bool
    importance: int  # 1-10


class SexualPreferences(TypedDict, total=False):
    monogamy: MonogamyPref
    libido: LibidoLevel
    preferences: List[str]
    mustMatch: bool
    importance: int  # 1-10


class IntellectPreferences(TypedDict, total=False):
    intellectStyle: IntellectStyle
    curiosityLevel: CuriosityLevel
    cultureTags: List[str]
    importance: int  # 1-10


class CommunicationPreferences(TypedDict, total=False):
    conflictStyle: ConflictStyle
    emotionalOpenness: OpennessLevel
    reassuranceNeed: ReassuranceNeed
    importance: int  # 1-10


class ReligionPreferences(TypedDict, total=False):
    belief: Belief
    practice: PracticeLevel
    mustMatch: bool
    importance: int  # 1-10


class FinancePreferences(TypedDict, total=False):
    spenderSaver: SpenderSaver
    riskTolerance: RiskTolerance
    debtComfort: DebtComfort
    mustMatch: bool
    importance: int  # 1-10


class Persona(TypedDict):
    id: str
    domain: Domain
    required: Required
    optional: Dict[str, object]
    conversations: List[Conversation]
    facts: List[Fact]


class MatchEntry(TypedDict):
    otherId: str
    score: int


class MatchMatrix(TypedDict):
    domain: Domain
    personaIds: List[str]
    scores: Dict[str, Dict[str, int]]
    topMatches: Dict[str, List[MatchEntry]]
    worstMatches: Dict[str, List[MatchEntry]]


class BenchmarkPair(TypedDict):
    a: str
    b: str
    expectedScoreRange: List[int]
    reason: str


class Benchmarks(TypedDict):
    domain: Domain
    description: str
    goodPairs: List[BenchmarkPair]
    badPairs: List[BenchmarkPair]
