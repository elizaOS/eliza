#!/usr/bin/env python3
"""
ElizaOS Training Pipeline - End-to-End Test

This script validates the complete training pipeline:
1. Database connectivity
2. Real trajectory data loading
3. Data conversion to training format
4. Backend availability (MLX/CUDA/CPU)

Run this BEFORE training to verify everything is set up correctly.

Usage:
    python scripts/test_pipeline.py
"""

import asyncio
import logging
import os
import sys
from pathlib import Path

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


class TestResult:
    def __init__(self, name: str):
        self.name = name
        self.passed = False
        self.message = ""
        self.details: dict = {}


async def test_database_connection() -> TestResult:
    """Test database connectivity."""
    result = TestResult("Database Connection")
    
    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        result.message = "DATABASE_URL not set"
        return result
    
    try:
        import asyncpg
        pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2)
        
        # Test query
        async with pool.acquire() as conn:
            count = await conn.fetchval("SELECT COUNT(*) FROM trajectories")
        
        await pool.close()
        
        result.passed = True
        result.message = f"Connected. Found {count} trajectories"
        result.details["trajectory_count"] = count
        
    except Exception as e:
        result.message = f"Connection failed: {e}"
    
    return result


async def test_trajectory_data() -> TestResult:
    """Test that real trajectory data exists."""
    result = TestResult("Real Trajectory Data")
    
    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        result.message = "DATABASE_URL not set"
        return result
    
    try:
        from src.data_bridge import PostgresTrajectoryReader
        
        async with PostgresTrajectoryReader(database_url) as reader:
            windows = await reader.get_window_ids(min_agents=1, lookback_hours=168)
            
            if not windows:
                result.message = "No trajectory windows found"
                return result
            
            # Load trajectories from first window
            trajectories = await reader.get_trajectories_by_window(
                windows[0], min_actions=1
            )
            
            # Count those with LLM calls
            with_llm_calls = 0
            total_llm_calls = 0
            
            for traj in trajectories:
                has_calls = False
                for step in traj.steps:
                    if step.llm_calls:
                        total_llm_calls += len(step.llm_calls)
                        has_calls = True
                if has_calls:
                    with_llm_calls += 1
            
            result.passed = with_llm_calls > 0
            result.message = (
                f"Found {len(windows)} windows, "
                f"{len(trajectories)} trajectories in first window, "
                f"{with_llm_calls} have LLM calls ({total_llm_calls} total calls)"
            )
            result.details = {
                "windows": len(windows),
                "trajectories": len(trajectories),
                "with_llm_calls": with_llm_calls,
                "total_llm_calls": total_llm_calls,
            }
            
    except Exception as e:
        result.message = f"Failed: {e}"
        import traceback
        traceback.print_exc()
    
    return result


async def test_data_conversion() -> TestResult:
    """Test conversion of trajectories to training samples."""
    result = TestResult("Data Conversion")
    
    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        result.message = "DATABASE_URL not set"
        return result
    
    try:
        from src.data_bridge import PostgresTrajectoryReader
        
        async with PostgresTrajectoryReader(database_url) as reader:
            windows = await reader.get_window_ids(min_agents=1, lookback_hours=168)
            
            if not windows:
                result.message = "No windows found"
                return result
            
            trajectories = await reader.get_trajectories_by_window(
                windows[0], min_actions=1
            )
        
        # Convert to training samples
        samples = []
        for traj in trajectories:
            for step in traj.steps:
                if not step.llm_calls:
                    continue
                
                for llm_call in step.llm_calls:
                    if not llm_call.response or len(llm_call.response) < 20:
                        continue
                    
                    messages = []
                    if llm_call.system_prompt:
                        messages.append({"role": "system", "content": llm_call.system_prompt})
                    if llm_call.user_prompt:
                        messages.append({"role": "user", "content": llm_call.user_prompt})
                    messages.append({"role": "assistant", "content": llm_call.response})
                    
                    if len(messages) >= 2:
                        samples.append({"messages": messages})
        
        result.passed = len(samples) >= 10
        result.message = f"Created {len(samples)} training samples"
        result.details["samples"] = len(samples)
        
        if len(samples) > 0:
            # Show sample
            sample = samples[0]
            result.details["sample_preview"] = {
                "roles": [m["role"] for m in sample["messages"]],
                "lengths": [len(m["content"]) for m in sample["messages"]],
            }
        
    except Exception as e:
        result.message = f"Failed: {e}"
        import traceback
        traceback.print_exc()
    
    return result


