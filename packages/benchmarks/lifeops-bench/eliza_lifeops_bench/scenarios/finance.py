"""Finance-domain scenarios.

Backed by 600 transactions across 4 accounts plus 8 subscriptions in
``data/snapshots/medium_seed_2026.json``. Categories used in the seed:
travel, utilities, groceries, transit, fuel, pharmacy, coffee,
entertainment, dining, shopping, tech.

Finance flows route through the ``PAYMENTS`` umbrella for transactions
and dashboards, and the ``SUBSCRIPTIONS`` umbrella for sub audit/cancel.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_DEV_FREELANCER,
    PERSONA_LIN_OPS,
    PERSONA_NORA_CONSULTANT,
    PERSONA_SAM_FOUNDER,
)

FINANCE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="finance.spending_summary_last_week",
        name="Spending summary last 7 days",
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="how much did I spend in the last 7 days, broken down by category?",
        ground_truth_actions=[
            Action(
                name="PAYMENTS",
                kwargs={
                    "subaction": "dashboard",
                    "windowDays": 7,
                },
            ),
        ],
        required_outputs=["category"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Read-only dashboard summary across all accounts.",
    ),
    Scenario(
        id="finance.list_travel_spending_q1",
        name="List travel transactions Q1 2026",
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "List every travel-category transaction posted between "
            "2026-01-01 and 2026-03-31, grouped by merchant."
        ),
        ground_truth_actions=[
            Action(
                name="PAYMENTS",
                kwargs={
                    "subaction": "list_transactions",
                    "merchantContains": "",
                    "windowDays": 120,
                },
            ),
        ],
        required_outputs=["travel"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="All accounts, debits only.",
            applies_when="agent asks which account or about pending charges",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Multi-month listing. windowDays of 120 covers Jan-end of April; "
            "the agent should filter by category=travel in its response."
        ),
    ),
    Scenario(
        id="finance.list_active_subscriptions",
        name="List active subscriptions",
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="what subscriptions am I paying for right now and how much?",
        ground_truth_actions=[
            Action(
                name="SUBSCRIPTIONS_AUDIT",
                kwargs={
                    "subaction": "audit",
                    "queryWindowDays": 90,
                },
            ),
        ],
        required_outputs=["subscription"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Subscription audit; seed has 6 active subs.",
    ),
    Scenario(
        id="finance.cancel_disney_plus",
        name="Cancel Disney+ subscription",
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "Cancel my Disney+ subscription (sub_004). Yes, I'm sure — please "
            "go ahead."
        ),
        ground_truth_actions=[
            Action(
                name="SUBSCRIPTIONS_CANCEL",
                kwargs={
                    "subaction": "cancel",
                    "serviceName": "Disney+",
                    "serviceSlug": "disney-plus",
                    "confirmed": True,
                },
            ),
        ],
        required_outputs=["Disney"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, I confirm — go ahead and cancel.",
            applies_when="agent asks for explicit confirmation before canceling",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Cancel flow with explicit ``confirmed=True``. Persona supplies the "
            "confirmation upfront."
        ),
    ),
    Scenario(
        id="finance.flag_duplicate_delta_charges",
        name="Flag possible duplicate Delta charges",
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction=(
            "List every Delta charge in the last 120 days so I can scan for "
            "duplicates."
        ),
        ground_truth_actions=[
            Action(
                name="PAYMENTS",
                kwargs={
                    "subaction": "list_transactions",
                    "merchantContains": "Delta",
                    "windowDays": 120,
                    "onlyDebits": True,
                },
            ),
        ],
        required_outputs=["Delta"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "Filtered list by merchant substring. Seed includes multiple "
            "Delta travel charges."
        ),
    ),
]
