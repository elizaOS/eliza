"""
Evaluation Suite for GRPO Training

Provides comprehensive evaluation infrastructure for tracking training progress:
1. Held-out test scenarios
2. Baseline comparison
3. Archetype-specific metrics
4. Trend tracking

Also includes RolloutDumper for debugging and dataset generation.
"""

import json
import logging
import random
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .scenario_pool import Scenario, ScenarioPool, ScenarioPoolConfig
from .quality_scorer import score_response, QualityScore
from .format_validator import validate_response_format

logger = logging.getLogger(__name__)


# =============================================================================
# Evaluation Result Types
# =============================================================================


@dataclass
class ArchetypeMetrics:
    """Metrics for a specific archetype"""
    archetype: str
    sample_count: int = 0
    avg_score: float = 0.0
    avg_format_score: float = 0.0
    avg_reasoning_score: float = 0.0
    format_compliance_rate: float = 0.0
    avg_think_length: float = 0.0
    action_distribution: Dict[str, int] = field(default_factory=dict)
    
    def to_dict(self) -> Dict:
        return {
            "archetype": self.archetype,
            "sample_count": self.sample_count,
            "avg_score": round(self.avg_score, 4),
            "avg_format_score": round(self.avg_format_score, 4),
            "avg_reasoning_score": round(self.avg_reasoning_score, 4),
            "format_compliance_rate": round(self.format_compliance_rate, 4),
            "avg_think_length": round(self.avg_think_length, 1),
            "action_distribution": self.action_distribution,
        }


@dataclass
class EvalResult:
    """Complete evaluation result"""
    step: int
    timestamp: datetime
    
    # Test set metrics
    test_sample_count: int = 0
    test_avg_score: float = 0.0
    test_accuracy: float = 0.0  # Ratio above threshold
    
    # Format compliance
    format_compliance_rate: float = 0.0
    avg_think_length: float = 0.0
    avg_response_length: float = 0.0
    valid_action_rate: float = 0.0
    
    # Per-archetype breakdown
    archetype_metrics: Dict[str, ArchetypeMetrics] = field(default_factory=dict)
    
    # Baseline comparison
    vs_baseline_score: Optional[float] = None
    vs_baseline_improvement: Optional[float] = None
    
    # Trend tracking
    improvement_vs_last: Optional[float] = None
    best_score_so_far: float = 0.0
    
    # Score distribution
    score_min: float = 0.0
    score_max: float = 0.0
    score_std: float = 0.0
    
    def to_dict(self) -> Dict:
        return {
            "step": self.step,
            "timestamp": self.timestamp.isoformat(),
            "test_sample_count": self.test_sample_count,
            "test_avg_score": round(self.test_avg_score, 4),
            "test_accuracy": round(self.test_accuracy, 4),
            "format_compliance_rate": round(self.format_compliance_rate, 4),
            "avg_think_length": round(self.avg_think_length, 1),
            "avg_response_length": round(self.avg_response_length, 1),
            "valid_action_rate": round(self.valid_action_rate, 4),
            "archetype_metrics": {k: v.to_dict() for k, v in self.archetype_metrics.items()},
            "vs_baseline_score": round(self.vs_baseline_score, 4) if self.vs_baseline_score else None,
            "vs_baseline_improvement": round(self.vs_baseline_improvement, 4) if self.vs_baseline_improvement else None,
            "improvement_vs_last": round(self.improvement_vs_last, 4) if self.improvement_vs_last else None,
            "best_score_so_far": round(self.best_score_so_far, 4),
            "score_min": round(self.score_min, 4),
            "score_max": round(self.score_max, 4),
            "score_std": round(self.score_std, 4),
        }
    
    def get_wandb_metrics(self) -> Dict[str, float]:
        """Get metrics in W&B format"""
        metrics = {
            "eval/avg_score": self.test_avg_score,
            "eval/accuracy": self.test_accuracy,
            "eval/format_compliance": self.format_compliance_rate,
            "eval/valid_action_rate": self.valid_action_rate,
            "eval/avg_think_length": self.avg_think_length,
            "eval/avg_response_length": self.avg_response_length,
            "eval/score_min": self.score_min,
            "eval/score_max": self.score_max,
            "eval/score_std": self.score_std,
            "eval/best_so_far": self.best_score_so_far,
        }
        
        if self.vs_baseline_improvement is not None:
            metrics["eval/vs_baseline"] = self.vs_baseline_improvement
        
        if self.improvement_vs_last is not None:
            metrics["eval/improvement"] = self.improvement_vs_last
        
        for name, archetype_m in self.archetype_metrics.items():
            metrics[f"eval/{name}/avg_score"] = archetype_m.avg_score
            metrics[f"eval/{name}/format_compliance"] = archetype_m.format_compliance_rate
        
        return metrics


