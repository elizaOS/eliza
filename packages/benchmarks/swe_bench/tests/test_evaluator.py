"""Tests for SWE-bench evaluator."""

import pytest

from benchmarks.swe_bench.evaluator import PatchQualityResult, SimplePatchEvaluator, SWEBenchEvaluator
from benchmarks.swe_bench.types import PatchStatus, SWEBenchInstance


class TestSimplePatchEvaluator:
    """Test SimplePatchEvaluator class."""

    @pytest.fixture
    def evaluator(self) -> SimplePatchEvaluator:
        """Create evaluator instance."""
        return SimplePatchEvaluator()

    def test_empty_patch(self, evaluator: SimplePatchEvaluator) -> None:
        """Test evaluating empty patch."""
        result = evaluator.evaluate_patch_quality("", "diff --git a/file.py")
        assert isinstance(result, PatchQualityResult)
        assert result.similarity == 0.0
        assert result.file_overlap == 0.0

    def test_identical_patches(self, evaluator: SimplePatchEvaluator) -> None:
        """Test evaluating identical patches."""
        patch = """diff --git a/src/module.py b/src/module.py
--- a/src/module.py
+++ b/src/module.py
@@ -1,3 +1,4 @@
 def foo():
     pass
+    return True
"""
        result = evaluator.evaluate_patch_quality(patch, patch)
        assert isinstance(result, PatchQualityResult)
        assert result.similarity == 1.0
        assert result.file_overlap == 1.0

    def test_different_files(self, evaluator: SimplePatchEvaluator) -> None:
        """Test patches touching different files."""
        patch1 = """diff --git a/src/a.py b/src/a.py
--- a/src/a.py
+++ b/src/a.py
"""
        patch2 = """diff --git a/src/b.py b/src/b.py
--- a/src/b.py
+++ b/src/b.py
"""
        result = evaluator.evaluate_patch_quality(patch1, patch2)
        assert isinstance(result, PatchQualityResult)
        assert result.file_overlap == 0.0

    def test_extract_files(self, evaluator: SimplePatchEvaluator) -> None:
        """Test extracting file paths from patch."""
        patch = """diff --git a/src/module.py b/src/module.py
--- a/src/module.py
+++ b/src/module.py
diff --git a/tests/test.py b/tests/test.py
--- a/tests/test.py
+++ b/tests/test.py
"""
        files = evaluator._extract_files(patch)
        assert "src/module.py" in files
        assert "tests/test.py" in files
        assert len(files) == 2


class TestSWEBenchEvaluator:
    """Test SWEBenchEvaluator class."""

    @pytest.fixture
    def evaluator(self) -> SWEBenchEvaluator:
        """Create evaluator instance."""
        return SWEBenchEvaluator(use_docker=False)

    @pytest.fixture
    def sample_instance(self) -> SWEBenchInstance:
        """Create a sample instance."""
        return SWEBenchInstance(
            instance_id="test__test-1",
            repo="test/test",
            base_commit="abc123",
            problem_statement="Fix bug",
            hints_text="",
            created_at="2023-01-01",
            patch="diff --git a/file.py b/file.py",
            test_patch="",
            fail_to_pass=["test_foo"],
            pass_to_pass=[],
        )

    @pytest.mark.asyncio
    async def test_empty_patch(
        self, evaluator: SWEBenchEvaluator, sample_instance: SWEBenchInstance
    ) -> None:
        """Test evaluating empty patch."""
        result = await evaluator.evaluate_patch(sample_instance, "")
        assert result.patch_status == PatchStatus.NOT_GENERATED
        assert not result.success

    @pytest.mark.asyncio
    async def test_basic_validation_valid_patch(
        self, evaluator: SWEBenchEvaluator, sample_instance: SWEBenchInstance
    ) -> None:
        """Test basic validation with valid patch format."""
        patch = """diff --git a/file.py b/file.py
--- a/file.py
+++ b/file.py
@@ -1,3 +1,4 @@
 def foo():
     pass
+    return True
"""
        result = await evaluator.evaluate_patch(sample_instance, patch)
        assert result.patch_status == PatchStatus.GENERATED
        assert "modifies 1 file" in (result.error or "")

    @pytest.mark.asyncio
    async def test_basic_validation_invalid_patch(
        self, evaluator: SWEBenchEvaluator, sample_instance: SWEBenchInstance
    ) -> None:
        """Test basic validation with invalid patch format."""
        result = await evaluator.evaluate_patch(
            sample_instance, "not a valid patch format"
        )
        assert result.patch_status == PatchStatus.NOT_GENERATED

    def test_parse_test_results_pytest(self, evaluator: SWEBenchEvaluator) -> None:
        """Test parsing pytest output."""
        logs = """
test_module.py::test_foo PASSED
test_module.py::test_bar PASSED
test_module.py::test_baz FAILED
test_module.py::test_error ERROR
"""
        passed, failed = evaluator._parse_test_results(logs)
        assert len(passed) == 2
        assert len(failed) == 2

    def test_parse_test_results_unittest(self, evaluator: SWEBenchEvaluator) -> None:
        """Test parsing unittest output."""
        logs = """
ok test_foo
ok test_bar
FAIL: test_baz
ERROR: test_error
"""
        passed, failed = evaluator._parse_test_results(logs)
        assert "test_foo" in passed
        assert "test_bar" in passed
        assert len(failed) == 2


@pytest.mark.integration
class TestSWEBenchEvaluatorDocker:
    """Integration tests requiring Docker."""

    @pytest.mark.asyncio
    async def test_check_docker_available(self) -> None:
        """Test checking if Docker is available."""
        evaluator = SWEBenchEvaluator()
        result = await evaluator.check_docker_available()
        # This depends on the environment
        assert isinstance(result, bool)
