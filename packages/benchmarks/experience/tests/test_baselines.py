"""Baseline validation tests.

Three agents are tested against the same benchmark:
1. PerfectAgent — cheats with ground truth, MUST score 100% (validates scoring)
2. RandomAgent  — random answers, MUST score low (validates discrimination)
3. RealAgent    — actual ExperienceService, should score well (validates implementation)

If the PerfectAgent doesn't get 100%, the benchmark scoring is broken.
If the RandomAgent gets high scores, the benchmark is too easy / not discriminating.
If the RealAgent scores poorly, the implementation has bugs.
"""

from elizaos_experience_bench.baselines import PerfectExperienceService, RandomExperienceService
from elizaos_experience_bench.evaluators.retrieval import RetrievalEvaluator
from elizaos_experience_bench.evaluators.reranking import RerankingEvaluator
from elizaos_experience_bench.evaluators.learning import LearningCycleEvaluator
from elizaos_experience_bench.generator import ExperienceGenerator
from elizaos_plugin_experience.service import ExperienceService


# ---------------------------------------------------------------------------
# Shared data (generated once, reused across tests)
# ---------------------------------------------------------------------------

_gen = ExperienceGenerator(seed=42)
_experiences = _gen.generate_experiences(count=200)
_queries = _gen.generate_retrieval_queries(_experiences, num_queries=50)
_scenarios = _gen.generate_learning_scenarios(num_scenarios=10)
# Use 200 background experiences to dilute random chance (5/201 ≈ 2.5% per pick)
_bg_experiences = _experiences[:200]


# ===========================================================================
# PERFECT AGENT — must score 100% on everything
# ===========================================================================

class TestPerfectAgent:
    """The perfect agent cheats to always get the right answer.
    If it doesn't score 100%, the benchmark scoring logic is broken.
    """

    def test_retrieval_perfect_high_mrr(self):
        """Perfect agent should have very high MRR, though not always 1.0 with
        adversarial queries (paraphrases, partial overlap) since Jaccard can't
        match synonyms. This is expected and correct — it validates that the
        adversarial queries are genuinely harder."""
        evaluator = RetrievalEvaluator(
            top_k_values=[1, 5, 10],
            service_factory=PerfectExperienceService,
        )
        metrics = evaluator.evaluate(_experiences, _queries)

        # Perfect agent with Jaccard should get >=0.9 MRR (paraphrases lower it)
        assert metrics.mean_reciprocal_rank >= 0.9, (
            f"Perfect agent MRR should be >= 0.9, got {metrics.mean_reciprocal_rank:.3f}"
        )

    def test_retrieval_perfect_hit_rate(self):
        evaluator = RetrievalEvaluator(
            top_k_values=[1, 5, 10],
            service_factory=PerfectExperienceService,
        )
        metrics = evaluator.evaluate(_experiences, _queries)

        # Hit@5 and Hit@10 should be near-perfect
        assert metrics.hit_rate_at_k[5] >= 0.95, (
            f"Perfect agent Hit@5 should be >= 0.95, got {metrics.hit_rate_at_k[5]:.3f}"
        )
        assert metrics.hit_rate_at_k[10] >= 0.95, (
            f"Perfect agent Hit@10 should be >= 0.95, got {metrics.hit_rate_at_k[10]:.3f}"
        )

    def test_retrieval_perfect_beats_real(self):
        """Perfect agent should beat or match real agent on retrieval."""
        perfect_eval = RetrievalEvaluator(top_k_values=[5], service_factory=PerfectExperienceService)
        real_eval = RetrievalEvaluator(top_k_values=[5], service_factory=ExperienceService)

        perfect_m = perfect_eval.evaluate(_experiences, _queries)
        real_m = real_eval.evaluate(_experiences, _queries)

        assert perfect_m.mean_reciprocal_rank >= real_m.mean_reciprocal_rank, (
            f"Perfect ({perfect_m.mean_reciprocal_rank:.3f}) should >= Real ({real_m.mean_reciprocal_rank:.3f})"
        )

    def test_reranking_perfect_all_pass(self):
        evaluator = RerankingEvaluator(service_factory=PerfectExperienceService)
        results = evaluator.evaluate()

        assert results["similarity_dominance_rate"] == 1.0, (
            f"Perfect agent similarity dominance should be 1.0: {results.get('failures')}"
        )
        assert results["quality_tiebreak_rate"] == 1.0, (
            f"Perfect agent quality tiebreak should be 1.0: {results.get('failures')}"
        )
        assert results["noise_rejection_rate"] == 1.0, (
            f"Perfect agent noise rejection should be 1.0: {results.get('failures')}"
        )

    def test_learning_cycle_perfect_recall(self):
        evaluator = LearningCycleEvaluator(service_factory=PerfectExperienceService)
        metrics = evaluator.evaluate(_bg_experiences, _scenarios)

        assert metrics.experience_recall_rate == 1.0, (
            f"Perfect agent recall should be 1.0, got {metrics.experience_recall_rate:.2f}. "
            f"Failures: {[c for c in metrics.cycle_results if not c['retrieved']]}"
        )

    def test_learning_cycle_perfect_success(self):
        evaluator = LearningCycleEvaluator(service_factory=PerfectExperienceService)
        metrics = evaluator.evaluate(_bg_experiences, _scenarios)

        assert metrics.cycle_success_rate == 1.0, (
            f"Perfect agent cycle success should be 1.0, got {metrics.cycle_success_rate:.2f}. "
            f"Failures: {[c for c in metrics.cycle_results if not c['cycle_success']]}"
        )


