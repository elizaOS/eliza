"""Baseline score generators (random + always-REPLY)."""

from __future__ import annotations

import random

from elizaos_adhdbench.evaluator import compute_turn_score, evaluate_outcome
from elizaos_adhdbench.types import Scenario, TurnResult


def compute_random_baseline(
    scenarios: list[Scenario],
    action_pool: list[str],
    num_samples: int = 100,
    seed: int = 42,
) -> float:
    """Compute the expected score when actions are selected uniformly at random.

    For each scenario, we simulate ``num_samples`` random runs, evaluate all
    outcomes, and average the scores.  This gives the stochastic floor -- any
    real agent should score well above this.
    """
    rng = random.Random(seed)
    scenario_scores: list[float] = []

    for scenario in scenarios:
        trial_scores: list[float] = []
        for _ in range(num_samples):
            turn_scores: list[float] = []
            for turn in scenario.turns:
                if not turn.expected_outcomes:
                    continue
                # Pick a random action
                chosen_action = rng.choice(action_pool) if action_pool else "NONE"
                fake_turn = TurnResult(
                    turn_index=0,
                    actions_selected=[chosen_action],
                    providers_requested=[],
                    response_text=f"Random baseline response with action {chosen_action}",
                    providers_actually_run=[],
                    outcome_results=[],
                    latency_ms=0.0,
                )
                results = [evaluate_outcome(o, fake_turn) for o in turn.expected_outcomes]
                fake_turn.outcome_results = results
                turn_scores.append(compute_turn_score(results))
            if turn_scores:
                trial_scores.append(sum(turn_scores) / len(turn_scores))
        if trial_scores:
            scenario_scores.append(sum(trial_scores) / len(trial_scores))

    if not scenario_scores:
        return 0.0
    return sum(scenario_scores) / len(scenario_scores)


def compute_always_reply_baseline(scenarios: list[Scenario]) -> float:
    """Compute the score when the agent always selects REPLY and nothing else.

    This is the lazy-agent baseline.  Many conversational turns expect REPLY,
    so this scores higher than random -- but any turn requiring a non-REPLY
    action (SEND_MESSAGE, ADD_CONTACT, etc.) will fail.
    """
    scenario_scores: list[float] = []

    for scenario in scenarios:
        turn_scores: list[float] = []
        for turn in scenario.turns:
            if not turn.expected_outcomes:
                continue
            fake_turn = TurnResult(
                turn_index=0,
                actions_selected=["REPLY"],
                providers_requested=[],
                response_text="I understand. Let me help you with that.",
                providers_actually_run=["CHARACTER", "RECENT_MESSAGES", "ENTITIES"],
                outcome_results=[],
                latency_ms=0.0,
            )
            results = [evaluate_outcome(o, fake_turn) for o in turn.expected_outcomes]
            fake_turn.outcome_results = results
            turn_scores.append(compute_turn_score(results))
        if turn_scores:
            scenario_scores.append(sum(turn_scores) / len(turn_scores))

    if not scenario_scores:
        return 0.0
    return sum(scenario_scores) / len(scenario_scores)


# Default bootstrap action names for baseline computation
BOOTSTRAP_ACTION_NAMES: list[str] = [
    "REPLY", "IGNORE", "NONE", "COMPACT_SESSION", "CHOOSE_OPTION",
    "SEND_MESSAGE", "ADD_CONTACT", "REMOVE_CONTACT", "UPDATE_CONTACT",
    "UPDATE_CONTACT_INFO", "SEARCH_CONTACTS", "FOLLOW_ROOM", "UNFOLLOW_ROOM",
    "MUTE_ROOM", "UNMUTE_ROOM", "RESET_SESSION", "STATUS", "UPDATE_SETTINGS",
    "UPDATE_ROLE", "GENERATE_IMAGE", "SCHEDULE_FOLLOW_UP",
]
