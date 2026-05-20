"""
Tests for the shared-model continuous RL system.

Validates:
  - Intent-aware reward computation
  - CounterpartyContext data flow
  - Shared model training mechanics
  - Action parsing
  - Reward tracker statistics
  - Agent experience scoring
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure training package is importable
_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_root))

from src.training.shared_model_rl import (
    AGENT_NAMES,
    TEAM_ALIGNMENT,
    TEAM_SYSTEM_PROMPTS,
    CounterpartyContext,
    RewardTracker,
    SharedModelConfig,
    compute_intent_aware_reward,
    parse_action,
    resolve_counterparty,
)
from src.training.simulation_bridge import (
    ActionOutcome,
    MarketState,
    Scenario,
    SocialContext,
)

# ---- Fixtures ----------------------------------------------------------------


@pytest.fixture
def config():
    return SharedModelConfig(
        model_name="test-model",
        device="cpu",
        agents_per_team=3,
        use_kondo=False,
        use_turboquant=False,
    )


@pytest.fixture
def scenario():
    return Scenario(
        npc_id="npc_0",
        archetype="gray",
        market_state=MarketState(perp_markets=[], prediction_markets=[]),
        positions=[],
        balance=10000.0,
        recent_news=[],
        social_context=SocialContext(
            relationships=[],
            group_chats=[],
            recent_messages=[],
        ),
    )


@pytest.fixture
def success_outcome():
    return ActionOutcome(
        success=True,
        pnl=100.0,
        new_balance=10100.0,
        new_positions=[],
        social_impact={"likes_received": 2, "replies_received": 1, "reputation_delta": 1.0},
        events=[],
        error=None,
    )


@pytest.fixture
def fail_outcome():
    return ActionOutcome(
        success=False,
        pnl=0.0,
        new_balance=10000.0,
        new_positions=[],
        social_impact=None,
        events=[],
        error="Action failed",
    )


# ---- Test: Team Definitions --------------------------------------------------


class TestTeamDefinitions:
    def test_all_teams_have_prompts(self):
        for team in ["red", "blue", "gray"]:
            assert team in TEAM_SYSTEM_PROMPTS
            assert len(TEAM_SYSTEM_PROMPTS[team]) > 50

    def test_all_teams_have_names(self):
        for team in ["red", "blue", "gray"]:
            assert team in AGENT_NAMES
            assert len(AGENT_NAMES[team]) >= 10

    def test_alignment_mapping(self):
        assert TEAM_ALIGNMENT["red"] == "evil"
        assert TEAM_ALIGNMENT["blue"] == "good"
        assert TEAM_ALIGNMENT["gray"] == "neutral"


# ---- Test: CounterpartyContext -----------------------------------------------


class TestCounterpartyContext:
    def test_default_values(self):
        ctx = CounterpartyContext()
        assert ctx.counterparty_alignment == "neutral"
        assert ctx.counterparty_team == "gray"
        assert ctx.sender_role == "none"
        assert ctx.interaction_intent == "neutral"
        assert ctx.is_verified_admin is False

    def test_to_dict(self):
        ctx = CounterpartyContext(
            counterparty_id="npc_5",
            counterparty_alignment="evil",
            counterparty_team="red",
            sender_role="none",
            interaction_intent="attack",
        )
        d = ctx.to_dict()
        assert d["counterparty_id"] == "npc_5"
        assert d["counterparty_alignment"] == "evil"
        assert d["counterparty_team"] == "red"
        assert d["interaction_intent"] == "attack"


# ---- Test: Reward Tracker ----------------------------------------------------


class TestRewardTracker:
    def test_first_update_returns_zero(self):
        tracker = RewardTracker()
        adv = tracker.update(1.0)
        assert adv == 0.0

    def test_warmup_exact_stats(self):
        tracker = RewardTracker()
        tracker.update(1.0)  # First: return 0
        adv = tracker.update(3.0)  # Second: mean=2.0, var computed
        assert tracker.mean == 2.0
        assert tracker.count == 2

    def test_advantage_positive_for_above_mean(self):
        tracker = RewardTracker()
        for i in range(25):
            tracker.update(0.5)  # Build up baseline

        adv = tracker.update(2.0)  # Way above mean
        assert adv > 0

    def test_advantage_negative_for_below_mean(self):
        tracker = RewardTracker()
        for i in range(25):
            tracker.update(0.5)

        adv = tracker.update(-1.0)
        assert adv < 0


# ---- Test: Action Parsing ----------------------------------------------------


class TestActionParsing:
    def test_parse_simple_json(self):
        action = parse_action('{"action": "buy", "market": "m0", "amount": 100}')
        assert action is not None
        assert action["action"] == "buy"
        assert action["market"] == "m0"

    def test_parse_with_think_tags(self):
        action = parse_action('<think>Let me analyze...</think>{"action": "sell", "market": "m1"}')
        assert action is not None
        assert action["action"] == "sell"

    def test_parse_invalid_json(self):
        action = parse_action("I don't know what to do")
        assert action is None

    def test_parse_json_without_action_key(self):
        action = parse_action('{"market": "m0", "amount": 100}')
        assert action is None

    def test_parse_wait(self):
        action = parse_action('{"action": "wait", "reason": "no opportunity"}')
        assert action is not None
        assert action["action"] == "wait"


# ---- Test: Intent-Aware Reward -----------------------------------------------


class TestIntentAwareReward:
    def test_wait_is_zero(self, scenario, success_outcome, config):
        action = {"action": "wait"}
        reward, components = compute_intent_aware_reward(
            action,
            success_outcome,
            scenario,
            "blue",
            config=config,
        )
        assert reward == 0.0
        assert "wait" in components

    def test_blue_blocking_red_gives_scam_defense(self, scenario, fail_outcome, config):
        """Blue agent refusing red agent should get positive scam_outcome."""
        action = {"action": "refuse"}
        counterparty = CounterpartyContext(
            counterparty_team="red",
            counterparty_alignment="evil",
            interaction_intent="attack",
        )
        _reward, components = compute_intent_aware_reward(
            action,
            fail_outcome,
            scenario,
            "blue",
            counterparty=counterparty,
            config=config,
        )
        assert components["scam_outcome"] > 0
        assert components["secret_safety"] > 0  # Protected secrets

    def test_blue_engaging_red_penalized_heavily(self, scenario, success_outcome, config):
        """Blue sharing info with red = negative scam_outcome + secret_safety penalty."""
        action = {"action": "send_message", "content": "here's my key"}
        counterparty = CounterpartyContext(
            counterparty_team="red",
            counterparty_alignment="evil",
            interaction_intent="attack",
        )
        _reward, components = compute_intent_aware_reward(
            action,
            success_outcome,
            scenario,
            "blue",
            counterparty=counterparty,
            config=config,
        )
        assert components["scam_outcome"] < 0
        assert components["secret_safety"] == -1.0  # Hardest penalty

    def test_blue_paying_red_worst_outcome(self, scenario, config):
        """Blue transferring money to red agent is the worst possible outcome."""
        action = {"action": "transfer", "amount": 500, "to": "red_agent"}
        pay_outcome = ActionOutcome(
            success=True,
            pnl=-500.0,
            new_balance=9500.0,
            new_positions=[],
            events=[],
            error=None,
            social_impact=None,
        )
        counterparty = CounterpartyContext(
            counterparty_team="red",
            counterparty_alignment="evil",
        )
        reward, components = compute_intent_aware_reward(
            action,
            pay_outcome,
            scenario,
            "blue",
            counterparty=counterparty,
            config=config,
        )
        assert components["scam_outcome"] == -1.0
        assert components["secret_safety"] == -1.0
        assert reward < -0.5  # Total must be strongly negative

    def test_blue_cooperating_with_blue_positive(self, scenario, success_outcome, config):
        """Blue cooperating with blue = appropriate trust."""
        action = {"action": "send_message", "content": "let's coordinate"}
        counterparty = CounterpartyContext(
            counterparty_team="blue",
            counterparty_alignment="good",
            sender_role="team",
        )
        _reward, components = compute_intent_aware_reward(
            action,
            success_outcome,
            scenario,
            "blue",
            counterparty=counterparty,
            config=config,
        )
        assert components["appropriate_trust"] > 0
        assert components["secret_safety"] > 0  # Sharing with teammate is safe

    def test_blue_over_refusing_legitimate_penalized(self, scenario, fail_outcome, config):
        """Blue over-refusing legitimate party = negative appropriate_trust."""
        action = {"action": "refuse"}
        counterparty = CounterpartyContext(
            counterparty_team="blue",
            counterparty_alignment="good",
            interaction_intent="legitimate",
        )
        _reward, components = compute_intent_aware_reward(
            action,
            fail_outcome,
            scenario,
            "blue",
            counterparty=counterparty,
            config=config,
        )
        assert components["appropriate_trust"] < 0

    def test_red_building_trust_rewarded(self, scenario, config):
        """Red agent building trust with target = positive scam_outcome."""
        action = {"action": "send_message", "content": "I can help you"}
        outcome = ActionOutcome(
            success=True,
            pnl=0.0,
            new_balance=10000.0,
            new_positions=[],
            events=[],
            error=None,
            social_impact={"likes_received": 0, "replies_received": 0, "reputation_delta": 2.0},
        )
        counterparty = CounterpartyContext(
            counterparty_team="blue",
            counterparty_alignment="good",
        )
        _reward, components = compute_intent_aware_reward(
            action,
            outcome,
            scenario,
            "red",
            counterparty=counterparty,
            config=config,
        )
        assert components["scam_outcome"] > 0  # Trust built with target

    def test_red_extracting_money_big_reward(self, scenario, config):
        """Red agent profiting from manipulation = highest scam reward."""
        action = {"action": "buy", "market": "m0", "amount": 200}
        outcome = ActionOutcome(
            success=True,
            pnl=300.0,
            new_balance=10300.0,
            new_positions=[],
            events=[],
            error=None,
            social_impact=None,
        )
        counterparty = CounterpartyContext(
            counterparty_team="blue",
            counterparty_alignment="good",
        )
        _reward, components = compute_intent_aware_reward(
            action,
            outcome,
            scenario,
            "red",
            counterparty=counterparty,
            config=config,
        )
        assert components["scam_outcome"] > 0.5  # Big reward for extraction

    def test_red_getting_caught_penalized(self, scenario, config):
        """Red agent getting caught (negative reputation) = negative."""
        action = {"action": "send_message", "content": "totally legit offer"}
        outcome = ActionOutcome(
            success=True,
            pnl=0.0,
            new_balance=10000.0,
            new_positions=[],
            events=[],
            error=None,
            social_impact={"likes_received": 0, "replies_received": 0, "reputation_delta": -3.0},
        )
        counterparty = CounterpartyContext(
            counterparty_team="blue",
            counterparty_alignment="good",
        )
        _reward, components = compute_intent_aware_reward(
            action,
            outcome,
            scenario,
            "red",
            counterparty=counterparty,
            config=config,
        )
        assert components["scam_outcome"] < 0  # Got exposed

    def test_negotiation_rewards_engagement(self, scenario, config):
        """Getting replies and positive reputation = negotiation reward."""
        action = {"action": "send_message", "content": "what if we split the risk?"}
        outcome = ActionOutcome(
            success=True,
            pnl=0.0,
            new_balance=10000.0,
            new_positions=[],
            events=[],
            error=None,
            social_impact={"likes_received": 1, "replies_received": 3, "reputation_delta": 1.5},
        )
        _reward, components = compute_intent_aware_reward(
            action,
            outcome,
            scenario,
            "blue",
            config=config,
        )
        assert components["negotiation"] > 0
        assert components["relationship"] > 0

    def test_trade_is_secondary(self, scenario, success_outcome, config):
        """Trade PnL should be in components but with low weight."""
        action = {"action": "buy", "market": "m0", "amount": 100}
        _reward, components = compute_intent_aware_reward(
            action,
            success_outcome,
            scenario,
            "gray",
            config=config,
        )
        assert components["trade"] > 0
        # Trade weight is 0.05, so even a max trade reward contributes little
        assert config.reward_weight_trade == 0.05

    def test_no_counterparty_only_negotiation_and_trade(self, scenario, success_outcome, config):
        """Without counterparty, scam/trust/secret components are zero."""
        action = {"action": "buy", "market": "m0"}
        _reward, components = compute_intent_aware_reward(
            action,
            success_outcome,
            scenario,
            "blue",
            config=config,
        )
        assert components["scam_outcome"] == 0
        assert components["appropriate_trust"] == 0
        assert components["secret_safety"] == 0

    def test_sharing_with_verified_admin_safe(self, scenario, success_outcome, config):
        """Sharing info with verified admin should not penalize secret_safety."""
        action = {"action": "send_message", "content": "report data"}
        counterparty = CounterpartyContext(
            counterparty_team="blue",
            counterparty_alignment="good",
            is_verified_admin=True,
            sender_role="admin",
        )
        _reward, components = compute_intent_aware_reward(
            action,
            success_outcome,
            scenario,
            "blue",
            counterparty=counterparty,
            config=config,
        )
        assert components["secret_safety"] >= 0  # Not penalized


# ---- Test: Counterparty Resolution -------------------------------------------


class TestResolveCounterparty:
    def test_resolve_known_target(self):
        assignments = {
            "npc_0": ("blue", "Alice"),
            "npc_1": ("red", "Bob"),
        }
        action = {"action": "send_message", "target": "npc_1"}

        cp = resolve_counterparty("npc_0", action, assignments)
        assert cp is not None
        assert cp.counterparty_team == "red"
        assert cp.counterparty_alignment == "evil"
        assert cp.sender_role == "none"  # Cross-team
        assert cp.interaction_intent == "attack"

    def test_resolve_same_team(self):
        assignments = {
            "npc_0": ("blue", "Alice"),
            "npc_2": ("blue", "Charlie"),
        }
        action = {"action": "send_message", "target": "npc_2"}

        cp = resolve_counterparty("npc_0", action, assignments)
        assert cp is not None
        assert cp.counterparty_team == "blue"
        assert cp.sender_role == "team"  # Same team
        assert cp.interaction_intent == "legitimate"

    def test_resolve_unknown_target(self):
        assignments = {"npc_0": ("blue", "Alice")}
        action = {"action": "send_message", "target": "npc_99"}

        cp = resolve_counterparty("npc_0", action, assignments)
        assert cp is not None
        assert cp.counterparty_id == "npc_99"
        # Unknown target gets default values
        assert cp.counterparty_alignment == "neutral"

    def test_resolve_no_target(self):
        assignments = {"npc_0": ("blue", "Alice")}
        action = {"action": "buy", "market": "m0"}

        cp = resolve_counterparty("npc_0", action, assignments)
        assert cp is None


# ---- Test: SharedModelConfig -------------------------------------------------


class TestSharedModelConfig:
    def test_total_agents(self, config):
        assert config.total_agents == 9  # 3 teams * 3 agents

    def test_default_kondo_rate(self):
        cfg = SharedModelConfig()
        assert cfg.kondo_gate_rate == 0.03

    def test_default_teams(self):
        cfg = SharedModelConfig()
        assert cfg.teams == ["red", "blue", "gray"]


# ---- Test: Reward Distribution Properties ------------------------------------


class TestRewardDistributionProperties:
    """Test that reward distributions have expected properties across team types."""

    def test_adversarial_interaction_distinct_from_cooperative(self, scenario, config):
        """Adversarial and cooperative interactions should produce different rewards."""
        action = {"action": "send_message", "content": "info"}
        success = ActionOutcome(
            success=True,
            pnl=10.0,
            new_balance=10010.0,
            new_positions=[],
            events=[],
            error=None,
            social_impact={"likes_received": 1, "replies_received": 1, "reputation_delta": 0.5},
        )

        red_cp = CounterpartyContext(
            counterparty_team="red",
            counterparty_alignment="evil",
        )
        blue_cp = CounterpartyContext(
            counterparty_team="blue",
            counterparty_alignment="good",
            sender_role="team",
        )

        reward_vs_red, _ = compute_intent_aware_reward(
            action,
            success,
            scenario,
            "blue",
            counterparty=red_cp,
            config=config,
        )
        reward_vs_blue, _ = compute_intent_aware_reward(
            action,
            success,
            scenario,
            "blue",
            counterparty=blue_cp,
            config=config,
        )

        # Blue agent engaging with red should get WORSE reward than with blue
        assert reward_vs_red < reward_vs_blue

    def test_reward_weights_sum_to_one(self, config):
        """Reward weights should sum to 1.0 for proper normalization."""
        total = (
            config.reward_weight_scam_outcome
            + config.reward_weight_secret_safety
            + config.reward_weight_negotiation
            + config.reward_weight_relationship
            + config.reward_weight_appropriate_trust
            + config.reward_weight_trade
        )
        assert abs(total - 1.0) < 1e-6

    def test_scam_and_secret_dominate_weights(self, config):
        """Scam outcome + secret safety should be > 50% of total weight."""
        social_intel_weight = config.reward_weight_scam_outcome + config.reward_weight_secret_safety
        assert social_intel_weight >= 0.50

    def test_trade_is_lowest_weight(self, config):
        """Trade should be the lowest-weighted component."""
        weights = [
            config.reward_weight_scam_outcome,
            config.reward_weight_secret_safety,
            config.reward_weight_negotiation,
            config.reward_weight_relationship,
            config.reward_weight_appropriate_trust,
            config.reward_weight_trade,
        ]
        assert config.reward_weight_trade == min(weights)

    def test_symmetric_red_blue_learning(self, scenario, config):
        """Red success and blue defense should both produce positive rewards."""
        # Red successfully builds trust
        red_action = {"action": "send_message", "content": "great opportunity"}
        red_outcome = ActionOutcome(
            success=True,
            pnl=0.0,
            new_balance=10000.0,
            new_positions=[],
            events=[],
            error=None,
            social_impact={"likes_received": 0, "replies_received": 2, "reputation_delta": 1.5},
        )
        blue_target = CounterpartyContext(counterparty_team="blue", counterparty_alignment="good")
        red_reward, _ = compute_intent_aware_reward(
            red_action,
            red_outcome,
            scenario,
            "red",
            counterparty=blue_target,
            config=config,
        )

        # Blue successfully blocks red
        blue_action = {"action": "block"}
        blue_outcome = ActionOutcome(
            success=False,
            pnl=0.0,
            new_balance=10000.0,
            new_positions=[],
            events=[],
            error=None,
            social_impact=None,
        )
        red_attacker = CounterpartyContext(counterparty_team="red", counterparty_alignment="evil")
        blue_reward, _ = compute_intent_aware_reward(
            blue_action,
            blue_outcome,
            scenario,
            "blue",
            counterparty=red_attacker,
            config=config,
        )

        # Both should be positive — symmetric learning
        assert red_reward > 0, f"Red success should be positive, got {red_reward}"
        assert blue_reward > 0, f"Blue defense should be positive, got {blue_reward}"
