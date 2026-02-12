#!/usr/bin/env python3
"""
A/B Test Runner for Babylon Agent Training

Compares a trained model against a baseline model using standardized evaluation scenarios.

Usage:
    # Compare trained model against baseline
    python scripts/run_ab_test.py \
        --model-a Qwen/Qwen3-30B \
        --model-b ./trained_models/final_model \
        --archetypes trader degen

    # Quick test with fewer scenarios
    python scripts/run_ab_test.py \
        --model-a Qwen/Qwen2.5-0.5B-Instruct \
        --model-b ./trained_models/final_model \
        --num-runs 1

    # Full test suite
    python scripts/run_ab_test.py \
        --model-a Qwen/Qwen3-30B \
        --model-b ./trained_models/final_model \
        --num-runs 5 \
        --output-dir ./ab_results
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.training.ab_testing import ABTestRunner, EVAL_SCENARIOS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


async def main():
    parser = argparse.ArgumentParser(
        description="Run A/B test comparing two models",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    
    parser.add_argument(
        "--model-a",
        required=True,
        help="Baseline model (path or HuggingFace name)",
    )
    parser.add_argument(
        "--model-b", 
        required=True,
        help="Trained model to compare (path or HuggingFace name)",
    )
    parser.add_argument(
        "--archetypes",
        nargs="+",
        choices=list(EVAL_SCENARIOS.keys()),
        help="Archetypes to test (default: all)",
    )
    parser.add_argument(
        "--num-runs",
        type=int,
        default=3,
        help="Number of runs per scenario for statistical significance (default: 3)",
    )
    parser.add_argument(
        "--vllm-url",
        default="http://localhost:9001/v1",
        help="vLLM server URL (default: http://localhost:9001/v1)",
    )
    parser.add_argument(
        "--output-dir",
        default="./ab_test_results",
        help="Directory to save results (default: ./ab_test_results)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging",
    )
    
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    # Filter scenarios by archetype if specified
    scenarios = EVAL_SCENARIOS
    if args.archetypes:
        scenarios = {k: v for k, v in EVAL_SCENARIOS.items() if k in args.archetypes}
        logger.info(f"Testing archetypes: {', '.join(args.archetypes)}")
    else:
        logger.info(f"Testing all archetypes: {', '.join(EVAL_SCENARIOS.keys())}")
    
    logger.info(f"Model A (baseline): {args.model_a}")
    logger.info(f"Model B (trained):  {args.model_b}")
    logger.info(f"Runs per scenario:  {args.num_runs}")
    
    # Create runner
    runner = ABTestRunner(
        model_a=args.model_a,
        model_b=args.model_b,
        scenarios=scenarios,
        vllm_url=args.vllm_url,
        num_runs_per_scenario=args.num_runs,
        output_dir=args.output_dir,
    )
    
    # Run tests
    logger.info("Starting A/B test...")
    result = await runner.run()
    
    # Print summary
    print()
    print(result.summary())
    
    # Return exit code based on result
    if result.model_b_wins > result.model_a_wins:
        logger.info("Trained model outperforms baseline!")
        return 0
    elif result.model_a_wins > result.model_b_wins:
        logger.warning("Baseline model outperforms trained model")
        return 1
    else:
        logger.info("Models performed equally")
        return 0


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)



