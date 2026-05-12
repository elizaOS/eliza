"""Tests for SWE-bench providers."""

import pytest

from benchmarks.swe_bench.providers import (
    SWE_BENCH_PROVIDERS,
    SWEBenchActionResultsProvider,
    get_current_instance,
    set_current_instance,
    swe_bench_action_results_provider,
    swe_bench_issue_provider,
    swe_bench_repo_structure_provider,
    swe_bench_strategy_provider,
    swe_bench_tools_provider,
)
from benchmarks.swe_bench.types import SWEBenchInstance


class TestProviderList:
    """Test provider list exports."""

    def test_providers_list_has_all_providers(self) -> None:
        """Test that SWE_BENCH_PROVIDERS contains all expected providers."""
        assert len(SWE_BENCH_PROVIDERS) == 5
        
        provider_names = [p.name for p in SWE_BENCH_PROVIDERS]
        assert "SWE_BENCH_ISSUE" in provider_names
        assert "SWE_BENCH_TOOLS" in provider_names
        assert "SWE_BENCH_REPO_STRUCTURE" in provider_names
        assert "SWE_BENCH_STRATEGY" in provider_names
        assert "SWE_BENCH_ACTION_RESULTS" in provider_names

    def test_provider_positions_are_ordered(self) -> None:
        """Test that providers have increasing positions."""
        positions = [p.position for p in SWE_BENCH_PROVIDERS]
        assert positions == sorted(positions)


class TestCurrentInstance:
    """Test current instance context management."""

    def test_get_set_instance(self) -> None:
        """Test getting and setting the current instance."""
        # Initially None
        set_current_instance(None)
        assert get_current_instance() is None

        # Create and set an instance
        instance = SWEBenchInstance(
            instance_id="test__repo-123",
            repo="test/repo",
            base_commit="abc123",
            problem_statement="Fix bug",
            hints_text="Check the tests",
            created_at="2024-01-01",
            version="1.0",
            fail_to_pass=["test_1"],
            pass_to_pass=["test_2"],
            environment_setup_commit="def456",
            patch="diff --git...",
            test_patch="diff --git...",
        )
        set_current_instance(instance)
        
        retrieved = get_current_instance()
        assert retrieved is not None
        assert retrieved.instance_id == "test__repo-123"
        assert retrieved.problem_statement == "Fix bug"

        # Clear it
        set_current_instance(None)
        assert get_current_instance() is None


class TestIssueProvider:
    """Test SWE-bench issue provider."""

    def test_provider_attributes(self) -> None:
        """Test provider has correct attributes."""
        assert swe_bench_issue_provider.name == "SWE_BENCH_ISSUE"
        assert swe_bench_issue_provider.position == 10
        assert swe_bench_issue_provider.private is False

    @pytest.mark.asyncio
    async def test_get_returns_empty_when_no_instance(self) -> None:
        """Test provider returns empty when no instance set."""
        set_current_instance(None)
        
        # Mock runtime and message
        class MockRuntime:
            pass
        
        class MockContent:
            text = "test"
        
        class MockMessage:
            content = MockContent()
        
        result = await swe_bench_issue_provider.get(MockRuntime(), MockMessage(), None)
        
        assert result.text == ""
        assert result.values == {}
        assert result.data == {}

    @pytest.mark.asyncio
    async def test_get_returns_issue_context(self) -> None:
        """Test provider returns issue context when instance set."""
        instance = SWEBenchInstance(
            instance_id="django__django-12345",
            repo="django/django",
            base_commit="abc123def",
            problem_statement="There is a bug in the admin panel.",
            hints_text="Look at admin/views.py",
            created_at="2024-01-01",
            version="4.0",
            fail_to_pass=["test_admin"],
            pass_to_pass=[],
            environment_setup_commit="xyz789",
            patch="diff...",
            test_patch="diff...",
        )
        set_current_instance(instance)
        
        try:
            class MockRuntime:
                pass
            
            class MockContent:
                text = "test"
            
            class MockMessage:
                content = MockContent()
            
            result = await swe_bench_issue_provider.get(MockRuntime(), MockMessage(), None)
            
            assert "SWE-bench Issue" in result.text
            assert "django__django-12345" in result.text
            assert "django/django" in result.text
            assert "There is a bug" in result.text
            assert "Look at admin/views.py" in result.text
            
            assert result.values["instance_id"] == "django__django-12345"
            assert result.values["repo"] == "django/django"
            
            assert result.data["problem_statement"] == "There is a bug in the admin panel."
        finally:
            set_current_instance(None)