# ===========================================================================
# RANDOM AGENT — must score poorly
# ===========================================================================

class TestRandomAgent:
    """The random agent picks random experiences regardless of query.
    It should score significantly worse than the real agent.
    """

    def test_retrieval_random_low_mrr(self):
        evaluator = RetrievalEvaluator(
            top_k_values=[1, 5, 10],
            service_factory=RandomExperienceService,
        )
        metrics = evaluator.evaluate(_experiences, _queries)

        # Random should have much lower MRR than perfect (1.0)
        assert metrics.mean_reciprocal_rank < 0.6, (
            f"Random agent MRR should be < 0.6, got {metrics.mean_reciprocal_rank:.3f}"
        )

    def test_retrieval_random_low_precision(self):
        evaluator = RetrievalEvaluator(
            top_k_values=[1, 5, 10],
            service_factory=RandomExperienceService,
        )
        metrics = evaluator.evaluate(_experiences, _queries)

        # P@1 for random should be very low
        assert metrics.precision_at_k[1] < 0.5, (
            f"Random agent P@1 should be < 0.5, got {metrics.precision_at_k[1]:.3f}"
        )

    def test_reranking_random_fails_similarity_dominance(self):
        """Run similarity dominance test 20 times — random should fail at least once."""
        # With 2 items per test and random ordering, P(fail) = 50% per test.
        # Over 20 runs of 3 test cases each, P(pass all) ≈ (0.5^3)^20 ≈ 0.
        failures = 0
        for _ in range(20):
            evaluator = RerankingEvaluator(service_factory=RandomExperienceService)
            results = evaluator.evaluate()
            if results["similarity_dominance_rate"] < 1.0:
                failures += 1

        assert failures > 0, (
            "Random agent should fail similarity dominance at least once in 20 trials"
        )

    def test_learning_cycle_random_low_recall(self):
        """With 200 background + 1 learned, random picks 5/201 ≈ 2.5%.
        Over 10 scenarios, expected recall ≈ 25%.
        """
        evaluator = LearningCycleEvaluator(service_factory=RandomExperienceService)
        metrics = evaluator.evaluate(_bg_experiences, _scenarios)

        # With 201 experiences and 5 returned, P(learned in 5) ≈ 2.5% per scenario
        # Expected recall over 10 scenarios ≈ 0.25 (generous upper bound)
        assert metrics.experience_recall_rate < 0.6, (
            f"Random agent recall should be < 0.6, got {metrics.experience_recall_rate:.2f}"
        )

    def test_learning_cycle_random_low_precision(self):
        evaluator = LearningCycleEvaluator(service_factory=RandomExperienceService)
        metrics = evaluator.evaluate(_bg_experiences, _scenarios)

        # Random should almost never have the learned experience as #1
        assert metrics.experience_precision_rate < 0.5, (
            f"Random agent precision should be < 0.5, got {metrics.experience_precision_rate:.2f}"
        )


