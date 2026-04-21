"""Tests for the synthetic experience generator."""

from elizaos_experience_bench.generator import ExperienceGenerator


def test_generate_experiences_count():
    gen = ExperienceGenerator(seed=42)
    exps = gen.generate_experiences(count=100)
    assert len(exps) == 100


def test_generate_experiences_domains():
    gen = ExperienceGenerator(seed=42)
    exps = gen.generate_experiences(count=100)
    domains = {e.domain for e in exps}
    # Should have multiple domains
    assert len(domains) >= 5


def test_generate_experiences_diversity():
    gen = ExperienceGenerator(seed=42)
    exps = gen.generate_experiences(count=200)

    # Should have diverse experience types
    types = {e.experience_type for e in exps}
    assert len(types) >= 4

    # Should have diverse outcomes
    outcomes = {e.outcome for e in exps}
    assert len(outcomes) >= 3

    # Confidence and importance should vary
    confidences = [e.confidence for e in exps]
    assert min(confidences) < 0.5
    assert max(confidences) > 0.7


def test_generate_experiences_ground_truth():
    gen = ExperienceGenerator(seed=42)
    exps = gen.generate_experiences(count=100)

    # Every experience should have ground truth clusters
    for exp in exps:
        assert len(exp.ground_truth_clusters) > 0
        assert all(":" in cluster for cluster in exp.ground_truth_clusters)


def test_generate_retrieval_queries():
    gen = ExperienceGenerator(seed=42)
    exps = gen.generate_experiences(count=200)
    queries = gen.generate_retrieval_queries(exps, num_queries=50)

    assert len(queries) == 50
    for q in queries:
        assert len(q.query_text) > 0
        assert len(q.relevant_indices) > 0
        # All relevant indices should be valid
        assert all(0 <= idx < len(exps) for idx in q.relevant_indices)


def test_generate_learning_scenarios():
    gen = ExperienceGenerator(seed=42)
    scenarios = gen.generate_learning_scenarios(num_scenarios=10)

    assert len(scenarios) == 10
    for s in scenarios:
        assert len(s.problem_context) > 0
        assert len(s.similar_query) > 0
        assert len(s.expected_learning_keywords) > 0
        assert s.learned_experience is not None


def test_reproducibility():
    gen1 = ExperienceGenerator(seed=42)
    gen2 = ExperienceGenerator(seed=42)

    exps1 = gen1.generate_experiences(count=50)
    exps2 = gen2.generate_experiences(count=50)

    for a, b in zip(exps1, exps2):
        assert a.domain == b.domain
        assert a.confidence == b.confidence
        assert a.learning == b.learning
