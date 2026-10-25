"""Release admission policies for evaluated training artifacts."""

from .gates import apply_gates, normalize_tier

__all__ = ["apply_gates", "normalize_tier"]
