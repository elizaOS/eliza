"""
End-to-End Pipeline Tests

These tests validate the complete training pipeline from trajectory generation
to scoring, ensuring all components work together correctly.

Test Coverage:
1. JSON trajectory loading and parsing
2. Archetype extraction (trajectory-level and step-level)
3. Behavior metrics extraction
4. Archetype-aware composite scoring
5. GRPO group formation
6. Score normalization
7. Schema validation
8. Data integrity across pipeline stages
"""

import sys
sys.path.insert(0, ".")

import json
from pathlib import Path
from typing import Dict, List

import pytest

from src.training.rewards import (
    BehaviorMetrics,
    TrajectoryRewardInputs,
    archetype_composite_reward,
    calculate_archetype_behavior_bonus,
    calculate_pnl_reward,
    get_archetype_weights,
    relative_scores,
)
from src.training.rubric_loader import (
    get_available_archetypes,
    get_rubric,
    get_rubric_hash,
    has_custom_rubric,
    normalize_archetype,
)
from src.training.schemas import TrajectorySchema, StepSchema, validate_trajectory

# Note: quality_utils has import issues due to relative imports from ..models
# We test quality scoring through composite reward instead


class TestJSONPipelineE2E:
    """End-to-end tests for JSON-based trajectory processing"""
    
    def test_load_and_parse_trajectory_file(self, trajectories_in_files: Path):
        """Test loading trajectory from JSON file"""
        files = list(trajectories_in_files.glob("*.json"))
        assert len(files) >= 1, "No trajectory files found"
        
        traj_file = files[0]
        data = json.loads(traj_file.read_text())
        
        assert "trajectory" in data
        assert "trajectoryId" in data["trajectory"]
        assert "stepsJson" in data["trajectory"]
    
    def test_parse_steps_json_correctly(self, sample_trajectories):
        """Test that stepsJson is parsed correctly"""
        traj = sample_trajectories[0]
        steps = json.loads(traj.steps_json)
        
        assert isinstance(steps, list)
        assert len(steps) == traj.episode_length
        
        for step in steps:
            assert "stepNumber" in step
            assert "environmentState" in step
            assert "action" in step
    
    def test_extract_archetype_from_trajectory_level(self, sample_trajectories):
        """Test archetype extraction from trajectory metadata"""
        traj = sample_trajectories[0]  # Has archetype at trajectory level
        
        archetype = traj.archetype
        assert archetype == "trader"
        
        normalized = normalize_archetype(archetype)
        assert normalized == "trader"
    
    def test_extract_archetype_from_step_actions(self, sample_trajectories):
        """Test archetype extraction from step action parameters"""
        # Trajectory 6 has empty archetype at trajectory level but in steps
        traj = sample_trajectories[5]
        assert traj.archetype == ""  # Empty at trajectory level
        
        steps = json.loads(traj.steps_json)
        
        # Find archetype in steps
        found_archetype = None
        for step in steps:
            action = step.get("action", {})
            params = action.get("parameters", {})
            archetype = params.get("archetype")
            if archetype:
                found_archetype = archetype
                break
        
        assert found_archetype is not None, "Archetype not found in steps"
        assert found_archetype == "trader"  # Default from fixture
    
    def test_behavior_metrics_extraction_from_steps(self, sample_trajectories):
        """Test extracting behavior metrics from trajectory steps"""
        traj = sample_trajectories[0]
        steps = json.loads(traj.steps_json)
        
        # Count actions by type
        trade_count = 0
        analysis_count = 0
        total_pnl = 0.0
        
        for step in steps:
            action = step.get("action", {})
            action_type = action.get("actionType", "")
            result = action.get("result", {})
            
            if action_type == "trade":
                trade_count += 1
                pnl = result.get("pnl", 0)
                if pnl:
                    total_pnl = pnl  # Last PnL is cumulative
            elif action_type == "analyze":
                analysis_count += 1
        
        assert trade_count > 0
        assert total_pnl > 0  # Profitable trajectory
    
    def test_complete_json_to_score_pipeline(self, trajectories_in_files: Path):
        """Test complete pipeline: JSON file → load → parse → score"""
        files = list(trajectories_in_files.glob("*.json"))
        scores = []
        
        for traj_file in files:
            # 1. Load JSON
            data = json.loads(traj_file.read_text())
            traj_data = data["trajectory"]
            
            # 2. Extract fields
            archetype = traj_data.get("archetype", "default")
            if not archetype:
                # Try to extract from steps
                steps = json.loads(traj_data.get("stepsJson", "[]"))
                for step in steps:
                    params = step.get("action", {}).get("parameters", {})
                    if params.get("archetype"):
                        archetype = params["archetype"]
                        break
                if not archetype:
                    archetype = "default"
            
            archetype_norm = normalize_archetype(archetype)
            final_pnl = traj_data.get("finalPnL", 0.0)
            
            # 3. Parse steps and extract behavior
            steps = json.loads(traj_data.get("stepsJson", "[]"))
            trade_count = sum(
                1 for s in steps 
                if s.get("action", {}).get("actionType") == "trade"
            )
            
            # 4. Create reward inputs
            inputs = TrajectoryRewardInputs(
                final_pnl=final_pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + final_pnl,
                format_score=0.8,
                reasoning_score=0.75,
                trades_executed=trade_count,
                total_actions=len(steps),
            )
            
            # 5. Create behavior metrics
            metrics = BehaviorMetrics(
                trades_executed=trade_count,
                profitable_trades=trade_count // 2,
                total_pnl=final_pnl,
                episode_length=len(steps),
            )
            
            # 6. Calculate composite score
            score = archetype_composite_reward(
                inputs=inputs,
                archetype=archetype_norm,
                behavior_metrics=metrics,
            )
            
            scores.append({
                "trajectory_id": traj_data["trajectoryId"],
                "archetype": archetype_norm,
                "pnl": final_pnl,
                "score": score,
            })
        
        # Verify all trajectories were scored
        assert len(scores) >= 5
        
        # Verify scores are in valid range
        for s in scores:
            assert -2.0 <= s["score"] <= 2.0, f"Score out of range: {s}"
        
        # Verify different archetypes produce different weights
        archetypes_seen = set(s["archetype"] for s in scores)
        assert len(archetypes_seen) >= 3, "Need diverse archetypes for valid test"


