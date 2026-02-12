"""
A/B Testing Framework for Babylon Agent Training

Compares trained agent models against baseline models using standardized evaluation scenarios.

Usage:
    from training.ab_testing import ABTestRunner
    
    runner = ABTestRunner(
        model_a="Qwen/Qwen3-30B",  # Baseline
        model_b="./trained_models/final_model",  # Trained
        scenarios=EVAL_SCENARIOS,
    )
    
    results = await runner.run()
    print(results.summary())
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .format_validator import validate_response_format
from .quality_scorer import score_response
from .scenario_pool import Scenario, ScenarioPool, ScenarioPoolConfig

logger = logging.getLogger(__name__)


@dataclass
class ModelResult:
    """Result from a single model evaluation."""
    model_name: str
    scenario_id: str
    response: str
    score: float
    format_valid: bool
    action_type: Optional[str]
    reasoning_quality: float
    latency_ms: float
    tokens_generated: int


@dataclass 
class ABTestResult:
    """Aggregated A/B test results."""
    model_a_name: str
    model_b_name: str
    
    # Per-scenario results
    scenario_results: List[Tuple[ModelResult, ModelResult]] = field(default_factory=list)
    
    # Aggregate metrics
    model_a_avg_score: float = 0.0
    model_b_avg_score: float = 0.0
    model_a_format_rate: float = 0.0
    model_b_format_rate: float = 0.0
    model_a_avg_latency: float = 0.0
    model_b_avg_latency: float = 0.0
    
    # Win rates
    model_a_wins: int = 0
    model_b_wins: int = 0
    ties: int = 0
    
    # Archetype-specific results
    archetype_results: Dict[str, Dict[str, float]] = field(default_factory=dict)
    
    def compute_aggregates(self) -> None:
        """Compute aggregate metrics from scenario results."""
        if not self.scenario_results:
            return
        
        n = len(self.scenario_results)
        
        # Aggregate scores
        a_scores = [r[0].score for r in self.scenario_results]
        b_scores = [r[1].score for r in self.scenario_results]
        self.model_a_avg_score = sum(a_scores) / n
        self.model_b_avg_score = sum(b_scores) / n
        
        # Format rates
        self.model_a_format_rate = sum(1 for r in self.scenario_results if r[0].format_valid) / n
        self.model_b_format_rate = sum(1 for r in self.scenario_results if r[1].format_valid) / n
        
        # Latencies
        self.model_a_avg_latency = sum(r[0].latency_ms for r in self.scenario_results) / n
        self.model_b_avg_latency = sum(r[1].latency_ms for r in self.scenario_results) / n
        
        # Win rates
        for a_result, b_result in self.scenario_results:
            if a_result.score > b_result.score:
                self.model_a_wins += 1
            elif b_result.score > a_result.score:
                self.model_b_wins += 1
            else:
                self.ties += 1
    
    def summary(self) -> str:
        """Generate a human-readable summary."""
        lines = [
            "=" * 60,
            "A/B TEST RESULTS",
            "=" * 60,
            f"Model A: {self.model_a_name}",
            f"Model B: {self.model_b_name}",
            f"Scenarios: {len(self.scenario_results)}",
            "",
            "AGGREGATE METRICS:",
            f"  Average Score: A={self.model_a_avg_score:.3f}, B={self.model_b_avg_score:.3f}",
            f"  Format Rate:   A={self.model_a_format_rate:.1%}, B={self.model_b_format_rate:.1%}",
            f"  Avg Latency:   A={self.model_a_avg_latency:.0f}ms, B={self.model_b_avg_latency:.0f}ms",
            "",
            "WIN RATES:",
            f"  Model A Wins: {self.model_a_wins} ({self.model_a_wins/max(len(self.scenario_results), 1):.1%})",
            f"  Model B Wins: {self.model_b_wins} ({self.model_b_wins/max(len(self.scenario_results), 1):.1%})",
            f"  Ties: {self.ties}",
            "",
        ]
        
        # Archetype breakdown
        if self.archetype_results:
            lines.append("ARCHETYPE BREAKDOWN:")
            for archetype, metrics in self.archetype_results.items():
                lines.append(f"  {archetype}:")
                lines.append(f"    A: {metrics.get('a_score', 0):.3f}, B: {metrics.get('b_score', 0):.3f}")
        
        # Winner determination
        lines.append("")
        if self.model_b_wins > self.model_a_wins:
            improvement = (self.model_b_avg_score - self.model_a_avg_score) / max(abs(self.model_a_avg_score), 0.001) * 100
            lines.append(f"WINNER: Model B (+{improvement:.1f}% improvement)")
        elif self.model_a_wins > self.model_b_wins:
            lines.append("WINNER: Model A (baseline)")
        else:
            lines.append("RESULT: TIE")
        
        lines.append("=" * 60)
        return "\n".join(lines)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "model_a": self.model_a_name,
            "model_b": self.model_b_name,
            "num_scenarios": len(self.scenario_results),
            "model_a_avg_score": self.model_a_avg_score,
            "model_b_avg_score": self.model_b_avg_score,
            "model_a_format_rate": self.model_a_format_rate,
            "model_b_format_rate": self.model_b_format_rate,
            "model_a_wins": self.model_a_wins,
            "model_b_wins": self.model_b_wins,
            "ties": self.ties,
            "winner": "model_b" if self.model_b_wins > self.model_a_wins else "model_a" if self.model_a_wins > self.model_b_wins else "tie",
            "archetype_results": self.archetype_results,
        }


# Standard evaluation scenarios for consistent benchmarking
EVAL_SCENARIOS = {
    "trader": [
        {"name": "bull_market", "volatility": 0.05, "trend": 0.02, "difficulty": "easy"},
        {"name": "bear_market", "volatility": 0.08, "trend": -0.03, "difficulty": "medium"},
        {"name": "choppy", "volatility": 0.15, "trend": 0.00, "difficulty": "hard"},
        {"name": "breakout", "volatility": 0.10, "trend": 0.05, "difficulty": "medium"},
    ],
    "degen": [
        {"name": "high_vol_opportunity", "volatility": 0.25, "trend": 0.08, "difficulty": "medium"},
        {"name": "pump_scenario", "volatility": 0.35, "trend": 0.15, "difficulty": "hard"},
        {"name": "leverage_test", "volatility": 0.20, "trend": 0.03, "difficulty": "hard"},
    ],
    "analyst": [
        {"name": "complex_market", "num_markets": 8, "difficulty": "hard"},
        {"name": "news_driven", "news_count": 10, "difficulty": "medium"},
    ],
    "whale": [
        {"name": "large_position", "balance": 100000, "difficulty": "medium"},
        {"name": "market_impact", "liquidity_low": True, "difficulty": "hard"},
    ],
    "influencer": [
        {"name": "social_opportunity", "social_posts": 15, "difficulty": "medium"},
        {"name": "trending_market", "trend": 0.10, "difficulty": "easy"},
    ],
}


class ABTestRunner:
    """
    Runs A/B tests comparing two models on standardized scenarios.
    
    Args:
        model_a: Path or name of first model (typically baseline)
        model_b: Path or name of second model (typically trained)
        scenarios: Dictionary of archetype -> scenario configs
        vllm_url: URL of vLLM server for inference
        num_runs_per_scenario: Number of runs per scenario for statistical significance
    """
    
    def __init__(
        self,
        model_a: str,
        model_b: str,
        scenarios: Optional[Dict[str, List[Dict]]] = None,
        vllm_url: str = "http://localhost:9001/v1",
        num_runs_per_scenario: int = 3,
        output_dir: str = "./ab_test_results",
    ):
        self.model_a = model_a
        self.model_b = model_b
        self.scenarios = scenarios or EVAL_SCENARIOS
        self.vllm_url = vllm_url
        self.num_runs = num_runs_per_scenario
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self._session = None
        self._scenario_pool = ScenarioPool(config=ScenarioPoolConfig())
        self._tokenizer = None  # Lazily loaded for accurate token counting
    
    async def run(self) -> ABTestResult:
        """Run the full A/B test suite."""
        import aiohttp
        
        result = ABTestResult(
            model_a_name=self.model_a,
            model_b_name=self.model_b,
        )
        
        async with aiohttp.ClientSession() as session:
            self._session = session
            
            for archetype, scenario_configs in self.scenarios.items():
                logger.info(f"Testing archetype: {archetype}")
                archetype_a_scores = []
                archetype_b_scores = []
                
                for config in scenario_configs:
                    for run_idx in range(self.num_runs):
                        # Generate scenario using pool
                        scenario = self._scenario_pool._generate_synthetic_scenario(
                            difficulty=config.get("difficulty", "medium"),
                            archetype_focus=archetype,
                        )
                        
                        # Run both models
                        a_result = await self._evaluate_model(
                            self.model_a, scenario, archetype
                        )
                        b_result = await self._evaluate_model(
                            self.model_b, scenario, archetype
                        )
                        
                        result.scenario_results.append((a_result, b_result))
                        archetype_a_scores.append(a_result.score)
                        archetype_b_scores.append(b_result.score)
                        
                        logger.debug(
                            f"  {config['name']} run {run_idx+1}: "
                            f"A={a_result.score:.3f}, B={b_result.score:.3f}"
                        )
                
                # Store archetype-level results
                if archetype_a_scores:
                    result.archetype_results[archetype] = {
                        "a_score": sum(archetype_a_scores) / len(archetype_a_scores),
                        "b_score": sum(archetype_b_scores) / len(archetype_b_scores),
                        "num_scenarios": len(archetype_a_scores),
                    }
        
        # Compute aggregates
        result.compute_aggregates()
        
        # Save results
        self._save_results(result)
        
        return result
    
    def _count_tokens(self, text: str) -> int:
        """Count tokens using tokenizer, with fallback to word splitting."""
        if self._tokenizer is None:
            try:
                from transformers import AutoTokenizer
                # Use model_a as the tokenizer source (both models should use same tokenizer)
                self._tokenizer = AutoTokenizer.from_pretrained(
                    self.model_a,
                    trust_remote_code=True,
                )
            except Exception:
                # Fallback: return word count if tokenizer unavailable
                return len(text.split())
        
        try:
            return len(self._tokenizer.encode(text))
        except Exception:
            return len(text.split())
    
    async def _evaluate_model(
        self,
        model_name: str,
        scenario: Scenario,
        archetype: str,
    ) -> ModelResult:
        """Evaluate a single model on a scenario."""
        import time
        import aiohttp
        from .online_env import build_trading_system_prompt, build_observation_prompt
        
        # Build prompt
        system_prompt = build_trading_system_prompt(archetype)
        user_prompt = build_observation_prompt(scenario)
        
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        
        # Call vLLM
        start_time = time.time()
        
        try:
            async with self._session.post(
                f"{self.vllm_url}/chat/completions",
                json={
                    "model": model_name,
                    "messages": messages,
                    "max_tokens": 512,
                    "temperature": 0.7,
                },
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status != 200:
                    logger.warning(f"vLLM error: {resp.status}")
                    response_text = ""
                else:
                    data = await resp.json()
                    response_text = data["choices"][0]["message"]["content"] or ""
        except Exception as e:
            logger.error(f"Error calling vLLM: {e}")
            response_text = ""
        
        latency_ms = (time.time() - start_time) * 1000
        
        # Score response
        format_result = validate_response_format(response_text)
        quality_result = score_response(response_text, scenario, archetype)
        
        return ModelResult(
            model_name=model_name,
            scenario_id=scenario.id,
            response=response_text,
            score=quality_result.total_score,
            format_valid=format_result.is_valid,
            action_type=format_result.action.action_type if format_result.action else None,
            reasoning_quality=quality_result.reasoning_score,
            latency_ms=latency_ms,
            tokens_generated=self._count_tokens(response_text),
        )
    
    def _save_results(self, result: ABTestResult) -> None:
        """Save results to JSON file."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"ab_test_{timestamp}.json"
        filepath = self.output_dir / filename
        
        with open(filepath, "w") as f:
            json.dump(result.to_dict(), f, indent=2)
        
        logger.info(f"Results saved to: {filepath}")


async def run_ab_test(
    model_a: str,
    model_b: str,
    archetypes: Optional[List[str]] = None,
    num_scenarios: int = 10,
) -> ABTestResult:
    """
    Convenience function to run an A/B test.
    
    Args:
        model_a: Baseline model path/name
        model_b: Trained model path/name  
        archetypes: List of archetypes to test (default: all)
        num_scenarios: Number of scenarios per archetype
    
    Returns:
        ABTestResult with comparison metrics
    """
    scenarios = EVAL_SCENARIOS
    if archetypes:
        scenarios = {k: v for k, v in EVAL_SCENARIOS.items() if k in archetypes}
    
    runner = ABTestRunner(
        model_a=model_a,
        model_b=model_b,
        scenarios=scenarios,
    )
    
    return await runner.run()