# =============================================================================
# Test Scenario Management
# =============================================================================


@dataclass
class TestScenario:
    """A test scenario with expected behavior"""
    scenario: Scenario
    archetype: str = "trader"
    expected_action_types: List[str] = field(default_factory=list)
    difficulty_label: str = "medium"
    tags: List[str] = field(default_factory=list)


class TestScenarioManager:
    """Manages held-out test scenarios"""
    
    def __init__(
        self,
        scenarios_path: Optional[str] = None,
        generate_synthetic: int = 50,
    ):
        self.scenarios: List[TestScenario] = []
        
        if scenarios_path and Path(scenarios_path).exists():
            self._load_from_file(scenarios_path)
        
        if not self.scenarios or generate_synthetic > 0:
            self._generate_synthetic(generate_synthetic)
    
    def _load_from_file(self, path: str) -> None:
        """Load test scenarios from JSON file"""
        with open(path) as f:
            data = json.load(f)
        
        for item in data:
            scenario = Scenario(
                id=item["id"],
                source="test",
                difficulty=item.get("difficulty", "medium"),
            )
            
            test_scenario = TestScenario(
                scenario=scenario,
                archetype=item.get("archetype", "trader"),
                expected_action_types=item.get("expected_actions", []),
                difficulty_label=item.get("difficulty", "medium"),
                tags=item.get("tags", []),
            )
            self.scenarios.append(test_scenario)
        
        logger.info(f"Loaded {len(self.scenarios)} test scenarios from {path}")
    
    def _generate_synthetic(self, count: int) -> None:
        """Generate synthetic test scenarios"""
        pool_config = ScenarioPoolConfig(max_scenarios=count, use_curriculum=False)
        pool = ScenarioPool(pool_config)
        
        synthetic = pool.generate_synthetic_batch(count)
        
        archetypes = ["trader", "degen", "analyst", "influencer"]
        
        for i, scenario in enumerate(synthetic):
            scenario.id = f"test-{scenario.id}"
            scenario.source = "test"
            
            test_scenario = TestScenario(
                scenario=scenario,
                archetype=archetypes[i % len(archetypes)],
                difficulty_label=scenario.difficulty,
            )
            self.scenarios.append(test_scenario)
        
        logger.info(f"Generated {count} synthetic test scenarios")
    
    def get_scenarios(self, archetype: Optional[str] = None) -> List[TestScenario]:
        """Get test scenarios, optionally filtered by archetype"""
        if archetype:
            return [s for s in self.scenarios if s.archetype == archetype]
        return self.scenarios
    
    def save_to_file(self, path: str) -> None:
        """Save test scenarios to JSON file"""
        data = []
        for ts in self.scenarios:
            data.append({
                "id": ts.scenario.id,
                "archetype": ts.archetype,
                "expected_actions": ts.expected_action_types,
                "difficulty": ts.difficulty_label,
                "tags": ts.tags,
            })
        
        with open(path, "w") as f:
            json.dump(data, f, indent=2)


# =============================================================================
# Baseline Manager
# =============================================================================


@dataclass
class BaselineResult:
    """Baseline evaluation result for comparison"""
    model_name: str
    timestamp: datetime
    avg_score: float
    format_compliance: float
    archetype_scores: Dict[str, float]


