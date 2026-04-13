#!/usr/bin/env python3
"""
Comprehensive integration tests for Mind2Web benchmark.

Tests:
1. Types and data structures
2. Dataset loading
3. Provider functionality
4. Action handler functionality
5. Evaluator metrics
6. Full benchmark run (mock mode)
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

# Add paths for imports
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "packages" / "python"))
sys.path.insert(0, str(REPO_ROOT / "benchmarks"))

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def test_types() -> bool:
    """Test type definitions."""
    from benchmarks.mind2web.types import (
        Mind2WebAction,
        Mind2WebConfig,
        Mind2WebOperation,
        Mind2WebResult,
        Mind2WebSplit,
        Mind2WebTask,
    )

    # Test operation enum
    assert Mind2WebOperation.CLICK.value == "CLICK"
    assert Mind2WebOperation.TYPE.value == "TYPE"
    assert Mind2WebOperation.SELECT.value == "SELECT"

    # Test split enum
    assert Mind2WebSplit.TEST_TASK.value == "test_task"
    assert Mind2WebSplit.TEST_WEBSITE.value == "test_website"

    # Test config defaults
    config = Mind2WebConfig()
    assert config.max_steps_per_task == 20
    assert config.use_mock is False
    assert config.temperature == 0.0

    # Test task creation
    task = Mind2WebTask(
        annotation_id="test_001",
        confirmed_task="Test task instruction",
        website="test.com",
        domain="testing",
    )
    assert task.instruction == "Test task instruction"
    assert task.num_steps == 0

    # Test action creation
    action = Mind2WebAction(
        operation=Mind2WebOperation.CLICK,
        element_id="node_123",
        value="",
    )
    assert action.operation == Mind2WebOperation.CLICK

    # Test result creation
    result = Mind2WebResult(
        task_id="test_001",
        instruction="Test",
        website="test.com",
        domain="testing",
        success=True,
        step_accuracy=0.85,
    )
    assert result.success is True
    assert result.step_accuracy == 0.85

    logger.info("✓ Types test passed")
    return True


async def test_dataset() -> bool:
    """Test dataset loading."""
    from benchmarks.mind2web.dataset import Mind2WebDataset
    from benchmarks.mind2web.types import Mind2WebSplit

    # Test sample loading
    dataset = Mind2WebDataset(split=Mind2WebSplit.TEST_TASK)
    await dataset.load(use_sample=True)

    tasks = dataset.get_tasks()
    assert len(tasks) == 3, f"Expected 3 sample tasks, got {len(tasks)}"

    # Verify task structure
    task = tasks[0]
    assert task.annotation_id == "sample_001"
    assert "wireless headphones" in task.confirmed_task.lower()
    assert task.website == "amazon.com"
    assert task.domain == "shopping"
    assert len(task.actions) > 0

    # Verify action structure
    action = task.actions[0]
    assert action.action_uid == "a001"
    assert len(action.pos_candidates) > 0

    # Test get_task_by_id
    found = dataset.get_task_by_id("sample_002")
    assert found is not None
    assert "flight" in found.confirmed_task.lower()

    # Test filter_by_domain
    shopping_tasks = dataset.filter_by_domain("shopping")
    assert len(shopping_tasks) == 1

    logger.info("✓ Dataset test passed")
    return True


async def test_evaluator() -> bool:
    """Test evaluator metrics."""
    from benchmarks.mind2web.evaluator import Mind2WebEvaluator
    from benchmarks.mind2web.types import (
        Mind2WebAction,
        Mind2WebActionStep,
        Mind2WebElement,
        Mind2WebOperation,
        Mind2WebTask,
    )

    evaluator = Mind2WebEvaluator()

    # Create a test task with ground truth
    target_element = Mind2WebElement(
        tag="input",
        backend_node_id="node_search",
        attributes={"id": "search-box"},
        is_original_target=True,
    )

    step1 = Mind2WebActionStep(
        action_uid="a1",
        operation=Mind2WebOperation.CLICK,
        pos_candidates=[target_element],
    )
    step2 = Mind2WebActionStep(
        action_uid="a2",
        operation=Mind2WebOperation.TYPE,
        value="test query",
        pos_candidates=[target_element],
    )

    task = Mind2WebTask(
        annotation_id="eval_test",
        confirmed_task="Test evaluation",
        website="test.com",
        domain="testing",
        actions=[step1, step2],
    )

    # Test perfect predictions
    predictions = [
        Mind2WebAction(operation=Mind2WebOperation.CLICK, element_id="node_search"),
        Mind2WebAction(operation=Mind2WebOperation.TYPE, element_id="node_search", value="test query"),
    ]

    result = evaluator.evaluate_task(task, predictions)
    assert result.success is True, f"Expected success, got {result.success}"
    assert result.element_accuracy == 1.0, f"Expected 100% element accuracy, got {result.element_accuracy}"
    assert result.operation_accuracy == 1.0, f"Expected 100% operation accuracy, got {result.operation_accuracy}"
    assert result.step_accuracy == 1.0, f"Expected 100% step accuracy, got {result.step_accuracy}"

    # Test partial predictions (wrong element on step 2)
    partial_predictions = [
        Mind2WebAction(operation=Mind2WebOperation.CLICK, element_id="node_search"),
        Mind2WebAction(operation=Mind2WebOperation.TYPE, element_id="wrong_node", value="test query"),
    ]

    result2 = evaluator.evaluate_task(task, partial_predictions)
    assert result2.success is False
    assert result2.element_accuracy == 0.5  # 1/2 correct
    assert result2.operation_accuracy == 1.0  # Both operations correct
    assert result2.step_accuracy == 0.5  # Only 1/2 steps fully correct

    # Test aggregate metrics
    metrics = evaluator.compute_aggregate_metrics([result, result2])
    assert metrics["overall_step_accuracy"] == 0.75  # (1.0 + 0.5) / 2
    assert metrics["overall_task_success_rate"] == 0.5  # 1/2 tasks successful

    logger.info("✓ Evaluator test passed")
    return True


async def test_context_and_provider() -> bool:
    """Test Mind2Web context and provider functionality."""
    from benchmarks.mind2web.dataset import Mind2WebDataset
    from benchmarks.mind2web.eliza_agent import (
        ELIZAOS_AVAILABLE,
        get_mind2web_context,
        get_mind2web_context_provider,
        set_mind2web_context,
    )
    from benchmarks.mind2web.types import Mind2WebSplit

    # Load a sample task
    dataset = Mind2WebDataset(split=Mind2WebSplit.TEST_TASK)
    await dataset.load(use_sample=True)
    task = dataset.get_tasks()[0]

    # Set context
    set_mind2web_context(task)
    ctx = get_mind2web_context()

    assert ctx.task is not None
    assert ctx.task.annotation_id == task.annotation_id
    assert ctx.current_step_index == 0
    assert ctx.done is False
    assert len(ctx.executed_actions) == 0

    # Test provider output
    # Note: We're testing the provider function directly without full runtime
    result = await get_mind2web_context_provider(None, None, None)  # type: ignore[arg-type]

    assert result.text != "", "Provider should return non-empty text"
    assert "Mind2Web Task" in result.text, "Provider should include task header"
    assert task.confirmed_task in result.text, "Provider should include task instruction"

    # Check values (these should work in both mock and real mode)
    assert result.values is not None
    assert result.values.get("mind2web_task_id") == task.annotation_id
    assert result.values.get("mind2web_step") == 0
    assert result.values.get("mind2web_done") is False

    # Only check for detailed elements when ElizaOS is available
    if ELIZAOS_AVAILABLE:
        assert "Available Elements" in result.text, "Full provider should include elements"

    logger.info("✓ Context and provider test passed")
    return True


async def test_action_handler() -> bool:
    """Test Mind2Web action handler."""
    from benchmarks.mind2web.dataset import Mind2WebDataset
    from benchmarks.mind2web.eliza_agent import (
        ELIZAOS_AVAILABLE,
        Mind2WebActionHandler,
        get_mind2web_context,
        set_mind2web_context,
    )
    from benchmarks.mind2web.types import Mind2WebOperation, Mind2WebSplit

    # Load a sample task
    dataset = Mind2WebDataset(split=Mind2WebSplit.TEST_TASK)
    await dataset.load(use_sample=True)
    task = dataset.get_tasks()[0]

    # Set context
    set_mind2web_context(task)

    # Create handler
    handler = Mind2WebActionHandler()

    # Test validate
    is_valid = await handler.validate(None, None, None)  # type: ignore[arg-type]
    assert is_valid is True, "Handler should validate when task context exists"

    # Test handler properties
    assert handler.name == "MIND2WEB_ACTION"
    assert "CLICK" in handler.similes or "BROWSER_ACTION" in handler.similes
    assert "operation" in handler.description

    if ELIZAOS_AVAILABLE:
        # Test parameters
        params = handler.parameters
        assert len(params) == 3
        param_names = [p.name for p in params]
        assert "operation" in param_names
        assert "element_id" in param_names
        assert "value" in param_names

    # Simulate action execution by directly modifying context
    ctx = get_mind2web_context()
    assert ctx.current_step_index == 0
    assert len(ctx.executed_actions) == 0

    logger.info("✓ Action handler test passed")
    return True


async def test_mock_agent() -> bool:
    """Test mock agent processing."""
    from benchmarks.mind2web.dataset import Mind2WebDataset
    from benchmarks.mind2web.eliza_agent import MockMind2WebAgent
    from benchmarks.mind2web.types import Mind2WebConfig, Mind2WebSplit

    # Load sample tasks
    dataset = Mind2WebDataset(split=Mind2WebSplit.TEST_TASK)
    await dataset.load(use_sample=True)
    task = dataset.get_tasks()[0]

    # Create mock agent
    config = Mind2WebConfig(use_mock=True)
    agent = MockMind2WebAgent(config)
    await agent.initialize()

    # Process task
    actions = await agent.process_task(task)

    # Verify actions match ground truth
    assert len(actions) == len(task.actions), f"Expected {len(task.actions)} actions, got {len(actions)}"

    for i, (action, gt_step) in enumerate(zip(actions, task.actions)):
        assert action.operation == gt_step.operation, f"Step {i}: operation mismatch"
        if gt_step.target_element:
            assert action.element_id == gt_step.target_element.backend_node_id, f"Step {i}: element_id mismatch"
        assert action.value == gt_step.value, f"Step {i}: value mismatch"

    await agent.close()

    logger.info("✓ Mock agent test passed")
    return True


async def test_full_benchmark_run() -> bool:
    """Test full benchmark run in mock mode."""
    from benchmarks.mind2web.runner import Mind2WebRunner
    from benchmarks.mind2web.types import Mind2WebConfig, Mind2WebSplit

    config = Mind2WebConfig(
        output_dir="/tmp/mind2web_test",
        split=Mind2WebSplit.TEST_TASK,
        max_tasks=2,
        num_trials=1,
        use_mock=True,  # Use mock for testing
        save_detailed_logs=False,
    )

    runner = Mind2WebRunner(config, use_sample=True, use_huggingface=False)
    report = await runner.run_benchmark()

    # Verify report structure
    assert report.total_tasks == 2
    assert report.total_trials == 2
    assert len(report.results) == 2

    # In mock mode with ground truth, should have perfect scores
    assert report.overall_task_success_rate == 1.0, f"Expected 100% success, got {report.overall_task_success_rate}"
    assert report.overall_step_accuracy == 1.0, f"Expected 100% step accuracy, got {report.overall_step_accuracy}"
    assert report.overall_element_accuracy == 1.0, f"Expected 100% element accuracy, got {report.overall_element_accuracy}"

    # Verify summary
    assert report.summary.get("mode") == "mock"
    assert report.summary.get("status") == "excellent"

    logger.info("✓ Full benchmark run test passed")
    return True


async def test_cli_integration() -> bool:
    """Test CLI creates valid config."""
    from benchmarks.mind2web.cli import create_config, parse_args

    # Simulate args
    import sys
    original_argv = sys.argv
    try:
        sys.argv = ["mind2web", "--sample", "--max-tasks", "5", "--provider", "groq"]
        args = parse_args()

        assert args.sample is True
        assert args.max_tasks == 5
        assert args.provider == "groq"

        config = create_config(args)
        assert config.max_tasks == 5
        assert config.model_provider == "groq"
        assert config.use_mock is False  # Real LLM is now the default
    finally:
        sys.argv = original_argv

    logger.info("✓ CLI integration test passed")
    return True


async def run_all_tests() -> bool:
    """Run all tests and report results."""
    print("=" * 60)
    print("Mind2Web Benchmark Integration Tests")
    print("=" * 60)

    tests = [
        ("Types", test_types),
        ("Dataset", test_dataset),
        ("Evaluator", test_evaluator),
        ("Context & Provider", test_context_and_provider),
        ("Action Handler", test_action_handler),
        ("Mock Agent", test_mock_agent),
        ("Full Benchmark Run", test_full_benchmark_run),
        ("CLI Integration", test_cli_integration),
    ]

    passed = 0
    failed = 0

    for name, test_func in tests:
        try:
            if asyncio.iscoroutinefunction(test_func):
                result = await test_func()
            else:
                result = test_func()

            if result:
                passed += 1
            else:
                failed += 1
                logger.error(f"✗ {name} test failed (returned False)")
        except Exception as e:
            failed += 1
            logger.error(f"✗ {name} test failed with error: {e}")
            import traceback
            traceback.print_exc()

    print()
    print("=" * 60)
    print(f"Results: {passed}/{len(tests)} tests passed")
    if failed > 0:
        print(f"         {failed} tests FAILED")
    print("=" * 60)

    return failed == 0


if __name__ == "__main__":
    success = asyncio.run(run_all_tests())
    sys.exit(0 if success else 1)
