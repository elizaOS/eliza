"""
Tests for AgentBench types.
"""


from elizaos_agentbench.types import (
    AgentBenchEnvironment,
    AgentBenchTask,
    AgentBenchResult,
    AgentBenchConfig,
    EnvironmentConfig,
    TaskDifficulty,
    GPT4_BASELINE_SCORES,
    GPT35_BASELINE_SCORES,
)


class TestAgentBenchEnvironment:
    def test_all_environments_defined(self) -> None:
        """Test that all 8 environments are defined."""
        envs = list(AgentBenchEnvironment)
        assert len(envs) == 8

    def test_environment_values(self) -> None:
        """Test environment enum values."""
        assert AgentBenchEnvironment.OS.value == "operating_system"
        assert AgentBenchEnvironment.DATABASE.value == "database"
        assert AgentBenchEnvironment.KNOWLEDGE_GRAPH.value == "knowledge_graph"
        assert AgentBenchEnvironment.CARD_GAME.value == "card_game"
        assert AgentBenchEnvironment.LATERAL_THINKING.value == "lateral_thinking"
        assert AgentBenchEnvironment.HOUSEHOLDING.value == "householding"
        assert AgentBenchEnvironment.WEB_SHOPPING.value == "web_shopping"
        assert AgentBenchEnvironment.WEB_BROWSING.value == "web_browsing"


class TestAgentBenchTask:
    def test_task_creation(self) -> None:
        """Test creating a task."""
        task = AgentBenchTask(
            id="test-001",
            environment=AgentBenchEnvironment.OS,
            description="Test task",
            initial_state={"working_dir": "/home"},
            goal="Complete the task",
            max_steps=10,
        )
        assert task.id == "test-001"
        assert task.environment == AgentBenchEnvironment.OS
        assert task.max_steps == 10
        assert task.difficulty == TaskDifficulty.MEDIUM

    def test_task_with_all_fields(self) -> None:
        """Test task with all optional fields."""
        task = AgentBenchTask(
            id="test-002",
            environment=AgentBenchEnvironment.DATABASE,
            description="SQL query task",
            initial_state={"schema": {}},
            goal="Write correct SQL",
            max_steps=5,
            timeout_ms=30000,
            difficulty=TaskDifficulty.HARD,
            ground_truth="SELECT * FROM users",
            hints=["Use SELECT", "Filter results"],
            metadata={"category": "sql"},
        )
        assert task.timeout_ms == 30000
        assert task.difficulty == TaskDifficulty.HARD
        assert len(task.hints) == 2


class TestAgentBenchResult:
    def test_result_creation(self) -> None:
        """Test creating a result."""
        result = AgentBenchResult(
            task_id="test-001",
            environment=AgentBenchEnvironment.OS,
            success=True,
            steps_taken=5,
            actions=["ls", "cd", "cat"],
            final_state={"output": "success"},
            duration_ms=1500.0,
        )
        assert result.success
        assert result.steps_taken == 5
        assert len(result.actions) == 3
        assert result.error is None

    def test_result_with_error(self) -> None:
        """Test result with error."""
        result = AgentBenchResult(
            task_id="test-002",
            environment=AgentBenchEnvironment.DATABASE,
            success=False,
            steps_taken=3,
            actions=["query1", "query2"],
            final_state={},
            duration_ms=500.0,
            error="SQL syntax error",
        )
        assert not result.success
        assert result.error == "SQL syntax error"


class TestAgentBenchConfig:
    def test_default_config(self) -> None:
        """Test default configuration."""
        config = AgentBenchConfig()
        assert config.save_detailed_logs
        assert config.enable_metrics
        assert config.use_docker

    def test_get_env_config(self) -> None:
        """Test getting environment-specific config."""
        config = AgentBenchConfig()
        os_config = config.get_env_config(AgentBenchEnvironment.OS)
        assert isinstance(os_config, EnvironmentConfig)
        assert os_config.enabled

    def test_get_enabled_environments(self) -> None:
        """Test getting list of enabled environments."""
        config = AgentBenchConfig()
        # Disable OS
        config.os_config.enabled = False
        enabled = config.get_enabled_environments()
        assert AgentBenchEnvironment.OS not in enabled
        assert AgentBenchEnvironment.DATABASE in enabled


class TestBaselineScores:
    def test_gpt4_baselines_defined(self) -> None:
        """Test GPT-4 baselines are defined for all environments."""
        assert len(GPT4_BASELINE_SCORES) == 8
        for env in AgentBenchEnvironment:
            assert env in GPT4_BASELINE_SCORES
            assert 0 <= GPT4_BASELINE_SCORES[env] <= 1

    def test_gpt35_baselines_defined(self) -> None:
        """Test GPT-3.5 baselines are defined for all environments."""
        assert len(GPT35_BASELINE_SCORES) == 8
        for env in AgentBenchEnvironment:
            assert env in GPT35_BASELINE_SCORES
            assert 0 <= GPT35_BASELINE_SCORES[env] <= 1

    def test_gpt4_outperforms_gpt35(self) -> None:
        """Test that GPT-4 scores are generally higher than GPT-3.5."""
        higher_count = 0
        for env in AgentBenchEnvironment:
            if GPT4_BASELINE_SCORES[env] > GPT35_BASELINE_SCORES[env]:
                higher_count += 1
        # GPT-4 should be better in most environments
        assert higher_count >= 6
