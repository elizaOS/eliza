#!/usr/bin/env python3
"""
Test Trained Model - Mac (MLX) Support

Tests a trained model by:
1. Loading the model (MLX adapter or full model)
2. Running inference on test prompts
3. Validating responses
4. Optionally running benchmarks

Usage:
    # Test MLX adapter
    python scripts/test_trained_model.py --adapter-path ./trained_models/local/adapters --base-model mlx-community/Qwen2.5-1.5B-Instruct-4bit
    
    # Test with validation prompts
    python scripts/test_trained_model.py --adapter-path ./trained_models/local/adapters --validate
    
    # Run benchmark
    python scripts/test_trained_model.py --adapter-path ./trained_models/local/adapters --benchmark
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Literal

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

# Load environment
env_path = Path(__file__).parent.parent.parent.parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)


def detect_backend() -> Literal["mlx", "cuda", "cpu"]:
    """Auto-detect backend."""
    try:
        import mlx.core
        logger.info("MLX backend detected")
        return "mlx"
    except ImportError:
        pass
    
    try:
        import torch
        if torch.cuda.is_available():
            logger.info(f"CUDA backend detected: {torch.cuda.get_device_name(0)}")
            return "cuda"
    except ImportError:
        pass
    
    logger.warning("No GPU backend, using CPU")
    return "cpu"


def test_mlx_model(adapter_path: str, base_model: str, prompts: list[str]) -> dict:
    """Test MLX model with adapter."""
    from mlx_lm import load, generate
    
    logger.info("=" * 60)
    logger.info("LOADING MLX MODEL")
    logger.info("=" * 60)
    logger.info(f"Base model: {base_model}")
    logger.info(f"Adapter: {adapter_path}")
    
    # Load model with adapter
    model, tokenizer = load(base_model, adapter_path=adapter_path)
    
    logger.info("Model loaded successfully!")
    logger.info("")
    
    results = []
    
    for i, prompt in enumerate(prompts):
        logger.info(f"Test {i + 1}/{len(prompts)}")
        logger.info("-" * 60)
        logger.info(f"Prompt: {prompt[:100]}...")
        
        # Format as chat messages
        messages = [{"role": "user", "content": prompt}]
        formatted_prompt = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        
        # Generate response
        response = generate(
            model, tokenizer, prompt=formatted_prompt, max_tokens=300, verbose=False
        )
        
        logger.info(f"Response: {response[:200]}...")
        logger.info("")
        
        results.append({
            "prompt": prompt,
            "response": response,
            "length": len(response),
        })
    
    return {
        "backend": "mlx",
        "base_model": base_model,
        "adapter_path": adapter_path,
        "results": results,
    }


def test_cuda_model(model_path: str, prompts: list[str]) -> dict:
    """Test CUDA/CPU model."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    
    logger.info("=" * 60)
    logger.info("LOADING CUDA/CPU MODEL")
    logger.info("=" * 60)
    logger.info(f"Model path: {model_path}")
    
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
        trust_remote_code=True,
    )
    
    logger.info("Model loaded successfully!")
    logger.info("")
    
    results = []
    
    for i, prompt in enumerate(prompts):
        logger.info(f"Test {i + 1}/{len(prompts)}")
        logger.info("-" * 60)
        logger.info(f"Prompt: {prompt[:100]}...")
        
        messages = [{"role": "user", "content": prompt}]
        formatted_prompt = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        
        inputs = tokenizer(formatted_prompt, return_tensors="pt")
        if torch.cuda.is_available():
            inputs = {k: v.cuda() for k, v in inputs.items()}
        
        outputs = model.generate(
            **inputs,
            max_new_tokens=300,
            temperature=0.7,
            do_sample=True,
            pad_token_id=tokenizer.eos_token_id,
        )
        
        response = tokenizer.decode(
            outputs[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True
        )
        
        logger.info(f"Response: {response[:200]}...")
        logger.info("")
        
        results.append({
            "prompt": prompt,
            "response": response,
            "length": len(response),
        })
    
    return {
        "backend": "cuda" if torch.cuda.is_available() else "cpu",
        "model_path": model_path,
        "results": results,
    }


def get_test_prompts() -> list[str]:
    """Get standard test prompts for trading agents."""
    return [
        """You are a trading agent in Babylon prediction markets.

Current State:
- Balance: $10,000
- P&L: $250
- Positions: 2 open

Market Update:
- BTC prediction market at 68% probability
- Recent news: Fed announces rate cut consideration

Analyze this market update and explain your trading decision.""",
        
        """You are evaluating a prediction market.

Market: "Will Bitcoin reach $100k by Q1 2025?"
Current Probability: 65% YES
Your Analysis: Technical indicators show bullish momentum, but macro uncertainty remains.

Should you buy YES or NO shares? Explain your reasoning.""",
        
        """You are managing a trading portfolio.

Current Holdings:
- 100 YES shares in "AI regulation passes" market
- 50 NO shares in "Ethereum upgrade succeeds" market

New Market Opens: "Stablecoin regulation announced"
Probability: 40% YES

How should you allocate capital? Explain your strategy.""",
    ]


def validate_responses(results: dict) -> dict:
    """Validate model responses."""
    validation = {
        "total_tests": len(results["results"]),
        "passed": 0,
        "failed": 0,
        "issues": [],
    }
    
    for i, result in enumerate(results["results"]):
        response = result["response"]
        
        # Check response length
        if len(response) < 50:
            validation["issues"].append(f"Test {i + 1}: Response too short ({len(response)} chars)")
            validation["failed"] += 1
            continue
        
        # Check for trading-related keywords
        trading_keywords = ["trade", "buy", "sell", "market", "position", "risk", "profit"]
        has_keywords = any(keyword in response.lower() for keyword in trading_keywords)
        
        if not has_keywords:
            validation["issues"].append(f"Test {i + 1}: Response doesn't contain trading-related content")
            validation["failed"] += 1
            continue
        
        validation["passed"] += 1
    
    return validation


def main():
    parser = argparse.ArgumentParser(
        description="Test Trained Model - Mac (MLX) Support",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    
    # Model paths
    parser.add_argument(
        "--adapter-path",
        default=None,
        help="Path to MLX adapter (for MLX models)"
    )
    parser.add_argument(
        "--model-path",
        default=None,
        help="Path to full model (for CUDA/CPU models)"
    )
    parser.add_argument(
        "--base-model",
        default="mlx-community/Qwen2.5-1.5B-Instruct-4bit",
        help="Base model for MLX adapter"
    )
    
    # Testing options
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Run validation checks on responses"
    )
    parser.add_argument(
        "--custom-prompts",
        nargs="+",
        default=None,
        help="Custom test prompts (space-separated)"
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Save results to JSON file"
    )
    
    args = parser.parse_args()
    
    # Detect backend
    backend = detect_backend()
    
    # Determine which model to test
    if args.adapter_path:
        if backend != "mlx":
            logger.error("Adapter path specified but MLX backend not available!")
            logger.error("Use --model-path for CUDA/CPU models")
            return 1
        
        if not os.path.exists(args.adapter_path):
            logger.error(f"Adapter path not found: {args.adapter_path}")
            return 1
        
        model_path = args.adapter_path
        use_adapter = True
    elif args.model_path:
        if not os.path.exists(args.model_path):
            logger.error(f"Model path not found: {args.model_path}")
            return 1
        
        model_path = args.model_path
        use_adapter = False
    else:
        logger.error("Must specify either --adapter-path (MLX) or --model-path (CUDA/CPU)")
        return 1
    
    # Get test prompts
    if args.custom_prompts:
        prompts = args.custom_prompts
    else:
        prompts = get_test_prompts()
    
    # Run tests
    try:
        if use_adapter and backend == "mlx":
            results = test_mlx_model(model_path, args.base_model, prompts)
        else:
            results = test_cuda_model(model_path, prompts)
        
        # Validate if requested
        if args.validate:
            logger.info("=" * 60)
            logger.info("VALIDATION RESULTS")
            logger.info("=" * 60)
            
            validation = validate_responses(results)
            
            logger.info(f"Total tests: {validation['total_tests']}")
            logger.info(f"Passed: {validation['passed']}")
            logger.info(f"Failed: {validation['failed']}")
            
            if validation['issues']:
                logger.warning("Issues found:")
                for issue in validation['issues']:
                    logger.warning(f"  - {issue}")
            
            results['validation'] = validation
        
        # Save results
        if args.output:
            with open(args.output, 'w') as f:
                json.dump(results, f, indent=2)
            logger.info(f"\nResults saved to: {args.output}")
        
        # Summary
        logger.info("\n" + "=" * 60)
        logger.info("TESTING COMPLETE")
        logger.info("=" * 60)
        logger.info(f"Backend: {results['backend']}")
        logger.info(f"Tests run: {len(results['results'])}")
        logger.info("=" * 60)
        
        return 0
        
    except Exception as e:
        logger.error(f"Testing failed: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())