class TestToolsProvider:
    """Test SWE-bench tools provider."""

    def test_provider_attributes(self) -> None:
        """Test provider has correct attributes."""
        assert swe_bench_tools_provider.name == "SWE_BENCH_TOOLS"
        assert swe_bench_tools_provider.position == 20

    @pytest.mark.asyncio
    async def test_get_returns_tools_description(self) -> None:
        """Test provider returns tools description."""
        class MockRuntime:
            pass
        
        class MockContent:
            text = "test"
        
        class MockMessage:
            content = MockContent()
        
        result = await swe_bench_tools_provider.get(MockRuntime(), MockMessage(), None)
        
        assert "SEARCH_CODE" in result.text
        assert "READ_FILE" in result.text
        assert "EDIT_FILE" in result.text
        assert "LIST_FILES" in result.text
        assert "SUBMIT" in result.text
        
        assert "SEARCH_CODE" in result.values["available_tools"]
        assert "SUBMIT" in result.values["available_tools"]


class TestStrategyProvider:
    """Test SWE-bench strategy provider."""

    def test_provider_attributes(self) -> None:
        """Test provider has correct attributes."""
        assert swe_bench_strategy_provider.name == "SWE_BENCH_STRATEGY"
        assert swe_bench_strategy_provider.position == 40

    @pytest.mark.asyncio
    async def test_get_returns_strategy(self) -> None:
        """Test provider returns strategy guidelines."""
        class MockRuntime:
            pass
        
        class MockContent:
            text = "test"
        
        class MockMessage:
            content = MockContent()
        
        result = await swe_bench_strategy_provider.get(MockRuntime(), MockMessage(), None)
        
        assert "Understand" in result.text
        assert "Locate" in result.text
        assert "Analyze" in result.text
        assert "Fix" in result.text
        assert "Submit" in result.text


class TestActionResultsProvider:
    """Test SWE-bench action results provider."""

    def test_provider_attributes(self) -> None:
        """Test provider has correct attributes."""
        assert swe_bench_action_results_provider.name == "SWE_BENCH_ACTION_RESULTS"
        assert swe_bench_action_results_provider.position == 50

    def test_add_and_clear_results(self) -> None:
        """Test adding and clearing action results."""
        SWEBenchActionResultsProvider.clear_results()
        
        SWEBenchActionResultsProvider.add_result("SEARCH_CODE", "Found 5 matches")
        SWEBenchActionResultsProvider.add_result("READ_FILE", "file content here")
        
        assert len(SWEBenchActionResultsProvider._results) == 2
        
        SWEBenchActionResultsProvider.clear_results()
        assert len(SWEBenchActionResultsProvider._results) == 0

    def test_results_limited_to_5(self) -> None:
        """Test that only last 5 results are kept."""
        SWEBenchActionResultsProvider.clear_results()
        
        for i in range(10):
            SWEBenchActionResultsProvider.add_result(f"ACTION_{i}", f"result_{i}")
        
        assert len(SWEBenchActionResultsProvider._results) == 5
        # Should have the last 5
        assert SWEBenchActionResultsProvider._results[0]["action"] == "ACTION_5"
        assert SWEBenchActionResultsProvider._results[4]["action"] == "ACTION_9"
        
        SWEBenchActionResultsProvider.clear_results()

    @pytest.mark.asyncio
    async def test_get_returns_empty_when_no_results(self) -> None:
        """Test provider returns empty when no results."""
        SWEBenchActionResultsProvider.clear_results()
        
        class MockRuntime:
            pass
        
        class MockContent:
            text = "test"
        
        class MockMessage:
            content = MockContent()
        
        result = await swe_bench_action_results_provider.get(MockRuntime(), MockMessage(), None)
        
        assert result.text == ""

    @pytest.mark.asyncio
    async def test_get_returns_results(self) -> None:
        """Test provider returns action results."""
        SWEBenchActionResultsProvider.clear_results()
        SWEBenchActionResultsProvider.add_result("LIST_FILES", "file1.py\nfile2.py")
        
        try:
            class MockRuntime:
                pass
            
            class MockContent:
                text = "test"
            
            class MockMessage:
                content = MockContent()
            
            result = await swe_bench_action_results_provider.get(MockRuntime(), MockMessage(), None)
            
            assert "Recent Action Results" in result.text
            assert "LIST_FILES" in result.text
            assert "file1.py" in result.text
            assert result.values["action_count"] == 1
        finally:
            SWEBenchActionResultsProvider.clear_results()
