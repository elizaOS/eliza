"""
Tests for canonical ElizaOS agent usage in REALM benchmark.

These tests verify that the REALM agent uses the full ElizaOS message handling loop:
1. AgentRuntime with basicCapabilities enabled
2. Custom REALM actions (GENERATE_PLAN, EXECUTE_STEP, etc.)
3. Custom REALM providers (REALM_TASK, PLANNING_STATE)
4. MessageService.handle_message() for processing
5. TrajectoryLoggerService for training data export
"""

from __future__ import annotations

import pytest
from benchmarks.realm import (
    ELIZAOS_AVAILABLE,
    REALM_PLUGIN_AVAILABLE,
    TRAJECTORY_LOGGER_AVAILABLE,
    REALMAgent,
    REALMCategory,
    REALMTask,
    REALMTestCase,
    realm_plugin,
)


@pytest.mark.skipif(not ELIZAOS_AVAILABLE, reason="ElizaOS not available")
def test_elizaos_available() -> None:
    """Verify ElizaOS is available for testing."""
    assert ELIZAOS_AVAILABLE is True


@pytest.mark.skipif(not REALM_PLUGIN_AVAILABLE, reason="REALM plugin not available")
def test_realm_plugin_structure() -> None:
    """Verify REALM plugin has correct structure."""
    assert realm_plugin is not None
    assert realm_plugin.name == "realm"
    
    # Check actions
    action_names = [a.name for a in realm_plugin.actions]
    assert "GENERATE_PLAN" in action_names
    assert "EXECUTE_STEP" in action_names
    assert "ADAPT_PLAN" in action_names
    assert "COMPLETE_TASK" in action_names
    
    # Check providers
    provider_names = [p.name for p in realm_plugin.providers]
    assert "REALM_TASK" in provider_names
    assert "PLANNING_STATE" in provider_names


@pytest.mark.skipif(not REALM_PLUGIN_AVAILABLE, reason="REALM plugin not available")
def test_realm_task_provider() -> None:
    """Test REALM_TASK provider context injection."""
    from benchmarks.realm.plugin.providers import (
        set_task_context,
        get_task_context,
    )
    
    # Set context
    context = {
        "task_id": "test-001",
        "task_name": "Test Task",
        "task_goal": "Test the provider",
        "available_tools": ["tool1", "tool2"],
        "constraints": {"time": "30s"},
        "max_steps": 5,
    }
    set_task_context(context)
    
    # Verify context is accessible
    retrieved = get_task_context()
    assert retrieved is not None
    assert retrieved["task_id"] == "test-001"
    assert retrieved["task_name"] == "Test Task"
    
    # Clear context
    set_task_context(None)
    assert get_task_context() is None


@pytest.mark.skipif(not ELIZAOS_AVAILABLE, reason="ElizaOS not available")
@pytest.mark.asyncio
async def test_agent_initialization() -> None:
    """Test that REALMAgent initializes with ElizaOS runtime."""
    agent = REALMAgent(use_llm=False)  # Don't require LLM for this test
    
    try:
        await agent.initialize()
        
        assert agent._initialized is True
        assert agent.runtime is not None
        
        # Check that basicCapabilities are loaded
        # Bootstrap plugin should have loaded basic actions (REPLY, IGNORE, NONE)
        basic_action_names = {a.name for a in agent.runtime.actions}
        assert "REPLY" in basic_action_names
        
        # Check that REALM plugin actions are loaded
        assert "GENERATE_PLAN" in basic_action_names
        assert "EXECUTE_STEP" in basic_action_names
        
        # Check providers
        provider_names = {p.name for p in agent.runtime.providers}
        assert "REALM_TASK" in provider_names
        assert "PLANNING_STATE" in provider_names
        
        # Basic providers should also be present
        assert "ACTIONS" in provider_names
        assert "CHARACTER" in provider_names
        
    finally:
        await agent.close()


@pytest.mark.skipif(not ELIZAOS_AVAILABLE, reason="ElizaOS not available")
@pytest.mark.asyncio
async def test_agent_solve_task_heuristic() -> None:
    """Test solving a task with heuristic planning (no LLM)."""
    task = REALMTask(
        id="test-task-001",
        name="Test Planning Task",
        description="A simple test task",
        category=REALMCategory.SEQUENTIAL,
        difficulty=1,
        goal="Complete the test task",
        available_tools=["search", "analyze", "report"],
        expected_outcome="Task completed",
        max_steps=5,
        timeout_ms=30000,
        constraints={},
        requirements=[],
    )
    
    test_case = REALMTestCase(
        task=task,
        input={"message": "Complete this test task"},
        expected={
            "actions": ["search", "analyze", "report"],
            "outcome": "Task completed",
            "metrics": {
                "max_duration": 30000,
                "max_steps": 5,
                "required_actions": ["search", "analyze"],
            },
        },
    )
    
    # Use heuristic mode (no LLM required)
    agent = REALMAgent(use_llm=False)
    
    try:
        await agent.initialize()
        trajectory = await agent.solve_task(task, test_case)
        
        # Verify trajectory has steps
        assert len(trajectory.steps) > 0
        assert trajectory.task_id == task.id
        assert trajectory.duration_ms > 0
        
        # Check step structure
        for step in trajectory.steps:
            assert step.action is not None
            assert step.action.name in task.available_tools
            assert step.step_number > 0
            
    finally:
        await agent.close()


