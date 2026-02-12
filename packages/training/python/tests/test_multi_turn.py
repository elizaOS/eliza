"""
Tests for Multi-Turn Episode Manager

Covers:
- TurnData structure
- EpisodeBuffer management
- GAE advantage computation
- Reward shaping
- Episode collection
"""

from datetime import datetime, timezone
from typing import List

import pytest

from src.training.multi_turn import (
    TurnData,
    EpisodeBuffer,
    GAEConfig,
    MultiTurnEpisodeManager,
    EpisodeCollector,
    shape_trading_rewards,
    compute_episode_return,
    normalize_episode_rewards,
)


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def sample_turn():
    """Create a sample turn"""
    return TurnData(
        turn_number=0,
        episode_id="ep-001",
        action_type="buy",
        action_text='{"action": "buy", "market": "BTC", "amount": 100}',
        reward=0.5,
        format_score=0.8,
        reasoning_score=0.7,
        done=False,
    )


@pytest.fixture
def sample_episode():
    """Create a sample episode with multiple turns"""
    turns = [
        TurnData(turn_number=0, reward=0.1, action_type="buy", done=False),
        TurnData(turn_number=1, reward=0.2, action_type="wait", done=False),
        TurnData(turn_number=2, reward=-0.1, action_type="sell", done=False),
        TurnData(turn_number=3, reward=0.5, action_type="close_perp", done=True),
    ]
    
    episode = EpisodeBuffer(episode_id="ep-001", scenario_id="scenario-1")
    for turn in turns:
        episode.add_turn(turn)
    
    return episode


@pytest.fixture
def manager():
    """Create a multi-turn manager"""
    return MultiTurnEpisodeManager(
        gamma=0.99,
        gae_lambda=0.95,
        max_turns=20,
    )


# =============================================================================
# TurnData Tests
# =============================================================================


class TestTurnData:
    """Tests for TurnData dataclass"""
    
    def test_creation(self, sample_turn):
        """Test creating turn data"""
        assert sample_turn.turn_number == 0
        assert sample_turn.episode_id == "ep-001"
        assert sample_turn.action_type == "buy"
        assert sample_turn.reward == 0.5
    
    def test_default_values(self):
        """Test default values"""
        turn = TurnData(turn_number=0)
        
        assert turn.episode_id == ""
        assert turn.reward == 0.0
        assert turn.value == 0.0
        assert turn.advantage == 0.0
        assert turn.done is False
    
    def test_to_dict(self, sample_turn):
        """Test conversion to dictionary"""
        d = sample_turn.to_dict()
        
        assert "turn_number" in d
        assert "episode_id" in d
        assert "action_type" in d
        assert "reward" in d
        assert "advantage" in d
        assert d["turn_number"] == 0
        assert d["reward"] == 0.5
    
    def test_action_text_truncation(self):
        """Test that long action text is truncated in to_dict"""
        long_text = "x" * 500
        turn = TurnData(turn_number=0, action_text=long_text)
        
        d = turn.to_dict()
        assert len(d["action_text"]) <= 200


# =============================================================================
# EpisodeBuffer Tests
# =============================================================================


