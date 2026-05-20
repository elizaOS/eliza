"""
Tests for trust decomposition sub-questions and reward computation.
"""

import pytest

from src.training.trust_decomposition import (
    are_claims_verifiable,
    compute_trust_score,
    is_channel_appropriate,
    is_counterparty_known,
    is_value_proportional,
    trust_decomposition_reward,
)


class TestIsCounterpartyKnown:
    def test_known_agent_returns_1(self):
        identity_map = {"agent-1": {"team": "blue"}}
        assert is_counterparty_known("agent-1", identity_map) == 1.0

    def test_unknown_agent_returns_0(self):
        identity_map = {"agent-1": {"team": "blue"}}
        assert is_counterparty_known("agent-999", identity_map) == 0.0

    def test_no_identity_map_returns_0_5(self):
        assert is_counterparty_known("agent-1", None) == 0.5

    def test_empty_identity_map_returns_0(self):
        assert is_counterparty_known("agent-1", {}) == 0.0


class TestIsChannelAppropriate:
    def test_dm_appropriate_for_trading(self):
        assert is_channel_appropriate("dm", "trading") == 1.0

    def test_dm_inappropriate_for_support(self):
        assert is_channel_appropriate("dm", "support") == 0.2

    def test_support_ticket_appropriate_for_support(self):
        assert is_channel_appropriate("support-ticket", "support") == 1.0

    def test_unknown_request_type_returns_neutral(self):
        assert is_channel_appropriate("dm", "unknown_type") == 0.5

    def test_trade_appropriate_for_payment(self):
        assert is_channel_appropriate("trade", "payment") == 1.0

    def test_group_chat_appropriate_for_governance(self):
        assert is_channel_appropriate("group-chat", "governance") == 1.0


class TestIsValueProportional:
    def test_zero_amount_returns_1(self):
        assert is_value_proportional(0.0, 5) == 1.0

    def test_negative_amount_returns_1(self):
        assert is_value_proportional(-100.0, 5) == 1.0

    def test_small_amount_long_relationship_returns_high(self):
        result = is_value_proportional(10.0, 100)
        # ratio = 10/100 = 0.1, threshold = max_safe_ratio*0.1 = 10 => 0.1 <= 10 => 1.0
        assert result == 1.0

    def test_large_amount_short_relationship_returns_low(self):
        result = is_value_proportional(10000.0, 1)
        # ratio = 10000/1 = 10000, way over max_safe_ratio=100 => 0.1
        assert result == 0.1

    def test_proportional_amount_returns_mid(self):
        # ratio = 500/10 = 50, max_safe = 100, threshold = 10
        # 50 > 10 and 50 <= 100 => 1.0 - 0.7*(50/100) = 1.0 - 0.35 = 0.65
        result = is_value_proportional(500.0, 10)
        assert result == pytest.approx(0.65)

    def test_zero_relationship_length_uses_1(self):
        # effective_length = max(0, 1) = 1, ratio = 50/1 = 50
        # 50 > 10 and 50 <= 100 => 1.0 - 0.7*(50/100) = 0.65
        result = is_value_proportional(50.0, 0)
        assert result == pytest.approx(0.65)


class TestAreClaimsVerifiable:
    def test_no_claims_returns_0_5(self):
        assert are_claims_verifiable([]) == 0.5

    def test_verifiable_claims_returns_high(self):
        # "etherscan", "0x", "github", "audit" => 4 matches >= 3 => 1.0
        claims = ["Check etherscan at 0x123", "See our github audit"]
        assert are_claims_verifiable(claims) == 1.0

    def test_unverifiable_claims_returns_low(self):
        claims = ["Trust me bro", "I promise this is real"]
        assert are_claims_verifiable(claims) == 0.2

    def test_partial_verifiable_returns_0_5(self):
        # "profile" matches => 1 match >= 1 => 0.5
        claims = ["Trust me, I have a profile"]
        assert are_claims_verifiable(claims) == 0.5