class BaselineManager:
    """Manages baseline results for comparison"""
    
    def __init__(self, baseline_path: Optional[str] = None):
        self.baselines: List[BaselineResult] = []
        self.current_baseline: Optional[BaselineResult] = None
        
        if baseline_path and Path(baseline_path).exists():
            self._load(baseline_path)
    
    def _load(self, path: str) -> None:
        """Load baseline from JSON"""
        with open(path) as f:
            data = json.load(f)
        
        for item in data:
            baseline = BaselineResult(
                model_name=item["model_name"],
                timestamp=datetime.fromisoformat(item["timestamp"]),
                avg_score=item["avg_score"],
                format_compliance=item["format_compliance"],
                archetype_scores=item.get("archetype_scores", {}),
            )
            self.baselines.append(baseline)
        
        if self.baselines:
            self.current_baseline = self.baselines[-1]
            logger.info(f"Loaded baseline: {self.current_baseline.model_name}")
    
    def save_baseline(
        self,
        path: str,
        model_name: str,
        avg_score: float,
        format_compliance: float,
        archetype_scores: Dict[str, float],
    ) -> None:
        """Save current results as baseline"""
        baseline = BaselineResult(
            model_name=model_name,
            timestamp=datetime.now(timezone.utc),
            avg_score=avg_score,
            format_compliance=format_compliance,
            archetype_scores=archetype_scores,
        )
        
        self.baselines.append(baseline)
        self.current_baseline = baseline
        
        data = [
            {
                "model_name": b.model_name,
                "timestamp": b.timestamp.isoformat(),
                "avg_score": b.avg_score,
                "format_compliance": b.format_compliance,
                "archetype_scores": b.archetype_scores,
            }
            for b in self.baselines
        ]
        
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
    
    def compare_to_baseline(
        self,
        avg_score: float,
        format_compliance: float,
    ) -> Tuple[float, float]:
        """
        Compare to current baseline.
        
        Returns:
            (score_improvement, format_improvement) as percentages
        """
        if not self.current_baseline:
            return 0.0, 0.0
        
        score_improvement = avg_score - self.current_baseline.avg_score
        format_improvement = format_compliance - self.current_baseline.format_compliance
        
        return score_improvement, format_improvement


# =============================================================================
# Evaluation Suite
# =============================================================================