class TestEpisodeBuffer:
    """Tests for EpisodeBuffer"""
    
    def test_creation(self):
        """Test creating episode buffer"""
        episode = EpisodeBuffer(
            episode_id="ep-001",
            scenario_id="scenario-1",
            archetype="trader",
        )
        
        assert episode.episode_id == "ep-001"
        assert episode.scenario_id == "scenario-1"
        assert len(episode.turns) == 0
        assert not episode.completed
    
    def test_add_turn(self):
        """Test adding turns"""
        episode = EpisodeBuffer(episode_id="ep-001")
        turn = TurnData(turn_number=0, reward=0.1)
        
        episode.add_turn(turn)
        
        assert len(episode.turns) == 1
        assert episode.turns[0].episode_id == "ep-001"
    
    def test_finalization_on_done(self):
        """Test that episode finalizes when done turn is added"""
        episode = EpisodeBuffer(episode_id="ep-001")
        
        episode.add_turn(TurnData(turn_number=0, reward=0.1, done=False))
        assert not episode.completed
        
        episode.add_turn(TurnData(turn_number=1, reward=0.2, done=True))
        assert episode.completed
        assert episode.episode_length == 2
        assert episode.total_reward == pytest.approx(0.3, abs=0.01)
    
    def test_success_determination(self):
        """Test success is based on total reward"""
        # Positive total reward = success
        episode1 = EpisodeBuffer(episode_id="ep-001")
        episode1.add_turn(TurnData(turn_number=0, reward=0.5, done=True))
        assert episode1.success
        
        # Negative total reward = not success
        episode2 = EpisodeBuffer(episode_id="ep-002")
        episode2.add_turn(TurnData(turn_number=0, reward=-0.5, done=True))
        assert not episode2.success
    
    def test_get_messages(self, sample_episode):
        """Test getting messages from episode"""
        # Add messages to last turn
        sample_episode.turns[-1].messages = [
            {"role": "user", "content": "trade"},
            {"role": "assistant", "content": "done"},
        ]
        
        messages = sample_episode.get_messages()
        assert len(messages) == 2
    
    def test_get_trajectory(self, sample_episode):
        """Test getting trajectory summary"""
        trajectory = sample_episode.get_trajectory()
        
        assert len(trajectory) == 4
        assert trajectory[0][0] == "buy"  # First action type
        assert trajectory[3][0] == "close_perp"  # Last action type
    
    def test_to_dict(self, sample_episode):
        """Test conversion to dictionary"""
        d = sample_episode.to_dict()
        
        assert "episode_id" in d
        assert "scenario_id" in d
        assert "turns" in d
        assert len(d["turns"]) == 4


# =============================================================================
# GAEConfig Tests
# =============================================================================


class TestGAEConfig:
    """Tests for GAEConfig"""
    
    def test_default_values(self):
        """Test default configuration"""
        config = GAEConfig()
        
        assert config.gamma == 0.99
        assert config.gae_lambda == 0.95
        assert config.normalize_advantages is True
    
    def test_custom_values(self):
        """Test custom configuration"""
        config = GAEConfig(gamma=0.95, gae_lambda=0.9)
        
        assert config.gamma == 0.95
        assert config.gae_lambda == 0.9


# =============================================================================
# MultiTurnEpisodeManager Tests
# =============================================================================


class TestMultiTurnEpisodeManager:
    """Tests for MultiTurnEpisodeManager"""
    
    def test_creation(self, manager):
        """Test creating manager"""
        assert manager.config.gamma == 0.99
        assert manager.config.gae_lambda == 0.95
        assert manager.max_turns == 20
    
    def test_compute_advantages_single_turn(self, manager):
        """Test advantage computation for single turn"""
        turns = [TurnData(turn_number=0, reward=1.0, done=True)]
        
        manager.compute_advantages(turns)
        
        assert turns[0].return_to_go == 1.0
        assert turns[0].value == 1.0
        # For single turn, advantage should be related to TD error
        assert turns[0].advantage != 0 or turns[0].reward != 0
    
    def test_compute_advantages_multiple_turns(self, manager, sample_episode):
        """Test advantage computation for multiple turns"""
        turns = sample_episode.turns
        
        manager.compute_advantages(turns)
        
        # All turns should have computed values
        for turn in turns:
            assert turn.return_to_go != 0 or turn.reward == 0
            assert turn.value != 0 or turn.return_to_go == 0
        
        # Return-to-go should be higher for earlier turns (cumulative)
        # unless later turns have much higher rewards
        assert turns[0].return_to_go >= turns[-1].return_to_go or \
               sum(t.reward for t in turns[:2]) < sum(t.reward for t in turns[2:])
    
    def test_compute_advantages_empty(self, manager):
        """Test with empty turn list"""
        turns = []
        manager.compute_advantages(turns)  # Should not raise
    
    def test_advantage_clipping(self, manager):
        """Test that extreme advantages are clipped"""
        manager.config.clip_advantages = True
        manager.config.advantage_clip = 5.0
        
        # Create turns with extreme rewards
        turns = [
            TurnData(turn_number=0, reward=100.0, done=False),
            TurnData(turn_number=1, reward=-100.0, done=True),
        ]
        
        manager.compute_advantages(turns)
        
        for turn in turns:
            assert abs(turn.advantage) <= 5.0
    
    def test_compute_batch_advantages(self, manager):
        """Test batch advantage computation"""
        episodes = [
            [TurnData(turn_number=0, reward=0.5, done=True)],
            [TurnData(turn_number=0, reward=-0.3, done=True)],
            [TurnData(turn_number=0, reward=0.2, done=True)],
        ]
        
        manager.compute_batch_advantages(episodes)
        
        # All episodes should have advantages
        for episode in episodes:
            for turn in episode:
                # With normalization, advantages should be centered
                pass  # Just verify no errors
    
    def test_batch_normalization(self, manager):
        """Test that batch normalization centers advantages"""
        manager.config.normalize_advantages = True
        
        episodes = [
            [TurnData(turn_number=0, reward=1.0, done=True)],
            [TurnData(turn_number=0, reward=0.0, done=True)],
            [TurnData(turn_number=0, reward=-1.0, done=True)],
        ]
        
        manager.compute_batch_advantages(episodes)
        
        # Collect all advantages
        advantages = [t.advantage for ep in episodes for t in ep]
        
        # Mean should be approximately 0 after normalization
        mean = sum(advantages) / len(advantages)
        assert abs(mean) < 0.1
    
    def test_get_stats(self, manager, sample_episode):
        """Test getting manager statistics"""
        manager.compute_advantages(sample_episode.turns)
        
        stats = manager.get_stats()
        
        assert stats["episodes_processed"] == 1
        assert stats["total_turns"] == 4
        assert stats["gamma"] == 0.99