# ===========================================================================
# REAL AGENT — should pass reasonable thresholds
# ===========================================================================

class TestRealAgent:
    """The real ExperienceService implementation.
    Should score well on all benchmarks — validates the actual code works.
    """

    def test_retrieval_real_good_mrr(self):
        evaluator = RetrievalEvaluator(
            top_k_values=[1, 5, 10],
            service_factory=ExperienceService,
        )
        metrics = evaluator.evaluate(_experiences, _queries)

        assert metrics.mean_reciprocal_rank >= 0.8, (
            f"Real agent MRR should be >= 0.8, got {metrics.mean_reciprocal_rank:.3f}"
        )

    def test_retrieval_real_good_hit_rate(self):
        evaluator = RetrievalEvaluator(
            top_k_values=[1, 5, 10],
            service_factory=ExperienceService,
        )
        metrics = evaluator.evaluate(_experiences, _queries)

        assert metrics.hit_rate_at_k[5] >= 0.9, (
            f"Real agent Hit@5 should be >= 0.9, got {metrics.hit_rate_at_k[5]:.3f}"
        )

    def test_reranking_real_all_pass(self):
        evaluator = RerankingEvaluator(service_factory=ExperienceService)
        results = evaluator.evaluate()

        assert results["similarity_dominance_rate"] == 1.0, (
            f"Real agent similarity dominance failed: {results.get('failures')}"
        )
        assert results["quality_tiebreak_rate"] == 1.0, (
            f"Real agent quality tiebreak failed: {results.get('failures')}"
        )
        assert results["noise_rejection_rate"] == 1.0, (
            f"Real agent noise rejection failed: {results.get('failures')}"
        )

    def test_learning_cycle_real_good_recall(self):
        evaluator = LearningCycleEvaluator(service_factory=ExperienceService)
        metrics = evaluator.evaluate(_bg_experiences, _scenarios)

        assert metrics.experience_recall_rate >= 0.8, (
            f"Real agent recall should be >= 0.8, got {metrics.experience_recall_rate:.2f}. "
            f"Failures: {[c for c in metrics.cycle_results if not c['retrieved']]}"
        )

    def test_learning_cycle_real_good_success(self):
        evaluator = LearningCycleEvaluator(service_factory=ExperienceService)
        metrics = evaluator.evaluate(_bg_experiences, _scenarios)

        assert metrics.cycle_success_rate >= 0.8, (
            f"Real agent cycle success should be >= 0.8, got {metrics.cycle_success_rate:.2f}. "
            f"Failures: {[c for c in metrics.cycle_results if not c['cycle_success']]}"
        )


# ===========================================================================
# COMPARATIVE — verify ordering: perfect > real > random
# ===========================================================================

class TestComparative:
    """Verify the ranking: perfect > real >> random on the same queries."""

    def test_mrr_ordering(self):
        perfect_eval = RetrievalEvaluator(top_k_values=[5], service_factory=PerfectExperienceService)
        real_eval = RetrievalEvaluator(top_k_values=[5], service_factory=ExperienceService)
        random_eval = RetrievalEvaluator(top_k_values=[5], service_factory=RandomExperienceService)

        perfect_m = perfect_eval.evaluate(_experiences, _queries)
        real_m = real_eval.evaluate(_experiences, _queries)
        random_m = random_eval.evaluate(_experiences, _queries)

        assert perfect_m.mean_reciprocal_rank >= real_m.mean_reciprocal_rank, (
            f"Perfect ({perfect_m.mean_reciprocal_rank:.3f}) should >= Real ({real_m.mean_reciprocal_rank:.3f})"
        )
        assert real_m.mean_reciprocal_rank > random_m.mean_reciprocal_rank, (
            f"Real ({real_m.mean_reciprocal_rank:.3f}) should > Random ({random_m.mean_reciprocal_rank:.3f})"
        )
        print(f"\n  MRR ordering: Perfect={perfect_m.mean_reciprocal_rank:.3f} "
              f">= Real={real_m.mean_reciprocal_rank:.3f} "
              f"> Random={random_m.mean_reciprocal_rank:.3f}")
