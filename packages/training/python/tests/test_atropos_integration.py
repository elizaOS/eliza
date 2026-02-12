"""
Integration tests for Atropos RLAIF implementation

Tests:
1. Module imports work correctly
2. Data conversion functions work
3. Reward functions produce valid outputs
4. Environment can be instantiated (mock mode)
"""

import pytest
from datetime import datetime
from typing import Dict

# Check for optional dependencies
try:
    import torch  # noqa: F401
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

try:
    import wandb  # noqa: F401
    HAS_WANDB = True
except ImportError:
    HAS_WANDB = False

requires_torch = pytest.mark.skipif(not HAS_TORCH, reason="torch not installed")
requires_wandb = pytest.mark.skipif(not HAS_WANDB, reason="wandb not installed")


# Test imports work
class TestImports:
    """Verify all modules can be imported"""
    
    def test_import_models(self):
        from src.models import (
            TrainingTrajectory,
            AtroposScoredGroup,
        )
        assert TrainingTrajectory is not None
        assert AtroposScoredGroup is not None
        
    def test_import_converter(self):
        from src.data_bridge import (
            TrajectoryToAtroposConverter,
            ScoredGroupResult,
        )
        assert TrajectoryToAtroposConverter is not None
        assert ScoredGroupResult is not None
        
    def test_import_rewards(self):
        from src.training.rewards import (
            pnl_reward,
            RewardNormalizer,
        )
        assert pnl_reward is not None
        assert RewardNormalizer is not None
    
    @requires_torch
    def test_import_trainer(self):
        from src.training import (
            AtroposTrainer,
        )
        assert AtroposTrainer is not None
    
    @requires_wandb
    def test_import_environment(self):
        from src.training import (
            RLAIFEnv,
        )
        assert RLAIFEnv is not None


class TestRewardFunctions:
    """Test reward calculation functions using archetype-aware API"""
    
    def test_pnl_reward_positive(self):
        from src.training.rewards import pnl_reward, TrajectoryRewardInputs
        
        # Positive P&L should give positive reward
        inputs = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
        )
        reward = pnl_reward(inputs)
        assert reward > 0.0
        
    def test_pnl_reward_negative(self):
        from src.training.rewards import pnl_reward, TrajectoryRewardInputs
        
        # Negative P&L should give negative reward
        inputs = TrajectoryRewardInputs(
            final_pnl=-500.0,
            starting_balance=10000.0,
            end_balance=9500.0,
        )
        reward = pnl_reward(inputs)
        assert reward < 0.0
        
    def test_pnl_reward_zero(self):
        from src.training.rewards import pnl_reward, TrajectoryRewardInputs
        
        # Zero P&L should give ~0
        inputs = TrajectoryRewardInputs(
            final_pnl=0.0,
            starting_balance=10000.0,
            end_balance=10000.0,
        )
        reward = pnl_reward(inputs)
        assert -0.1 <= reward <= 0.1
        
    def test_archetype_composite_reward(self):
        from src.training.rewards import (
            archetype_composite_reward,
            TrajectoryRewardInputs,
            BehaviorMetrics,
        )
        
        inputs = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
            format_score=0.8,
            reasoning_score=0.75,
        )
        behavior = BehaviorMetrics(
            trades_executed=5,
            total_pnl=500.0,
            episode_length=10,
        )
        
        reward = archetype_composite_reward(inputs, "trader", behavior)
        assert 0.0 <= reward <= 1.0
        
    def test_composite_reward_with_inputs(self):
        from src.training.rewards import composite_reward, TrajectoryRewardInputs
        
        inputs = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
        )
        
        reward = composite_reward(inputs)
        assert 0.0 <= reward <= 1.0
        
    def test_relative_scores(self):
        from src.training.rewards import relative_scores
        
        # relative_scores expects a list of raw reward floats
        rewards = [0.8, 0.5, 0.2]  # High, medium, low rewards
        
        scores = relative_scores(rewards)
        
        # Should return normalized scores in [0, 1]
        assert all(0.0 <= s <= 1.0 for s in scores)
        # Best reward should have highest relative score
        assert scores[0] > scores[1] > scores[2]
        
    def test_reward_normalizer(self):
        from src.training.rewards import RewardNormalizer
        
        normalizer = RewardNormalizer()
        
        # Update with some rewards
        for r in [0.5, 0.6, 0.7, 0.8, 0.55, 0.65, 0.75, 0.85]:
            normalizer.update(r)
        
        # Normalize should work
        normalized = normalizer.normalize(0.65)
        assert isinstance(normalized, float)