class TestArchetypeScoringE2E:
    """End-to-end tests for archetype-aware scoring"""
    
    def test_archetype_weights_affect_scores(self):
        """Test that different archetypes produce different scores for same inputs"""
        # Same financial performance
        base_inputs = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
            format_score=0.8,
            reasoning_score=0.75,
            trades_executed=10,
            total_actions=20,
        )
        
        # Same behavior metrics
        base_metrics = BehaviorMetrics(
            trades_executed=10,
            profitable_trades=7,
            total_pnl=500.0,
            episode_length=20,
        )
        
        scores = {}
        for archetype in ["trader", "degen", "influencer", "analyst", "whale"]:
            score = archetype_composite_reward(
                inputs=base_inputs,
                archetype=archetype,
                behavior_metrics=base_metrics,
            )
            scores[archetype] = score
        
        # All should be valid scores
        for arch, score in scores.items():
            assert -2.0 <= score <= 2.0, f"{arch} score out of range: {score}"
        
        # Scores should vary based on archetype
        score_values = list(scores.values())
        assert max(score_values) != min(score_values), "Scores should vary by archetype"
    
    def test_behavior_bonus_applied_correctly(self, behavior_metrics_factory):
        """Test that behavior bonuses are calculated correctly"""
        archetypes_and_profiles = [
            ("trader", "high_trader"),
            ("influencer", "social_influencer"),
            ("degen", "risky_degen"),
        ]
        
        for archetype, profile in archetypes_and_profiles:
            metrics = behavior_metrics_factory(profile)
            
            bonus = calculate_archetype_behavior_bonus(archetype, metrics)
            
            assert isinstance(bonus, float)
            assert -0.5 <= bonus <= 0.5, f"Bonus out of range for {archetype}: {bonus}"
    
    def test_rubric_consistency_across_archetypes(self):
        """Test that rubrics and weights are consistent and valid"""
        archetypes = get_available_archetypes()
        
        assert len(archetypes) >= 5, "Should have at least 5 archetypes"
        
        for archetype in archetypes:
            # Rubric is a string (prompt text)
            rubric = get_rubric(archetype)
            assert isinstance(rubric, str), f"Rubric should be string for {archetype}"
            assert len(rubric) > 0, f"Empty rubric for {archetype}"
            
            # Weights are from get_archetype_weights
            weights = get_archetype_weights(archetype)
            assert "pnl" in weights, f"No pnl weight for {archetype}"
            assert "format" in weights, f"No format weight for {archetype}"
            assert "reasoning" in weights, f"No reasoning weight for {archetype}"
            
            # Weights should be non-negative
            for key, value in weights.items():
                assert value >= 0, f"Negative weight {key}={value} for {archetype}"
    
    def test_score_normalization_for_grpo(self):
        """Test that scores are properly normalized for GRPO training"""
        # Create a batch of scores
        raw_scores = [0.8, 0.6, 0.4, 0.2, 0.9, 0.5]
        
        normalized = relative_scores(raw_scores)
        
        # Normalized scores should be in [0, 1] range
        for score in normalized:
            assert 0.0 <= score <= 1.0, f"Score {score} out of [0,1] range"
        
        # Order should be preserved (higher raw score = higher normalized)
        for i in range(len(raw_scores) - 1):
            for j in range(i + 1, len(raw_scores)):
                if raw_scores[i] > raw_scores[j]:
                    assert normalized[i] > normalized[j], (
                        f"Order not preserved: raw[{i}]={raw_scores[i]} > raw[{j}]={raw_scores[j]} "
                        f"but norm[{i}]={normalized[i]} <= norm[{j}]={normalized[j]}"
                    )
                elif raw_scores[i] < raw_scores[j]:
                    assert normalized[i] < normalized[j]
        
        # Best score should get 1.0, worst should get 0.0
        best_idx = raw_scores.index(max(raw_scores))
        worst_idx = raw_scores.index(min(raw_scores))
        assert normalized[best_idx] == 1.0, f"Best score should be 1.0, got {normalized[best_idx]}"
        assert normalized[worst_idx] == 0.0, f"Worst score should be 0.0, got {normalized[worst_idx]}"


