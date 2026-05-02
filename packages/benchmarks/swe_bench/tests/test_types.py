"""Tests for SWE-bench type definitions."""

import pytest

from benchmarks.swe_bench.types import (
    AgentStep,
    AgentTrajectory,
    CodeLocation,
    LEADERBOARD_SCORES,
    PatchStatus,
    RepoStats,
    SWEBenchConfig,
    SWEBenchInstance,
    SWEBenchReport,
    SWEBenchResult,
    SWEBenchVariant,
)


class TestSWEBenchVariant:
    """Test SWEBenchVariant enum."""

    def test_variants_exist(self) -> None:
        """Test all variants are defined."""
        assert SWEBenchVariant.FULL.value == "full"
        assert SWEBenchVariant.LITE.value == "lite"
        assert SWEBenchVariant.VERIFIED.value == "verified"

    def test_variant_from_string(self) -> None:
        """Test creating variant from string."""
        assert SWEBenchVariant("lite") == SWEBenchVariant.LITE


class TestPatchStatus:
    """Test PatchStatus enum."""

    def test_all_statuses(self) -> None:
        """Test all statuses are defined."""
        assert PatchStatus.NOT_GENERATED.value == "not_generated"
        assert PatchStatus.GENERATED.value == "generated"
        assert PatchStatus.APPLIED.value == "applied"
        assert PatchStatus.TESTS_PASSED.value == "tests_passed"
        assert PatchStatus.TESTS_FAILED.value == "tests_failed"
        assert PatchStatus.APPLY_FAILED.value == "apply_failed"


class TestSWEBenchInstance:
    """Test SWEBenchInstance dataclass."""

    def test_create_instance(self) -> None:
        """Test creating an instance."""
        instance = SWEBenchInstance(
            instance_id="django__django-12345",
            repo="django/django",
            base_commit="abc123",
            problem_statement="Fix the bug",
            hints_text="Check the view",
            created_at="2023-01-01",
            patch="diff --git a/...",
            test_patch="diff --git b/...",
            fail_to_pass=["test_foo"],
            pass_to_pass=["test_bar"],
        )

        assert instance.instance_id == "django__django-12345"
        assert instance.repo == "django/django"
        assert len(instance.fail_to_pass) == 1


class TestSWEBenchResult:
    """Test SWEBenchResult dataclass."""

    def test_create_result(self) -> None:
        """Test creating a result."""
        result = SWEBenchResult(
            instance_id="django__django-12345",
            generated_patch="diff --git a/...",
            patch_status=PatchStatus.TESTS_PASSED,
            tests_passed=["test_foo"],
            tests_failed=[],
            success=True,
            duration_seconds=10.5,
            tokens_used=1000,
        )

        assert result.success is True
        assert result.patch_status == PatchStatus.TESTS_PASSED
        assert result.error is None


class TestSWEBenchConfig:
    """Test SWEBenchConfig dataclass."""

    def test_default_config(self) -> None:
        """Test default configuration values."""
        config = SWEBenchConfig()

        assert config.variant == SWEBenchVariant.LITE
        assert config.max_steps == 30
        assert config.use_docker_eval is True
        assert config.timeout_seconds == 600

    def test_custom_config(self) -> None:
        """Test custom configuration."""
        config = SWEBenchConfig(
            variant=SWEBenchVariant.VERIFIED,
            max_instances=10,
            repo_filter="django",
        )

        assert config.variant == SWEBenchVariant.VERIFIED
        assert config.max_instances == 10
        assert config.repo_filter == "django"


class TestCodeLocation:
    """Test CodeLocation dataclass."""

    def test_create_location(self) -> None:
        """Test creating a code location."""
        loc = CodeLocation(
            file_path="src/module.py",
            start_line=10,
            end_line=20,
            content="def foo():",
        )

        assert loc.file_path == "src/module.py"
        assert loc.start_line == 10


class TestAgentTrajectory:
    """Test AgentTrajectory dataclass."""

    def test_create_trajectory(self) -> None:
        """Test creating an agent trajectory."""
        step = AgentStep(
            step_number=1,
            action="SEARCH_CODE",
            action_input={"query": "foo"},
            observation="Found 3 matches",
            thought="Looking for foo function",
        )

        trajectory = AgentTrajectory(
            instance_id="django__django-12345",
            steps=[step],
            files_viewed=["src/foo.py"],
            files_edited=["src/bar.py"],
            search_queries=["foo"],
            total_tokens=500,
        )

        assert len(trajectory.steps) == 1
        assert trajectory.steps[0].action == "SEARCH_CODE"


class TestRepoStats:
    """Test RepoStats dataclass."""

    def test_create_repo_stats(self) -> None:
        """Test creating repo stats."""
        stats = RepoStats(total=10, resolved=5, resolve_rate=0.5)
        assert stats.total == 10
        assert stats.resolved == 5
        assert stats.resolve_rate == 0.5


class TestValidation:
    """Test validation in dataclasses."""

    def test_instance_requires_id(self) -> None:
        """Test that instance_id is required."""
        with pytest.raises(ValueError, match="instance_id is required"):
            SWEBenchInstance(
                instance_id="",
                repo="test/repo",
                base_commit="abc123",
                problem_statement="Fix bug",
                hints_text="",
                created_at="2025-01-01",
                patch="",
                test_patch="",
                fail_to_pass=[],
                pass_to_pass=[],
            )

    def test_code_location_valid_lines(self) -> None:
        """Test CodeLocation validates line numbers."""
        with pytest.raises(ValueError, match="start_line must be >= 1"):
            CodeLocation(file_path="test.py", start_line=0, end_line=5, content="")

        with pytest.raises(ValueError, match="end_line must be >= start_line"):
            CodeLocation(file_path="test.py", start_line=10, end_line=5, content="")

    def test_config_validates_max_steps(self) -> None:
        """Test SWEBenchConfig validates max_steps."""
        with pytest.raises(ValueError, match="max_steps must be >= 1"):
            SWEBenchConfig(max_steps=0)

    def test_result_validates_duration(self) -> None:
        """Test SWEBenchResult validates duration."""
        with pytest.raises(ValueError, match="duration_seconds must be >= 0"):
            SWEBenchResult(
                instance_id="test",
                generated_patch="",
                patch_status=PatchStatus.NOT_GENERATED,
                tests_passed=[],
                tests_failed=[],
                success=False,
                duration_seconds=-1,
                tokens_used=0,
            )


class TestLeaderboardScores:
    """Test leaderboard scores data."""

    def test_leaderboard_has_data(self) -> None:
        """Test leaderboard scores are populated."""
        assert "SWE-bench Lite" in LEADERBOARD_SCORES
        assert len(LEADERBOARD_SCORES["SWE-bench Lite"]) > 0

    def test_leaderboard_score_format(self) -> None:
        """Test leaderboard scores are valid percentages."""
        for variant, scores in LEADERBOARD_SCORES.items():
            for system, score in scores.items():
                assert 0 <= score <= 100, f"Invalid score for {system}: {score}"
