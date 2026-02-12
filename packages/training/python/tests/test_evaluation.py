"""
Tests for Evaluation Suite and Rollout Dumper

Covers:
- EvaluationSuite functionality
- RolloutDumper for debugging/dataset generation
- TestScenarioManager
- BaselineManager
"""

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

import pytest

from src.training.evaluation import (
    ArchetypeMetrics,
    BaselineManager,
    BaselineResult,
    EvalResult,
    EvaluationSuite,
    RolloutDumper,
    RolloutRecord,
    TestScenario,
    TestScenarioManager,
    get_wandb_config,
)
from src.training.scenario_pool import Scenario, ScenarioPoolConfig, ScenarioPool
from src.training.quality_scorer import QualityScore


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def sample_scenario():
    """Create a sample scenario for testing"""
    return Scenario(
        id="test-scenario-1",
        source="test",
        difficulty="medium",
    )


@pytest.fixture
def sample_test_scenario(sample_scenario):
    """Create a sample test scenario"""
    return TestScenario(
        scenario=sample_scenario,
        archetype="trader",
        expected_action_types=["buy", "sell"],
        difficulty_label="medium",
        tags=["prediction"],
    )


@pytest.fixture
def sample_responses():
    """Sample responses for testing evaluation"""
    good_response = """<think>
    Looking at the market data, I see BTC is showing strong bullish momentum
    with price consolidating near resistance. Volume is increasing, suggesting
    a potential breakout. Given the positive funding rates and overall sentiment,
    I believe this is a good opportunity to take a long position.
    
    Risk consideration: I'll keep position size moderate due to volatility.
    </think>
    
    {"action": "buy", "market": "BTC-PERP", "amount": 100}
    """
    
    bad_response = """
    {"action": "unknown_action"}
    """
    
    mediocre_response = """<think>buy btc</think>{"action": "wait"}"""
    
    return [good_response, bad_response, mediocre_response]


@pytest.fixture
def temp_output_dir():
    """Create a temporary directory for outputs"""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


# =============================================================================
# EvalResult Tests
# =============================================================================


class TestEvalResult:
    """Tests for EvalResult dataclass"""
    
    def test_basic_creation(self):
        """Test creating an EvalResult"""
        result = EvalResult(
            step=100,
            timestamp=datetime.now(timezone.utc),
            test_avg_score=0.75,
            test_accuracy=0.8,
        )
        
        assert result.step == 100
        assert result.test_avg_score == 0.75
        assert result.test_accuracy == 0.8
    
    def test_to_dict(self):
        """Test conversion to dictionary"""
        result = EvalResult(
            step=100,
            timestamp=datetime.now(timezone.utc),
            test_sample_count=50,
            test_avg_score=0.75,
            format_compliance_rate=0.9,
        )
        
        d = result.to_dict()
        
        assert "step" in d
        assert "timestamp" in d
        assert d["test_sample_count"] == 50
        assert d["test_avg_score"] == 0.75
    
    def test_wandb_metrics(self):
        """Test getting W&B metrics"""
        result = EvalResult(
            step=100,
            timestamp=datetime.now(timezone.utc),
            test_avg_score=0.75,
            test_accuracy=0.8,
            format_compliance_rate=0.9,
            vs_baseline_improvement=0.05,
        )
        
        metrics = result.get_wandb_metrics()
        
        assert "eval/avg_score" in metrics
        assert "eval/accuracy" in metrics
        assert "eval/vs_baseline" in metrics
        assert metrics["eval/avg_score"] == 0.75
    
    def test_archetype_metrics(self):
        """Test archetype metrics in result"""
        result = EvalResult(
            step=100,
            timestamp=datetime.now(timezone.utc),
        )
        
        trader_metrics = ArchetypeMetrics(
            archetype="trader",
            sample_count=10,
            avg_score=0.8,
            format_compliance_rate=0.95,
        )
        
        result.archetype_metrics["trader"] = trader_metrics
        
        d = result.to_dict()
        assert "trader" in d["archetype_metrics"]
        assert d["archetype_metrics"]["trader"]["avg_score"] == 0.8


