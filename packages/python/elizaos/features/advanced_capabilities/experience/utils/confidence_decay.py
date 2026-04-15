from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.features.advanced_capabilities.experience.types import Experience

# Time constants in milliseconds
_MS_PER_DAY = 24 * 60 * 60 * 1000


@dataclass
class DecayConfig:
    half_life: int = 30 * _MS_PER_DAY  # Time in ms for confidence to decay by half (30 days)
    min_confidence: float = 0.1  # Minimum confidence level (never decays below this)
    decay_start_delay: int = 7 * _MS_PER_DAY  # Time before decay starts (7 day grace period)


_DEFAULT_DECAY_CONFIG = DecayConfig()


class ConfidenceDecayManager:
    """Manages time-based confidence decay for experiences."""

    def __init__(self, config: DecayConfig | None = None) -> None:
        self._config = config or DecayConfig()

    def get_decayed_confidence(self, experience: Experience) -> float:
        """Calculate the decayed confidence for an experience."""
        now = _now_ms()
        age = now - experience.created_at
        specific_config = self.get_domain_specific_decay(experience)

        # No decay during grace period
        if age < specific_config.decay_start_delay:
            return experience.confidence

        # Calculate decay based on half-life
        decay_time = age - specific_config.decay_start_delay
        half_lives = decay_time / specific_config.half_life
        decay_factor = 0.5**half_lives

        # Apply decay but respect minimum
        decayed_confidence = experience.confidence * decay_factor
        return max(specific_config.min_confidence, decayed_confidence)

    def get_experiences_needing_reinforcement(
        self,
        experiences: list[Experience],
        threshold: float = 0.3,
    ) -> list[Experience]:
        """Get experiences that need reinforcement (low confidence due to decay)."""
        return [
            exp
            for exp in experiences
            if self._config.min_confidence < self.get_decayed_confidence(exp) < threshold
        ]

    def calculate_reinforcement_boost(
        self,
        experience: Experience,
        validation_strength: float = 1.0,
    ) -> float:
        """Calculate reinforcement boost when an experience is validated."""
        current_confidence = self.get_decayed_confidence(experience)
        boost = (1 - current_confidence) * validation_strength * 0.5
        return min(1.0, current_confidence + boost)

    def get_domain_specific_decay(self, experience: Experience) -> DecayConfig:
        """Adjust decay rate based on experience type and domain."""
        from elizaos.features.advanced_capabilities.experience.types import ExperienceType

        config = DecayConfig(
            half_life=self._config.half_life,
            min_confidence=self._config.min_confidence,
            decay_start_delay=self._config.decay_start_delay,
        )

        # Facts and discoveries decay slower
        if experience.type in (ExperienceType.DISCOVERY, ExperienceType.LEARNING):
            config.half_life *= 2  # Double the half-life

        # Warnings and corrections decay slower (important to remember)
        if experience.type in (ExperienceType.WARNING, ExperienceType.CORRECTION):
            config.half_life = int(config.half_life * 1.5)
            config.min_confidence = 0.2  # Higher minimum

        # Domain-specific adjustments
        domain = experience.domain
        if domain in ("security", "safety"):
            config.half_life *= 3  # Security lessons decay very slowly
            config.min_confidence = 0.3
        elif domain == "performance":
            config.half_life = int(
                config.half_life * 0.5
            )  # Performance insights may change quickly
        elif domain == "user_preference":
            config.half_life = int(config.half_life * 0.7)  # User preferences can change

        return config

    def get_confidence_trend(
        self,
        experience: Experience,
        points: int = 10,
    ) -> list[dict[str, float]]:
        """Get confidence trend for an experience over time."""
        now = _now_ms()
        total_time = now - experience.created_at
        if total_time <= 0 or points < 2:
            return [{"timestamp": float(now), "confidence": experience.confidence}]

        interval = total_time / (points - 1)
        specific_config = self.get_domain_specific_decay(experience)
        trend: list[dict[str, float]] = []

        for i in range(points):
            timestamp = experience.created_at + interval * i
            age = timestamp - experience.created_at

            if age < specific_config.decay_start_delay:
                confidence = experience.confidence
            else:
                decay_time = age - specific_config.decay_start_delay
                half_lives = decay_time / specific_config.half_life
                decay_factor = 0.5**half_lives
                confidence = max(
                    specific_config.min_confidence,
                    experience.confidence * decay_factor,
                )

            trend.append({"timestamp": timestamp, "confidence": confidence})

        return trend


def _now_ms() -> int:
    """Current time in milliseconds (matching JS Date.now())."""
    return int(time.time() * 1000)
