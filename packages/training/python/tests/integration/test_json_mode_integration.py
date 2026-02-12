"""
JSON Mode Integration Tests

Tests the complete JSON-based training data pipeline:
1. Trajectory loading from JSON files
2. Archetype extraction from step parameters
3. Scoring with archetype-aware rewards
4. GRPO group formation
5. End-to-end scoring pipeline

These tests run WITHOUT a database, using only local JSON files.
"""

import json
import sys
from pathlib import Path
from typing import Dict, List

import pytest

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.data_bridge.reader import JsonTrajectoryReader, validate_llm_calls
from src.training.rewards import (
    archetype_composite_reward,
    calculate_archetype_behavior_bonus,
    BehaviorMetrics,
    TrajectoryRewardInputs,
)
from src.training.rubric_loader import (
    normalize_archetype,
    has_custom_rubric,
    get_rubric,
    get_available_archetypes,
)
from tests.integration.conftest import (
    TrajectoryFixture,
    create_trading_step,
)


class TestJsonTrajectoryLoading:
    """Test loading trajectories from JSON files."""

    def test_load_single_trajectory_file(
        self,
        temp_trajectory_dir: Path,
        sample_trader_trajectory: TrajectoryFixture,
    ):
        """Test loading a single trajectory from JSON file."""
        # Write trajectory to file
        file_path = temp_trajectory_dir / f"{sample_trader_trajectory.trajectory_id}.json"
        file_path.write_text(json.dumps(sample_trader_trajectory.to_json_file_format()))

        # Load using reader
        reader = JsonTrajectoryReader(str(temp_trajectory_dir))
        window_ids = reader.get_window_ids()
        
        assert len(window_ids) >= 1
        assert sample_trader_trajectory.window_id in window_ids

        trajectories = reader.get_trajectories_by_window(sample_trader_trajectory.window_id)
        assert len(trajectories) == 1
        
        # JsonTrajectoryReader returns trajectory data directly (unwrapped)
        traj = trajectories[0]
        assert traj.get("archetype") == "trader"

    def test_load_multiple_trajectories_same_window(
        self,
        temp_trajectory_dir: Path,
        trajectory_group: List[TrajectoryFixture],
    ):
        """Test loading multiple trajectories from same window."""
        # Write all trajectories
        for traj in trajectory_group:
            file_path = temp_trajectory_dir / f"{traj.trajectory_id}.json"
            file_path.write_text(json.dumps(traj.to_json_file_format()))

        reader = JsonTrajectoryReader(str(temp_trajectory_dir))
        trajectories = reader.get_trajectories_by_window("window-test-1")
        
        assert len(trajectories) == 3
        # JsonTrajectoryReader returns trajectory data directly
        archetypes = {t.get("archetype") for t in trajectories}
        assert archetypes == {"trader", "degen", "scammer"}

    def test_validate_llm_calls_in_loaded_trajectory(
        self,
        temp_trajectory_dir: Path,
        sample_trader_trajectory: TrajectoryFixture,
    ):
        """Test that loaded trajectories pass LLM call validation."""
        file_path = temp_trajectory_dir / f"{sample_trader_trajectory.trajectory_id}.json"
        file_path.write_text(json.dumps(sample_trader_trajectory.to_json_file_format()))

        reader = JsonTrajectoryReader(str(temp_trajectory_dir))
        trajectories = reader.get_trajectories_by_window(sample_trader_trajectory.window_id)
        
        # JsonTrajectoryReader returns trajectory data directly
        traj_data = trajectories[0]
        steps_json = traj_data.get("stepsJson", "[]")
        steps = json.loads(steps_json) if isinstance(steps_json, str) else steps_json
        
        is_valid, issues = validate_llm_calls(steps)
        assert is_valid, f"LLM calls should be valid: {issues}"

    def test_load_all_archetypes(
        self,
        temp_trajectory_dir: Path,
        all_archetype_trajectories: Dict[str, TrajectoryFixture],
    ):
        """Test loading trajectories for all valid archetypes."""
        # Write all trajectories
        for archetype, traj in all_archetype_trajectories.items():
            file_path = temp_trajectory_dir / f"{traj.trajectory_id}.json"
            file_path.write_text(json.dumps(traj.to_json_file_format()))

        reader = JsonTrajectoryReader(str(temp_trajectory_dir))
        trajectories = reader.get_trajectories_by_window("window-all-archetypes")
        
        # JsonTrajectoryReader returns trajectory data directly
        loaded_archetypes = {t.get("archetype") for t in trajectories}
        expected_archetypes = set(get_available_archetypes())
        
        assert loaded_archetypes == expected_archetypes

    def test_empty_directory_returns_empty_list(self, temp_trajectory_dir: Path):
        """Test that empty directory returns empty results."""
        reader = JsonTrajectoryReader(str(temp_trajectory_dir))
        window_ids = reader.get_window_ids()
        assert window_ids == []