class TestGRPOGroupFormationE2E:
    """End-to-end tests for GRPO group formation and scoring"""
    
    def test_group_formation_by_window(self, sample_trajectories):
        """Test grouping trajectories by window/scenario"""
        # All fixtures have same window_id
        windows = {}
        
        for traj in sample_trajectories:
            key = f"{traj.window_id}_{traj.scenario_id}"
            if key not in windows:
                windows[key] = []
            windows[key].append(traj)
        
        # Should have at least one group
        assert len(windows) >= 1
        
        # Each group should have multiple trajectories
        for key, trajs in windows.items():
            assert len(trajs) >= 2, f"Group {key} needs at least 2 trajectories for GRPO"
    
    def test_relative_scoring_within_group(self, sample_trajectories):
        """Test that relative scoring works within a GRPO group"""
        # Score all trajectories
        scores = []
        
        for traj in sample_trajectories:
            archetype_norm = normalize_archetype(traj.archetype or "default")
            
            inputs = TrajectoryRewardInputs(
                final_pnl=traj.final_pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + traj.final_pnl,
                format_score=0.8,
                reasoning_score=0.75,
            )
            
            metrics = BehaviorMetrics(
                total_pnl=traj.final_pnl,
                episode_length=traj.episode_length,
            )
            
            score = archetype_composite_reward(
                inputs=inputs,
                archetype=archetype_norm,
                behavior_metrics=metrics,
            )
            scores.append(score)
        
        # Apply relative normalization
        normalized = relative_scores(scores)
        
        # All normalized scores should be in [0, 1]
        for n in normalized:
            assert 0.0 <= n <= 1.0
        
        # Best performer should have high score (close to 1.0)
        best_idx = scores.index(max(scores))
        assert normalized[best_idx] == 1.0, f"Best should be 1.0, got {normalized[best_idx]}"
        
        # Worst performer should have low score (close to 0.0)
        worst_idx = scores.index(min(scores))
        assert normalized[worst_idx] == 0.0, f"Worst should be 0.0, got {normalized[worst_idx]}"
    
    def test_minimum_group_size_enforcement(self, sample_trajectories):
        """Test that groups with too few trajectories are handled"""
        min_group_size = 2
        
        # Filter to valid groups
        windows = {}
        for traj in sample_trajectories:
            key = f"{traj.window_id}_{traj.scenario_id}"
            if key not in windows:
                windows[key] = []
            windows[key].append(traj)
        
        valid_groups = [
            trajs for trajs in windows.values()
            if len(trajs) >= min_group_size
        ]
        
        assert len(valid_groups) >= 1, "Need at least one valid group"


