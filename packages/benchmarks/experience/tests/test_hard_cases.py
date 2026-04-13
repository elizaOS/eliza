"""Tests for the hard case benchmark suite.

Validates that:
- The hard case data is well-formed (72 cases, 8 categories)
- The evaluator runs without errors
- Jaccard-tier cases have a high pass rate (they share enough tokens)
- The 3 truly zero-overlap semantic cases fail on Jaccard (no shared tokens at all)
- Per-category results are meaningful
"""

from elizaos_experience_bench.hard_cases import (
    ALL_HARD_CASES,
    JACCARD_CATEGORIES,
    SEMANTIC_CATEGORIES,
    get_all_cases,
    get_jaccard_cases,
    get_semantic_cases,
)
from elizaos_experience_bench.evaluators.hard_cases import HardCaseEvaluator


# ---------------------------------------------------------------------------
# Data integrity
# ---------------------------------------------------------------------------

class TestHardCaseData:

    def test_total_case_count(self):
        all_cases = get_all_cases()
        assert len(all_cases) >= 60, f"Expected at least 60 hard cases, got {len(all_cases)}"

    def test_all_categories_present(self):
        expected = set(JACCARD_CATEGORIES + SEMANTIC_CATEGORIES)
        actual = set(ALL_HARD_CASES.keys())
        assert expected == actual, f"Missing categories: {expected - actual}"

    def test_each_category_has_cases(self):
        for name, cases in ALL_HARD_CASES.items():
            assert len(cases) >= 5, f"Category '{name}' has only {len(cases)} cases, expected >= 5"

    def test_case_structure(self):
        for case in get_all_cases():
            assert case.name, f"Case has no name"
            assert case.category, f"Case {case.name} has no category"
            assert case.tier in ("jaccard", "semantic"), (
                f"Case {case.name} has invalid tier '{case.tier}'"
            )
            assert case.query, f"Case {case.name} has no query"
            assert len(case.experiences) >= 1, (
                f"Case {case.name} has no experiences"
            )
            assert 0 <= case.expected_best_index < len(case.experiences), (
                f"Case {case.name} expected_best_index out of range"
            )
            assert case.why_hard, f"Case {case.name} has no why_hard explanation"

    def test_jaccard_cases_not_flagged_as_embeddings(self):
        for case in get_jaccard_cases():
            assert not case.requires_embeddings, (
                f"Jaccard case {case.name} is incorrectly flagged requires_embeddings=True"
            )

    def test_semantic_cases_flagged_as_embeddings(self):
        for case in get_semantic_cases():
            assert case.requires_embeddings, (
                f"Semantic case {case.name} is NOT flagged requires_embeddings=True"
            )

    def test_no_duplicate_names(self):
        names = [c.name for c in get_all_cases()]
        duplicates = [n for n in names if names.count(n) > 1]
        assert not duplicates, f"Duplicate case names: {set(duplicates)}"


# ---------------------------------------------------------------------------
# Evaluator execution
# ---------------------------------------------------------------------------

class TestHardCaseEvaluator:

    def test_evaluator_runs_without_error(self):
        evaluator = HardCaseEvaluator()
        results = evaluator.evaluate()
        assert len(results.categories) == len(ALL_HARD_CASES)

    def test_jaccard_tier_high_pass_rate(self):
        """Jaccard-tier cases share enough tokens to be solvable."""
        evaluator = HardCaseEvaluator()
        results = evaluator.evaluate()

        assert results.jaccard_total > 0
        assert results.jaccard_rate >= 0.80, (
            f"Jaccard tier pass rate {results.jaccard_rate:.0%} is below 80%. "
            f"Failures: {[f for c in results.categories if c.tier == 'jaccard' for f in c.failures][:5]}"
        )

    def test_semantic_tier_has_some_failures(self):
        """Semantic-tier should have at least some failures on Jaccard (zero-overlap cases)."""
        evaluator = HardCaseEvaluator()
        results = evaluator.evaluate()

        assert results.semantic_total > 0
        # At least some semantic cases should fail (the truly zero-overlap ones)
        failed_count = results.semantic_total - results.semantic_passed
        assert failed_count >= 2, (
            f"Only {failed_count} semantic cases failed. Expected at least 2 truly "
            f"zero-overlap cases to fail on Jaccard."
        )

    def test_per_category_results(self):
        evaluator = HardCaseEvaluator()
        results = evaluator.evaluate()

        for cat in results.categories:
            assert cat.total > 0, f"Category {cat.category} has 0 total cases"
            assert cat.total == len(ALL_HARD_CASES[cat.category])

    def test_zero_overlap_has_true_failures(self):
        """Zero-overlap paraphrase should have at least 1 failure (truly zero shared tokens)."""
        evaluator = HardCaseEvaluator()
        results = evaluator.evaluate()

        zero_overlap = next(c for c in results.categories if c.category == "zero_overlap_paraphrase")
        failed = zero_overlap.total - zero_overlap.passed
        assert failed >= 1, (
            f"Zero-overlap paraphrase has 0 failures. At least some cases should have "
            f"genuinely zero token overlap with the query."
        )

    def test_contradiction_resolution_has_cases(self):
        evaluator = HardCaseEvaluator()
        results = evaluator.evaluate()

        contradiction = next(c for c in results.categories if c.category == "contradiction_resolution")
        assert contradiction.total >= 5

    def test_overall_results_meaningful(self):
        """The overall results should show the benchmark is challenging but not broken."""
        evaluator = HardCaseEvaluator()
        results = evaluator.evaluate()

        # At least some cases overall should fail
        total_failed = results.overall_total - results.overall_passed
        assert total_failed >= 2, (
            f"Only {total_failed} failures total. The benchmark should be hard enough "
            f"to have some failures."
        )
        # But not everything should fail
        assert results.overall_passed > results.overall_total * 0.5, (
            f"Only {results.overall_passed}/{results.overall_total} passed. "
            f"More than half should pass."
        )
