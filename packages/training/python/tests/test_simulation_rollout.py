"""
Comprehensive tests for simulation, rollout generation, and dataset preparation.

Tests:
1. FastSimulator - benchmark and data generation modes
2. FastRolloutGenerator - rollout creation and quality validation
3. MultiPromptDatasetBuilder - dataset creation from trajectories
4. RolloutQualityValidator - validation logic
5. PromptTypeAnalyzer - correlation analysis
"""

import pytest
from datetime import datetime

import sys
sys.path.insert(0, '.')

from src.models import (
    TrainingTrajectory, TrajectoryStep, EnvironmentState, 
    Action, LLMCall, AtroposScoredGroup
)
from src.training import (
    FastSimulator, SimulatorConfig, GameState,
    RolloutResult, AgentTickData,
    RolloutQualityValidator,
    MultiPromptDatasetBuilder, PromptSample,
    prepare_multi_prompt_training_data, PromptTypeAnalyzer,
)


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def sample_env_state():
    """Create sample environment state"""
    return EnvironmentState(
        agent_balance=10000.0,
        agent_pnl=100.0,
        open_positions=2,
        active_markets=5
    )


@pytest.fixture
def sample_action():
    """Create sample action"""
    return Action(
        action_type='buy',
        parameters={'ticker': 'BTC', 'amount': 0.1},
        success=True
    )


@pytest.fixture
def sample_llm_call():
    """Create sample LLM call"""
    return LLMCall(
        model='gpt-4',
        system_prompt='You are a trading agent.',
        user_prompt='Market update: BTC is up 5%',
        response='I will buy 0.1 BTC',
        reasoning='Price momentum is positive',
        temperature=0.7,
        max_tokens=100,
        purpose='action'
    )


@pytest.fixture
def sample_tick_data(sample_env_state, sample_action, sample_llm_call):
    """Create sample tick data"""
    return AgentTickData(
        tick_number=0,
        timestamp=1000000,
        observation={'markets': [{'id': 'm1', 'price': 50000}]},
        environment_state=sample_env_state,
        llm_calls=[sample_llm_call],
        action=sample_action,
        reward=0.1
    )


@pytest.fixture
def sample_trajectory(sample_env_state, sample_action, sample_llm_call):
    """Create sample trajectory"""
    steps = []
    for i in range(5):
        env = EnvironmentState(
            agent_balance=10000.0 + i * 100,
            agent_pnl=i * 100.0,
            open_positions=i
        )
        steps.append(TrajectoryStep(
            step_number=i,
            timestamp=1000000 + i * 1000,
            environment_state=env,
            provider_accesses=[],
            llm_calls=[LLMCall(
                model='gpt-4',
                system_prompt='You are a trading agent.',
                user_prompt=f'Market update for step {i}: price is moving',
                response=f'I will execute action {i}: buying at current price level',
                reasoning=f'Reasoning for step {i}',
                temperature=0.7,
                max_tokens=100,
                purpose='action'
            )],
            action=Action(
                action_type='trade' if i % 2 == 0 else 'wait',
                parameters={'amount': 100},
                success=True
            ),
            reward=0.1
        ))
    
    return TrainingTrajectory(
        id='traj-1',
        trajectory_id='traj-1',
        agent_id='agent-1',
        window_id='2024-01-01T00:00',
        start_time=datetime.now(),
        end_time=datetime.now(),
        duration_ms=5000,
        steps=steps,
        total_reward=0.5,
        final_pnl=400.0,
        episode_length=5,
        final_status='completed'
    )


# ============================================================
# GameState Tests
# ============================================================

