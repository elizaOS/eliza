#!/usr/bin/env python3
"""
Terminal-Bench Integration Test Script

Tests the complete benchmark flow including:
1. Docker environment functionality
2. Agent action parsing and execution
3. Task evaluation
4. Report generation

This script tests WITHOUT an LLM by mocking the agent responses.
"""

import asyncio
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from elizaos_terminal_bench.agent import TerminalAgent
from elizaos_terminal_bench.dataset import TerminalBenchDataset
from elizaos_terminal_bench.environment import TerminalEnvironment, MockTerminalEnvironment
from elizaos_terminal_bench.evaluator import TerminalBenchEvaluator, format_report_markdown
from elizaos_terminal_bench.runner import TerminalBenchRunner
from elizaos_terminal_bench.types import (
    TaskCategory,
    TaskDifficulty,
    TerminalBenchConfig,
    TerminalTask,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


class IntegrationTestResult:
    """Tracks test results."""
    
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []
    
    def success(self, name: str) -> None:
        self.passed += 1
        logger.info(f"✓ {name}")
    
    def failure(self, name: str, error: str) -> None:
        self.failed += 1
        self.errors.append(f"{name}: {error}")
        logger.error(f"✗ {name}: {error}")
    
    def summary(self) -> None:
        total = self.passed + self.failed
        logger.info(f"\n{'='*50}")
        logger.info(f"Tests: {self.passed}/{total} passed")
        if self.errors:
            logger.info("Errors:")
            for error in self.errors:
                logger.info(f"  - {error}")


async def test_dataset_loading(results: IntegrationTestResult) -> None:
    """Test dataset loading and filtering."""
    logger.info("\n--- Testing Dataset Loading ---")
    
    try:
        dataset = TerminalBenchDataset(use_sample_tasks=True)
        await dataset.load()
        
        if len(dataset) > 0:
            results.success("Load sample tasks")
        else:
            results.failure("Load sample tasks", "No tasks loaded")
            return
        
        # Test filtering
        scripting_tasks = dataset.filter_by_category(TaskCategory.SCRIPTING)
        if len(scripting_tasks) > 0:
            results.success("Filter by category")
        else:
            results.failure("Filter by category", "No scripting tasks found")
        
        easy_tasks = dataset.filter_by_difficulty(TaskDifficulty.EASY)
        if len(easy_tasks) > 0:
            results.success("Filter by difficulty")
        else:
            results.failure("Filter by difficulty", "No easy tasks found")
        
        # Test statistics
        stats = dataset.get_statistics()
        if stats["total_tasks"] > 0:
            results.success("Get statistics")
        else:
            results.failure("Get statistics", "Invalid statistics")
            
    except Exception as e:
        results.failure("Dataset loading", str(e))


async def test_mock_environment(results: IntegrationTestResult) -> None:
    """Test mock terminal environment."""
    logger.info("\n--- Testing Mock Environment ---")
    
    try:
        env = MockTerminalEnvironment()
        await env.start()
        
        # Test basic execution
        result = await env.execute("echo 'hello'")
        if result.exit_code == 0:
            results.success("Mock command execution")
        else:
            results.failure("Mock command execution", f"Exit code: {result.exit_code}")
        
        # Test mock response
        env.set_mock_response("test_cmd", "test output", "", 0)
        result = await env.execute("test_cmd arg1")
        if result.stdout == "test output":
            results.success("Mock response override")
        else:
            results.failure("Mock response override", f"Got: {result.stdout}")
        
        # Test run_test
        success, output, code = await env.run_test("exit 0")
        if success:
            results.success("Mock test execution")
        else:
            results.failure("Mock test execution", f"Test failed with code {code}")
        
        await env.stop()
        
    except Exception as e:
        results.failure("Mock environment", str(e))


async def test_docker_environment(results: IntegrationTestResult) -> None:
    """Test Docker terminal environment (if Docker available)."""
    logger.info("\n--- Testing Docker Environment ---")
    
    try:
        import docker
        client = docker.from_env()
        client.ping()
    except Exception:
        logger.warning("Docker not available, skipping Docker tests")
        return
    
    try:
        env = TerminalEnvironment(
            image="ubuntu:22.04",
            timeout_seconds=30,
        )
        
        await env.start()
        results.success("Docker container start")
        
        # Test basic command
        result = await env.execute("echo 'hello from docker'")
        if result.exit_code == 0 and "hello from docker" in result.stdout:
            results.success("Docker command execution")
        else:
            results.failure("Docker command execution", f"Unexpected output: {result.stdout}")
        
        # Test file operations
        success = await env.write_file("/workspace/test.txt", "test content")
        if success:
            results.success("Docker file write")
        else:
            results.failure("Docker file write", "Write failed")
        
        content = await env.get_file_content("/workspace/test.txt")
        if "test content" in content:
            results.success("Docker file read")
        else:
            results.failure("Docker file read", f"Unexpected content: {content}")
        
        # Test test script
        test_script = """#!/bin/bash
if [ -f /workspace/test.txt ]; then
    exit 0
fi
exit 1
"""
        success, output, code = await env.run_test(test_script)
        if success:
            results.success("Docker test script execution")
        else:
            results.failure("Docker test script execution", f"Exit code: {code}")
        
        await env.stop()
        results.success("Docker container cleanup")
        
    except Exception as e:
        results.failure("Docker environment", str(e))


async def test_agent_action_parsing(results: IntegrationTestResult) -> None:
    """Test agent action parsing logic."""
    logger.info("\n--- Testing Agent Action Parsing ---")
    
    try:
        env = MockTerminalEnvironment()
        await env.start()
        
        agent = TerminalAgent(environment=env)
        agent._session = type('obj', (object,), {'commands': []})()
        
        # Test EXECUTE action parsing
        response = """Let me execute the command.

ACTION: EXECUTE
COMMAND: ls -la /workspace"""
        
        result, completed = await agent._parse_and_execute_action(response)
        if (not completed) and result and "Exit code" in result:
            results.success("Parse EXECUTE action")
        else:
            results.failure("Parse EXECUTE action", f"Unexpected result: {result}")
        
        # Test TASK_COMPLETE detection
        response = """I have completed the task.
        
ACTION: TASK_COMPLETE"""
        
        result, completed = await agent._parse_and_execute_action(response)
        if completed:
            results.success("Parse TASK_COMPLETE action")
        else:
            results.failure("Parse TASK_COMPLETE action", "Should signal completion")
        
        # Test code block extraction
        response = """Here's the command:

```bash
echo "hello world"
```
"""
        command = agent._extract_command_from_response(response)
        if command and "hello world" in command:
            results.success("Extract command from code block")
        else:
            results.failure("Extract command from code block", f"Got: {command}")
        
        # Test COMMAND: prefix extraction
        response = "COMMAND: pwd"
        command = agent._extract_command_from_response(response)
        if command == "pwd":
            results.success("Extract COMMAND: prefix")
        else:
            results.failure("Extract COMMAND: prefix", f"Got: {command}")
        
        await env.stop()
        
    except Exception as e:
        results.failure("Agent action parsing", str(e))


async def test_evaluator_metrics(results: IntegrationTestResult) -> None:
    """Test evaluator metrics calculation."""
    logger.info("\n--- Testing Evaluator Metrics ---")
    
    try:
        from elizaos_terminal_bench.types import TerminalBenchResult
        
        evaluator = TerminalBenchEvaluator()
        
        # Create test results
        test_results = [
            TerminalBenchResult(
                task_id="task_1",
                success=True,
                commands_executed=5,
                total_execution_time_ms=1000,
                test_output="",
                tokens_used=100,
                category=TaskCategory.SCRIPTING,
                difficulty=TaskDifficulty.EASY,
            ),
            TerminalBenchResult(
                task_id="task_2",
                success=False,
                commands_executed=3,
                total_execution_time_ms=500,
                test_output="",
                tokens_used=80,
                category=TaskCategory.FILE_OPERATIONS,
                difficulty=TaskDifficulty.MEDIUM,
                error_message="Test failed",
            ),
        ]
        
        # Test basic metrics
        metrics = evaluator.calculate_metrics(test_results)
        if metrics["total"] == 2 and metrics["passed"] == 1 and metrics["accuracy"] == 0.5:
            results.success("Calculate basic metrics")
        else:
            results.failure("Calculate basic metrics", f"Unexpected metrics: {metrics}")
        
        # Test category metrics
        by_category = evaluator.calculate_category_metrics(test_results)
        if TaskCategory.SCRIPTING in by_category:
            results.success("Calculate category metrics")
        else:
            results.failure("Calculate category metrics", "Missing category")
        
        # Test difficulty metrics
        by_difficulty = evaluator.calculate_difficulty_metrics(test_results)
        if TaskDifficulty.EASY in by_difficulty:
            results.success("Calculate difficulty metrics")
        else:
            results.failure("Calculate difficulty metrics", "Missing difficulty")
        
        # Test error categorization
        errors = evaluator.categorize_errors(test_results)
        if "Test failed" in errors:
            results.success("Categorize errors")
        else:
            results.failure("Categorize errors", f"Missing error: {errors}")
        
        # Test leaderboard comparison
        comparison = evaluator.compare_to_leaderboard(0.50)
        if comparison.our_score == 50.0 and comparison.rank > 0:
            results.success("Leaderboard comparison")
        else:
            results.failure("Leaderboard comparison", f"Unexpected: {comparison}")
        
        # Test report generation
        report = evaluator.create_report(
            results=test_results,
            evaluation_time_seconds=10.0,
        )
        if report.accuracy == 0.5:
            results.success("Create report")
        else:
            results.failure("Create report", f"Unexpected accuracy: {report.accuracy}")
        
        # Test markdown formatting
        markdown = format_report_markdown(report)
        if "Terminal-Bench" in markdown and "50.0%" in markdown:
            results.success("Format markdown report")
        else:
            results.failure("Format markdown report", "Missing expected content")
        
    except Exception as e:
        results.failure("Evaluator metrics", str(e))


async def test_runner_dry_run(results: IntegrationTestResult) -> None:
    """Test benchmark runner in dry-run mode."""
    logger.info("\n--- Testing Runner (Dry Run) ---")
    
    try:
        config = TerminalBenchConfig(
            output_dir="./test_output",
            max_tasks=2,
            dry_run=True,
            generate_markdown=True,
        )
        
        runner = TerminalBenchRunner(config=config)
        await runner.setup(use_sample_tasks=True)
        
        if runner._setup_complete and len(runner.dataset) > 0:
            results.success("Runner setup")
        else:
            results.failure("Runner setup", "Setup incomplete")
            return
        
        report = await runner.run(max_tasks=2)
        
        if report.total_tasks == 2:
            results.success("Runner dry run execution")
        else:
            results.failure("Runner dry run execution", f"Unexpected tasks: {report.total_tasks}")
        
        # Check report files were created
        output_dir = Path(config.output_dir)
        json_files = list(output_dir.glob("*.json"))
        if json_files:
            results.success("JSON report generation")
        else:
            results.failure("JSON report generation", "No JSON files created")
        
        md_files = list(output_dir.glob("*.md"))
        if md_files:
            results.success("Markdown report generation")
        else:
            results.failure("Markdown report generation", "No MD files created")
        
        # Cleanup
        import shutil
        if output_dir.exists():
            shutil.rmtree(output_dir)
        
    except Exception as e:
        results.failure("Runner dry run", str(e))


async def test_end_to_end_with_docker(results: IntegrationTestResult) -> None:
    """Test complete end-to-end flow with Docker (no LLM)."""
    logger.info("\n--- Testing End-to-End with Docker (Mocked Agent) ---")
    
    try:
        import docker
        client = docker.from_env()
        client.ping()
    except Exception:
        logger.warning("Docker not available, skipping E2E test")
        return
    
    try:
        # Create a simple task
        task = TerminalTask(
            task_id="e2e_test",
            instruction="Create a file called hello.txt with 'Hello World' content",
            category=TaskCategory.FILE_OPERATIONS,
            difficulty=TaskDifficulty.EASY,
            test_script="""#!/bin/bash
if [ -f /workspace/hello.txt ]; then
    content=$(cat /workspace/hello.txt)
    if [[ "$content" == *"Hello World"* ]]; then
        exit 0
    fi
fi
exit 1
""",
            reference_solution="echo 'Hello World' > /workspace/hello.txt",
            timeout_seconds=60,
        )
        
        # Create environment
        env = TerminalEnvironment(timeout_seconds=30)
        await env.start(task)
        
        # Manually execute the solution (simulating agent behavior)
        result = await env.execute("echo 'Hello World' > /workspace/hello.txt")
        if result.exit_code != 0:
            results.failure("E2E command execution", f"Exit code: {result.exit_code}")
            await env.stop()
            return
        
        # Run test
        success, output, code = await env.run_test(task.test_script)
        
        if success:
            results.success("End-to-end task completion")
        else:
            results.failure("End-to-end task completion", f"Test failed: {output}")
        
        await env.stop()
        
    except Exception as e:
        results.failure("End-to-end test", str(e))


async def main() -> int:
    """Run all integration tests."""
    logger.info("="*60)
    logger.info("Terminal-Bench Integration Tests")
    logger.info("="*60)
    
    results = IntegrationTestResult()
    
    await test_dataset_loading(results)
    await test_mock_environment(results)
    await test_docker_environment(results)
    await test_agent_action_parsing(results)
    await test_evaluator_metrics(results)
    await test_runner_dry_run(results)
    await test_end_to_end_with_docker(results)
    
    results.summary()
    
    return 0 if results.failed == 0 else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
