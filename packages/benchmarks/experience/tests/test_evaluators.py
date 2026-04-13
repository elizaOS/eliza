"""Tests for the benchmark evaluators."""

import time

from elizaos_experience_bench.evaluators.reranking import RerankingEvaluator
from elizaos_experience_bench.evaluators.retrieval import RetrievalEvaluator
from elizaos_experience_bench.evaluators.learning import LearningCycleEvaluator
from elizaos_experience_bench.generator import ExperienceGenerator
from elizaos_plugin_experience.service import ExperienceService


def test_reranking_evaluator():
    evaluator = RerankingEvaluator()
    results = evaluator.evaluate()

    assert results["similarity_dominance_rate"] == 1.0, (
        f"Similarity dominance failed: {results.get('failures', [])}"
    )
    assert results["quality_tiebreak_rate"] == 1.0, (
        f"Quality tiebreak failed: {results.get('failures', [])}"
    )
    assert results["noise_rejection_rate"] == 1.0, (
        f"Noise rejection failed: {results.get('failures', [])}"
    )


def test_retrieval_evaluator_basic():
    gen = ExperienceGenerator(seed=42)
    exps = gen.generate_experiences(count=100)
    queries = gen.generate_retrieval_queries(exps, num_queries=20)

    evaluator = RetrievalEvaluator(top_k_values=[1, 5, 10])
    metrics = evaluator.evaluate(exps, queries)

    # MRR should be positive
    assert metrics.mean_reciprocal_rank > 0.0
    # Hit rate at 10 should be reasonable
    assert metrics.hit_rate_at_k[10] > 0.0
    assert 1 in metrics.precision_at_k
    assert 5 in metrics.recall_at_k


def test_retrieval_with_adversarial_queries():
    """Test that adversarial queries (paraphrases, partial overlap) still work."""
    gen = ExperienceGenerator(seed=42)
    exps = gen.generate_experiences(count=200)
    queries = gen.generate_retrieval_queries(exps, num_queries=50)

    evaluator = RetrievalEvaluator(top_k_values=[1, 5, 10])
    metrics = evaluator.evaluate(exps, queries)

    # With adversarial queries, MRR should be lower than 0.995 but still reasonable
    # The mix includes paraphrases and partial-overlap which are genuinely harder
    assert metrics.mean_reciprocal_rank > 0.3, (
        f"MRR too low even for adversarial: {metrics.mean_reciprocal_rank:.3f}"
    )
    # Hit@10 should still find something relevant most of the time
    assert metrics.hit_rate_at_k[10] > 0.5, (
        f"Hit@10 too low: {metrics.hit_rate_at_k[10]:.3f}"
    )


def test_retrieval_at_scale():
    """Test retrieval quality doesn't degrade badly at 5k experiences."""
    gen = ExperienceGenerator(seed=42)
    exps = gen.generate_experiences(count=5000)
    queries = gen.generate_retrieval_queries(exps, num_queries=30)

    svc = ExperienceService()
    now_ms = int(time.time() * 1000)
    for exp in exps:
        offset_ms = int(exp.created_at_offset_days * 24 * 60 * 60 * 1000)
        svc.record_experience(
            agent_id="bench-agent",
            context=exp.context,
            action=exp.action,
            result=exp.result,
            learning=exp.learning,
            domain=exp.domain,
            tags=exp.tags,
            confidence=exp.confidence,
            importance=exp.importance,
            created_at=now_ms - offset_ms,
        )

    assert svc.experience_count == 5000

    # Measure query latency
    from elizaos_plugin_experience.types import ExperienceQuery
    latencies: list[float] = []
    for q in queries:
        t0 = time.time()
        svc.query_experiences(ExperienceQuery(query=q.query_text, limit=10))
        latencies.append((time.time() - t0) * 1000)

    avg_latency = sum(latencies) / len(latencies)
    max_latency = max(latencies)

    # At 5k experiences with O(n) Jaccard scan + confidence decay, latency is ~400-600ms
    # on a quiet system, but can be 1-2s under load. This is the known scaling limitation.
    # ANN indexing or a vector database is needed for >10k experiences.
    # The test guards against catastrophic regressions only (> 5s average).
    assert avg_latency < 5000, f"Average query latency {avg_latency:.1f}ms too high at 5k experiences"
    assert max_latency < 10000, f"Max query latency {max_latency:.1f}ms too high at 5k experiences"
    # Log actual latency for monitoring
    print(f"\n  Scale test: 5k experiences, avg={avg_latency:.1f}ms, max={max_latency:.1f}ms")


def test_learning_cycle_evaluator():
    gen = ExperienceGenerator(seed=42)
    bg = gen.generate_experiences(count=50)
    scenarios = gen.generate_learning_scenarios(num_scenarios=5)

    evaluator = LearningCycleEvaluator()
    metrics = evaluator.evaluate(bg, scenarios)

    assert metrics.experience_recall_rate > 0.5, (
        f"Low recall: {metrics.experience_recall_rate:.2f}"
    )
    assert metrics.cycle_success_rate > 0.3, (
        f"Low cycle success: {metrics.cycle_success_rate:.2f}"
    )
    assert len(metrics.cycle_results) == 5