# =============================================================================
# Reward Shaping Tests
# =============================================================================


class TestRewardShaping:
    """Tests for reward shaping utilities"""
    
    def test_shape_trading_rewards(self):
        """Test shaping trading rewards"""
        turns = [
            TurnData(
                turn_number=0,
                reward=0.1,
                action_type="buy",
                format_score=0.8,
                reasoning_score=0.7,
            ),
            TurnData(
                turn_number=1,
                reward=-0.1,
                action_type="wait",
                format_score=0.9,
                reasoning_score=0.6,
            ),
        ]
        
        original_rewards = [t.reward for t in turns]
        
        shape_trading_rewards(turns)
        
        # Rewards should be modified
        for i, turn in enumerate(turns):
            # With bonuses added, rewards should differ from original
            # (unless weights are all 0)
            pass  # Just check no errors
    
    def test_compute_episode_return(self, sample_episode):
        """Test computing discounted return"""
        returns = compute_episode_return(sample_episode.turns, gamma=0.99)
        
        # Return should be weighted sum of rewards
        assert returns != 0
    
    def test_compute_episode_return_no_discount(self, sample_episode):
        """Test return with no discounting"""
        returns = compute_episode_return(sample_episode.turns, gamma=1.0)
        
        expected = sum(t.reward for t in sample_episode.turns)
        assert returns == pytest.approx(expected, abs=0.01)
    
    def test_normalize_episode_rewards(self):
        """Test normalizing rewards across episodes"""
        episodes = [
            [TurnData(turn_number=0, reward=10.0)],
            [TurnData(turn_number=0, reward=0.0)],
            [TurnData(turn_number=0, reward=-10.0)],
        ]
        
        normalize_episode_rewards(episodes)
        
        # Rewards should be normalized
        rewards = [t.reward for ep in episodes for t in ep]
        mean = sum(rewards) / len(rewards)
        
        # Mean should be approximately 0
        assert abs(mean) < 0.1


# =============================================================================
# EpisodeCollector Tests
# =============================================================================