class TestGameState:
    """Tests for GameState dataclass"""
    
    def test_default_initialization(self):
        """Test default GameState values"""
        state = GameState()
        assert state.tick == 0
        assert state.time == 0
        assert state.markets == []
        assert state.portfolios == {}
    
    def test_to_observation(self):
        """Test observation conversion"""
        state = GameState(
            tick=5,
            time=1000000,
            markets=[{'id': 'm1'}],
            news=[{'headline': 'News 1'}, {'headline': 'News 2'}]
        )
        obs = state.to_observation()
        
        assert obs['tick'] == 5
        assert obs['time'] == 1000000
        assert len(obs['markets']) == 1
        assert 'news' in obs
    
    def test_get_env_state(self):
        """Test environment state extraction"""
        state = GameState(
            portfolios={
                'agent-1': {'balance': 15000.0, 'pnl': 500.0, 'positions': 3}
            }
        )
        
        env = state.get_env_state('agent-1')
        assert env.agent_balance == 15000.0
        assert env.agent_pnl == 500.0
        assert env.open_positions == 3
    
    def test_get_env_state_unknown_agent(self):
        """Test environment state for unknown agent"""
        state = GameState()
        env = state.get_env_state('unknown-agent')
        
        # Should return default values
        assert env.agent_balance == 10000.0
        assert env.agent_pnl == 0.0
        assert env.open_positions == 0


# ============================================================
# SimulatorConfig Tests
# ============================================================

class TestSimulatorConfig:
    """Tests for SimulatorConfig"""
    
    def test_default_config(self):
        """Test default configuration"""
        config = SimulatorConfig()
        assert config.mode == 'data_generation'
        assert config.max_concurrent_agents == 8
        assert config.batch_size == 4
        assert config.ticks_per_window == 60
        assert config.min_actions_per_trajectory == 5
    
    def test_benchmark_mode_config(self):
        """Test benchmark mode configuration"""
        config = SimulatorConfig(
            mode='benchmark',
            benchmark_snapshot={'ticks': []},
            ground_truth={'marketOutcomes': {}}
        )
        assert config.mode == 'benchmark'
        assert config.benchmark_snapshot is not None
        assert config.ground_truth is not None


# ============================================================
# FastSimulator Tests
# ============================================================

class TestFastSimulator:
    """Tests for FastSimulator"""
    
    def test_for_benchmark(self):
        """Test benchmark mode creation"""
        snapshot = {
            'ticks': [
                {'state': {'currentTime': 1000}},
                {'state': {'currentTime': 2000}}
            ],
            'groundTruth': {'marketOutcomes': {}},
            'initialState': {
                'predictionMarkets': [{'id': 'm1'}],
                'currentTime': 1000
            }
        }
        
        sim = FastSimulator.for_benchmark(snapshot)
        
        assert sim.config.mode == 'benchmark'
        assert len(sim.benchmark_ticks) == 2
        assert sim.game_state.markets == [{'id': 'm1'}]
    
    def test_is_complete_benchmark(self):
        """Test completion check in benchmark mode"""
        snapshot = {'ticks': [{}] * 5, 'groundTruth': {}, 'initialState': {}}
        sim = FastSimulator.for_benchmark(snapshot)
        
        assert not sim.is_complete()
        sim.current_tick = 5
        assert sim.is_complete()
    
    def test_is_complete_data_generation(self):
        """Test completion check in data generation mode"""
        config = SimulatorConfig(max_ticks=100)
        sim = FastSimulator(config)
        
        assert not sim.is_complete()
        sim.current_tick = 100
        assert sim.is_complete()
    
    def test_advance_tick(self):
        """Test tick advancement"""
        config = SimulatorConfig()
        sim = FastSimulator(config)
        
        initial_tick = sim.current_tick
        initial_time = sim.game_state.time
        
        sim._advance_tick()
        
        assert sim.current_tick == initial_tick + 1
        assert sim.game_state.time == initial_time + 1000


# ============================================================
# AgentTickData Tests
# ============================================================

class TestAgentTickData:
    """Tests for AgentTickData"""
    
    def test_get_full_context(self, sample_tick_data):
        """Test full context generation"""
        context = sample_tick_data.get_full_context()
        
        assert '=== OBSERVATION' in context
        assert '=== LLM CALL 1' in context
        assert '=== ACTION ===' in context
        assert 'buy' in context.lower()
    
    def test_get_full_context_no_action(self, sample_env_state, sample_llm_call):
        """Test context without action"""
        tick = AgentTickData(
            tick_number=0,
            timestamp=1000000,
            observation={},
            environment_state=sample_env_state,
            llm_calls=[sample_llm_call],
            action=None,
            reward=0.0
        )
        
        context = tick.get_full_context()
        assert '=== OBSERVATION' in context
        assert '=== ACTION ===' not in context


