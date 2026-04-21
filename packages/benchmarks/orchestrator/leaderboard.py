from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HighScore:
    label: str
    value: float


# Curated high-score references from benchmark-local leaderboard constants.
# Values are intentionally scalarized to the best comparable primary metric
# per benchmark for cross-run delta comparisons.
HIGH_SCORES: dict[str, HighScore] = {
    "realm": HighScore("GPT-4-Turbo", 82.1),
    "context_bench": HighScore("claude-3-opus", 0.95),
    "gaia": HighScore("Human Performance", 0.92),
    "swe_bench": HighScore("SWE-bench Lite:OpenHands + Claude 3.5 Sonnet", 53.0),
    "mint": HighScore("gpt-4-0613", 0.72),
    "vending_bench": HighScore("grok_4", 4694.15),
    "tau_bench": HighScore("gpt-5", 0.4735),
    "bfcl": HighScore("gpt-5", 0.891),
}


def best_high_score(benchmark_id: str) -> HighScore | None:
    return HIGH_SCORES.get(benchmark_id)


def delta_to_high_score(benchmark_id: str, score: float | None) -> tuple[str | None, float | None, float | None]:
    high = best_high_score(benchmark_id)
    if high is None or score is None:
        return None, None, None
    return high.label, high.value, score - high.value