# =============================================================================
# ArchetypeMetrics Tests
# =============================================================================


class TestArchetypeMetrics:
    """Tests for ArchetypeMetrics dataclass"""
    
    def test_basic_creation(self):
        """Test creating archetype metrics"""
        metrics = ArchetypeMetrics(
            archetype="degen",
            sample_count=20,
            avg_score=0.65,
        )
        
        assert metrics.archetype == "degen"
        assert metrics.sample_count == 20
    
    def test_action_distribution(self):
        """Test action distribution tracking"""
        metrics = ArchetypeMetrics(archetype="trader")
        metrics.action_distribution["buy"] = 10
        metrics.action_distribution["sell"] = 5
        metrics.action_distribution["wait"] = 3
        
        d = metrics.to_dict()
        assert d["action_distribution"]["buy"] == 10
        assert d["action_distribution"]["sell"] == 5


# =============================================================================
# TestScenarioManager Tests
# =============================================================================


class TestTestScenarioManager:
    """Tests for TestScenarioManager"""
    
    def test_generate_synthetic(self):
        """Test synthetic scenario generation"""
        manager = TestScenarioManager(generate_synthetic=10)
        
        assert len(manager.scenarios) == 10
        assert all(isinstance(s, TestScenario) for s in manager.scenarios)
    
    def test_get_scenarios_all(self):
        """Test getting all scenarios"""
        manager = TestScenarioManager(generate_synthetic=20)
        
        scenarios = manager.get_scenarios()
        assert len(scenarios) == 20
    
    def test_get_scenarios_by_archetype(self):
        """Test filtering by archetype"""
        manager = TestScenarioManager(generate_synthetic=20)
        
        # Archetypes are assigned in round-robin
        trader_scenarios = manager.get_scenarios(archetype="trader")
        
        # Should have some trader scenarios
        assert len(trader_scenarios) >= 1
        assert all(s.archetype == "trader" for s in trader_scenarios)
    
    def test_save_and_load(self, temp_output_dir):
        """Test saving and loading scenarios"""
        path = f"{temp_output_dir}/test_scenarios.json"
        
        manager = TestScenarioManager(generate_synthetic=5)
        manager.save_to_file(path)
        
        # Load from file
        manager2 = TestScenarioManager(scenarios_path=path, generate_synthetic=0)
        
        # Note: loading from file only loads IDs, not full scenarios
        assert Path(path).exists()


# =============================================================================
# BaselineManager Tests
# =============================================================================


class TestBaselineManager:
    """Tests for BaselineManager"""
    
    def test_empty_baseline(self):
        """Test with no baseline"""
        manager = BaselineManager()
        
        assert manager.current_baseline is None
        
        score_imp, format_imp = manager.compare_to_baseline(0.5, 0.8)
        assert score_imp == 0.0
        assert format_imp == 0.0
    
    def test_save_baseline(self, temp_output_dir):
        """Test saving a baseline"""
        path = f"{temp_output_dir}/baseline.json"
        manager = BaselineManager()
        
        manager.save_baseline(
            path=path,
            model_name="test-model-v1",
            avg_score=0.6,
            format_compliance=0.85,
            archetype_scores={"trader": 0.65, "degen": 0.55},
        )
        
        assert manager.current_baseline is not None
        assert manager.current_baseline.model_name == "test-model-v1"
        assert Path(path).exists()
    
    def test_compare_to_baseline(self, temp_output_dir):
        """Test comparing to baseline"""
        path = f"{temp_output_dir}/baseline.json"
        manager = BaselineManager()
        
        manager.save_baseline(
            path=path,
            model_name="baseline-model",
            avg_score=0.5,
            format_compliance=0.8,
            archetype_scores={},
        )
        
        score_imp, format_imp = manager.compare_to_baseline(0.6, 0.9)
        
        assert score_imp == pytest.approx(0.1, abs=0.01)
        assert format_imp == pytest.approx(0.1, abs=0.01)
    
    def test_load_baseline(self, temp_output_dir):
        """Test loading baseline from file"""
        path = f"{temp_output_dir}/baseline.json"
        
        # Create baseline file
        data = [{
            "model_name": "saved-baseline",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "avg_score": 0.7,
            "format_compliance": 0.9,
            "archetype_scores": {"trader": 0.75},
        }]
        
        with open(path, "w") as f:
            json.dump(data, f)
        
        manager = BaselineManager(baseline_path=path)
        
        assert manager.current_baseline is not None
        assert manager.current_baseline.avg_score == 0.7