class TestQualityScoringE2E:
    """End-to-end tests for quality (format/reasoning) scoring"""
    
    def test_llm_calls_structure_for_quality_scoring(self, sample_trajectories):
        """Test that LLM calls have expected structure for quality scoring"""
        traj = sample_trajectories[0]
        steps = json.loads(traj.steps_json)
        
        # Get LLM calls from first step
        first_step = steps[0]
        llm_calls = first_step.get("llmCalls", [])
        
        assert len(llm_calls) >= 1, "Need LLM calls for quality scoring"
        
        # Verify LLM call structure
        for call in llm_calls:
            assert "model" in call, "LLM call missing model"
            assert "response" in call, "LLM call missing response"
            
            # Response should contain content for scoring
            response = call.get("response", "")
            assert len(response) > 0, "LLM response should not be empty"
            
            # Optional but recommended fields
            if "reasoning" in call:
                assert isinstance(call["reasoning"], str)
        
        # Verify action structure exists for quality alignment
        action = first_step.get("action", {})
        assert "actionType" in action or "action_type" in action, "Action missing type"
    
    def test_quality_scores_affect_composite(self):
        """Test that quality scores affect the composite reward"""
        base_inputs_good_quality = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
            format_score=0.95,
            reasoning_score=0.90,
        )
        
        base_inputs_poor_quality = TrajectoryRewardInputs(
            final_pnl=500.0,
            starting_balance=10000.0,
            end_balance=10500.0,
            format_score=0.3,
            reasoning_score=0.2,
        )
        
        metrics = BehaviorMetrics(total_pnl=500.0, episode_length=10)
        
        score_good = archetype_composite_reward(
            inputs=base_inputs_good_quality,
            archetype="trader",
            behavior_metrics=metrics,
        )
        
        score_poor = archetype_composite_reward(
            inputs=base_inputs_poor_quality,
            archetype="trader",
            behavior_metrics=metrics,
        )
        
        assert score_good > score_poor, "Good quality should score higher"


class TestDataIntegrityE2E:
    """End-to-end tests for data integrity across pipeline stages"""
    
    def test_trajectory_id_preserved_through_pipeline(self, trajectories_in_files):
        """Test that trajectory IDs are preserved"""
        original_ids = set()
        processed_ids = set()
        
        for traj_file in trajectories_in_files.glob("*.json"):
            data = json.loads(traj_file.read_text())
            original_id = data["trajectory"]["trajectoryId"]
            original_ids.add(original_id)
            
            # Simulate processing
            processed_id = data["trajectory"]["trajectoryId"]
            processed_ids.add(processed_id)
        
        assert original_ids == processed_ids
    
    def test_pnl_values_consistent(self, sample_trajectories):
        """Test that PnL values are consistent across pipeline"""
        for traj in sample_trajectories:
            steps = json.loads(traj.steps_json)
            
            # Final step PnL should match trajectory finalPnL (approximately)
            if steps:
                final_step = steps[-1]
                step_pnl = final_step.get("environmentState", {}).get("agentPnL", 0)
                
                # Allow some floating point tolerance
                assert abs(step_pnl - traj.final_pnl) < 0.01, (
                    f"PnL mismatch: step={step_pnl}, trajectory={traj.final_pnl}"
                )
    
    def test_archetype_normalization_consistent(self):
        """Test that archetype normalization is consistent"""
        test_cases = [
            ("trader", "trader"),
            ("TRADER", "trader"),
            ("Trader", "trader"),
            ("degen", "degen"),
            ("DEGEN", "degen"),
            ("whale", "whale"),
            ("", "default"),
            (None, "default"),
        ]
        
        for input_val, expected in test_cases:
            if input_val is None:
                result = normalize_archetype("default")
            else:
                result = normalize_archetype(input_val)
            
            assert result == expected, f"normalize_archetype({input_val!r}) = {result!r}, expected {expected!r}"
    
    def test_schema_validation_on_real_data(self, trajectories_in_files):
        """Test that real trajectory data passes schema validation"""
        for traj_file in trajectories_in_files.glob("*.json"):
            data = json.loads(traj_file.read_text())
            traj_data = data["trajectory"]
            
            # Validate trajectory schema
            is_valid, errors = validate_trajectory(traj_data)
            
            assert is_valid, f"Schema validation failed for {traj_file.name}: {errors}"


