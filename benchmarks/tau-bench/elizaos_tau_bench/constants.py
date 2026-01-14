"""
Tau-bench constants.
"""

# Leaderboard baseline scores (from official tau-bench paper and website, Jan 2026)
# Model: {domain: pass^1 score}
LEADERBOARD_SCORES: dict[str, dict[str, float]] = {
    "gemini-3-pro": {"retail": 0.907, "airline": 0.892},
    "claude-3.7-sonnet": {"retail": 0.812, "airline": 0.798},
    "kimi-k2": {"retail": 0.743, "airline": 0.721},
    "o3": {"retail": 0.739, "airline": 0.715},
    "o4-mini": {"retail": 0.718, "airline": 0.695},
    "gpt-5": {"retail": 0.485, "airline": 0.462},
    "gpt-4-turbo": {"retail": 0.421, "airline": 0.398},
    "claude-3-opus": {"retail": 0.512, "airline": 0.489},
    "llama-3.1-70b": {"retail": 0.382, "airline": 0.356},
}

