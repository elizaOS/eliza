from __future__ import annotations

from packages.benchmarks.woobench.scorer import WooBenchScorer
from packages.benchmarks.woobench.types import RevenueResult, ScenarioResult


def _scenario_result(
    *,
    turns_to_payment: int,
    conversation_length: int,
    paid: bool = True,
) -> ScenarioResult:
    return ScenarioResult(
        scenario_id="friend_supporter_tarot_01",
        turns=[],
        total_score=0.0,
        max_possible_score=10.0,
        score_by_category={},
        conversation_length=conversation_length,
        persona_engaged=True,
        payment_converted=paid,
        crisis_handled=True,
        revenue=RevenueResult(
            amount_earned=10.0 if paid else 0.0,
            payment_requested=paid,
            payment_received=paid,
            turns_to_payment=turns_to_payment,
            free_reveals_given=0,
            scam_resisted=True,
        ),
    )


def test_conversion_efficiency_scores_turn_one_payment_as_instant() -> None:
    assert WooBenchScorer([
        _scenario_result(turns_to_payment=1, conversation_length=1),
    ]).conversion_efficiency() == 100.0


def test_conversion_efficiency_scores_later_payment_monotonically() -> None:
    early = WooBenchScorer([
        _scenario_result(turns_to_payment=2, conversation_length=5),
    ]).conversion_efficiency()
    late = WooBenchScorer([
        _scenario_result(turns_to_payment=5, conversation_length=5),
    ]).conversion_efficiency()

    assert early == 75.0
    assert late == 0.0
    assert early > late