# ============================================================
# RolloutQualityValidator Tests
# ============================================================

class TestRolloutQualityValidator:
    """Tests for RolloutQualityValidator"""
    
    def test_validate_valid_rollout(self, sample_trajectory):
        """Test validation of valid rollout"""
        result = RolloutResult(
            agent_id='test',
            trajectory_id='test-traj',
            ticks_completed=10,
            total_duration_ms=5000,
            avg_tick_duration_ms=500.0,
            total_llm_calls=15,
            total_reward=5.0,
            final_pnl=500.0,
            quality_score=0.7,
            trajectory=sample_trajectory
        )
        
        is_valid, issues = RolloutQualityValidator.validate_rollout(result)
        
        # Should have some issues due to LLM call requirements per step
        assert isinstance(is_valid, bool)
        assert isinstance(issues, list)
    
    def test_validate_no_trajectory(self):
        """Test validation with no trajectory"""
        result = RolloutResult(
            agent_id='test',
            trajectory_id='test-traj',
            ticks_completed=10,
            total_duration_ms=5000,
            avg_tick_duration_ms=500.0,
            total_llm_calls=15,
            total_reward=5.0,
            final_pnl=500.0,
            quality_score=0.7,
            trajectory=None
        )
        
        is_valid, issues = RolloutQualityValidator.validate_rollout(result)
        
        assert not is_valid
        assert 'No trajectory data' in issues
    
    def test_validate_too_few_ticks(self, sample_trajectory):
        """Test validation with too few ticks"""
        result = RolloutResult(
            agent_id='test',
            trajectory_id='test-traj',
            ticks_completed=3,  # Less than 5
            total_duration_ms=1500,
            avg_tick_duration_ms=500.0,
            total_llm_calls=3,
            total_reward=0.3,
            final_pnl=100.0,
            quality_score=0.3,
            trajectory=sample_trajectory
        )
        
        is_valid, issues = RolloutQualityValidator.validate_rollout(result)
        
        # Should flag too few ticks
        assert any('Too few ticks' in issue for issue in issues)
    
    def test_validate_low_quality_score(self, sample_trajectory):
        """Test validation with low quality score"""
        result = RolloutResult(
            agent_id='test',
            trajectory_id='test-traj',
            ticks_completed=10,
            total_duration_ms=5000,
            avg_tick_duration_ms=500.0,
            total_llm_calls=10,
            total_reward=1.0,
            final_pnl=100.0,
            quality_score=0.3,  # Below 0.5 threshold
            trajectory=sample_trajectory
        )
        
        is_valid, issues = RolloutQualityValidator.validate_rollout(result)
        
        # Should flag low quality
        assert any('Quality score too low' in issue for issue in issues)


# ============================================================
# MultiPromptDatasetBuilder Tests
# ============================================================

class TestMultiPromptDatasetBuilder:
    """Tests for MultiPromptDatasetBuilder"""
    
    def test_initialization(self):
        """Test builder initialization"""
        builder = MultiPromptDatasetBuilder()
        
        assert len(builder.datasets) == 4
        assert 'action' in builder.datasets
        assert 'reasoning' in builder.datasets
        assert 'evaluation' in builder.datasets
        assert 'response' in builder.datasets
        assert builder.total_trajectories == 0
    
    def test_add_trajectory(self, sample_trajectory):
        """Test adding trajectory"""
        builder = MultiPromptDatasetBuilder()
        
        samples_added = builder.add_trajectory(sample_trajectory, trajectory_score=0.8)
        
        assert samples_added == 5  # One per step
        assert builder.total_trajectories == 1
        assert builder.total_steps == 5
        assert builder.total_samples == 5
    
    def test_get_statistics(self, sample_trajectory):
        """Test statistics calculation"""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(sample_trajectory, trajectory_score=0.8)
        
        stats = builder.get_statistics()
        
        assert stats['total_trajectories'] == 1
        assert stats['total_samples'] == 5
        assert 'by_purpose' in stats
        assert 'action' in stats['by_purpose']
    
    def test_build_training_data(self, sample_trajectory):
        """Test training data building"""
        builder = MultiPromptDatasetBuilder()
        
        # Add multiple trajectories
        for i in range(4):
            builder.add_trajectory(sample_trajectory, trajectory_score=0.5 + i * 0.1)
        
        groups = builder.build_training_data(purpose='action', group_size=4)
        
        # Should create some groups
        assert isinstance(groups, list)
        if groups:
            assert isinstance(groups[0], AtroposScoredGroup)


