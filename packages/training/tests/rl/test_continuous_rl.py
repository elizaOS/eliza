"""Tests for the continuous RL agent and multi-agent orchestrator."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import torch

from src.training.continuous_rl import (
    ContinuousRLAgent,
    ContinuousRLConfig,
    RewardTracker,
    _compute_reward,
)
from src.training.multi_agent_orchestrator import (
    MultiAgentOrchestrator,
    OrchestratorConfig,
)
from src.training.simulation_bridge import (
    ActionOutcome,
    MarketState,
    Scenario,
    SocialContext,
)

# ─── RewardTracker ──────────────────────────────────────────────────────────


class TestRewardTracker:
    def test_first_update_returns_zero_advantage(self) -> None:
        tracker = RewardTracker(ema_alpha=0.1)
        adv = tracker.update(1.0)
        assert adv == 0.0
        assert tracker.mean == 1.0

    def test_subsequent_updates_return_normalized_advantage(self) -> None:
        tracker = RewardTracker(ema_alpha=0.1)
        tracker.update(0.0)  # First: sets mean
        adv = tracker.update(1.0)  # Second: positive advantage
        assert adv > 0.0

    def test_negative_reward_gives_negative_advantage(self) -> None:
        tracker = RewardTracker(ema_alpha=0.1)
        tracker.update(1.0)
        adv = tracker.update(-1.0)
        assert adv < 0.0

    def test_running_mean_converges(self) -> None:
        tracker = RewardTracker(ema_alpha=0.1)
        for _ in range(100):
            tracker.update(5.0)
        assert abs(tracker.mean - 5.0) < 0.01


# ─── ContinuousRLConfig ────────────────────────────────────────────────────


class TestContinuousRLConfig:
    def test_defaults_use_apollo(self) -> None:
        config = ContinuousRLConfig()
        assert config.optimizer == "apollo"
        assert config.use_kondo is True
        assert config.use_turboquant is True
        assert config.kondo_gate_rate == 0.03

    def test_can_disable_everything(self) -> None:
        config = ContinuousRLConfig(
            optimizer="adamw",
            use_kondo=False,
            use_turboquant=False,
        )
        assert config.optimizer == "adamw"
        assert config.use_kondo is False
        assert config.use_turboquant is False


# ─── Reward Computation ────────────────────────────────────────────────────


def _make_scenario(balance: float = 1000.0) -> Scenario:
    return Scenario(
        npc_id="npc_test",
        archetype="trader",
        market_state=MarketState(),
        positions=[],
        balance=balance,
        recent_news=[],
        social_context=SocialContext(),
    )


def _make_outcome(
    success: bool = True,
    pnl: float = 0.0,
    new_balance: float = 1000.0,
) -> ActionOutcome:
    return ActionOutcome(
        success=success,
        pnl=pnl,
        new_balance=new_balance,
        new_positions=[],
        social_impact={},
        events=[],
    )


class TestComputeReward:
    def test_successful_trade_with_positive_pnl(self) -> None:
        action = {"action": "buy"}
        outcome = _make_outcome(success=True, pnl=50.0)
        scenario = _make_scenario(balance=1000.0)
        reward = _compute_reward(action, outcome, scenario)
        assert reward > 0.0

    def test_failed_action_gives_negative_reward(self) -> None:
        action = {"action": "buy"}
        outcome = _make_outcome(success=False)
        outcome.error = "Insufficient balance"
        scenario = _make_scenario()
        reward = _compute_reward(action, outcome, scenario)
        assert reward < 0.0

    def test_wait_action_gives_lower_reward_than_trade(self) -> None:
        scenario = _make_scenario()
        wait_reward = _compute_reward(
            {"action": "wait"},
            _make_outcome(),
            scenario,
        )
        trade_reward = _compute_reward(
            {"action": "buy"},
            _make_outcome(),
            scenario,
        )
        assert trade_reward > wait_reward

    def test_social_impact_adds_reward(self) -> None:
        action = {"action": "post"}
        outcome = _make_outcome(success=True)
        outcome.social_impact = {"likes_received": 5, "reputation_delta": 1}
        scenario = _make_scenario()
        reward = _compute_reward(action, outcome, scenario)
        # Should be higher than base reward from success alone
        base_reward = _compute_reward(
            action,
            _make_outcome(success=True),
            scenario,
        )
        assert reward > base_reward


# ─── ContinuousRLAgent (unit, no actual model) ─────────────────────────────


class TestContinuousRLAgentParsing:
    def test_parse_action_from_think_response(self) -> None:
        agent = ContinuousRLAgent("test", ContinuousRLConfig(device="cpu"))
        response = (
            '<think>Market looks bullish</think>\n{"action": "buy", "market": "m1", "amount": 10}'
        )
        action = agent.parse_action(response)
        assert action is not None
        assert action["action"] == "buy"

    def test_parse_action_from_raw_json(self) -> None:
        agent = ContinuousRLAgent("test", ContinuousRLConfig(device="cpu"))
        response = '{"action": "wait", "reason": "no signal"}'
        action = agent.parse_action(response)
        assert action is not None
        assert action["action"] == "wait"

    def test_parse_action_returns_none_for_garbage(self) -> None:
        agent = ContinuousRLAgent("test", ContinuousRLConfig(device="cpu"))
        action = agent.parse_action("I don't know what to do")
        assert action is None

    def test_get_stats_initial_state(self) -> None:
        agent = ContinuousRLAgent("test", ContinuousRLConfig(device="cpu"))
        stats = agent.get_stats()
        assert stats["total_interactions"] == 0
        assert stats["backward_rate"] == 0.0
        assert stats["cumulative_reward"] == 0.0


# ─── OrchestratorConfig ────────────────────────────────────────────────────


class TestOrchestratorConfig:
    def test_defaults(self) -> None:
        config = OrchestratorConfig()
        assert config.num_agents == 4
        assert config.pbt_enabled is True
        assert config.optimizer == "apollo"

    def test_device_map_auto(self) -> None:
        orchestrator = MultiAgentOrchestrator(OrchestratorConfig())
        devices = orchestrator._resolve_devices()
        assert len(devices) == 4
        # All should be valid device strings
        for d in devices:
            assert "cuda" in d or d == "cpu"

    def test_device_map_explicit(self) -> None:
        config = OrchestratorConfig(
            num_agents=3,
            device_map=["cuda:0", "cuda:1"],
        )
        orchestrator = MultiAgentOrchestrator(config)
        devices = orchestrator._resolve_devices()
        assert len(devices) == 3
        assert devices == ["cuda:0", "cuda:1", "cuda:1"]


# ─── PBT Selection (unit test, mock agents) ────────────────────────────────


class TestPBTSelection:
    def test_pbt_replaces_weakest_agents(self, tmp_path) -> None:
        config = OrchestratorConfig(
            num_agents=4,
            pbt_enabled=True,
            pbt_replace_fraction=0.25,
            checkpoint_dir=str(tmp_path / "ckpts"),
        )
        orchestrator = MultiAgentOrchestrator(config)

        # Create mock agents with different delight values
        for i in range(4):
            agent = ContinuousRLAgent(
                f"agent_{i:03d}",
                ContinuousRLConfig(device="cpu", checkpoint_dir=str(tmp_path / "ckpts")),
            )
            agent.cumulative_delight = float(i * 10)  # 0, 10, 20, 30

            agent.model = torch.nn.Linear(4, 4)
            agent.optimizer = torch.optim.AdamW(agent.model.parameters(), lr=5e-6)
            agent.tokenizer = MagicMock()
            agent.tokenizer.save_pretrained = MagicMock()
            agent.reward_tracker = RewardTracker()
            agent.reward_tracker.mean = 0.5
            agent._checkpoint_history = []
            # Patch save_checkpoint to avoid needing HF model
            agent.save_checkpoint = MagicMock(
                return_value=str(tmp_path / "ckpts" / f"agent_{i:03d}")
            )
            orchestrator.agents.append(agent)

        report = orchestrator.run_pbt_selection()

        assert len(report["replaced"]) == 1
        assert "agent_000" in report["replaced"]  # Weakest (delight=0)
        assert "agent_003" in report["source"]  # Strongest (delight=30)

    def test_pbt_disabled_returns_early(self) -> None:
        config = OrchestratorConfig(pbt_enabled=False)
        orchestrator = MultiAgentOrchestrator(config)
        report = orchestrator.run_pbt_selection()
        assert report == {"pbt": "disabled"}


# ─── _setup_training_components vs setup ────────────────────────────────────


class TestSetupTrainingComponents:
    def test_setup_training_components_creates_optimizer(self) -> None:
        """_setup_training_components should create optimizer without loading model."""
        agent = ContinuousRLAgent(
            "test",
            ContinuousRLConfig(
                device="cpu", optimizer="adamw", use_kondo=False, use_turboquant=False
            ),
        )
        # Manually assign a tiny model (skip full setup which downloads from HF)
        agent.model = torch.nn.Linear(4, 4)
        agent._setup_training_components()
        assert agent.optimizer is not None

    @pytest.mark.skip(
        reason="kondo_gate module was not vendored into eliza/packages/training; "
        "the use_kondo=True path silently no-ops here. Re-enable when KondoGate is restored."
    )
    def test_setup_training_components_creates_kondo_gate(self) -> None:
        agent = ContinuousRLAgent(
            "test",
            ContinuousRLConfig(
                device="cpu", optimizer="adamw", use_kondo=True, use_turboquant=False
            ),
        )
        agent.model = torch.nn.Linear(4, 4)
        agent._setup_training_components()
        assert agent.kondo_gate is not None

    def test_setup_training_components_creates_turboquant(self) -> None:
        agent = ContinuousRLAgent(
            "test",
            ContinuousRLConfig(
                device="cpu", optimizer="adamw", use_kondo=False, use_turboquant=True
            ),
        )
        agent.model = torch.nn.Linear(4, 4)
        agent._setup_training_components()
        assert agent.turboquant_settings is not None
        assert agent.turboquant_settings.key_bits == 3.5


# ─── TurboQuant cache build ────────────────────────────────────────────────


class TestTurboQuantCacheBuild:
    def test_build_generation_cache_dynamic_returns_none(self) -> None:
        from src.training.turboquant import build_generation_cache

        result = build_generation_cache(MagicMock(), cache_implementation="dynamic")
        assert result is None

    def test_build_generation_cache_rejects_unknown_impl(self) -> None:
        from src.training.turboquant import build_generation_cache

        with pytest.raises(ValueError, match="Unsupported"):
            build_generation_cache(MagicMock(), cache_implementation="unknown")

    def test_turboquant_settings_validates_bits(self) -> None:
        from src.training.turboquant import TurboQuantSettings

        settings = TurboQuantSettings(key_bits=3.5, value_bits=2.0, residual_length=64)
        settings.validate()  # Should not raise

    def test_turboquant_settings_rejects_invalid_bits(self) -> None:
        from src.training.turboquant import TurboQuantSettings

        settings = TurboQuantSettings(key_bits=5.0, value_bits=2.0, residual_length=64)
        with pytest.raises(ValueError, match="must be one of"):
            settings.validate()


# ─── Atropos trainer Kondo gate in train_step ───────────────────────────────


class TestAtroposTrainerKondoIntegration:
    def test_config_kondo_and_apollo_together(self) -> None:
        from src.training.atropos_trainer import AtroposTrainingConfig

        config = AtroposTrainingConfig(
            optimizer="apollo",
            use_kondo=True,
            kondo_gate_rate=0.03,
            use_turboquant=True,
        )
        assert config.optimizer == "apollo"
        assert config.use_kondo is True
        assert config.kondo_gate_rate == 0.03
        assert config.use_turboquant is True

    def test_config_kondo_price_overrides_gate_rate(self) -> None:
        from src.training.atropos_trainer import AtroposTrainingConfig

        config = AtroposTrainingConfig(
            use_kondo=True,
            kondo_gate_rate=None,
            kondo_price=1.5,
        )
        assert config.kondo_gate_rate is None
        assert config.kondo_price == 1.5


# ─── Reward edge cases ─────────────────────────────────────────────────────


class TestRewardEdgeCases:
    def test_zero_balance_no_divide_by_zero(self) -> None:
        """Ensure reward computation doesn't crash on zero balance."""
        action = {"action": "buy"}
        outcome = _make_outcome(success=True, pnl=10.0)
        scenario = _make_scenario(balance=0.0)
        reward = _compute_reward(action, outcome, scenario)
        assert isinstance(reward, float)

    def test_large_negative_pnl_clamps(self) -> None:
        """PnL reward should be clamped to [-1, 1]."""
        action = {"action": "sell"}
        outcome = _make_outcome(success=True, pnl=-999999.0)
        scenario = _make_scenario(balance=100.0)
        reward = _compute_reward(action, outcome, scenario)
        # The PnL component is clamped, so total reward shouldn't go below -1
        assert reward >= -1.0

    def test_social_impact_caps_at_02(self) -> None:
        """Social reward capped at 0.2."""
        action = {"action": "post"}
        outcome = _make_outcome(success=True)
        outcome.social_impact = {"likes_received": 1000, "reputation_delta": 100}
        scenario = _make_scenario()
        reward = _compute_reward(action, outcome, scenario)
        # Social cap is 0.2, plus 0.2 success + 0.1 activity = max ~0.5
        assert reward <= 0.6


# ─── Module exports ────────────────────────────────────────────────────────


class TestModuleExports:
    def test_continuous_rl_importable_from_package(self) -> None:
        from src.training import ContinuousRLAgent, ContinuousRLConfig

        assert ContinuousRLAgent is not None
        assert ContinuousRLConfig is not None

    def test_orchestrator_importable_from_package(self) -> None:
        from src.training import MultiAgentOrchestrator, OrchestratorConfig

        assert MultiAgentOrchestrator is not None
        assert OrchestratorConfig is not None

    def test_reward_tracker_importable_from_package(self) -> None:
        from src.training import RewardTracker

        assert RewardTracker is not None
