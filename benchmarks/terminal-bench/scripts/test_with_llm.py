#!/usr/bin/env python3
"""
Terminal-Bench LLM Integration Test

Tests the complete benchmark with an actual LLM.
Requires OPENAI_API_KEY environment variable.

Usage:
    export OPENAI_API_KEY=sk-...
    python scripts/test_with_llm.py
"""

import asyncio
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# When running inside the monorepo, add local ElizaOS + plugins to PYTHONPATH
_repo_root = Path(__file__).resolve().parents[4]
_local_elizaos = _repo_root / "packages" / "python"
_local_openai_plugin = _repo_root / "plugins" / "plugin-openai" / "python"
if _local_elizaos.exists():
    sys.path.insert(0, str(_local_elizaos))
if _local_openai_plugin.exists():
    sys.path.insert(0, str(_local_openai_plugin))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.getenv("TERMINAL_BENCH_MODEL", "gpt-5-mini")


async def test_standalone_mode() -> bool:
    """Test the agent in standalone mode (direct OpenAI API calls)."""
    from elizaos_terminal_bench.agent import TerminalAgent
    from elizaos_terminal_bench.environment import TerminalEnvironment
    from elizaos_terminal_bench.types import TaskCategory, TaskDifficulty, TerminalTask
    
    logger.info("Testing Standalone Mode (Direct OpenAI API)")
    logger.info("=" * 60)
    
    # Simple task
    task = TerminalTask(
        task_id="llm_test_001",
        instruction="Create a Python script called hello.py that prints 'Hello from Terminal-Bench!' and run it.",
        category=TaskCategory.SCRIPTING,
        difficulty=TaskDifficulty.EASY,
        test_script="""#!/bin/bash
if [ -f /workspace/hello.py ]; then
    output=$(python3 /workspace/hello.py 2>&1)
    if [[ "$output" == *"Hello from Terminal-Bench!"* ]]; then
        exit 0
    fi
fi
exit 1
""",
        reference_solution="""cat > /workspace/hello.py << 'EOF'
print("Hello from Terminal-Bench!")
EOF
python3 /workspace/hello.py""",
        timeout_seconds=120,
        docker_image="python:3.11-slim",
    )
    
    # Create agent (no runtime = standalone mode)
    agent = TerminalAgent(
        max_iterations=10,
        model_name=DEFAULT_MODEL,
        temperature=0.0,
        verbose=True,
    )
    
    try:
        result = await agent.solve_task(task)
        
        logger.info(f"\nResult:")
        logger.info(f"  Success: {result.success}")
        logger.info(f"  Commands executed: {result.commands_executed}")
        logger.info(f"  Tokens used: {result.tokens_used}")
        logger.info(f"  Test exit code: {result.test_exit_code}")
        
        if result.session:
            logger.info(f"\nCommands executed:")
            for cmd in result.session.commands:
                logger.info(f"  $ {cmd.command[:80]}...")
                if cmd.stdout:
                    logger.info(f"    stdout: {cmd.stdout[:100]}...")
        
        if result.error_message:
            logger.info(f"  Error: {result.error_message}")
        
        return result.success
        
    except Exception as e:
        logger.error(f"Error: {e}")
        return False
    finally:
        await agent.close()


async def test_with_elizaos_runtime() -> bool:
    """Test the agent with ElizaOS runtime (requires OpenAI plugin setup)."""
    logger.info("\nTesting ElizaOS Runtime Mode")
    logger.info("=" * 60)
    
    try:
        from elizaos.runtime import AgentRuntime
        from elizaos.types.agent import Character
        from elizaos_plugin_openai import get_openai_plugin
    except ImportError as e:
        logger.warning(f"ElizaOS runtime not available: {e}")
        logger.info("Skipping ElizaOS runtime test")
        return True  # Not a failure, just not available
    
    from elizaos_terminal_bench.agent import TerminalAgent
    from elizaos_terminal_bench.types import TaskCategory, TaskDifficulty, TerminalTask
    
    # Create a simple task
    task = TerminalTask(
        task_id="runtime_test_001",
        instruction="Echo 'Hello Runtime!' to a file called message.txt",
        category=TaskCategory.FILE_OPERATIONS,
        difficulty=TaskDifficulty.EASY,
        test_script="""#!/bin/bash
if [ -f /workspace/message.txt ]; then
    content=$(cat /workspace/message.txt)
    if [[ "$content" == *"Hello Runtime!"* ]]; then
        exit 0
    fi
fi
exit 1
""",
        reference_solution="echo 'Hello Runtime!' > /workspace/message.txt",
        timeout_seconds=60,
    )
    
    try:
        # Create ElizaOS runtime with OpenAI plugin
        character = Character(
            name="TerminalBenchAgent",
            bio="An agent specialized in terminal tasks",
        )
        
        runtime = AgentRuntime(
            character=character,
            plugins=[get_openai_plugin()],
            log_level="WARNING",
        )
        
        await runtime.initialize()
        
        # Create agent with runtime
        agent = TerminalAgent(
            runtime=runtime,
            max_iterations=5,
            verbose=True,
        )
        
        result = await agent.solve_task(task)
        
        logger.info(f"\nResult:")
        logger.info(f"  Success: {result.success}")
        logger.info(f"  Commands: {result.commands_executed}")
        
        await runtime.stop()
        
        return result.success
        
    except Exception as e:
        logger.error(f"ElizaOS runtime test failed: {e}")
        return False


