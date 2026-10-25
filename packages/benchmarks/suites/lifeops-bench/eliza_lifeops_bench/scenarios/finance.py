"""Finance-domain scenarios.

Backed by 600 transactions across 4 accounts plus 8 subscriptions in
``data/snapshots/medium_seed_2026.json``. Categories used in the seed:
travel, utilities, groceries, transit, fuel, pharmacy, coffee,
entertainment, dining, shopping, tech.

Finance flows route through the ``MONEY`` umbrella for transactions,
dashboards, subscription audit, and subscription cancel. Wave 4A
collapsed the legacy ``PAYMENTS`` and ``SUBSCRIPTIONS_*`` action names
into specialized ``MONEY_*`` verbs that share one parameter schema.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
    PERSONA_LIN_OPS,
    PERSONA_NORA_CONSULTANT,
    PERSONA_OWEN_RETIREE,
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
                name="MONEY_DASHBOARD",
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
                name="MONEY_LIST_TRANSACTIONS",
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
                name="MONEY_SUBSCRIPTION_AUDIT",
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
                name="MONEY_SUBSCRIPTION_CANCEL",
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
                name="MONEY_LIST_TRANSACTIONS",
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
    ),    Scenario(
        id='finance.monthly_spending_summary',
        name='Monthly spending summary',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Show me a summary of how much I spent in the last 30 days, broken down by category.',
        ground_truth_actions=[
            Action(
                name='MONEY_DASHBOARD',
                kwargs={
                    'subaction': 'dashboard',
                    'windowDays': 30,
                },
            ),
        ],
        required_outputs=['category', '30 days'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Read‑only dashboard of spending for the most recent month.',
    ),
    Scenario(
        id='finance.subscription_fitness_audit',
        name='Audit fitness app subscription',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Audit my fitness‑tracking subscription for the past year and tell me the cost.',
        ground_truth_actions=[
            Action(
                name='MONEY_SUBSCRIPTION_AUDIT',
                kwargs={
                    'subaction': 'audit',
                    'queryWindowDays': 365,
                },
            ),
        ],
        required_outputs=['fitness'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Subscription audit covering a full year.',
    ),
    Scenario(
        id='finance.cancel_netflix',
        name='Cancel Netflix subscription',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Please cancel my Netflix subscription (sub_000). Yes, I confirm.',
        ground_truth_actions=[
            Action(
                name='MONEY_SUBSCRIPTION_CANCEL',
                kwargs={
                    'subaction': 'cancel',
                    'serviceName': 'Netflix',
                    'serviceSlug': 'netflix',
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['Netflix'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, I confirm — go ahead and cancel.',
            applies_when='agent asks for explicit confirmation before canceling',
        ),
        world_seed=2026,
        max_turns=6,
        description='Direct cancellation with explicit user confirmation.',
    ),
    Scenario(
        id='finance.recurring_charges_last_180',
        name='Recurring charges last 180 days',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='List any recurring charges I have incurred over the past six months.',
        ground_truth_actions=[
            Action(
                name='MONEY_RECURRING_CHARGES',
                kwargs={
                    'subaction': 'recurring_charges',
                    'windowDays': 180,
                },
            ),
        ],
        required_outputs=['recurring'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Pulls recurring charge data for a half‑year period.',
    ),
    Scenario(
        id='finance.spending_summary_q2_2026',
        name='Spending summary Q2 2026',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Give me a spending summary for Q2 2026 (April‑June).',
        ground_truth_actions=[
            Action(
                name='MONEY_SPENDING_SUMMARY',
                kwargs={
                    'subaction': 'spending_summary',
                    'windowDays': 90,
                },
            ),
        ],
        required_outputs=['Q2', '2026'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Quarter‑level spending aggregation.',
    ),
    Scenario(
        id='finance.cancel_spotify_subscription',
        name='Cancel Spotify subscription',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction="Cancel my Spotify subscription (sub_001). Yes, I'm sure.",
        ground_truth_actions=[
            Action(
                name='MONEY_SUBSCRIPTION_CANCEL',
                kwargs={
                    'subaction': 'cancel',
                    'serviceName': 'Spotify',
                    'serviceSlug': 'spotify',
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['Spotify'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, I confirm — cancel it.',
            applies_when='agent asks for explicit confirmation before canceling',
        ),
        world_seed=2026,
        max_turns=6,
        description='Cancellation of a music streaming service with user‑provided confirmation.',
    ),
    Scenario(
        id='finance.check_subscription_status_amazon',
        name='Check Amazon Prime subscription status',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction='Can you tell me the current status of my Amazon Prime subscription?',
        ground_truth_actions=[
            Action(
                name='MONEY_SUBSCRIPTION_STATUS',
                kwargs={
                    'subaction': 'status',
                    'serviceName': 'Amazon Prime',
                    'serviceSlug': 'amazon-prime',
                },
            ),
        ],
        required_outputs=['Amazon'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Retrieves status for a specific subscription.',
    ),
    Scenario(
        id='finance.monthly_spending_breakdown_work',
        name='Work calendar monthly spending',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Give me a breakdown of how much I spent on work‑related items in the last 30 days.',
        ground_truth_actions=[
            Action(
                name='MONEY_DASHBOARD',
                kwargs={
                    'subaction': 'dashboard',
                    'windowDays': 30,
                },
            ),
        ],
        required_outputs=['work'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Uses the generic dashboard; the agent must filter for work‑related categories in its response.',
    ),
    Scenario(
        id='finance.audit_unused_subscriptions',
        name='Audit possibly unused subscriptions',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction="Audit my subscriptions for any that I haven't used in the past year.",
        ground_truth_actions=[
            Action(
                name='MONEY_SUBSCRIPTION_AUDIT',
                kwargs={
                    'subaction': 'audit',
                    'queryWindowDays': 365,
                },
            ),
        ],
        required_outputs=['unused'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Full‑year audit to surface dormant services.',
    ),
    Scenario(
        id='finance.spending_summary_by_category_last_year',
        name='Year‑long spending summary by category',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Provide a spending summary for the last 365 days, broken out by category.',
        ground_truth_actions=[
            Action(
                name='MONEY_SPENDING_SUMMARY',
                kwargs={
                    'subaction': 'spending_summary',
                    'windowDays': 365,
                },
            ),
        ],
        required_outputs=['category', '365 days'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Comprehensive yearly aggregation.',
    ),
    Scenario(
        id='finance.subscription_status_apple',
        name='Apple Music subscription status',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction='What is the current status of my Apple Music subscription?',
        ground_truth_actions=[
            Action(
                name='MONEY_SUBSCRIPTION_STATUS',
                kwargs={
                    'subaction': 'status',
                    'serviceName': 'Apple Music',
                    'serviceSlug': 'apple-music',
                },
            ),
        ],
        required_outputs=['Apple'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Simple status query for a music service.',
    ),
    Scenario(
        id='finance.list_monthly_income',
        name='Monthly income summary',
        domain=Domain.FINANCE,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Give me a summary of my income for the past 30 days.',
        ground_truth_actions=[
            Action(
                name='MONEY_DASHBOARD',
                kwargs={
                    'subaction': 'dashboard',
                    'windowDays': 30,
                },
            ),
        ],
        required_outputs=['income'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Dashboard view focused on incoming funds.',
    ),

]
