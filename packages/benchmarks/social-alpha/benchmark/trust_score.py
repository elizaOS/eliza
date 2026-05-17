"""Local trust-score helpers for Social Alpha benchmark runs."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TrustScoreMetrics:
    total_calls: int
    profitable_calls: int
    average_profit: float
    win_rate: float
    sharpe_ratio: float
    alpha: float
    volume_penalty: float
    consistency: float


def calculate_balanced_trust_score(
    metrics: TrustScoreMetrics,
    archetype: str,
    rug_promotions: int,
    good_calls: int,
    total_calls: int,
) -> float:
    """Return a bounded 0-100 trust score without Python Eliza plugin imports."""
    n = max(0, total_calls or metrics.total_calls)
    if n == 0:
        return 50.0

    score = 50.0
    score += (metrics.win_rate - 0.5) * 35.0
    score += max(-30.0, min(30.0, metrics.average_profit)) * 0.45
    score += max(-3.0, min(3.0, metrics.sharpe_ratio)) * 4.0
    score += (max(0.0, min(1.0, metrics.consistency)) - 0.5) * 12.0
    score += min(good_calls, n) * 1.5
    score -= min(rug_promotions, n) * 12.0
    score -= max(0.0, metrics.volume_penalty)

    archetype_adjustments = {
        "alpha_caller": 14.0,
        "solid_trader": 8.0,
        "one_hit_wonder": -6.0,
        "noise_maker": -4.0,
        "degen_gambler": -10.0,
        "fud_artist": -18.0,
        "rug_promoter": -35.0,
        "low_info": -2.0,
    }
    score += archetype_adjustments.get(archetype, 0.0)

    confidence = min(1.0, n / 10.0)
    score = 50.0 * (1.0 - confidence) + score * confidence
    return max(0.0, min(100.0, score))
