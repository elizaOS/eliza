"""Trust engine and security module services.

Ported from plugin-trust TypeScript ``TrustEngine`` and ``SecurityModule``.
Provides multi-dimensional trust scoring, evidence-based evaluation, and
security threat detection.
"""

from __future__ import annotations

import math
import time
from typing import TYPE_CHECKING, ClassVar

from elizaos.types import Service
from elizaos.types.primitives import UUID

from .types import (
    SecurityActionResponse,
    SecurityCheck,
    SecurityCheckType,
    SecurityContext,
    SecurityEvent,
    SecuritySeverity,
    ThreatAssessment,
    TrustCalculationConfig,
    TrustContext,
    TrustDecision,
    TrustDimensions,
    TrustEvidence,
    TrustEvidenceType,
    TrustInteraction,
    TrustProfile,
    TrustRequirements,
    TrustTrend,
    TrustTrendDirection,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


# ---------------------------------------------------------------------------
# Evidence impact mapping
# ---------------------------------------------------------------------------

_EVIDENCE_IMPACT_MAP: dict[TrustEvidenceType, tuple[dict[str, float], float]] = {
    # Positive evidence  ->  (dimension_deltas, base_impact)
    TrustEvidenceType.PROMISE_KEPT: ({"reliability": 15, "integrity": 10}, 10),
    TrustEvidenceType.HELPFUL_ACTION: ({"benevolence": 15, "competence": 10}, 8),
    TrustEvidenceType.CONSISTENT_BEHAVIOR: ({"reliability": 20, "transparency": 10}, 12),
    TrustEvidenceType.VERIFIED_IDENTITY: ({"transparency": 20, "integrity": 10}, 15),
    TrustEvidenceType.COMMUNITY_CONTRIBUTION: ({"benevolence": 20, "competence": 15}, 12),
    TrustEvidenceType.SUCCESSFUL_TRANSACTION: ({"reliability": 15, "competence": 15}, 10),
    # Negative evidence
    TrustEvidenceType.PROMISE_BROKEN: ({"reliability": -25, "integrity": -15}, -15),
    TrustEvidenceType.HARMFUL_ACTION: ({"benevolence": -30, "integrity": -20}, -20),
    TrustEvidenceType.INCONSISTENT_BEHAVIOR: ({"reliability": -20, "transparency": -15}, -12),
    TrustEvidenceType.SUSPICIOUS_ACTIVITY: ({"integrity": -15, "transparency": -20}, -15),
    TrustEvidenceType.FAILED_VERIFICATION: ({"transparency": -25, "integrity": -10}, -10),
    TrustEvidenceType.SPAM_BEHAVIOR: ({"benevolence": -15, "competence": -10}, -10),
    TrustEvidenceType.SECURITY_VIOLATION: ({"integrity": -35, "reliability": -20}, -25),
    # Neutral
    TrustEvidenceType.IDENTITY_CHANGE: ({"transparency": -5}, 0),
    TrustEvidenceType.ROLE_CHANGE: ({}, 0),
    TrustEvidenceType.CONTEXT_SWITCH: ({}, 0),
}

# Action-specific dimension weight overrides
_ACTION_CONTEXT_WEIGHTS: dict[str, dict[str, float]] = {
    "financial": {
        "integrity": 0.35,
        "reliability": 0.3,
        "competence": 0.15,
        "benevolence": 0.1,
        "transparency": 0.1,
    },
    "moderation": {
        "benevolence": 0.3,
        "integrity": 0.25,
        "competence": 0.2,
        "reliability": 0.15,
        "transparency": 0.1,
    },
    "content_creation": {
        "competence": 0.3,
        "integrity": 0.2,
        "reliability": 0.2,
        "benevolence": 0.15,
        "transparency": 0.15,
    },
}

_DIMINISHING_WEIGHTS: tuple[float, ...] = (1.0, 0.75, 0.5, 0.25)
_DIMENSION_SUGGESTIONS: dict[str, list[str]] = {
    "reliability": [
        "Keep your promises and commitments",
        "Be consistent in your actions",
        "Follow through on what you say",
    ],
    "competence": [
        "Demonstrate your skills through helpful contributions",
        "Share valuable knowledge or resources",
        "Complete tasks successfully",
    ],
    "integrity": [
        "Be honest and transparent in your communications",
        "Admit mistakes when they happen",
        "Follow community guidelines consistently",
    ],
    "benevolence": [
        "Help other community members",
        "Show genuine interest in others' wellbeing",
        "Contribute positively to discussions",
    ],
    "transparency": [
        "Be open about your intentions",
        "Share information freely when appropriate",
        "Verify your identity on multiple platforms",
    ],
}


# ---------------------------------------------------------------------------
# TrustEngineService
# ---------------------------------------------------------------------------


class TrustEngineService(Service):
    """Multi-dimensional trust scoring and evidence-based trust evaluation."""

    service_type: ClassVar[str] = "trust_engine"

    def __init__(
        self,
        config: TrustCalculationConfig | None = None,
    ) -> None:
        super().__init__()
        self._config = config or TrustCalculationConfig()
        self._profile_cache: dict[str, TrustProfile] = {}
        self._cache_timeout: float = 5 * 60  # 5 minutes (seconds)
        self._max_interactions: int = 500
        self._interactions: list[TrustInteraction] = []
        self._rate_limits: dict[str, _RateLimitEntry] = {}
        self._max_evidence_per_hour: int = 10

    @property
    def capability_description(self) -> str:
        return "Multi-dimensional trust scoring and evidence-based trust evaluation"

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> TrustEngineService:
        service = cls()
        service._runtime = runtime
        runtime.logger.info(
            "TrustEngine initialized",
            src="service:trust_engine",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        self._profile_cache.clear()
        self._interactions.clear()
        self._rate_limits.clear()
        if self._runtime:
            self._runtime.logger.info("TrustEngine stopped", src="service:trust_engine")

    # ------------------------------------------------------------------
    # Core API
    # ------------------------------------------------------------------

    async def calculate_trust(self, subject_id: UUID, context: TrustContext) -> TrustProfile:
        """Calculate trust profile for an entity."""
        cache_key = f"{context.evaluator_id}-{subject_id}"
        cached = self._profile_cache.get(cache_key)
        if cached and (time.time() - cached.last_calculated) < self._cache_timeout:
            return cached

        evidence = await self._load_evidence(subject_id, context)
        dimensions = self._calculate_dimensions(evidence)

        # Resolve dimension weights
        base_w = self._config.dimension_weights
        overrides = _ACTION_CONTEXT_WEIGHTS.get(context.action) if context.action else None
        if overrides:
            active_weights = TrustDimensions(
                reliability=overrides.get("reliability", base_w.reliability),
                competence=overrides.get("competence", base_w.competence),
                integrity=overrides.get("integrity", base_w.integrity),
                benevolence=overrides.get("benevolence", base_w.benevolence),
                transparency=overrides.get("transparency", base_w.transparency),
            )
        else:
            active_weights = base_w

        overall_trust = self._calculate_overall_trust(dimensions, active_weights)
        confidence = self._calculate_confidence(evidence)
        trend = self._analyze_trend(overall_trust)

        profile = TrustProfile(
            entity_id=subject_id,
            dimensions=dimensions,
            overall_trust=overall_trust,
            confidence=confidence,
            interaction_count=len(evidence),
            evidence=evidence[:100],
            last_calculated=time.time(),
            calculation_method="dimensional_aggregation_v1",
            trend=trend,
            evaluator_id=context.evaluator_id,
        )

        self._profile_cache[cache_key] = profile
        return profile

    async def record_interaction(self, interaction: TrustInteraction) -> None:
        """Record a trust interaction with rate-limiting and diminishing returns."""
        rate_result = self._check_rate_limit(interaction.target_entity_id, interaction.type)
        if not rate_result[0]:
            if self._runtime:
                self._runtime.logger.warn(
                    "Rate limit exceeded, skipping interaction recording",
                    src="service:trust_engine",
                    entity_id=str(interaction.target_entity_id),
                )
            return

        if rate_result[1] < 1.0:
            interaction.impact *= rate_result[1]

        self._interactions.append(interaction)
        if len(self._interactions) > self._max_interactions:
            self._interactions = self._interactions[-self._max_interactions :]

        # Invalidate cache for the affected entity
        keys_to_remove = [
            k for k in self._profile_cache if k.endswith(f"-{interaction.target_entity_id}")
        ]
        for k in keys_to_remove:
            del self._profile_cache[k]

    async def evaluate_trust_decision(
        self,
        entity_id: UUID,
        requirements: TrustRequirements,
        context: TrustContext,
    ) -> TrustDecision:
        """Evaluate if an action is allowed based on trust."""
        profile = await self.calculate_trust(entity_id, context)

        if profile.overall_trust < requirements.minimum_trust:
            return TrustDecision(
                allowed=False,
                trust_score=profile.overall_trust,
                required_score=requirements.minimum_trust,
                dimensions_checked=profile.dimensions,
                reason=(
                    f"Trust score {profile.overall_trust} is below "
                    f"required {requirements.minimum_trust}"
                ),
                suggestions=self._generate_trust_building_suggestions(profile, requirements),
            )

        if requirements.dimensions:
            for dim_name, required in requirements.dimensions.items():
                actual = getattr(profile.dimensions, dim_name, 0)
                if actual < required:
                    return TrustDecision(
                        allowed=False,
                        trust_score=profile.overall_trust,
                        required_score=requirements.minimum_trust,
                        dimensions_checked=requirements.dimensions,
                        reason=f"{dim_name} score {actual} is below required {required}",
                        suggestions=_DIMENSION_SUGGESTIONS.get(dim_name, []),
                    )

        if (
            requirements.minimum_interactions
            and profile.interaction_count < requirements.minimum_interactions
        ):
            return TrustDecision(
                allowed=False,
                trust_score=profile.overall_trust,
                required_score=requirements.minimum_trust,
                dimensions_checked=profile.dimensions,
                reason=(
                    f"Insufficient interactions: {profile.interaction_count} "
                    f"< {requirements.minimum_interactions}"
                ),
                suggestions=["Engage in more interactions to build history"],
            )

        if requirements.minimum_confidence and profile.confidence < requirements.minimum_confidence:
            return TrustDecision(
                allowed=False,
                trust_score=profile.overall_trust,
                required_score=requirements.minimum_trust,
                dimensions_checked=profile.dimensions,
                reason=(
                    f"Trust confidence {profile.confidence} is below "
                    f"required {requirements.minimum_confidence}"
                ),
                suggestions=["More consistent interactions needed to increase confidence"],
            )

        return TrustDecision(
            allowed=True,
            trust_score=profile.overall_trust,
            required_score=requirements.minimum_trust,
            dimensions_checked=profile.dimensions,
            reason="All trust requirements met",
        )

    async def get_recent_interactions(
        self, entity_id: UUID, days_back: int = 10
    ) -> list[TrustInteraction]:
        """Get recent trust interactions for an entity."""
        cutoff = time.time() - days_back * 86400
        return [
            i
            for i in self._interactions
            if (i.source_entity_id == entity_id or i.target_entity_id == entity_id)
            and i.timestamp > cutoff
        ]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _load_evidence(self, entity_id: UUID, context: TrustContext) -> list[TrustEvidence]:
        """Load evidence from in-memory interactions.

        In a production system this would also query the component store and
        database.  For the Python port we aggregate from in-memory interactions.
        """
        evidence: list[TrustEvidence] = []
        for interaction in self._interactions:
            if interaction.target_entity_id != entity_id:
                continue
            if context.time_window:
                if (
                    interaction.timestamp < context.time_window[0]
                    or interaction.timestamp > context.time_window[1]
                ):
                    continue
            impact_info = _EVIDENCE_IMPACT_MAP.get(interaction.type)
            base_impact = impact_info[1] if impact_info else interaction.impact
            evidence.append(
                TrustEvidence(
                    type=interaction.type,
                    timestamp=interaction.timestamp,
                    impact=base_impact,
                    weight=1.0,
                    description=(interaction.details or {}).get("description", ""),
                    reported_by=interaction.source_entity_id,
                    target_entity_id=interaction.target_entity_id,
                    evaluator_id=context.evaluator_id,
                    verified=True,
                    context=context,
                )
            )
        evidence.sort(key=lambda e: e.timestamp, reverse=True)
        return evidence

    def _calculate_dimensions(self, evidence: list[TrustEvidence]) -> TrustDimensions:
        dims = TrustDimensions()
        for ev in evidence:
            impact_info = _EVIDENCE_IMPACT_MAP.get(ev.type)
            if not impact_info:
                continue
            dim_deltas, _ = impact_info
            age_weight = self._calculate_age_weight(ev.timestamp)
            ver_mult = self._config.verification_multiplier if ev.verified else 1.0
            for dim_name, value in dim_deltas.items():
                adjusted = value * ev.weight * age_weight * ver_mult
                current = getattr(dims, dim_name)
                setattr(dims, dim_name, max(0, min(100, current + adjusted)))
        return dims

    def _calculate_overall_trust(
        self, dimensions: TrustDimensions, weights: TrustDimensions
    ) -> float:
        weighted_sum = 0.0
        total_weight = 0.0
        for dim_name in ("reliability", "competence", "integrity", "benevolence", "transparency"):
            val = getattr(dimensions, dim_name)
            w = getattr(weights, dim_name)
            weighted_sum += val * w
            total_weight += w
        return round(weighted_sum / total_weight) if total_weight else 50

    def _calculate_confidence(self, evidence: list[TrustEvidence]) -> float:
        if len(evidence) < self._config.minimum_evidence_count:
            return 0.0
        count_conf = min(1.0, len(evidence) / 20)
        positive = sum(1 for e in evidence if e.impact > 0)
        negative = sum(1 for e in evidence if e.impact < 0)
        consistency = 1 - abs(positive - negative) / max(len(evidence), 1)
        now = time.time()
        recent = sum(1 for e in evidence if now - e.timestamp < 7 * 86400)
        recency_factor = recent / max(len(evidence), 1)
        return count_conf * 0.4 + consistency * 0.3 + recency_factor * 0.3

    def _calculate_age_weight(self, timestamp: float) -> float:
        age_days = (time.time() - timestamp) / 86400
        decay = math.exp(-self._config.evidence_decay_rate * age_days)
        return self._config.recency_bias * decay + (1 - self._config.recency_bias) * 0.5

    def _analyze_trend(self, current_score: float) -> TrustTrend:
        """Simplified trend analysis from in-memory data."""
        return TrustTrend(
            direction=TrustTrendDirection.STABLE,
            change_rate=0.0,
            last_change_at=time.time(),
        )

    def _check_rate_limit(
        self, entity_id: UUID, evidence_type: TrustEvidenceType
    ) -> tuple[bool, float]:
        now = time.time()
        hour_s = 3600.0
        key = str(entity_id)
        entry = self._rate_limits.get(key)
        if not entry:
            entry = _RateLimitEntry(count=0, window_start=now, type_history={})
            self._rate_limits[key] = entry

        if now - entry.window_start > hour_s:
            entry.count = 0
            entry.window_start = now
            entry.type_history.clear()
            # Prune stale entries
            stale = [k for k, v in self._rate_limits.items() if now - v.window_start > hour_s * 2]
            for k in stale:
                del self._rate_limits[k]

        if entry.count >= self._max_evidence_per_hour:
            return (False, 0.0)

        type_count = entry.type_history.get(evidence_type, 0)
        weight = _DIMINISHING_WEIGHTS[min(type_count, len(_DIMINISHING_WEIGHTS) - 1)]

        entry.count += 1
        entry.type_history[evidence_type] = type_count + 1
        return (True, weight)

    def _generate_trust_building_suggestions(
        self, profile: TrustProfile, requirements: TrustRequirements
    ) -> list[str]:
        suggestions: list[str] = []
        if profile.overall_trust < requirements.minimum_trust:
            gap = requirements.minimum_trust - profile.overall_trust
            suggestions.append(f"Build {gap:.0f} more trust points through positive interactions")
        weakest = min(
            ("reliability", "competence", "integrity", "benevolence", "transparency"),
            key=lambda d: getattr(profile.dimensions, d),
        )
        suggestions.extend(_DIMENSION_SUGGESTIONS.get(weakest, []))
        if profile.interaction_count < 10:
            suggestions.append("Engage in more conversations and activities")
        return suggestions


# ---------------------------------------------------------------------------
# Internal rate-limit entry
# ---------------------------------------------------------------------------


class _RateLimitEntry:
    __slots__ = ("count", "window_start", "type_history")

    def __init__(
        self,
        count: int,
        window_start: float,
        type_history: dict[TrustEvidenceType, int],
    ) -> None:
        self.count = count
        self.window_start = window_start
        self.type_history = type_history


# ---------------------------------------------------------------------------
# SecurityModuleService
# ---------------------------------------------------------------------------


class SecurityModuleService(Service):
    """Security threat detection and trust-based security analysis."""

    service_type: ClassVar[str] = "security_module"

    def __init__(self) -> None:
        super().__init__()
        self._trust_engine: TrustEngineService | None = None
        self._events: list[SecurityEvent] = []
        self._max_events: int = 1000

    @property
    def capability_description(self) -> str:
        return "Security threat detection and trust-based security analysis"

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> SecurityModuleService:
        service = cls()
        service._runtime = runtime
        runtime.logger.info(
            "SecurityModule initialized",
            src="service:security_module",
            agentId=str(runtime.agent_id),
        )
        return service

    async def stop(self) -> None:
        self._events.clear()
        if self._runtime:
            self._runtime.logger.info("SecurityModule stopped", src="service:security_module")

    def set_trust_engine(self, engine: TrustEngineService) -> None:
        """Link the trust engine (called during plugin init)."""
        self._trust_engine = engine

    # ------------------------------------------------------------------
    # Detection methods
    # ------------------------------------------------------------------

    async def detect_prompt_injection(
        self, content: str, context: SecurityContext
    ) -> SecurityCheck:
        """Detect prompt injection attempts in message content."""
        injection_patterns = [
            "ignore previous instructions",
            "ignore all prior",
            "disregard above",
            "system prompt",
            "you are now",
            "new instructions",
            "override",
            "jailbreak",
        ]
        content_lower = content.lower()
        matches = [p for p in injection_patterns if p in content_lower]
        if matches:
            confidence = min(1.0, len(matches) * 0.3 + 0.2)
            return SecurityCheck(
                detected=True,
                confidence=confidence,
                type=SecurityCheckType.PROMPT_INJECTION,
                severity=(
                    SecuritySeverity.CRITICAL
                    if confidence > 0.7
                    else SecuritySeverity.HIGH
                    if confidence > 0.4
                    else SecuritySeverity.MEDIUM
                ),
                action=(
                    SecurityActionResponse.BLOCK
                    if confidence > 0.7
                    else SecurityActionResponse.REQUIRE_VERIFICATION
                ),
                details=f"Detected injection patterns: {', '.join(matches)}",
            )
        return SecurityCheck(
            detected=False,
            confidence=0.0,
            type=SecurityCheckType.NONE,
            severity=SecuritySeverity.LOW,
            action=SecurityActionResponse.ALLOW,
        )

    async def assess_threat_level(self, context: SecurityContext) -> ThreatAssessment:
        """Assess overall threat level for a security context."""
        recent_events = (
            [
                e
                for e in self._events
                if e.entity_id == context.entity_id and (e.timestamp or 0) > time.time() - 3600
            ]
            if context.entity_id
            else []
        )

        if len(recent_events) >= 5:
            return ThreatAssessment(
                detected=True,
                confidence=0.8,
                type=SecurityCheckType.ANOMALY,
                severity=SecuritySeverity.HIGH,
                action=SecurityActionResponse.BLOCK,
                recommendation="Multiple security events detected. Consider blocking entity.",
            )
        if len(recent_events) >= 2:
            return ThreatAssessment(
                detected=True,
                confidence=0.5,
                type=SecurityCheckType.ANOMALY,
                severity=SecuritySeverity.MEDIUM,
                action=SecurityActionResponse.REQUIRE_VERIFICATION,
                recommendation="Elevated security events. Require additional verification.",
            )
        return ThreatAssessment(
            detected=False,
            confidence=0.0,
            type=SecurityCheckType.NONE,
            severity=SecuritySeverity.LOW,
            action=SecurityActionResponse.ALLOW,
            recommendation="No significant threats detected.",
        )

    async def log_security_event(self, event: SecurityEvent) -> None:
        """Log a security event."""
        if event.timestamp is None:
            event.timestamp = time.time()
        self._events.append(event)
        if len(self._events) > self._max_events:
            self._events = self._events[-self._max_events :]

    async def get_recent_security_events(
        self, room_id: UUID | None = None, hours: float = 24
    ) -> list[SecurityEvent]:
        """Get recent security incidents."""
        cutoff = time.time() - hours * 3600
        events = [e for e in self._events if (e.timestamp or 0) > cutoff]
        if room_id:
            events = [e for e in events if e.context.room_id == room_id]
        return events

    def get_security_recommendations(self, threat_level: float) -> list[str]:
        """Get security recommendations based on threat level."""
        if threat_level >= 80:
            return [
                "Immediately restrict entity access",
                "Enable enhanced monitoring",
                "Review recent interactions for suspicious patterns",
                "Consider temporary ban",
            ]
        if threat_level >= 50:
            return [
                "Increase monitoring frequency",
                "Require verification for sensitive actions",
                "Review entity's trust profile",
            ]
        if threat_level >= 20:
            return [
                "Continue standard monitoring",
                "Log interactions for future reference",
            ]
        return ["No action needed. Standard security measures sufficient."]