# =============================================================================
# EvaluationSuite Tests
# =============================================================================


class TestEvaluationSuite:
    """Tests for EvaluationSuite"""
    
    def test_creation(self):
        """Test creating evaluation suite"""
        suite = EvaluationSuite(
            generate_test_count=10,
            success_threshold=0.5,
        )
        
        assert len(suite.test_manager.scenarios) == 10
        assert suite.success_threshold == 0.5
    
    def test_get_test_scenarios(self):
        """Test getting test scenarios"""
        suite = EvaluationSuite(generate_test_count=20)
        
        scenarios = suite.get_test_scenarios()
        assert len(scenarios) == 20
        
        subset = suite.get_test_scenarios(count=5)
        assert len(subset) == 5
    
    def test_evaluate_single_response(self, sample_responses):
        """Test evaluating a single response"""
        suite = EvaluationSuite(generate_test_count=5)
        
        good_response = sample_responses[0]
        score = suite.evaluate_single_response(good_response, archetype="trader")
        
        assert isinstance(score, QualityScore)
        assert score.total_score >= 0
        assert score.total_score <= 1
    
    @pytest.mark.asyncio
    async def test_evaluate_responses(self, sample_responses, sample_test_scenario):
        """Test evaluating a batch of responses"""
        suite = EvaluationSuite(generate_test_count=5, success_threshold=0.3)
        
        # Create response-scenario pairs
        pairs = [(response, sample_test_scenario) for response in sample_responses]
        
        result = await suite.evaluate_responses(pairs, step=100)
        
        assert isinstance(result, EvalResult)
        assert result.step == 100
        assert result.test_sample_count == 3
        assert result.test_avg_score >= 0
    
    @pytest.mark.asyncio
    async def test_improvement_tracking(self, sample_responses, sample_test_scenario):
        """Test improvement tracking over evaluations"""
        suite = EvaluationSuite(generate_test_count=5, success_threshold=0.3)
        
        pairs = [(sample_responses[0], sample_test_scenario)]  # Good response
        
        # First evaluation
        result1 = await suite.evaluate_responses(pairs, step=100)
        
        # Second evaluation (simulate improvement)
        result2 = await suite.evaluate_responses(pairs, step=200)
        
        assert len(suite.history) == 2
        assert result2.best_score_so_far >= result1.test_avg_score
    
    def test_get_summary(self):
        """Test getting summary when no evaluations"""
        suite = EvaluationSuite(generate_test_count=5)
        
        summary = suite.get_summary()
        assert "message" in summary
    
    def test_save_results(self, temp_output_dir):
        """Test saving evaluation results"""
        suite = EvaluationSuite(generate_test_count=5)
        
        # Add a result to history
        suite.history.append(EvalResult(
            step=100,
            timestamp=datetime.now(timezone.utc),
            test_avg_score=0.7,
        ))
        
        path = f"{temp_output_dir}/eval_results.json"
        suite.save_results(path)
        
        assert Path(path).exists()
        
        with open(path) as f:
            data = json.load(f)
        
        assert len(data) == 1
        assert data[0]["step"] == 100


# =============================================================================
# RolloutDumper Tests
# =============================================================================


