"""Rolodex Benchmark Types — Python equivalent of types.ts.

Entity IDs are opaque (ent_d1, ent_w2, etc). Display names are realistic
handles (d4v3_builds, WhaleAlert42). The handler never sees the canonical
person — only the scorer does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

# ── Ground Truth ─────────────────────────────────


@dataclass(frozen=True)
class WorldEntity:
    """A single entity in the ground-truth world."""

    id: str  # opaque: "ent_d1"
    canonical_person: str  # "dave" — ONLY for scoring
    display_name: str  # what appears in chat: "d4v3_builds"
    platform: str  # "discord" | "twitter" | "telegram"
    platform_handle: str  # "d4v3_builds" or "@chaintrack3r"
    attributes: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class GroundTruthLink:
    """A known cross-platform link between two entities."""

    entity_a: str  # opaque entity ID
    entity_b: str
    difficulty: Literal["easy", "medium", "hard"]
    reason: str
    expected_signals: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AntiLink:
    """Two entities that MUST NOT be merged."""

    entity_a: str
    entity_b: str
    reason: str


@dataclass
class GroundTruthWorld:
    """Full ground-truth world for the benchmark."""

    entities: list[WorldEntity]
    links: list[GroundTruthLink]
    anti_links: list[AntiLink]


# ── Conversations ────────────────────────────────


@dataclass(frozen=True)
class Message:
    """A single message in a conversation."""

    from_entity: str  # opaque entity ID
    display_name: str  # visible handle
    text: str
    platform: str
    room: str


@dataclass(frozen=True)
class ExpectedIdentity:
    """An expected identity extraction."""

    entity_id: str
    platform: str
    handle: str


@dataclass(frozen=True)
class ExpectedRelationship:
    """An expected relationship extraction."""

    entity_a: str
    entity_b: str
    type: str
    sentiment: str


@dataclass(frozen=True)
class ExpectedTrustSignal:
    """An expected trust signal."""

    entity_id: str
    signal: str


@dataclass
class ExpectedExtractions:
    """Expected extractions for a conversation."""

    identities: list[ExpectedIdentity] = field(default_factory=list)
    relationships: list[ExpectedRelationship] = field(default_factory=list)
    trust_signals: list[ExpectedTrustSignal] = field(default_factory=list)


@dataclass
class Conversation:
    """A benchmark conversation with ground truth."""

    id: str
    name: str
    platform: str
    room: str
    messages: list[Message]
    expected: ExpectedExtractions


# ── Handler ──────────────────────────────────────


@dataclass
class IdentityExtraction:
    """An extracted identity."""

    entity_id: str
    platform: str
    handle: str


@dataclass
class RelationshipExtraction:
    """An extracted relationship."""

    entity_a: str
    entity_b: str
    type: str
    sentiment: str


@dataclass
class TrustSignalExtraction:
    """An extracted trust signal."""

    entity_id: str
    signal: str


@dataclass
class Extraction:
    """Result of extracting information from a single conversation."""

    conversation_id: str
    identities: list[IdentityExtraction] = field(default_factory=list)
    relationships: list[RelationshipExtraction] = field(default_factory=list)
    trust_signals: list[TrustSignalExtraction] = field(default_factory=list)
    traces: list[str] = field(default_factory=list)
    wall_time_ms: float = 0.0


@dataclass
class ResolutionLink:
    """A proposed cross-platform link."""

    entity_a: str
    entity_b: str
    confidence: float
    signals: list[str] = field(default_factory=list)


@dataclass
class Resolution:
    """Result of entity resolution across all extractions."""

    links: list[ResolutionLink] = field(default_factory=list)
    traces: list[str] = field(default_factory=list)
    wall_time_ms: float = 0.0


@runtime_checkable
class Handler(Protocol):
    """Interface for benchmark handlers."""

    name: str

    async def setup(self) -> None: ...
    async def teardown(self) -> None: ...
    async def extract(self, conv: Conversation, world: GroundTruthWorld) -> Extraction: ...
    async def resolve(self, extractions: list[Extraction], world: GroundTruthWorld) -> Resolution: ...


# ── Scoring ──────────────────────────────────────


@dataclass
class Metrics:
    """Precision / Recall / F1 metrics."""

    tp: int = 0
    fp: int = 0
    fn: int = 0
    precision: float = 1.0
    recall: float = 1.0
    f1: float = 0.0


@dataclass
class RelationshipMetrics(Metrics):
    """Metrics with relationship-type accuracy."""

    type_accuracy: float = 1.0


@dataclass(frozen=True)
class ItemTrace:
    """Per-item scoring trace."""

    status: Literal["TP", "FP", "FN", "PARTIAL"]
    label: str
    detail: str