class TestConverter:
    """Test Trajectory to Atropos conversion"""
    
    def create_sample_trajectory(self) -> Dict:
        """Create a sample trajectory for testing"""
        from src.models import (
            TrainingTrajectory,
            TrajectoryStep,
            EnvironmentState,
            Action,
            LLMCall,
        )
        
        steps = []
        for i in range(5):
            step = TrajectoryStep(
                step_number=i,
                timestamp=1000000 + i * 1000,
                environment_state=EnvironmentState(
                    agent_balance=10000.0 + i * 100,
                    agent_pnl=i * 100.0,
                    open_positions=i,
                ),
                provider_accesses=[],
                llm_calls=[
                    LLMCall(
                        model="gpt-4",
                        system_prompt="You are a trading agent",
                        user_prompt=f"Market update {i}",
                        response=f"Action {i}",
                        temperature=0.7,
                        max_tokens=100,
                        purpose="action",
                    )
                ],
                action=Action(
                    action_type="trade",
                    parameters={"amount": 100},
                    success=True,
                ),
                reward=0.1,
            )
            steps.append(step)
            
        return TrainingTrajectory(
            id="test-1",
            trajectory_id="traj-1",
            agent_id="agent-1",
            window_id="2024-01-01T00:00",
            start_time=datetime.now(),
            end_time=datetime.now(),
            duration_ms=5000,
            steps=steps,
            total_reward=0.5,
            final_pnl=400.0,
            episode_length=5,
            final_status="completed",
        )
        
    def test_convert_trajectory(self):
        from src.data_bridge import TrajectoryToAtroposConverter
        
        converter = TrajectoryToAtroposConverter()
        traj = self.create_sample_trajectory()
        
        result = converter.convert_trajectory(traj)
        
        assert result is not None
        assert len(result.messages) >= 3  # system + at least one exchange
        assert result.metadata["trajectory_id"] == "traj-1"
        assert result.metadata["final_pnl"] == 400.0
        
    def test_convert_window_group(self):
        from src.data_bridge import TrajectoryToAtroposConverter
        
        converter = TrajectoryToAtroposConverter()
        trajs = [self.create_sample_trajectory() for _ in range(4)]
        
        # Modify trajectory IDs
        for i, t in enumerate(trajs):
            t.trajectory_id = f"traj-{i}"
            
        result = converter.convert_window_group(trajs, None)
        
        assert result.group_size == 4
        assert len(result.scores) == 4
        assert len(result.messages) == 4
        
    def test_dropout(self):
        from src.data_bridge import TrajectoryToAtroposConverter
        
        # High dropout should skip some trajectories
        converter = TrajectoryToAtroposConverter(dropout_rate=0.5)
        
        dropped_count = 0
        for _ in range(100):
            traj = self.create_sample_trajectory()
            result = converter.convert_trajectory(traj)
            if result is None:
                dropped_count += 1
                
        # Should drop roughly 50%
        assert 30 < dropped_count < 70


@requires_torch
class TestTrainerConfig:
    """Test trainer configuration (requires torch)"""
    
    def test_default_config(self):
        from src.training import AtroposTrainingConfig
        
        config = AtroposTrainingConfig()
        
        assert config.model_name == "Qwen/Qwen2.5-3B-Instruct"
        assert config.learning_rate == 1e-5
        assert config.training_steps == 100
        
    def test_custom_config(self):
        from src.training import AtroposTrainingConfig
        
        config = AtroposTrainingConfig(
            model_name="Qwen/Qwen2.5-7B-Instruct",
            training_steps=50,
            learning_rate=5e-6,
        )
        
        assert config.model_name == "Qwen/Qwen2.5-7B-Instruct"
        assert config.training_steps == 50
        assert config.learning_rate == 5e-6


@requires_wandb
class TestEnvironmentConfig:
    """Test environment configuration (requires wandb)"""
    
    def test_default_config(self):
        from src.training import RLAIFEnvConfig
        
        config = RLAIFEnvConfig()
        
        assert config.group_size == 4
        assert config.lookback_hours == 72
        assert config.min_agents_per_window == 2
        
    def test_custom_config(self):
        from src.training import RLAIFEnvConfig
        
        config = RLAIFEnvConfig(
            group_size=8,
            lookback_hours=48,
            judge_model="gpt-4",
        )
        
        assert config.group_size == 8
        assert config.lookback_hours == 48
        assert config.judge_model == "gpt-4"


class TestCalculateDropoutRate:
    """Test dropout rate calculation"""
    
    def test_no_dropout_needed(self):
        from src.data_bridge import calculate_dropout_rate
        
        rate = calculate_dropout_rate(500, target_trajectories=1000)
        assert rate == 0.0
        
    def test_dropout_needed(self):
        from src.data_bridge import calculate_dropout_rate
        
        rate = calculate_dropout_rate(2000, target_trajectories=1000)
        assert 0.0 < rate <= 0.3
        
    def test_max_dropout_cap(self):
        from src.data_bridge import calculate_dropout_rate
        
        rate = calculate_dropout_rate(10000, target_trajectories=1000, max_dropout=0.2)
        assert rate == 0.2


# Run tests with: pytest tests/test_atropos_integration.py -v
if __name__ == "__main__":
    pytest.main([__file__, "-v"])