# ============================================================
# PromptSample Tests
# ============================================================

class TestPromptSample:
    """Tests for PromptSample"""
    
    def test_to_messages(self):
        """Test message conversion"""
        sample = PromptSample(
            trajectory_id='t1',
            step_number=0,
            call_index=0,
            system_prompt='You are a trading agent.',
            user_prompt='What should I do?',
            response='Buy BTC',
            purpose='action',
            action_type='buy',
            model='gpt-4',
            temperature=0.7,
            trajectory_score=0.8,
            step_reward=0.1,
            action_success=True,
            environment_context={'balance': 10000},
            previous_actions=['wait']
        )
        
        messages = sample.to_messages()
        
        assert len(messages) == 3
        assert messages[0]['role'] == 'system'
        assert messages[1]['role'] == 'user'
        assert messages[2]['role'] == 'assistant'
    
    def test_get_weighted_score(self):
        """Test weighted score calculation"""
        sample = PromptSample(
            trajectory_id='t1',
            step_number=0,
            call_index=0,
            system_prompt='sys',
            user_prompt='user',
            response='resp',
            purpose='action',
            action_type='buy',
            model='gpt-4',
            temperature=0.7,
            trajectory_score=0.8,
            step_reward=0.1,
            action_success=True,
            environment_context={},
            previous_actions=[]
        )
        
        score = sample.get_weighted_score()
        
        # Should be higher than base due to success bonus and step reward
        assert score > 0.8
        assert score <= 1.0


# ============================================================
# PromptTypeAnalyzer Tests
# ============================================================

class TestPromptTypeAnalyzer:
    """Tests for PromptTypeAnalyzer"""
    
    def test_analyze_correlation(self, sample_trajectory):
        """Test correlation analysis"""
        trajs = [sample_trajectory]
        scores = [0.8]
        
        analysis = PromptTypeAnalyzer.analyze_correlation(trajs, scores)
        
        assert 'prompt_count_by_purpose' in analysis
        assert 'avg_length_by_purpose' in analysis
        assert 'high_score_characteristics' in analysis
        assert 'low_score_characteristics' in analysis
    
    def test_analyze_high_low_scores(self, sample_trajectory):
        """Test high/low score classification"""
        # Create trajectories with different scores
        trajs = [sample_trajectory, sample_trajectory]
        scores = [0.9, 0.2]  # One high, one low
        
        analysis = PromptTypeAnalyzer.analyze_correlation(trajs, scores)
        
        # Should have entries in both
        assert len(analysis['high_score_characteristics']) > 0
        assert len(analysis['low_score_characteristics']) > 0


# ============================================================
# Integration Tests
# ============================================================

class TestIntegration:
    """Integration tests for the full pipeline"""
    
    def test_prepare_multi_prompt_training_data(self, sample_trajectory):
        """Test convenience function"""
        trajectories = [sample_trajectory] * 4
        scores = [0.8, 0.6, 0.4, 0.9]
        
        result = prepare_multi_prompt_training_data(
            trajectories=trajectories,
            scores=scores,
            group_size=4
        )
        
        # Should return dict with purposes as keys
        assert isinstance(result, dict)
        # May or may not have groups depending on variance
    
    def test_trajectory_count_score_mismatch(self, sample_trajectory):
        """Test error on mismatched counts"""
        with pytest.raises(ValueError, match='Trajectory count'):
            prepare_multi_prompt_training_data(
                trajectories=[sample_trajectory],
                scores=[0.8, 0.6]  # Wrong count
            )


# Run tests
if __name__ == "__main__":
    pytest.main([__file__, "-v"])