class EvaluationSuite:
    """
    Comprehensive evaluation for tracking training progress.
    
    Components:
    1. Held-out test scenarios
    2. Baseline comparison
    3. Archetype-specific metrics
    4. Trend tracking
    """
    
    def __init__(
        self,
        test_scenarios_path: Optional[str] = None,
        baseline_path: Optional[str] = None,
        generate_test_count: int = 50,
        success_threshold: float = 0.5,
    ):
        self.test_manager = TestScenarioManager(
            scenarios_path=test_scenarios_path,
            generate_synthetic=generate_test_count if not test_scenarios_path else 0,
        )
        self.baseline_manager = BaselineManager(baseline_path)
        self.success_threshold = success_threshold
        
        self.history: List[EvalResult] = []
        self.best_score: float = 0.0
    
    async def evaluate_responses(
        self,
        responses: List[Tuple[str, TestScenario]],
        step: int,
    ) -> EvalResult:
        """
        Evaluate a batch of responses.
        
        Args:
            responses: List of (response_text, test_scenario) pairs
            step: Current training step
        
        Returns:
            Complete evaluation result
        """
        result = EvalResult(
            step=step,
            timestamp=datetime.now(timezone.utc),
        )
        
        scores: List[float] = []
        format_compliant = 0
        valid_actions = 0
        think_lengths: List[int] = []
        response_lengths: List[int] = []
        
        archetype_data: Dict[str, List[Dict]] = {}
        
        for response_text, test_scenario in responses:
            archetype = test_scenario.archetype
            
            # Score the response
            quality = score_response(
                response_text,
                scenario=test_scenario.scenario,
                archetype=archetype,
            )
            
            scores.append(quality.total_score)
            think_lengths.append(quality.thinking_length)
            response_lengths.append(quality.response_length)
            
            if quality.has_thinking and quality.has_valid_action:
                format_compliant += 1
            
            if quality.has_valid_action:
                valid_actions += 1
            
            # Track per-archetype
            if archetype not in archetype_data:
                archetype_data[archetype] = []
            
            archetype_data[archetype].append({
                "score": quality.total_score,
                "format_score": quality.format_score,
                "reasoning_score": quality.reasoning_score,
                "has_thinking": quality.has_thinking,
                "has_valid_action": quality.has_valid_action,
                "action_type": quality.action_type,
                "think_length": quality.thinking_length,
            })
        
        n = len(responses)
        if n == 0:
            return result
        
        # Aggregate metrics
        result.test_sample_count = n
        result.test_avg_score = sum(scores) / n
        result.test_accuracy = sum(1 for s in scores if s >= self.success_threshold) / n
        result.format_compliance_rate = format_compliant / n
        result.valid_action_rate = valid_actions / n
        result.avg_think_length = sum(think_lengths) / n if think_lengths else 0
        result.avg_response_length = sum(response_lengths) / n if response_lengths else 0
        
        # Score distribution
        result.score_min = min(scores) if scores else 0
        result.score_max = max(scores) if scores else 0
        if len(scores) > 1:
            mean = sum(scores) / len(scores)
            variance = sum((s - mean) ** 2 for s in scores) / len(scores)
            result.score_std = variance ** 0.5
        
        # Per-archetype metrics
        for archetype, data_list in archetype_data.items():
            n_arch = len(data_list)
            metrics = ArchetypeMetrics(archetype=archetype, sample_count=n_arch)
            
            metrics.avg_score = sum(d["score"] for d in data_list) / n_arch
            metrics.avg_format_score = sum(d["format_score"] for d in data_list) / n_arch
            metrics.avg_reasoning_score = sum(d["reasoning_score"] for d in data_list) / n_arch
            metrics.format_compliance_rate = sum(
                1 for d in data_list if d["has_thinking"] and d["has_valid_action"]
            ) / n_arch
            metrics.avg_think_length = sum(d["think_length"] for d in data_list) / n_arch
            
            # Action distribution
            for d in data_list:
                action = d["action_type"] or "invalid"
                metrics.action_distribution[action] = metrics.action_distribution.get(action, 0) + 1
            
            result.archetype_metrics[archetype] = metrics
        
        # Baseline comparison
        if self.baseline_manager.current_baseline:
            score_imp, format_imp = self.baseline_manager.compare_to_baseline(
                result.test_avg_score,
                result.format_compliance_rate,
            )
            result.vs_baseline_score = self.baseline_manager.current_baseline.avg_score
            result.vs_baseline_improvement = score_imp
        
        # Trend tracking
        if self.history:
            last_result = self.history[-1]
            result.improvement_vs_last = result.test_avg_score - last_result.test_avg_score
        
        if result.test_avg_score > self.best_score:
            self.best_score = result.test_avg_score
        result.best_score_so_far = self.best_score
        
        self.history.append(result)
        
        return result
    
    def evaluate_single_response(
        self,
        response_text: str,
        archetype: str = "trader",
    ) -> QualityScore:
        """Evaluate a single response without full suite"""
        return score_response(response_text, archetype=archetype)
    
    def get_test_scenarios(
        self,
        archetype: Optional[str] = None,
        count: Optional[int] = None,
    ) -> List[TestScenario]:
        """Get test scenarios for evaluation"""
        scenarios = self.test_manager.get_scenarios(archetype)
        
        if count and count < len(scenarios):
            return random.sample(scenarios, count)
        return scenarios
    
    def save_results(self, path: str) -> None:
        """Save evaluation history to JSON"""
        data = [r.to_dict() for r in self.history]
        
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
    
    def get_summary(self) -> Dict:
        """Get summary of evaluation history"""
        if not self.history:
            return {"message": "No evaluations yet"}
        
        latest = self.history[-1]
        
        return {
            "total_evaluations": len(self.history),
            "latest_step": latest.step,
            "latest_avg_score": latest.test_avg_score,
            "best_avg_score": self.best_score,
            "latest_format_compliance": latest.format_compliance_rate,
            "improvement_trend": self._calculate_trend(),
        }
    
    def _calculate_trend(self) -> str:
        """Calculate improvement trend"""
        if len(self.history) < 3:
            return "insufficient_data"
        
        recent = self.history[-3:]
        scores = [r.test_avg_score for r in recent]
        
        if scores[-1] > scores[0]:
            return "improving"
        elif scores[-1] < scores[0]:
            return "declining"
        return "stable"


# =============================================================================
# Rollout Dumper
# =============================================================================