async def run_sample_benchmark() -> None:
    """Run a small benchmark with sample tasks."""
    from elizaos_terminal_bench.runner import TerminalBenchRunner
    from elizaos_terminal_bench.types import TerminalBenchConfig
    
    logger.info("\nRunning Sample Benchmark")
    logger.info("=" * 60)
    
    config = TerminalBenchConfig(
        output_dir="./benchmark_results/llm_test",
        max_tasks=3,  # Just run 3 tasks
        max_iterations=10,
        model_name=DEFAULT_MODEL,
        temperature=0.0,
        verbose=True,
        compare_leaderboard=True,
    )
    
    runner = TerminalBenchRunner(config=config)
    await runner.setup(use_sample_tasks=True)
    
    report = await runner.run(max_tasks=3)
    
    logger.info(f"\n{'='*60}")
    logger.info("BENCHMARK RESULTS")
    logger.info(f"{'='*60}")
    logger.info(f"Accuracy: {report.accuracy:.1%}")
    logger.info(f"Passed: {report.passed_tasks}/{report.total_tasks}")
    logger.info(f"Total Commands: {report.total_commands}")
    logger.info(f"Total Tokens: {report.total_tokens:,}")
    logger.info(f"Evaluation Time: {report.evaluation_time_seconds:.1f}s")
    
    if report.leaderboard_comparison:
        lc = report.leaderboard_comparison
        logger.info(f"\nLeaderboard Position:")
        logger.info(f"  Rank: #{lc.rank} out of {lc.total_entries}")
        logger.info(f"  Score: {lc.our_score:.1f}%")
        logger.info(f"  Percentile: {lc.percentile:.1f}%")
        
        if lc.nearest_above:
            logger.info(f"  Nearest above: {lc.nearest_above[0]} ({lc.nearest_above[1]:.1f}%)")
        if lc.nearest_below:
            logger.info(f"  Nearest below: {lc.nearest_below[0]} ({lc.nearest_below[1]:.1f}%)")
    
    logger.info(f"\nResults saved to: {config.output_dir}")


async def main() -> int:
    """Main entry point."""
    # Check for API key
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        logger.error("OPENAI_API_KEY environment variable not set")
        logger.info("\nTo run this test:")
        logger.info("  export OPENAI_API_KEY=sk-...")
        logger.info("  python scripts/test_with_llm.py")
        return 1

    # Do NOT log any part of API keys (even partial prefixes/suffixes).
    logger.info("OPENAI_API_KEY: set")
    
    # Check Docker
    try:
        import docker
        client = docker.from_env()
        client.ping()
        logger.info("Docker: Available")
    except Exception as e:
        logger.error(f"Docker not available: {e}")
        return 1
    
    results = []
    
    # Test 1: Standalone mode
    try:
        success = await test_standalone_mode()
        results.append(("Standalone Mode", success))
    except Exception as e:
        logger.error(f"Standalone test failed: {e}")
        results.append(("Standalone Mode", False))
    
    # Test 2: ElizaOS runtime mode
    try:
        success = await test_with_elizaos_runtime()
        results.append(("ElizaOS Runtime", success))
    except Exception as e:
        logger.error(f"Runtime test failed: {e}")
        results.append(("ElizaOS Runtime", False))
    
    # Test 3: Sample benchmark
    try:
        await run_sample_benchmark()
        results.append(("Sample Benchmark", True))
    except Exception as e:
        logger.error(f"Benchmark failed: {e}")
        results.append(("Sample Benchmark", False))
    
    # Summary
    logger.info("\n" + "=" * 60)
    logger.info("TEST SUMMARY")
    logger.info("=" * 60)
    
    all_passed = True
    for name, success in results:
        status = "✓ PASS" if success else "✗ FAIL"
        logger.info(f"  {name}: {status}")
        if not success:
            all_passed = False
    
    return 0 if all_passed else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
