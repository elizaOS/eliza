"""Trust system type definitions.

Ported from plugin-trust TypeScript sources. Defines the core data structures
for multi-dimensional trust scoring, evidence tracking, and security events.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from elizaos.types.primitives import UUID

# ---------------------------------------------------------------------------
# Trust Dimensions
# ---------------------------------------------------------------------------


@dataclass
class TrustDimensions:
    """Core trust dimensions based on interpersonal trust theory.

    Each dimension is scored 0-100.
    """

    reliability: float = 50.0
    """Consistency in behavior and promise keeping."""

    competence: float = 50.0
    """Ability to perform tasks and provide value."""

    integrity: float = 50.0
    """Adherence to ethical principles."""

    benevolence: float = 50.0
    """Good intentions towards others."""

    transparency: float = 50.0
    """Open and honest communication."""


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class TrustEvidenceType(StrEnum):
    """Evidence types that impact trust scores."""

    # Positive
    PROMISE_KEPT = "PROMISE_KEPT"
    HELPFUL_ACTION = "HELPFUL_ACTION"
    CONSISTENT_BEHAVIOR = "CONSISTENT_BEHAVIOR"
    VERIFIED_IDENTITY = "VERIFIED_IDENTITY"
    COMMUNITY_CONTRIBUTION = "COMMUNITY_CONTRIBUTION"
    SUCCESSFUL_TRANSACTION = "SUCCESSFUL_TRANSACTION"

    # Negative
    PROMISE_BROKEN = "PROMISE_BROKEN"
    HARMFUL_ACTION = "HARMFUL_ACTION"
    INCONSISTENT_BEHAVIOR = "INCONSISTENT_BEHAVIOR"
    SUSPICIOUS_ACTIVITY = "SUSPICIOUS_ACTIVITY"
    FAILED_VERIFICATION = "FAILED_VERIFICATION"
    SPAM_BEHAVIOR = "SPAM_BEHAVIOR"
    SECURITY_VIOLATION = "SECURITY_VIOLATION"

    # Neutral
    IDENTITY_CHANGE = "IDENTITY_CHANGE"
    ROLE_CHANGE = "ROLE_CHANGE"
    CONTEXT_SWITCH = "CONTEXT_SWITCH"


class SecurityEventType(StrEnum):
    """Types of security events detected by the security module."""

    PROMPT_INJECTION_ATTEMPT = "prompt_injection_attempt"
    SOCIAL_ENGINEERING_ATTEMPT = "social_engineering_attempt"
    PRIVILEGE_ESCALATION_ATTEMPT = "privilege_escalation_attempt"
    ANOMALOUS_REQUEST = "anomalous_request"
    TRUST_MANIPULATION = "trust_manipulation"
    IDENTITY_SPOOFING = "identity_spoofing"
    MULTI_ACCOUNT_ABUSE = "multi_account_abuse"
    CREDENTIAL_THEFT_ATTEMPT = "credential_theft_attempt"
    PHISHING_ATTEMPT = "phishing_attempt"
    IMPERSONATION_ATTEMPT = "impersonation_attempt"
    COORDINATED_ATTACK = "coordinated_attack"
    MALICIOUS_LINK_CAMPAIGN = "malicious_link_campaign"


class TrustTrendDirection(StrEnum):
    INCREASING = "increasing"
    DECREASING = "decreasing"
    STABLE = "stable"


class SecurityCheckType(StrEnum):
    PROMPT_INJECTION = "prompt_injection"
    SOCIAL_ENGINEERING = "social_engineering"
    CREDENTIAL_THEFT = "credential_theft"
    ANOMALY = "anomaly"
    NONE = "none"


class SecuritySeverity(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class SecurityActionResponse(StrEnum):
    BLOCK = "block"
    REQUIRE_VERIFICATION = "require_verification"
    ALLOW = "allow"
    LOG_ONLY = "log_only"


# ---------------------------------------------------------------------------
# Trust data classes
# ---------------------------------------------------------------------------


@dataclass
class TrustContext:
    """Context for trust calculations."""

    evaluator_id: UUID
    world_id: UUID | None = None
    room_id: UUID | None = None
    platform: str | None = None
    action: str | None = None
    time_window: tuple[float, float] | None = None
    """(start_timestamp, end_timestamp) for evidence consideration."""


@dataclass
class TrustEvidence:
    """A piece of evidence that affects trust."""

    type: TrustEvidenceType
    timestamp: float
    impact: float
    """Impact on trust score (-100 to +100)."""
    weight: float
    """Weight/importance of this evidence (0-1)."""
    description: str
    reported_by: UUID
    target_entity_id: UUID
    evaluator_id: UUID
    verified: bool = False
    context: TrustContext | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TrustTrend:
    """Trust trend over time."""

    direction: TrustTrendDirection = TrustTrendDirection.STABLE
    change_rate: float = 0.0
    """Points per day."""
    last_change_at: float = 0.0


@dataclass
class TrustProfile:
    """Trust profile for an entity."""

    entity_id: UUID
    dimensions: TrustDimensions
    overall_trust: float
    confidence: float
    """Confidence in the trust score (0-1)."""
    interaction_count: int
    evidence: list[TrustEvidence]
    last_calculated: float
    calculation_method: str
    trend: TrustTrend
    evaluator_id: UUID


@dataclass
class TrustRequirements:
    """Configuration for trust requirements."""

    minimum_trust: float
    dimensions: dict[str, float] | None = None
    """Required dimension scores (key = dimension name)."""
    required_evidence: list[TrustEvidenceType] | None = None
    minimum_interactions: int | None = None
    minimum_confidence: float | None = None


@dataclass
class TrustDecision:
    """Result of a trust-based decision."""

    allowed: bool
    trust_score: float
    required_score: float
    dimensions_checked: TrustDimensions | dict[str, float]
    reason: str
    suggestions: list[str] | None = None


@dataclass
class TrustInteraction:
    """Trust interaction to be recorded."""

    source_entity_id: UUID
    target_entity_id: UUID
    type: TrustEvidenceType
    timestamp: float
    impact: float
    details: dict[str, Any] | None = None
    context: TrustContext | None = None


@dataclass
class TrustCalculationConfig:
    """Trust calculation configuration."""

    recency_bias: float = 0.7
    """How much recent evidence is weighted vs old (0-1)."""
    evidence_decay_rate: float = 0.5
    """Points per day."""
    minimum_evidence_count: int = 3
    verification_multiplier: float = 1.5
    dimension_weights: TrustDimensions = field(
        default_factory=lambda: TrustDimensions(
            reliability=0.25,
            competence=0.20,
            integrity=0.25,
            benevolence=0.20,
            transparency=0.10,
        )
    )


# ---------------------------------------------------------------------------
# Security data classes
# ---------------------------------------------------------------------------


@dataclass
class PermissionContext:
    """Context for permission evaluation."""

    world_id: UUID | None = None
    room_id: UUID | None = None
    platform: str | None = None
    server_id: str | None = None
    channel_id: str | None = None
    timestamp: float | None = None


@dataclass
class SecurityContext(PermissionContext):
    """Extended security context."""

    entity_id: UUID | None = None
    requested_action: str | None = None
    message_history: list[str] | None = None


@dataclass
class SecurityCheck:
    """Result of a security check."""

    detected: bool
    confidence: float
    type: SecurityCheckType
    severity: SecuritySeverity
    action: SecurityActionResponse
    details: str | None = None


@dataclass
class ThreatAssessment(SecurityCheck):
    """Extended security check with recommendation."""

    recommendation: str | None = None


@dataclass
class SecurityEvent:
    """A security event."""

    type: SecurityEventType
    entity_id: UUID
    severity: SecuritySeverity
    context: PermissionContext
    details: dict[str, Any]
    id: UUID | None = None
    timestamp: float | None = None
    handled: bool = False


@dataclass
class SecurityMessage:
    """A message for security analysis."""

    id: UUID
    entity_id: UUID
    content: str
    timestamp: float
    room_id: UUID | None = None
    reply_to: UUID | None = None


@dataclass
class SecurityAction:
    """An action for security tracking."""

    id: UUID
    entity_id: UUID
    type: str
    timestamp: float
    target: str | None = None
    result: str | None = None