@pytest.mark.skipif(not REALM_PLUGIN_AVAILABLE, reason="REALM plugin not available")
@pytest.mark.asyncio
async def test_generate_plan_action_validation() -> None:
    """Test GENERATE_PLAN action validates task context."""
    from benchmarks.realm.plugin.actions import validate_generate_plan
    from benchmarks.realm.plugin.providers import set_task_context
    
    # Mock runtime and message (not used by validation)
    class MockRuntime:
        pass
    
    class MockMemory:
        pass
    
    # Without context, validation should fail
    set_task_context(None)
    assert await validate_generate_plan(MockRuntime(), MockMemory(), None) is False  # type: ignore[arg-type]
    
    # With context but no goal, validation should fail
    set_task_context({"task_name": "test"})
    assert await validate_generate_plan(MockRuntime(), MockMemory(), None) is False  # type: ignore[arg-type]
    
    # With full context, validation should pass
    set_task_context({
        "task_name": "test",
        "task_goal": "accomplish something",
        "available_tools": ["tool1"],
    })
    assert await validate_generate_plan(MockRuntime(), MockMemory(), None) is True  # type: ignore[arg-type]
    
    # Cleanup
    set_task_context(None)


@pytest.mark.skipif(not REALM_PLUGIN_AVAILABLE, reason="REALM plugin not available")
@pytest.mark.asyncio
async def test_execute_step_action_validation() -> None:
    """Test EXECUTE_STEP action validates plan exists."""
    from benchmarks.realm.plugin.actions import validate_execute_step
    from benchmarks.realm.plugin.providers import set_task_context
    
    class MockRuntime:
        pass
    
    class MockMemory:
        pass
    
    # Without context, validation should fail
    set_task_context(None)
    assert await validate_execute_step(MockRuntime(), MockMemory(), None) is False  # type: ignore[arg-type]
    
    # Without plan, validation should fail
    set_task_context({"current_plan": [], "executed_steps": []})
    assert await validate_execute_step(MockRuntime(), MockMemory(), None) is False  # type: ignore[arg-type]
    
    # With plan and remaining steps, validation should pass
    set_task_context({
        "current_plan": [{"action": "step1"}, {"action": "step2"}],
        "executed_steps": [{"action": "step1"}],
    })
    assert await validate_execute_step(MockRuntime(), MockMemory(), None) is True  # type: ignore[arg-type]
    
    # With plan fully executed, validation should fail
    set_task_context({
        "current_plan": [{"action": "step1"}],
        "executed_steps": [{"action": "step1"}],
    })
    assert await validate_execute_step(MockRuntime(), MockMemory(), None) is False  # type: ignore[arg-type]
    
    # Cleanup
    set_task_context(None)


@pytest.mark.skipif(not ELIZAOS_AVAILABLE, reason="ElizaOS not available")  
@pytest.mark.asyncio
async def test_runtime_has_basic_capabilities() -> None:
    """Test that runtime has basicCapabilities enabled by default."""
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    
    character = Character(
        name="TestAgent",
        bio="A test agent",
        system="You are a test agent.",
    )
    
    # Default should have basic capabilities enabled
    runtime = AgentRuntime(
        character=character,
        plugins=[],
        disable_basic_capabilities=False,  # Explicit default
    )
    
    try:
        await runtime.initialize()
        
        # Check basic actions from bootstrap
        action_names = {a.name for a in runtime.actions}
        assert "REPLY" in action_names, "Basic REPLY action should be present"
        assert "IGNORE" in action_names, "Basic IGNORE action should be present"
        
        # Check basic providers from bootstrap
        provider_names = {p.name for p in runtime.providers}
        assert "ACTIONS" in provider_names, "ACTIONS provider should be present"
        assert "CHARACTER" in provider_names, "CHARACTER provider should be present"
        assert "RECENT_MESSAGES" in provider_names, "RECENT_MESSAGES provider should be present"
        
    finally:
        await runtime.stop()