class TestRolloutDumper:
    """Tests for RolloutDumper"""
    
    def test_creation(self, temp_output_dir):
        """Test creating rollout dumper"""
        dumper = RolloutDumper(
            output_dir=temp_output_dir,
            success_threshold=0.7,
            save_rate=0.5,
        )
        
        assert dumper.output_dir == Path(temp_output_dir)
        assert dumper.success_threshold == 0.7
    
    def test_save_successful_rollout(self, temp_output_dir):
        """Test saving successful rollout"""
        dumper = RolloutDumper(
            output_dir=temp_output_dir,
            success_threshold=0.5,
            save_rate=1.0,  # Save all
        )
        
        dumper.save_rollout(
            scenario_id="scenario-1",
            archetype="trader",
            response="<think>analysis</think>{\"action\": \"buy\"}",
            messages=[{"role": "user", "content": "trade"}, {"role": "assistant", "content": "ok"}],
            score=0.8,  # Above threshold
            quality_metrics={"format_score": 0.9},
            step=100,
        )
        
        assert dumper.success_file.exists()
        assert dumper.successful_saved == 1
    
    def test_save_failed_rollout(self, temp_output_dir):
        """Test saving failed rollout"""
        dumper = RolloutDumper(
            output_dir=temp_output_dir,
            success_threshold=0.7,
            save_rate=1.0,
        )
        
        dumper.save_rollout(
            scenario_id="scenario-1",
            archetype="trader",
            response="invalid",
            messages=[],
            score=0.2,  # Below threshold
            quality_metrics={},
            step=100,
        )
        
        # Should be in failed file, not success
        assert dumper.failed_file.exists()
        assert dumper.successful_saved == 0
    
    def test_dpo_pair_creation(self, temp_output_dir):
        """Test creating DPO pairs"""
        dumper = RolloutDumper(
            output_dir=temp_output_dir,
            save_rate=1.0,
        )
        
        # Add high-scoring rollout
        dumper.save_rollout(
            scenario_id="scenario-1",
            archetype="trader",
            response="good response",
            messages=[{"role": "assistant", "content": "good response"}],
            score=0.9,
            quality_metrics={},
            step=100,
        )
        
        # Add low-scoring rollout for same scenario
        dumper.save_rollout(
            scenario_id="scenario-1",
            archetype="trader",
            response="bad response",
            messages=[{"role": "assistant", "content": "bad response"}],
            score=0.3,  # Score diff of 0.6 > 0.2 threshold
            quality_metrics={},
            step=100,
        )
        
        assert dumper.dpo_pairs_saved == 1
        assert dumper.dpo_file.exists()
        
        with open(dumper.dpo_file) as f:
            pair = json.loads(f.readline())
        
        assert pair["scenario_id"] == "scenario-1"
        assert pair["chosen"]["score"] > pair["rejected"]["score"]
        assert pair["score_diff"] > 0.5
    
    def test_generate_sft_dataset(self, temp_output_dir):
        """Test generating SFT dataset"""
        dumper = RolloutDumper(
            output_dir=temp_output_dir,
            success_threshold=0.5,
            save_rate=1.0,
        )
        
        # Add successful rollouts
        for i in range(3):
            dumper.save_rollout(
                scenario_id=f"scenario-{i}",
                archetype="trader",
                response="good",
                messages=[{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}],
                score=0.8,
                quality_metrics={},
                step=i,
            )
        
        sft_path = dumper.generate_sft_dataset()
        
        assert Path(sft_path).exists()
        
        with open(sft_path) as f:
            lines = f.readlines()
        
        assert len(lines) == 3
    
    def test_generate_dpo_dataset(self, temp_output_dir):
        """Test generating DPO dataset"""
        dumper = RolloutDumper(
            output_dir=temp_output_dir,
            save_rate=1.0,
        )
        
        # Create pairs
        for i in range(2):
            dumper.save_rollout(
                scenario_id=f"scenario-{i}",
                archetype="trader",
                response="good",
                messages=[{"role": "assistant", "content": "good"}],
                score=0.9,
                quality_metrics={},
                step=i,
            )
            dumper.save_rollout(
                scenario_id=f"scenario-{i}",
                archetype="trader",
                response="bad",
                messages=[{"role": "assistant", "content": "bad"}],
                score=0.3,
                quality_metrics={},
                step=i,
            )
        
        dpo_path = dumper.generate_dpo_dataset()
        
        assert Path(dpo_path).exists()
        
        with open(dpo_path) as f:
            lines = f.readlines()
        
        assert len(lines) == 2
    
    def test_get_stats(self, temp_output_dir):
        """Test getting dumper statistics"""
        dumper = RolloutDumper(
            output_dir=temp_output_dir,
            save_rate=1.0,
        )
        
        stats = dumper.get_stats()
        
        assert "total_saved" in stats
        assert "successful_saved" in stats
        assert "dpo_pairs_saved" in stats
        assert stats["output_dir"] == temp_output_dir
    
    def test_flush_buffers(self, temp_output_dir):
        """Test flushing DPO buffers"""
        dumper = RolloutDumper(
            output_dir=temp_output_dir,
            save_rate=1.0,
        )
        
        # Add only 2 rollouts (enough for pair)
        dumper.save_rollout(
            scenario_id="scenario-1",
            archetype="trader",
            response="good",
            messages=[{"role": "assistant", "content": "good"}],
            score=0.9,
            quality_metrics={},
            step=1,
        )
        dumper.save_rollout(
            scenario_id="scenario-1",
            archetype="trader",
            response="bad",
            messages=[{"role": "assistant", "content": "bad"}],
            score=0.2,
            quality_metrics={},
            step=2,
        )
        
        # Pair should already be created due to sufficient score diff
        initial_pairs = dumper.dpo_pairs_saved
        
        # Flush doesn't create more if already processed
        dumper.flush_buffers()
        
        assert dumper.dpo_pairs_saved >= initial_pairs


