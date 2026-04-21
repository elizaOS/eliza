#!/usr/bin/env python3
"""
Run batch model comparison for code_loop_explorer with parallel execution support.
Tests multiple models with specified runs and messages in parallel batches.
"""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# Add to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))


async def run_single_experiment(model: str, run_idx: int, max_messages: int, env_name: str, cleanup_files: bool = False):
    """Run a single code_loop_explorer experiment"""
    
    # Create unique code file name
    model_safe = model.replace("/", "_").replace("-", "_").replace(".", "_")
    timestamp = datetime.now().strftime('%H%M%S')
    code_file = f"voyager/skill_runner/batch_{model_safe}_{run_idx}_{timestamp}.ts"
    env_config = f'voyager/environments/{env_name}_env.json'

    # Set up environment for this run
    env = os.environ.copy()
    env['MODEL_NAME'] = model
    env['RUN_INDEX'] = str(run_idx)
    env['CODE_FILE'] = code_file
    env['MAX_MESSAGES'] = str(max_messages)
    env['ENVIRONMENT_CONFIG'] = env_config 
    env['USE_EXTERNAL_SURFPOOL'] = 'true'  # Always use external for parallel
    
    print(f"  🚀 Starting {model} run {run_idx} (file: {Path(code_file).name})")
    
    # Run as subprocess to avoid conflicts
    process = await asyncio.create_subprocess_exec(
        'uv', 'run', 'python', 'code_loop_explorer.py',
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    stdout, stderr = await process.communicate()
    
    # Optionally clean up temp file
    if cleanup_files:
        try:
            os.remove(code_file)
        except:
            pass
    
    if process.returncode == 0:
        print(f"  ✅ {model} run {run_idx} completed (file: {Path(code_file).name})")
        return True
    else:
        print(f"  ❌ {model} run {run_idx} failed")
        if stderr:
            error_msg = stderr.decode()[:200]
            print(f"     Error: {error_msg}")
        return False


async def run_parallel_batch(experiments, batch_size, max_messages, env_name, cleanup_files=False):
    """Run a batch of experiments in parallel"""
    
    results = []
    total = len(experiments)
    
    for i in range(0, total, batch_size):
        batch = experiments[i:i+batch_size]
        batch_num = i // batch_size + 1
        total_batches = (total + batch_size - 1) // batch_size
        
        print(f"\n📦 Batch {batch_num}/{total_batches} ({len(batch)} experiments)")
        print("─" * 50)
        
        batch_start = time.time()
        
        # Run batch in parallel
        tasks = [
            run_single_experiment(model, run_idx, max_messages, env_name, cleanup_files)
            for model, run_idx in batch
        ]
        
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Process results
        for (model, run_idx), result in zip(batch, batch_results):
            if isinstance(result, Exception):
                print(f"  ⚠️  {model} run {run_idx}: Exception - {result}")
                results.append(False)
            else:
                results.append(result)
        
        batch_duration = time.time() - batch_start
        print(f"  ⏱️  Batch completed in {batch_duration:.1f} seconds")
        
        # Small delay between batches to avoid overwhelming the system
        if i + batch_size < total:
            print("  💤 Pausing 5 seconds before next batch...")
            await asyncio.sleep(5)
    
    return results


def load_environment(env_name: str):
    def load_environment_config(env_name: str):
        with open(f"voyager/environments/{env_name}_env.json", "r") as f:
            return json.load(f)
    env_file = load_environment_config(env_name)
    package_json = env_file.get("package_json", None)
    if not package_json:
        raise ValueError(f"Package JSON not found for environment {env_name}")

    # cp this to voyager/skill_runner/package.json
    shutil.copy(package_json, "voyager/skill_runner/package.json")
    # then do bun install in the skill_runner directory
    subprocess.run(["bun", "install"], cwd="voyager/skill_runner")

    return env_file, package_json

async def run_comparison():
    """Run model comparison with parallel execution"""
    
    # Configuration
    models = [
        "openai/gpt-oss-120b",
        "google/gemini-2.5-flash",
        "anthropic/claude-sonnet-4",
        "openai/gpt-5"
    ]
    
    runs_per_model = 5
    max_messages = 50
    parallel_batch_size = len(models) * runs_per_model  # Run ALL experiments at once!
    cleanup_files = False  # Keep the generated code files for inspection
    env_name = "basic"
    load_environment(env_name)
    
    # Check surfpool
    use_external_surfpool = os.getenv("USE_EXTERNAL_SURFPOOL", "false").lower() == "true"
    
    print("="*60)
    print("CODE LOOP MODEL COMPARISON BATCH (PARALLEL)")
    print("="*60)
    print(f"Models to test: {len(models)}")
    for m in models:
        print(f"  - {m}")
    print(f"Runs per model: {runs_per_model}")
    print(f"Messages per run: {max_messages}")
    print(f"Total experiments: {len(models) * runs_per_model}")
    print(f"Parallel batch size: {parallel_batch_size}")
    print(f"Keep code files: {not cleanup_files}")
    print(f"Environment: {env_name}")
    
    # Time estimates
    if not use_external_surfpool:
        print("\n⚠️  WARNING: Parallel execution requires external surfpool!")
        print("   Please run in another terminal:")
        print("   surfpool start -u https://api.mainnet-beta.solana.com --no-tui")
        print("\n   Then set: export USE_EXTERNAL_SURFPOOL=true")
        return
    
    print("\n✅ Using EXTERNAL surfpool instance on localhost:8899")
    print("="*60)
    
    # Confirm
    response = input("\nProceed with parallel execution? (y/n): ")
    if response.lower() != 'y':
        print("Cancelled")
        return
    
    # Prepare all experiments
    experiments = []
    for model in models:
        for run_idx in range(runs_per_model):
            experiments.append((model, run_idx))
    
    print(f"\n🚀 Starting {len(experiments)} experiments in batches of {parallel_batch_size}")
    start_time = time.time()
    
    # Run all experiments in parallel batches
    results = await run_parallel_batch(experiments, parallel_batch_size, max_messages, env_name, cleanup_files)
    
    # Summary
    total_duration = time.time() - start_time
    success_count = sum(1 for r in results if r)
    
    print(f"\n{'='*60}")
    print("PARALLEL BATCH COMPLETE!")
    print(f"{'='*60}")
    print(f"Total experiments: {len(experiments)}")
    print(f"Successful: {success_count}/{len(experiments)}")
    print(f"Failed: {len(experiments) - success_count}")
    print(f"\n⏱️  Performance:")
    print(f"  Total time: {total_duration:.1f} seconds ({total_duration/60:.1f} minutes)")
    print(f"  Average per experiment: {total_duration/len(experiments):.1f} seconds")
    print(f"  Effective speedup: ~{(len(experiments) * 12 * 60) / total_duration:.1f}x")
    
    # Report by model
    print(f"\n📊 Results by Model:")
    for model in models:
        model_results = []
        for i, (m, _) in enumerate(experiments):
            if m == model:
                model_results.append(results[i])
        success = sum(1 for r in model_results if r)
        print(f"  {model}: {success}/{len(model_results)} successful")
    
    print(f"\n📈 To analyze results, run:")
    print("  uv run python analyze_code_loop_performance.py")
    print(f"{'='*60}")


async def run_sequential_comparison():
    """Original sequential version for comparison"""
    
    # This is the old sequential code - kept for reference
    # You can call this instead of run_comparison() to use sequential mode
    
    from code_loop_explorer import main as run_code_loop
    
    models = ["qwen/qwen3-coder"]
    runs_per_model = 5
    max_messages = 50
    
    print("Running in SEQUENTIAL mode (slow)...")
    
    for model in models:
        for run_idx in range(runs_per_model):
            os.environ['MODEL_NAME'] = model
            os.environ['MAX_MESSAGES'] = str(max_messages)
            os.environ['RUN_INDEX'] = str(run_idx)
            
            print(f"Running {model} run {run_idx}...")
            await run_code_loop()
            print(f"Completed {model} run {run_idx}")


if __name__ == "__main__":
    # Default to parallel mode
    asyncio.run(run_comparison())
    
    # To use sequential mode:
    # asyncio.run(run_sequential_comparison())