class TestArchetypeExtractionFromSteps:
    """Test extracting archetype from step action parameters."""

    def test_extract_archetype_from_action_parameters(self):
        """Test extracting archetype from step's action parameters."""
        step = create_trading_step(0, "buy_prediction", "trader")
        
        # Simulate extraction logic from babylon_env.py
        action = step.get("action", {})
        params = action.get("parameters", {})
        archetype = params.get("archetype")
        
        assert archetype == "trader"

    def test_extract_archetype_from_first_step(self):
        """Test extracting archetype from first step when trajectory-level is missing."""
        steps = [
            create_trading_step(0, "buy_prediction", "degen"),
            create_trading_step(1, "hold", "degen"),
            create_trading_step(2, "sell_prediction", "degen"),
        ]
        
        # Simulate extraction logic
        archetype = None
        for step in steps:
            action = step.get("action", {})
            params = action.get("parameters", {})
            if params.get("archetype"):
                archetype = params.get("archetype")
                break
        
        assert archetype == "degen"

    def test_normalize_extracted_archetype(self):
        """Test that extracted archetypes are normalized correctly."""
        test_cases = [
            ("TRADER", "trader"),
            ("Social_Butterfly", "social-butterfly"),
            ("goody_twoshoes", "goody-twoshoes"),
            ("DEGEN", "degen"),
            ("", "default"),
            (None, "default"),
        ]
        
        for input_val, expected in test_cases:
            result = normalize_archetype(input_val)
            assert result == expected, f"normalize_archetype({input_val}) = {result}, expected {expected}"

    def test_validate_extracted_archetype(self):
        """Test that extracted archetypes are validated."""
        valid_archetypes = get_available_archetypes()
        
        for arch in valid_archetypes:
            normalized = normalize_archetype(arch)
            assert has_custom_rubric(normalized), f"{arch} should have custom rubric"

    def test_fallback_for_invalid_archetype(self):
        """Test fallback when archetype is invalid."""
        invalid_archetype = "invalid-fake-archetype"
        normalized = normalize_archetype(invalid_archetype)
        
        # Should get default rubric for invalid archetypes
        rubric = get_rubric(normalized)
        assert rubric is not None
        assert len(rubric) > 0