# =============================================================================
# RolloutRecord Tests
# =============================================================================


class TestRolloutRecord:
    """Tests for RolloutRecord dataclass"""
    
    def test_creation(self):
        """Test creating rollout record"""
        record = RolloutRecord(
            scenario_id="scenario-1",
            archetype="trader",
            response="test response",
            messages=[],
            score=0.5,
            quality_metrics={"format": 0.8},
            timestamp=datetime.now(timezone.utc),
            step=100,
        )
        
        assert record.scenario_id == "scenario-1"
        assert record.score == 0.5
    
    def test_to_dict(self):
        """Test conversion to dictionary"""
        ts = datetime.now(timezone.utc)
        record = RolloutRecord(
            scenario_id="scenario-1",
            archetype="degen",
            response="response",
            messages=[{"role": "user", "content": "hi"}],
            score=0.75,
            quality_metrics={"test": 1},
            timestamp=ts,
            step=50,
        )
        
        d = record.to_dict()
        
        assert d["scenario_id"] == "scenario-1"
        assert d["archetype"] == "degen"
        assert d["score"] == 0.75
        assert d["step"] == 50


# =============================================================================
# W&B Config Tests
# =============================================================================


class TestWandbConfig:
    """Tests for W&B configuration"""
    
    def test_get_config(self):
        """Test getting W&B config"""
        config = get_wandb_config()
        
        assert "step_metrics" in config
        assert "eval_metrics" in config
        assert "tables" in config
        
        assert "train/loss" in config["step_metrics"]
        assert "eval/avg_score" in config["eval_metrics"]
    
    def test_config_completeness(self):
        """Test config has required components"""
        config = get_wandb_config()
        
        # Check step metrics
        assert len(config["step_metrics"]) >= 5
        
        # Check eval metrics
        assert len(config["eval_metrics"]) >= 5
        
        # Check tables
        assert len(config["tables"]) >= 2
        
        for table in config["tables"]:
            assert "name" in table
            assert "columns" in table