def test_mlx_backend() -> TestResult:
    """Test MLX backend availability."""
    result = TestResult("MLX Backend")
    
    try:
        import mlx.core as mx
        import mlx_lm
        
        result.passed = True
        result.message = f"MLX available (mlx-lm version: {mlx_lm.__version__})"
        
    except ImportError as e:
        result.message = f"MLX not available: {e}"
    
    return result


def test_cuda_backend() -> TestResult:
    """Test CUDA backend availability."""
    result = TestResult("CUDA Backend")
    
    try:
        import torch
        
        if torch.cuda.is_available():
            device_name = torch.cuda.get_device_name(0)
            vram = torch.cuda.get_device_properties(0).total_memory / 1e9
            
            result.passed = True
            result.message = f"CUDA available: {device_name} ({vram:.1f} GB)"
            result.details = {
                "device": device_name,
                "vram_gb": vram,
            }
        else:
            result.message = "PyTorch installed but CUDA not available"
            
    except ImportError as e:
        result.message = f"PyTorch not installed: {e}"
    
    return result


def test_transformers() -> TestResult:
    """Test transformers library."""
    result = TestResult("Transformers Library")
    
    try:
        import transformers
        
        result.passed = True
        result.message = f"transformers {transformers.__version__}"
        
    except ImportError as e:
        result.message = f"Not installed: {e}"
    
    return result


def test_environment_variables() -> TestResult:
    """Test required environment variables."""
    result = TestResult("Environment Variables")
    
    checks = {
        "DATABASE_URL": bool(os.getenv("DATABASE_URL")),
        "OPENAI_API_KEY": bool(os.getenv("OPENAI_API_KEY")),
        "TINKER_API_KEY": bool(os.getenv("TINKER_API_KEY")),
    }
    
    required = ["DATABASE_URL"]
    optional = ["OPENAI_API_KEY", "TINKER_API_KEY"]
    
    missing_required = [k for k in required if not checks[k]]
    missing_optional = [k for k in optional if not checks[k]]
    
    result.passed = len(missing_required) == 0
    
    if result.passed:
        result.message = f"Required vars set. Optional missing: {', '.join(missing_optional) or 'none'}"
    else:
        result.message = f"Missing required: {', '.join(missing_required)}"
    
    result.details = checks
    return result


async def main():
    """Run all tests."""
    print("=" * 70)
    print("  ELIZAOS TRAINING PIPELINE - END-TO-END TEST")
    print("=" * 70)
    print()
    
    # Run tests
    tests = [
        ("Environment Variables", test_environment_variables()),
        ("Database Connection", await test_database_connection()),
        ("Real Trajectory Data", await test_trajectory_data()),
        ("Data Conversion", await test_data_conversion()),
        ("Transformers Library", test_transformers()),
        ("MLX Backend", test_mlx_backend()),
        ("CUDA Backend", test_cuda_backend()),
    ]
    
    passed = 0
    failed = 0
    
    for name, result in tests:
        status = "✅" if result.passed else "❌"
        print(f"{status} {result.name}")
        print(f"   {result.message}")
        if result.details:
            for k, v in result.details.items():
                if k != "sample_preview":
                    print(f"   - {k}: {v}")
        print()
        
        if result.passed:
            passed += 1
        else:
            failed += 1
    
    # Summary
    print("=" * 70)
    print(f"  RESULTS: {passed} passed, {failed} failed")
    print("=" * 70)
    
    # Required checks
    required_tests = [
        "Environment Variables",
        "Database Connection", 
        "Real Trajectory Data",
        "Data Conversion",
    ]
    
    required_passed = all(
        result.passed for name, result in tests 
        if result.name in required_tests
    )
    
    if required_passed:
        print()
        print("✅ All required checks passed!")
        print()
        print("Ready to train. Run:")
        print("  python scripts/train_local.py")
        print()
        return 0
    else:
        print()
        print("❌ Some required checks failed. Fix issues before training.")
        print()
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

