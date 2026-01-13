#!/usr/bin/env python3
"""
Docker Environment Test Script

Tests the Docker-based terminal environment without requiring an LLM.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from elizaos_terminal_bench.environment import TerminalEnvironment
from elizaos_terminal_bench.types import TaskCategory, TaskDifficulty, TerminalTask


async def test_docker_environment() -> bool:
    """Test the Docker environment functionality."""
    print("Testing Docker Terminal Environment")
    print("=" * 50)

    # Create a simple test task
    task = TerminalTask(
        task_id="docker_test",
        instruction="Test Docker environment",
        category=TaskCategory.SCRIPTING,
        difficulty=TaskDifficulty.EASY,
        test_script="exit 0",
        reference_solution="echo 'test'",
        timeout_seconds=60,
    )

    env = TerminalEnvironment(
        image="ubuntu:22.04",
        memory_limit="1g",
        timeout_seconds=30,
    )

    try:
        print("\n1. Starting Docker container...")
        await env.start(task)
        print("   ✓ Container started successfully")

        print("\n2. Testing command execution...")
        result = await env.execute("echo 'Hello from Docker!'")
        assert result.exit_code == 0
        assert "Hello from Docker!" in result.stdout
        print(f"   ✓ Command executed: {result.stdout.strip()}")

        print("\n3. Testing file operations...")
        success = await env.write_file("/workspace/test.txt", "test content")
        assert success
        content = await env.get_file_content("/workspace/test.txt")
        assert "test content" in content
        print("   ✓ File write/read successful")

        print("\n4. Testing directory operations...")
        await env.execute("mkdir -p /workspace/subdir")
        exists = await env.directory_exists("/workspace/subdir")
        assert exists
        print("   ✓ Directory created successfully")

        print("\n5. Testing test script execution...")
        test_script = """#!/bin/bash
if [ -f /workspace/test.txt ]; then
    exit 0
else
    exit 1
fi
"""
        success, output, exit_code = await env.run_test(test_script)
        assert success
        print(f"   ✓ Test script passed (exit code: {exit_code})")

        print("\n" + "=" * 50)
        print("✓ All Docker environment tests passed!")
        return True

    except AssertionError as e:
        print(f"\n✗ Test assertion failed: {e}")
        return False
    except Exception as e:
        print(f"\n✗ Error: {e}")
        return False
    finally:
        print("\n6. Stopping container...")
        await env.stop()
        print("   ✓ Container stopped")


def main() -> None:
    """Main entry point."""
    success = asyncio.run(test_docker_environment())
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
