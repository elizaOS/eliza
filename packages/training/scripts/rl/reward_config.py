"""
Reward Configuration Loader

Loads reward weight configurations from YAML config file.
This allows experimentation with different weight distributions
without code changes.
"""

from pathlib import Path
from typing import Optional

import yaml

# Find the config directory relative to this file
_CURRENT_DIR = Path(__file__).parent
_CONFIG_DIR = _CURRENT_DIR.parent.parent.parent / "config"
_WEIGHTS_FILE = _CONFIG_DIR / "reward_weights.yaml"


# Default weights if config file not found
DEFAULT_WEIGHTS: dict[str, float] = {
    "regime_pnl": 0.35,
    "skill_alpha": 0.20,
    "temporal_bonus": 0.05,
    "format": 0.15,
    "reasoning": 0.10,
    "behavior": 0.15,
    "anti_scam": 0.0,
    "offensive_scam": 0.0,
    "social_capital": 0.0,
    "information_sale": 0.0,
    "trade_quality": 0.0,
    "unsafe_disclosure_penalty": 0.0,
    "group_chat_intel": 0.0,
    "context_efficiency": 0.0,
    "working_memory": 0.0,
}

DEFAULT_LEGACY_WEIGHTS: dict[str, float] = {
    "pnl": 0.55,
    "format": 0.20,
    "reasoning": 0.15,
    "behavior": 0.10,
}

DEFAULT_REGIME_EXPECTED_RETURNS: dict[str, float] = {
    "bull": 0.05,
    "bear": -0.05,
    "sideways": 0.0,
}

DEFAULT_TEMPORAL_CONFIG: dict[str, float] = {
    "decay_rate": 0.9,
    "min_weight": 0.1,
}


class RewardWeightConfig:
    """Singleton for reward weight configuration loaded from YAML."""

    _instance: Optional["RewardWeightConfig"] = None
    _weights_profiles: dict[str, dict[str, float]]
    _regime_expected_returns: dict[str, float]
    _regime_thresholds: dict[str, float]
    _temporal_config: dict[str, float]
    _volatility_config: dict[str, float]

    def __new__(cls) -> "RewardWeightConfig":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load_config()
        return cls._instance

    def _load_config(self) -> None:
        """Load reward weights from YAML config file."""
        if not _WEIGHTS_FILE.exists():
            self._set_defaults()
            return

        with open(_WEIGHTS_FILE, encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}

        # Load weight profiles
        self._weights_profiles = {}
        for key, value in config.items():
            # Skip non-profile sections
            if key in ("regime_thresholds", "regime_expected_returns", "temporal", "volatility"):
                continue
            if isinstance(value, dict) and ("regime_pnl" in value or "pnl" in value):
                self._weights_profiles[key] = value

        if not self._weights_profiles:
            self._weights_profiles = {"default": DEFAULT_WEIGHTS}

        # Load regime configuration
        self._regime_expected_returns = config.get(
            "regime_expected_returns", DEFAULT_REGIME_EXPECTED_RETURNS
        )
        self._regime_thresholds = config.get("regime_thresholds", {"bull": 0.05, "bear": -0.05})

        # Load temporal configuration
        self._temporal_config = config.get("temporal", DEFAULT_TEMPORAL_CONFIG)

        # Load volatility configuration
        self._volatility_config = config.get(
            "volatility",
            {
                "low": 2.0,
                "high": 15.0,
                "dampening_factor": 0.5,
            },
        )

    def _set_defaults(self) -> None:
        """Set default values when config file is not found."""
        self._weights_profiles = {
            "default": DEFAULT_WEIGHTS,
            "legacy": DEFAULT_LEGACY_WEIGHTS,
        }
        self._regime_expected_returns = DEFAULT_REGIME_EXPECTED_RETURNS
        self._regime_thresholds = {"bull": 0.05, "bear": -0.05}
        self._temporal_config = DEFAULT_TEMPORAL_CONFIG
        self._volatility_config = {
            "low": 2.0,
            "high": 15.0,
            "dampening_factor": 0.5,
        }

    def get_weights(self, profile: str = "default") -> dict[str, float]:
        """
        Get reward weights for a profile.

        Args:
            profile: Name of the weight profile (e.g., "default", "skill_focused")

        Returns:
            Dictionary mapping component names to weights
        """
        return self._weights_profiles.get(
            profile, self._weights_profiles.get("default", DEFAULT_WEIGHTS)
        )

    def get_regime_expected_return(self, regime: str) -> float:
        """
        Get expected return for a market regime.

        Args:
            regime: Market regime ("bull", "bear", "sideways")

        Returns:
            Expected return as decimal (e.g., 0.05 for +5%)
        """
        return self._regime_expected_returns.get(regime.lower(), 0.0)

    def get_regime_thresholds(self) -> dict[str, float]:
        """Get regime classification thresholds."""
        return self._regime_thresholds.copy()

    def get_temporal_decay_rate(self) -> float:
        """Get temporal credit decay rate."""
        return self._temporal_config.get("decay_rate", 0.9)

    def get_temporal_min_weight(self) -> float:
        """Get minimum temporal credit weight."""
        return self._temporal_config.get("min_weight", 0.1)

    def get_volatility_config(self) -> dict[str, float]:
        """Get volatility configuration."""
        return self._volatility_config.copy()

    @property
    def available_profiles(self) -> list:
        """List available weight profiles."""
        return list(self._weights_profiles.keys())


# Module-level convenience functions


def get_reward_weights(profile: str = "default") -> dict[str, float]:
    """Get reward weights for a profile."""
    return RewardWeightConfig().get_weights(profile)


def get_regime_expected_return(regime: str) -> float:
    """Get expected return for a market regime."""
    return RewardWeightConfig().get_regime_expected_return(regime)


def get_temporal_decay_rate() -> float:
    """Get temporal credit decay rate."""
    return RewardWeightConfig().get_temporal_decay_rate()


def list_weight_profiles() -> list:
    """List available weight profiles."""
    return RewardWeightConfig().available_profiles


def blend_weight_profiles(
    primary_profile: str,
    secondary_profiles: list[str] | None = None,
    secondary_ratio: float = 0.2,
) -> dict[str, float]:
    """
    Blend a primary weight profile with one or more secondary profiles.

    This supports GRPO-style reward mixing across objectives.
    """
    primary = get_reward_weights(primary_profile).copy()
    if not secondary_profiles:
        return primary

    mix = max(0.0, min(1.0, secondary_ratio))
    secondary_weights = [get_reward_weights(profile) for profile in secondary_profiles]
    if not secondary_weights:
        return primary

    all_keys = set(primary.keys())
    for weights in secondary_weights:
        all_keys.update(weights.keys())

    secondary_mean: dict[str, float] = {}
    for key in all_keys:
        secondary_mean[key] = sum(weights.get(key, 0.0) for weights in secondary_weights) / len(
            secondary_weights
        )

    blended = {
        key: primary.get(key, 0.0) * (1.0 - mix) + secondary_mean.get(key, 0.0) * mix
        for key in all_keys
    }

    total = sum(blended.values())
    if total <= 0:
        return primary

    return {key: value / total for key, value in blended.items()}
