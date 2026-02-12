"""
Rubric Loader - Single Source of Truth

Loads archetype rubrics from the canonical JSON config file.
This eliminates duplication between TypeScript and Python.

Includes versioning for cache invalidation and reproducibility.
"""

import hashlib
import json
from pathlib import Path
from typing import Dict, List, Optional

# Rubric version - increment when rubrics change significantly
# This should match RUBRICS_VERSION in packages/training/src/rubrics/index.ts
RUBRICS_VERSION = "1.0.0"

# Find the config directory relative to this file
_CURRENT_DIR = Path(__file__).parent
_CONFIG_DIR = _CURRENT_DIR.parent.parent.parent / "config"
_RUBRICS_FILE = _CONFIG_DIR / "rubrics.json"


def _normalize(archetype: str) -> str:
    """
    Internal normalization helper - lowercase, stripped, underscores to hyphens.
    This is the single source of truth for normalization logic.
    """
    return archetype.lower().strip().replace("_", "-")


class RubricConfig:
    """Singleton for rubric configuration loaded from JSON."""
    
    _instance: Optional['RubricConfig'] = None
    _rubrics: Dict[str, str]
    _priority_metrics: Dict[str, List[str]]
    _default_rubric: str
    _default_metrics: List[str]
    _available_archetypes: List[str]
    
    def __new__(cls) -> 'RubricConfig':
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load_config()
        return cls._instance
    
    def _load_config(self) -> None:
        """Load rubrics from JSON config file."""
        if not _RUBRICS_FILE.exists():
            # Fallback to defaults if file not found
            self._rubrics = {}
            self._priority_metrics = {}
            self._default_rubric = _get_fallback_default_rubric()
            self._default_metrics = [
                "trading.totalPnL",
                "trading.winRate",
                "behavior.actionSuccessRate",
                "behavior.episodeLength",
            ]
            self._available_archetypes = []
            return
        
        with open(_RUBRICS_FILE, 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        self._rubrics = config.get("rubrics", {})
        self._priority_metrics = config.get("priorityMetrics", {})
        self._default_rubric = config.get("defaults", {}).get("rubric", _get_fallback_default_rubric())
        self._default_metrics = config.get("defaults", {}).get("priorityMetrics", [])
        self._available_archetypes = config.get("availableArchetypes", list(self._rubrics.keys()))
    
    def get_rubric(self, archetype: str) -> str:
        """Get rubric for an archetype."""
        return self._rubrics.get(_normalize(archetype), self._default_rubric)
    
    def get_priority_metrics(self, archetype: str) -> List[str]:
        """Get priority metrics for an archetype."""
        return self._priority_metrics.get(_normalize(archetype), self._default_metrics)
    
    def get_available_archetypes(self) -> List[str]:
        """Get list of all available archetypes."""
        return self._available_archetypes.copy()
    
    def has_custom_rubric(self, archetype: str) -> bool:
        """Check if archetype has a custom rubric."""
        return _normalize(archetype) in self._rubrics
    
    def get_rubric_hash(self, archetype: str) -> str:
        """
        Get content hash for a specific archetype's rubric.
        Used for cache invalidation when rubric content changes.
        """
        rubric = self.get_rubric(archetype)
        return hashlib.sha256(rubric.encode()).hexdigest()[:16]
    
    def get_all_rubrics_hash(self) -> str:
        """
        Get combined hash of all rubrics.
        Used for detecting any rubric changes.
        """
        all_rubrics = "::".join(sorted(self._rubrics.values())) + self._default_rubric
        return hashlib.sha256(all_rubrics.encode()).hexdigest()[:16]
    
    def get_version(self) -> str:
        """Get the current rubrics version."""
        return RUBRICS_VERSION
    
    def reload(self) -> None:
        """Reload configuration from file."""
        self._load_config()


def _get_fallback_default_rubric() -> str:
    """Fallback rubric if config file not found."""
    return """
## General Agent Evaluation

You are evaluating an AI agent's performance in a prediction market simulation.

### Scoring Criteria (0.0 to 1.0)
- **Profitability**: Higher P&L should receive higher scores
- **Risk Management**: Balanced positions and avoiding excessive losses
- **Efficiency**: Achieving goals with fewer actions is better
- **Decision Quality**: Good reasoning and analysis before actions

### Scoring Guidelines
- 0.8-1.0: Excellent performance, consistent profits, good risk management
- 0.6-0.8: Good performance, positive P&L, reasonable decisions
- 0.4-0.6: Average performance, mixed results
- 0.2-0.4: Below average, some losses, questionable decisions
- 0.0-0.2: Poor performance, significant losses, poor decision making

Compare trajectories RELATIVE to each other within this group.
If one trajectory is significantly better, reflect that in score differences.
"""


# Module-level convenience functions
_config = RubricConfig()


def get_rubric(archetype: str) -> str:
    """Get the rubric for an archetype."""
    return _config.get_rubric(archetype)


def get_priority_metrics(archetype: str) -> List[str]:
    """Get priority metrics for an archetype."""
    return _config.get_priority_metrics(archetype)


def get_available_archetypes() -> List[str]:
    """Get list of all available archetypes."""
    return _config.get_available_archetypes()


def has_custom_rubric(archetype: str) -> bool:
    """Check if archetype has a custom rubric."""
    return _config.has_custom_rubric(archetype)


def reload_rubrics() -> None:
    """Reload rubrics from file."""
    _config.reload()


def get_rubric_hash(archetype: str) -> str:
    """Get content hash for a specific archetype's rubric."""
    return _config.get_rubric_hash(archetype)


def get_all_rubrics_hash() -> str:
    """Get combined hash of all rubrics."""
    return _config.get_all_rubrics_hash()


def get_rubrics_version() -> str:
    """Get the current rubrics version."""
    return RUBRICS_VERSION


def normalize_archetype(archetype: Optional[str]) -> str:
    """
    Normalize archetype name to canonical form (lowercase, hyphenated).
    Returns 'default' for None or empty string.
    
    Uses _normalize() internally for the actual transformation.
    """
    if not archetype or not archetype.strip():
        return "default"
    return _normalize(archetype)


# For backwards compatibility, expose DEFAULT_RUBRIC
DEFAULT_RUBRIC = _get_fallback_default_rubric()