@pytest.mark.skipif(not TRAJECTORY_LOGGER_AVAILABLE, reason="Trajectory logger not available")
def test_trajectory_logger_available() -> None:
    """Verify trajectory logger plugin is available."""
    assert TRAJECTORY_LOGGER_AVAILABLE is True


@pytest.mark.skipif(not TRAJECTORY_LOGGER_AVAILABLE, reason="Trajectory logger not available")
@pytest.mark.asyncio
async def test_agent_trajectory_logging_enabled() -> None:
    """Test that agent has trajectory logging enabled by default."""
    agent = REALMAgent(use_llm=False, enable_trajectory_logging=True)
    
    try:
        await agent.initialize()
        
        assert agent.enable_trajectory_logging is True
        assert agent._trajectory_logger is not None
        
    finally:
        await agent.close()


@pytest.mark.skipif(not TRAJECTORY_LOGGER_AVAILABLE, reason="Trajectory logger not available")
@pytest.mark.asyncio
async def test_agent_trajectory_logging_disabled() -> None:
    """Test that agent trajectory logging can be disabled."""
    agent = REALMAgent(use_llm=False, enable_trajectory_logging=False)
    
    try:
        await agent.initialize()
        
        assert agent.enable_trajectory_logging is False
        assert agent._trajectory_logger is None
        
    finally:
        await agent.close()


@pytest.mark.skipif(
    not (ELIZAOS_AVAILABLE and TRAJECTORY_LOGGER_AVAILABLE),
    reason="ElizaOS and trajectory logger required"
)
@pytest.mark.asyncio
async def test_agent_collects_trajectories() -> None:
    """Test that agent collects trajectories during task execution."""
    task = REALMTask(
        id="traj-test-001",
        name="Trajectory Test Task",
        description="A task to test trajectory collection",
        category=REALMCategory.SEQUENTIAL,
        difficulty=1,
        goal="Complete test for trajectory",
        available_tools=["step1", "step2"],
        expected_outcome="Trajectories collected",
        max_steps=5,
        timeout_ms=30000,
        constraints={},
        requirements=[],
    )
    
    test_case = REALMTestCase(
        task=task,
        input={"message": "Execute trajectory test"},
        expected={"actions": ["step1", "step2"]},
    )
    
    agent = REALMAgent(use_llm=False, enable_trajectory_logging=True)
    
    try:
        await agent.initialize()
        
        # Verify logger is initialized
        assert agent._trajectory_logger is not None
        
        # Execute task
        trajectory = await agent.solve_task(task, test_case)
        
        # Verify trajectory was completed
        assert trajectory.task_id == task.id
        assert len(trajectory.steps) > 0
        
        # Verify trajectory was stored
        completed = agent.get_completed_trajectories()
        assert len(completed) == 1
        
        # Verify trajectory metadata
        stored_traj = completed[0]
        assert stored_traj.scenario_id == task.id
        assert stored_traj.metadata.get("task_name") == task.name
        assert stored_traj.metadata.get("benchmark") == "REALM"
        
    finally:
        await agent.close()


@pytest.mark.skipif(
    not (ELIZAOS_AVAILABLE and TRAJECTORY_LOGGER_AVAILABLE),
    reason="ElizaOS and trajectory logger required"
)
@pytest.mark.asyncio
async def test_agent_export_trajectories() -> None:
    """Test trajectory export functionality."""
    import tempfile
    import os
    
    task = REALMTask(
        id="export-test-001",
        name="Export Test Task",
        description="A task to test trajectory export",
        category=REALMCategory.SEQUENTIAL,
        difficulty=1,
        goal="Complete test for export",
        available_tools=["action1"],
        expected_outcome="Exported",
        max_steps=3,
        timeout_ms=30000,
        constraints={},
        requirements=[],
    )
    
    test_case = REALMTestCase(
        task=task,
        input={"message": "Execute export test"},
        expected={"actions": ["action1"]},
    )
    
    agent = REALMAgent(use_llm=False, enable_trajectory_logging=True)
    
    try:
        await agent.initialize()
        
        # Execute task to generate trajectory
        await agent.solve_task(task, test_case)
        
        # Create temp directory for export
        with tempfile.TemporaryDirectory() as tmpdir:
            # Export ART format
            art_path = agent.export_trajectories_art(
                dataset_name="test-export",
                output_dir=tmpdir,
            )
            
            assert art_path is not None
            assert os.path.exists(art_path)
            
            # Export GRPO format
            grpo_path = agent.export_trajectories_grpo(
                dataset_name="test-export",
                output_dir=tmpdir,
            )
            
            assert grpo_path is not None
            assert os.path.exists(grpo_path)
        
        # Clear trajectories
        agent.clear_trajectories()
        assert len(agent.get_completed_trajectories()) == 0
        
    finally:
        await agent.close()