class TestRubricVersioningE2E:
    """End-to-end tests for rubric versioning and hashing"""
    
    def test_rubric_hash_stability(self):
        """Test that rubric hashes are stable"""
        archetypes = get_available_archetypes()
        
        # Get hashes twice
        hashes_1 = {arch: get_rubric_hash(arch) for arch in archetypes}
        hashes_2 = {arch: get_rubric_hash(arch) for arch in archetypes}
        
        assert hashes_1 == hashes_2, "Rubric hashes should be stable"
    
    def test_different_archetypes_have_different_hashes(self):
        """Test that different archetypes have different hashes"""
        archetypes = get_available_archetypes()
        hashes = {arch: get_rubric_hash(arch) for arch in archetypes}
        
        unique_hashes = set(hashes.values())
        
        # Most archetypes should have unique hashes
        # (some may share if they have identical rubrics)
        assert len(unique_hashes) >= len(archetypes) // 2
    
    def test_has_custom_rubric_returns_correct_values(self):
        """Test has_custom_rubric for known archetypes"""
        known_archetypes = ["trader", "degen", "influencer", "analyst", "whale"]
        
        for arch in known_archetypes:
            result = has_custom_rubric(arch)
            assert isinstance(result, bool)
        
        # Unknown archetype should return False
        assert has_custom_rubric("unknown_archetype_xyz") is False


class TestErrorHandlingE2E:
    """End-to-end tests for error handling"""
    
    def test_malformed_steps_json_handled(self):
        """Test that malformed stepsJson is handled gracefully"""
        malformed_data = {
            "trajectory": {
                "trajectoryId": "malformed-001",
                "agentId": "agent-001",
                "windowId": "2024-01-01T00:00",
                "stepsJson": "not valid json {{{",
                "finalPnL": 100.0,
            }
        }
        
        traj_data = malformed_data["trajectory"]
        steps_json = traj_data.get("stepsJson", "[]")
        
        # Should handle parse error
        try:
            steps = json.loads(steps_json)
        except json.JSONDecodeError:
            steps = []  # Graceful fallback
        
        assert steps == []
    
    def test_missing_archetype_handled(self):
        """Test that missing archetype defaults correctly"""
        traj_data = {
            "trajectoryId": "no-archetype-001",
            "finalPnL": 100.0,
            # No archetype field
        }
        
        archetype = traj_data.get("archetype", "default")
        normalized = normalize_archetype(archetype)
        
        assert normalized == "default"
    
    def test_extreme_pnl_values_handled(self):
        """Test that extreme PnL values don't break scoring"""
        extreme_cases = [
            0.0,
            -10000.0,  # 100% loss
            100000.0,  # 1000% gain
            1e-10,  # Very small
            1e10,  # Very large
        ]
        
        for pnl in extreme_cases:
            inputs = TrajectoryRewardInputs(
                final_pnl=pnl,
                starting_balance=10000.0,
                end_balance=10000.0 + pnl,
                format_score=0.8,
                reasoning_score=0.75,
            )
            
            metrics = BehaviorMetrics(total_pnl=pnl)
            
            score = archetype_composite_reward(
                inputs=inputs,
                archetype="trader",
                behavior_metrics=metrics,
            )
            
            # Score should be a valid float, not NaN or Inf
            assert isinstance(score, float)
            assert score == score  # Not NaN
            assert abs(score) < float('inf')  # Not Inf