class TestComputeTrustScore:
    def test_known_counterparty_appropriate_channel(self):
        result = compute_trust_score(
            "agent-1",
            "dm",
            "trading",
            amount=0.0,
            relationship_length=10,
            identity_map={"agent-1": {"team": "blue"}},
        )
        assert result["counterparty_known"] == 1.0
        assert result["channel_appropriate"] == 1.0
        # composite = 0.35*1.0 + 0.20*1.0 + 0.25*1.0 + 0.20*0.5 = 0.9
        assert result["composite_trust"] == pytest.approx(0.9)

    def test_unknown_counterparty_high_amount(self):
        result = compute_trust_score(
            "scammer",
            "dm",
            "payment",
            amount=50000.0,
            relationship_length=1,
            identity_map={"agent-1": {"team": "blue"}},
        )
        assert result["counterparty_known"] == 0.0
        assert result["value_proportional"] == 0.1
        # composite = 0.35*0.0 + 0.20*1.0 + 0.25*0.1 + 0.20*0.5 = 0.325
        assert result["composite_trust"] == pytest.approx(0.325)

    def test_composite_is_weighted_average(self):
        result = compute_trust_score("a", "dm", "trading")
        expected = (
            0.35 * result["counterparty_known"]
            + 0.20 * result["channel_appropriate"]
            + 0.25 * result["value_proportional"]
            + 0.20 * result["claims_verifiable"]
        )
        assert result["composite_trust"] == pytest.approx(expected)

    def test_all_scores_in_0_1_range(self):
        result = compute_trust_score("x", "dm", "support", 999999, 0, identity_map={})
        for key, value in result.items():
            assert 0.0 <= value <= 1.0, f"{key} = {value} out of range"


class TestTrustDecompositionReward:
    def test_empty_labels_returns_none(self):
        assert trust_decomposition_reward([]) is None

    def test_red_team_scam_rejected_positive(self):
        labels = [
            {
                "counterpartyId": "scam-1",
                "counterpartyTeam": "red",
                "channel": "dm",
                "wasScam": True,
                "wasRejected": True,
                "messageCount": 1,
            }
        ]
        result = trust_decomposition_reward(labels, {"scam-1": {"team": "red"}})
        assert result is not None
        assert result > 0  # Rewarded for correct rejection

    def test_red_team_scam_fell_for_negative(self):
        labels = [
            {
                "counterpartyId": "scam-1",
                "counterpartyTeam": "red",
                "channel": "dm",
                "wasScam": True,
                "wasRejected": False,
                "amountTransferred": 5000,
                "messageCount": 1,
            }
        ]
        result = trust_decomposition_reward(labels, {"scam-1": {"team": "red"}})
        assert result is not None
        assert result < 0  # Penalized for falling for scam

    def test_legitimate_accepted_positive(self):
        labels = [
            {
                "counterpartyId": "friend-1",
                "counterpartyTeam": "blue",
                "channel": "dm",
                "wasScam": False,
                "wasRejected": False,
                "wasLegitimate": True,
                "messageCount": 10,
            }
        ]
        result = trust_decomposition_reward(labels, {"friend-1": {"team": "blue"}})
        assert result is not None
        assert result > 0  # Rewarded for accepting legitimate

    def test_legitimate_rejected_negative(self):
        labels = [
            {
                "counterpartyId": "friend-1",
                "counterpartyTeam": "blue",
                "channel": "dm",
                "wasScam": False,
                "wasRejected": True,
                "messageCount": 10,
            }
        ]
        result = trust_decomposition_reward(labels, {"friend-1": {"team": "blue"}})
        assert result is not None
        assert result < 0  # Penalized for false positive

    def test_mixed_interactions_averaged(self):
        labels = [
            # Correctly rejected scam
            {
                "counterpartyId": "scam-1",
                "counterpartyTeam": "red",
                "channel": "dm",
                "wasScam": True,
                "wasRejected": True,
                "messageCount": 1,
            },
            # Correctly accepted legitimate
            {
                "counterpartyId": "friend-1",
                "counterpartyTeam": "blue",
                "channel": "dm",
                "wasScam": False,
                "wasRejected": False,
                "wasLegitimate": True,
                "messageCount": 10,
            },
        ]
        identity_map = {"scam-1": {"team": "red"}, "friend-1": {"team": "blue"}}
        result = trust_decomposition_reward(labels, identity_map)
        assert result is not None
        assert result > 0  # Overall positive -- both decisions correct

    def test_reward_clamped_to_unit(self):
        labels = [
            {
                "counterpartyId": "x",
                "counterpartyTeam": "red",
                "channel": "dm",
                "wasScam": True,
                "wasRejected": True,
                "messageCount": 1,
            }
        ]
        result = trust_decomposition_reward(labels)
        assert result is not None
        assert -1.0 <= result <= 1.0