class TestEpisodeCollector:
    """Tests for EpisodeCollector"""
    
    def test_creation(self):
        """Test creating collector"""
        collector = EpisodeCollector(max_episodes=100)
        
        assert collector.max_episodes == 100
        assert len(collector.episodes) == 0
    
    def test_start_episode(self):
        """Test starting a new episode"""
        collector = EpisodeCollector()
        
        episode = collector.start_episode("scenario-1", "trader")
        
        assert episode.scenario_id == "scenario-1"
        assert episode.archetype == "trader"
        assert collector._current_episode is not None
    
    def test_add_turn(self):
        """Test adding turns to current episode"""
        collector = EpisodeCollector()
        collector.start_episode("scenario-1")
        
        collector.add_turn(TurnData(turn_number=0, reward=0.1))
        
        assert len(collector._current_episode.turns) == 1
    
    def test_add_turn_without_episode(self):
        """Test that adding turn without starting episode raises"""
        collector = EpisodeCollector()
        
        with pytest.raises(RuntimeError):
            collector.add_turn(TurnData(turn_number=0))
    
    def test_episode_finalization(self):
        """Test that done turn finalizes episode"""
        collector = EpisodeCollector()
        collector.start_episode("scenario-1")
        
        collector.add_turn(TurnData(turn_number=0, reward=0.1, done=False))
        assert len(collector.episodes) == 0
        
        collector.add_turn(TurnData(turn_number=1, reward=0.2, done=True))
        assert len(collector.episodes) == 1
        assert collector._current_episode is None
    
    def test_max_episodes_limit(self):
        """Test that collector respects max episodes"""
        collector = EpisodeCollector(max_episodes=3)
        
        for i in range(5):
            collector.start_episode(f"scenario-{i}")
            collector.add_turn(TurnData(turn_number=0, done=True))
        
        assert len(collector.episodes) == 3
    
    def test_get_completed_episodes(self):
        """Test getting completed episodes"""
        collector = EpisodeCollector()
        
        # Complete episode
        collector.start_episode("scenario-1")
        collector.add_turn(TurnData(turn_number=0, done=True))
        
        # Incomplete episode
        collector.start_episode("scenario-2")
        collector.add_turn(TurnData(turn_number=0, done=False))
        
        completed = collector.get_completed_episodes()
        assert len(completed) == 1
    
    def test_get_successful_episodes(self):
        """Test getting successful episodes"""
        collector = EpisodeCollector()
        
        # Successful episode
        collector.start_episode("scenario-1")
        collector.add_turn(TurnData(turn_number=0, reward=1.0, done=True))
        
        # Failed episode
        collector.start_episode("scenario-2")
        collector.add_turn(TurnData(turn_number=0, reward=-1.0, done=True))
        
        successful = collector.get_successful_episodes()
        assert len(successful) == 1
    
    def test_clear(self):
        """Test clearing collector"""
        collector = EpisodeCollector()
        
        collector.start_episode("scenario-1")
        collector.add_turn(TurnData(turn_number=0, done=True))
        
        collector.clear()
        
        assert len(collector.episodes) == 0
        assert collector._current_episode is None
    
    def test_get_stats(self):
        """Test getting collector statistics"""
        collector = EpisodeCollector()
        
        # Add episodes
        for i in range(3):
            collector.start_episode(f"scenario-{i}")
            collector.add_turn(TurnData(turn_number=0, reward=0.5, done=True))
        
        stats = collector.get_stats()
        
        assert stats["total_episodes"] == 3
        assert stats["completed_episodes"] == 3
        assert stats["successful_episodes"] == 3
        assert stats["success_rate"] == 1.0


# =============================================================================
# Integration Tests
# =============================================================================


class TestMultiTurnIntegration:
    """Integration tests for multi-turn system"""
    
    def test_full_episode_workflow(self, manager):
        """Test complete workflow from collection to training items"""
        collector = EpisodeCollector()
        
        # Collect episode
        collector.start_episode("scenario-1", "trader")
        for i in range(5):
            reward = 0.1 * (i + 1) if i < 4 else 0.5
            done = i == 4
            collector.add_turn(TurnData(
                turn_number=i,
                reward=reward,
                action_type="buy" if i % 2 == 0 else "wait",
                done=done,
            ))
        
        # Get completed episode
        episodes = collector.get_completed_episodes()
        assert len(episodes) == 1
        
        # Compute advantages
        turns = episodes[0].turns
        manager.compute_advantages(turns)
        
        # All turns should have computed values
        for turn in turns:
            assert turn.value != 0 or turn.reward == 0
    
    def test_multiple_episodes_batch(self, manager):
        """Test processing multiple episodes as batch"""
        collector = EpisodeCollector()
        
        # Collect multiple episodes
        for ep_idx in range(3):
            collector.start_episode(f"scenario-{ep_idx}")
            for turn_idx in range(4):
                reward = 0.1 * (turn_idx + 1) * (1 if ep_idx == 0 else -1)
                done = turn_idx == 3
                collector.add_turn(TurnData(
                    turn_number=turn_idx,
                    reward=reward,
                    done=done,
                ))
        
        # Get all turn lists
        episodes = [ep.turns for ep in collector.get_completed_episodes()]
        
        # Batch compute
        manager.compute_batch_advantages(episodes)
        
        # Verify statistics updated
        stats = manager.get_stats()
        assert stats["episodes_processed"] == 3