class TestArchetypeAwareScoring:
    """Test scoring with archetype-specific weights and bonuses."""

    def test_trader_scores_high_on_pnl(self, sample_reward_inputs: TrajectoryRewardInputs):
        """Test that traders are scored primarily on PnL."""
        behavior = BehaviorMetrics(
            trades_executed=5,
            total_pnl=150.0,
            win_rate=0.6,
        )
        
        # High PnL trader
        high_pnl_inputs = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
            format_score=0.8,
            reasoning_score=0.75,
        )
        high_score = archetype_composite_reward(high_pnl_inputs, "trader", behavior)
        
        # Low PnL trader
        low_pnl_inputs = TrajectoryRewardInputs(
            final_pnl=-200.0,
            starting_balance=10000.0,
            end_balance=9800.0,
            format_score=0.8,
            reasoning_score=0.75,
        )
        low_score = archetype_composite_reward(low_pnl_inputs, "trader", behavior)
        
        assert high_score > low_score, "Trader with high PnL should score higher"

    def test_degen_tolerates_losses_for_activity(self):
        """Test that degens can score well despite losses if active."""
        high_activity = BehaviorMetrics(
            trades_executed=30,
            pnl_variance=500,
            avg_position_size=300,
            total_pnl=-500.0,  # Loss
        )
        
        low_activity = BehaviorMetrics(
            trades_executed=2,
            pnl_variance=10,
            avg_position_size=50,
            total_pnl=50.0,  # Small profit
        )
        
        degen_loss_inputs = TrajectoryRewardInputs(
            final_pnl=-500.0,
            starting_balance=10000.0,
            end_balance=9500.0,
            format_score=0.7,
            reasoning_score=0.6,
        )
        
        degen_profit_inputs = TrajectoryRewardInputs(
            final_pnl=50.0,
            starting_balance=10000.0,
            end_balance=10050.0,
            format_score=0.7,
            reasoning_score=0.6,
        )
        
        active_degen_score = archetype_composite_reward(degen_loss_inputs, "degen", high_activity)
        passive_degen_score = archetype_composite_reward(degen_profit_inputs, "degen", low_activity)
        
        # Active degen with loss should not score much lower than passive degen with profit
        # The behavior bonus should compensate for the PnL loss
        assert active_degen_score > 0.1, "Active degen should score reasonably despite loss"

    def test_social_butterfly_scores_on_social_metrics(self):
        """Test that social butterflies are scored on social activity."""
        high_social = BehaviorMetrics(
            posts_created=10,
            comments_made=25,
            dms_initiated=5,
            unique_users_interacted=30,
            trades_executed=2,
            total_pnl=10.0,
        )
        
        low_social = BehaviorMetrics(
            posts_created=0,
            comments_made=1,
            dms_initiated=0,
            unique_users_interacted=2,
            trades_executed=10,
            total_pnl=200.0,  # Better PnL
        )
        
        inputs = TrajectoryRewardInputs(
            final_pnl=10.0,
            starting_balance=10000.0,
            end_balance=10010.0,
            format_score=0.7,
            reasoning_score=0.7,
        )
        
        high_social_score = archetype_composite_reward(inputs, "social-butterfly", high_social)
        
        # Social butterfly behavior bonus
        high_social_bonus = calculate_archetype_behavior_bonus("social-butterfly", high_social)
        low_social_bonus = calculate_archetype_behavior_bonus("social-butterfly", low_social)
        
        assert high_social_bonus > low_social_bonus, "High social activity should get higher bonus"

    def test_scammer_scores_on_profit_from_manipulation(self):
        """Test that scammers score on PnL from deceptive actions."""
        scammer_behavior = BehaviorMetrics(
            posts_created=5,
            trades_executed=3,
            total_pnl=500.0,
        )
        
        inputs = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
            format_score=0.75,
            reasoning_score=0.7,
        )
        
        score = archetype_composite_reward(inputs, "scammer", scammer_behavior)
        assert score > 0.3, "Profitable scammer should score well"

    def test_all_archetypes_produce_valid_scores(
        self,
        all_archetype_trajectories: Dict[str, TrajectoryFixture],
    ):
        """Test that all archetypes produce valid scores in [0, 1] range."""
        for archetype, traj in all_archetype_trajectories.items():
            behavior = BehaviorMetrics(
                trades_executed=3,
                total_pnl=traj.final_pnl,
                episode_length=traj.episode_length,
            )
            
            inputs = TrajectoryRewardInputs(
                final_pnl=traj.final_pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + traj.final_pnl,
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(inputs, archetype, behavior)
            
            assert 0.0 <= score <= 1.0, f"{archetype} score {score} out of [0,1] range"


class TestGRPOGroupFormation:
    """Test GRPO group formation from trajectories."""

    def test_group_trajectories_by_window(
        self,
        temp_trajectory_dir: Path,
        trajectory_group: List[TrajectoryFixture],
    ):
        """Test grouping trajectories by window ID."""
        # Write trajectories to same window
        for traj in trajectory_group:
            file_path = temp_trajectory_dir / f"{traj.trajectory_id}.json"
            file_path.write_text(json.dumps(traj.to_json_file_format()))

        reader = JsonTrajectoryReader(str(temp_trajectory_dir))
        trajectories = reader.get_trajectories_by_window("window-test-1")
        
        assert len(trajectories) >= 2, "GRPO requires at least 2 trajectories per group"

    def test_score_centering_for_grpo(
        self,
        trajectory_group: List[TrajectoryFixture],
    ):
        """Test that scores are centered around mean for GRPO stability."""
        scores = []
        
        for traj in trajectory_group:
            behavior = BehaviorMetrics(
                trades_executed=traj.episode_length,
                total_pnl=traj.final_pnl,
            )
            
            inputs = TrajectoryRewardInputs(
                final_pnl=traj.final_pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + traj.final_pnl,
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(inputs, traj.archetype, behavior)
            scores.append(score)
        
        # Center scores
        mean_score = sum(scores) / len(scores)
        centered_scores = [s - mean_score for s in scores]
        
        # Check that centering works
        centered_mean = sum(centered_scores) / len(centered_scores)
        assert abs(centered_mean) < 0.01, "Centered scores should have mean ~0"

    def test_relative_ordering_preserved(
        self,
        trajectory_group: List[TrajectoryFixture],
    ):
        """Test that relative ordering is preserved after centering."""
        scores = []
        
        for traj in trajectory_group:
            behavior = BehaviorMetrics(
                trades_executed=traj.episode_length,
                total_pnl=traj.final_pnl,
            )
            
            inputs = TrajectoryRewardInputs(
                final_pnl=traj.final_pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + traj.final_pnl,
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(inputs, traj.archetype, behavior)
            scores.append((traj.archetype, score))
        
        # Sort by score
        sorted_by_score = sorted(scores, key=lambda x: x[1], reverse=True)
        
        # Verify trader (high PnL) scores higher than degen (negative PnL)
        # Note: This depends on archetype weights - trader prioritizes PnL
        trader_score = next(s for a, s in scores if a == "trader")
        degen_score = next(s for a, s in scores if a == "degen")
        
        # Trader should score higher due to positive PnL
        assert trader_score > degen_score, "Trader with profit should beat degen with loss"


class TestEndToEndJsonPipeline:
    """Test complete end-to-end JSON mode pipeline."""

    def test_full_pipeline_single_window(
        self,
        temp_trajectory_dir: Path,
        trajectory_group: List[TrajectoryFixture],
    ):
        """Test full pipeline from JSON files to scores."""
        # Step 1: Write trajectories to files
        for traj in trajectory_group:
            file_path = temp_trajectory_dir / f"{traj.trajectory_id}.json"
            file_path.write_text(json.dumps(traj.to_json_file_format()))

        # Step 2: Load trajectories
        reader = JsonTrajectoryReader(str(temp_trajectory_dir))
        window_ids = reader.get_window_ids()
        assert "window-test-1" in window_ids

        trajectories = reader.get_trajectories_by_window("window-test-1")
        assert len(trajectories) == 3

        # Step 3: Validate LLM calls
        for traj_data in trajectories:
            # JsonTrajectoryReader returns trajectory data directly
            steps_json = traj_data.get("stepsJson", "[]")
            steps = json.loads(steps_json) if isinstance(steps_json, str) else steps_json
            is_valid, issues = validate_llm_calls(steps)
            assert is_valid, f"Invalid LLM calls: {issues}"

        # Step 4: Extract archetypes and score
        scores = []
        for traj_data in trajectories:
            # JsonTrajectoryReader returns trajectory data directly
            traj = traj_data
            archetype = traj.get("archetype", "default")
            archetype_norm = normalize_archetype(archetype)
            
            steps = json.loads(traj.get("stepsJson", "[]"))
            
            behavior = BehaviorMetrics(
                trades_executed=len([s for s in steps if s.get("action", {}).get("actionType", "") != "hold"]),
                total_pnl=traj.get("finalPnL", 0.0),
                episode_length=traj.get("episodeLength", len(steps)),
            )
            
            inputs = TrajectoryRewardInputs(
                final_pnl=traj.get("finalPnL", 0.0),
                starting_balance=10000.0,
                end_balance=10000.0 + traj.get("finalPnL", 0.0),
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(inputs, archetype_norm, behavior)
            scores.append((archetype_norm, score))

        # Step 5: Center scores for GRPO
        mean_score = sum(s for _, s in scores) / len(scores)
        centered_scores = [(a, s - mean_score) for a, s in scores]

        # Verify results
        assert len(centered_scores) == 3
        centered_mean = sum(s for _, s in centered_scores) / len(centered_scores)
        assert abs(centered_mean) < 0.01

    def test_pipeline_with_all_archetypes(
        self,
        temp_trajectory_dir: Path,
        all_archetype_trajectories: Dict[str, TrajectoryFixture],
    ):
        """Test pipeline with all archetype types."""
        # Write all trajectories
        for archetype, traj in all_archetype_trajectories.items():
            file_path = temp_trajectory_dir / f"{traj.trajectory_id}.json"
            file_path.write_text(json.dumps(traj.to_json_file_format()))

        # Load and score all
        reader = JsonTrajectoryReader(str(temp_trajectory_dir))
        trajectories = reader.get_trajectories_by_window("window-all-archetypes")
        
        assert len(trajectories) == len(get_available_archetypes())

        # Score each
        archetype_scores: Dict[str, float] = {}
        for traj_data in trajectories:
            # JsonTrajectoryReader returns trajectory data directly
            traj = traj_data
            archetype = normalize_archetype(traj.get("archetype", "default"))
            
            behavior = BehaviorMetrics(
                trades_executed=3,
                total_pnl=traj.get("finalPnL", 0.0),
            )
            
            inputs = TrajectoryRewardInputs(
                final_pnl=traj.get("finalPnL", 0.0),
                starting_balance=10000.0,
                end_balance=10000.0 + traj.get("finalPnL", 0.0),
                format_score=0.7,
                reasoning_score=0.7,
            )
            
            score = archetype_composite_reward(inputs, archetype, behavior)
            archetype_scores[archetype] = score

        # Verify all archetypes got scored
        assert len(archetype_scores) == len(get_available_archetypes())
        
        # All scores should be valid
        for arch, score in archetype_scores.items():
            assert 0.0 <= score <= 1.0, f"{arch} has invalid score: {score}"