@dataclass
class RolloutRecord:
    """A saved rollout for debugging or dataset generation"""
    scenario_id: str
    archetype: str
    response: str
    messages: List[Dict[str, str]]
    score: float
    quality_metrics: Dict[str, Any]
    timestamp: datetime
    step: int
    
    def to_dict(self) -> Dict:
        return {
            "scenario_id": self.scenario_id,
            "archetype": self.archetype,
            "response": self.response,
            "messages": self.messages,
            "score": round(self.score, 4),
            "quality_metrics": self.quality_metrics,
            "timestamp": self.timestamp.isoformat(),
            "step": self.step,
        }


class RolloutDumper:
    """
    Save rollouts for debugging and dataset generation.
    
    Saves:
    - Successful rollouts (score > threshold) for SFT
    - Paired rollouts (high/low) for DPO
    - All rollouts with metadata for analysis
    """
    
    def __init__(
        self,
        output_dir: str,
        success_threshold: float = 0.7,
        save_rate: float = 0.1,
        max_buffer_size: int = 1000,
    ):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self.success_threshold = success_threshold
        self.save_rate = save_rate
        self.max_buffer_size = max_buffer_size
        
        # Output files
        self.all_file = self.output_dir / "all_rollouts.jsonl"
        self.success_file = self.output_dir / "successful_rollouts.jsonl"
        self.failed_file = self.output_dir / "failed_rollouts.jsonl"
        self.dpo_file = self.output_dir / "dpo_pairs.jsonl"
        
        # Buffers for DPO pairs
        self._pair_buffer: Dict[str, List[RolloutRecord]] = {}
        
        # Statistics
        self.total_saved = 0
        self.successful_saved = 0
        self.dpo_pairs_saved = 0
    
    def save_rollout(
        self,
        scenario_id: str,
        archetype: str,
        response: str,
        messages: List[Dict[str, str]],
        score: float,
        quality_metrics: Dict[str, Any],
        step: int,
    ) -> None:
        """
        Save rollout based on criteria.
        
        Automatically saves:
        - Random sample to all_rollouts
        - High-scoring to successful_rollouts
        - Low-scoring to failed_rollouts
        - Buffers for DPO pair creation
        """
        record = RolloutRecord(
            scenario_id=scenario_id,
            archetype=archetype,
            response=response,
            messages=messages,
            score=score,
            quality_metrics=quality_metrics,
            timestamp=datetime.now(timezone.utc),
            step=step,
        )
        
        # Random sampling for all rollouts
        if random.random() < self.save_rate:
            self._append_jsonl(self.all_file, record.to_dict())
            self.total_saved += 1
        
        # Save successful rollouts (for SFT)
        if score >= self.success_threshold:
            self._append_jsonl(self.success_file, record.to_dict())
            self.successful_saved += 1
        elif score < 0.3:
            # Save failed rollouts for analysis
            self._append_jsonl(self.failed_file, record.to_dict())
        
        # Buffer for DPO pairs
        self._buffer_for_dpo(record)
    
    def _append_jsonl(self, path: Path, data: Dict) -> None:
        """Append a JSON line to file"""
        with open(path, "a") as f:
            f.write(json.dumps(data) + "\n")
    
    def _buffer_for_dpo(self, record: RolloutRecord) -> None:
        """Buffer rollouts for DPO pair creation"""
        scenario_id = record.scenario_id
        
        if scenario_id not in self._pair_buffer:
            self._pair_buffer[scenario_id] = []
        
        self._pair_buffer[scenario_id].append(record)
        
        # Trim buffer if too large
        if len(self._pair_buffer[scenario_id]) > 10:
            self._pair_buffer[scenario_id] = self._pair_buffer[scenario_id][-10:]
        
        # Create pairs when we have enough
        if len(self._pair_buffer[scenario_id]) >= 2:
            self._maybe_create_dpo_pair(scenario_id)
    
    def _maybe_create_dpo_pair(self, scenario_id: str) -> None:
        """Create DPO pair if there's sufficient score difference"""
        rollouts = self._pair_buffer[scenario_id]
        
        if len(rollouts) < 2:
            return
        
        # Sort by score
        rollouts.sort(key=lambda x: x.score, reverse=True)
        
        best = rollouts[0]
        worst = rollouts[-1]
        
        score_diff = best.score - worst.score
        
        # Only create pair if there's meaningful difference
        if score_diff < 0.2:
            return
        
        pair = {
            "scenario_id": scenario_id,
            "archetype": best.archetype,
            "chosen": {
                "response": best.response,
                "messages": best.messages,
                "score": best.score,
            },
            "rejected": {
                "response": worst.response,
                "messages": worst.messages,
                "score": worst.score,
            },
            "score_diff": score_diff,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        
        self._append_jsonl(self.dpo_file, pair)
        self.dpo_pairs_saved += 1
        
        # Clear the used rollouts
        self._pair_buffer[scenario_id] = []
    
    def generate_sft_dataset(self, output_path: Optional[str] = None) -> str:
        """
        Convert successful rollouts to SFT format.
        
        Returns path to generated dataset.
        """
        sft_path = Path(output_path) if output_path else self.output_dir / "sft_dataset.jsonl"
        
        if not self.success_file.exists():
            logger.warning("No successful rollouts to convert")
            return str(sft_path)
        
        count = 0
        with open(self.success_file) as f_in, open(sft_path, "w") as f_out:
            for line in f_in:
                rollout = json.loads(line)
                
                sft_item = {
                    "messages": rollout["messages"],
                    "archetype": rollout.get("archetype"),
                    "score": rollout.get("score"),
                }
                
                f_out.write(json.dumps(sft_item) + "\n")
                count += 1
        
        logger.info(f"Generated SFT dataset with {count} samples: {sft_path}")
        return str(sft_path)
    
    def generate_dpo_dataset(self, output_path: Optional[str] = None) -> str:
        """
        Format DPO pairs for training.
        
        Returns path to generated dataset.
        """
        dpo_path = Path(output_path) if output_path else self.output_dir / "dpo_dataset.jsonl"
        
        if not self.dpo_file.exists():
            logger.warning("No DPO pairs to convert")
            return str(dpo_path)
        
        count = 0
        with open(self.dpo_file) as f_in, open(dpo_path, "w") as f_out:
            for line in f_in:
                pair = json.loads(line)
                
                dpo_item = {
                    "prompt": pair["chosen"]["messages"][:-1],  # All but last
                    "chosen": pair["chosen"]["messages"][-1]["content"],
                    "rejected": pair["rejected"]["messages"][-1]["content"],
                    "archetype": pair.get("archetype"),
                }
                
                f_out.write(json.dumps(dpo_item) + "\n")
                count += 1
        
        logger.info(f"Generated DPO dataset with {count} pairs: {dpo_path}")
        return str(dpo_path)
    
    def get_stats(self) -> Dict:
        """Get dumper statistics"""
        return {
            "total_saved": self.total_saved,
            "successful_saved": self.successful_saved,
            "dpo_pairs_saved": self.dpo_pairs_saved,
            "buffer_size": sum(len(v) for v in self._pair_buffer.values()),
            "output_dir": str(self.output_dir),
        }
    
    def flush_buffers(self) -> None:
        """Force creation of DPO pairs from remaining buffers"""
        for scenario_id in list(self._pair_buffer.keys()):
            if len(self._pair_buffer[scenario_id]) >= 2:
                self._maybe_create_dpo_pair(scenario_id)


# =============================================================================
# W&B Metrics Configuration
# =============================================================================


STEP_METRICS = [
    "train/loss",
    "train/avg_score",
    "train/score_std",
    "train/positive_advantage_ratio",
    "train/avg_token_count",
    "train/format_compliance_rate",
    "train/valid_action_rate",
    "train/avg_think_length",
]

EVAL_METRICS = [
    "eval/avg_score",
    "eval/accuracy",
    "eval/format_compliance",
    "eval/valid_action_rate",
    "eval/vs_baseline",
    "eval/improvement",
    "eval/best_so_far",
]

ARCHETYPE_METRICS_TEMPLATE = [
    "eval/{archetype}/avg_score",
    "eval/{archetype}/format_compliance",
]


def get_wandb_config() -> Dict:
    """Get W&B configuration for dashboard"""
    return {
        "step_metrics": STEP_METRICS,
        "eval_metrics": EVAL_METRICS,
        "archetype_metrics_template": ARCHETYPE_METRICS_TEMPLATE,
        "tables": [
            {
                "name": "train/rollout_examples",
                "columns": ["scenario", "response", "score", "archetype"],
            },
            {
                "name": "eval/test_results", 
                "columns": ["scenario", "response", "score", "expected"],
            },
        ],
    }


