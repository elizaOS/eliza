"""Evaluate reranking correctness: similarity dominance, quality tiebreaking, noise rejection."""

from __future__ import annotations

import sys
from collections.abc import Callable

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[4] / "plugins" / "plugin-experience" / "python"))

from elizaos_plugin_experience.service import ExperienceService

ServiceFactory = Callable[[], ExperienceService]


class RerankingEvaluator:
    """Evaluate that the reranking formula behaves correctly.

    Tests three properties:
    1. Similarity dominance: relevant low-quality beats irrelevant high-quality
    2. Quality tiebreaking: among same-similarity, higher quality ranks first
    3. Noise rejection: truly irrelevant items are filtered out
    """

    def __init__(self, service_factory: ServiceFactory | None = None) -> None:
        self._service_factory = service_factory or ExperienceService

    def evaluate(self) -> dict[str, object]:
        """Run all reranking tests and return results."""
        results: dict[str, object] = {}

        sim_pass, sim_total, sim_failures = self._test_similarity_dominance()
        results["similarity_dominance_rate"] = sim_pass / sim_total if sim_total else 0.0
        results["similarity_dominance_pass"] = sim_pass
        results["similarity_dominance_total"] = sim_total

        tie_pass, tie_total, tie_failures = self._test_quality_tiebreaking()
        results["quality_tiebreak_rate"] = tie_pass / tie_total if tie_total else 0.0
        results["quality_tiebreak_pass"] = tie_pass
        results["quality_tiebreak_total"] = tie_total

        noise_pass, noise_total, noise_failures = self._test_noise_rejection()
        results["noise_rejection_rate"] = noise_pass / noise_total if noise_total else 0.0
        results["noise_rejection_pass"] = noise_pass
        results["noise_rejection_total"] = noise_total

        all_failures = sim_failures + tie_failures + noise_failures
        results["failures"] = all_failures

        return results

    def _test_similarity_dominance(self) -> tuple[int, int, list[str]]:
        """Relevant experiences must outrank irrelevant high-quality ones."""
        test_cases = [
            {
                "relevant": {"context": "installing python packages pip", "action": "pip install",
                             "result": "packages installed", "learning": "use pip install for python packages",
                             "domain": "coding", "confidence": 0.5, "importance": 0.5},
                "irrelevant": {"context": "weather satellite forecast", "action": "check radar",
                               "result": "rain predicted", "learning": "satellite radar for weather",
                               "domain": "general", "confidence": 0.99, "importance": 0.99},
                "query": "how to install python packages with pip",
            },
            {
                "relevant": {"context": "configuring nginx reverse proxy", "action": "edit nginx conf",
                             "result": "proxy working", "learning": "nginx upstream for reverse proxy",
                             "domain": "devops", "confidence": 0.4, "importance": 0.4},
                "irrelevant": {"context": "cooking pasta carbonara", "action": "boil water",
                               "result": "delicious meal", "learning": "pasta al dente carbonara",
                               "domain": "cooking", "confidence": 0.99, "importance": 0.99},
                "query": "nginx reverse proxy configuration setup",
            },
            {
                "relevant": {"context": "debugging database connection pool", "action": "check pool settings",
                             "result": "found exhausted connections", "learning": "set pool limits for database connections",
                             "domain": "database", "confidence": 0.6, "importance": 0.5},
                "irrelevant": {"context": "planning vacation itinerary", "action": "book flights hotels",
                               "result": "trip planned", "learning": "book flights early for better prices",
                               "domain": "travel", "confidence": 0.95, "importance": 0.95},
                "query": "database connection pool exhausted how to fix",
            },
        ]

        passed = 0
        failures: list[str] = []

        for case in test_cases:
            svc = self._service_factory()
            rel = svc.record_experience(agent_id="test", **case["relevant"])
            svc.record_experience(agent_id="test", **case["irrelevant"])

            results = svc.find_similar_experiences(case["query"], limit=2)
            if results and results[0].id == rel.id:
                passed += 1
            else:
                top_domain = results[0].domain if results else "none"
                failures.append(
                    f"Similarity dominance failed: query='{case['query']}', "
                    f"expected domain={case['relevant']['domain']}, got={top_domain}"
                )

        return passed, len(test_cases), failures

    def _test_quality_tiebreaking(self) -> tuple[int, int, list[str]]:
        """Among similarly-relevant experiences, higher quality should rank first."""
        test_cases = [
            {
                "high_quality": {"context": "debugging python error", "action": "check stack trace",
                                 "result": "found bug", "learning": "always check stack trace for python errors",
                                 "domain": "coding", "confidence": 0.95, "importance": 0.9},
                "low_quality": {"context": "debugging python error", "action": "check stack trace",
                                "result": "found bug", "learning": "check stack trace for python errors sometimes",
                                "domain": "coding", "confidence": 0.2, "importance": 0.15},
                "query": "debugging python errors stack trace",
            },
        ]

        passed = 0
        failures: list[str] = []

        for case in test_cases:
            svc = self._service_factory()
            hq = svc.record_experience(agent_id="test", **case["high_quality"])
            svc.record_experience(agent_id="test", **case["low_quality"])

            results = svc.find_similar_experiences(case["query"], limit=2)
            if len(results) >= 2 and results[0].confidence > results[1].confidence:
                passed += 1
            else:
                failures.append(
                    f"Quality tiebreak failed: query='{case['query']}', "
                    f"top confidence={results[0].confidence if results else 'none'}"
                )

        return passed, len(test_cases), failures

    def _test_noise_rejection(self) -> tuple[int, int, list[str]]:
        """Truly irrelevant experiences should be filtered out or rank very low."""
        test_cases = [
            {
                "relevant": {"context": "docker container deployment", "action": "docker compose up",
                             "result": "deployed", "learning": "use docker compose for deployments",
                             "domain": "devops", "confidence": 0.8, "importance": 0.7},
                "noise": {"context": "baking chocolate cake recipe", "action": "mix flour sugar eggs",
                          "result": "cake baked", "learning": "preheat oven to 350 for chocolate cake",
                          "domain": "cooking", "confidence": 0.99, "importance": 0.99},
                "query": "deploying containers with docker compose",
            },
        ]

        passed = 0
        failures: list[str] = []

        for case in test_cases:
            svc = self._service_factory()
            rel = svc.record_experience(agent_id="test", **case["relevant"])
            noise = svc.record_experience(agent_id="test", **case["noise"])

            results = svc.find_similar_experiences(case["query"], limit=10)
            result_ids = [r.id for r in results]

            if rel.id in result_ids:
                rel_rank = result_ids.index(rel.id)
                if noise.id not in result_ids:
                    passed += 1
                elif result_ids.index(noise.id) > rel_rank:
                    passed += 1
                else:
                    failures.append(
                        f"Noise rejection failed: noise ranked above relevant for '{case['query']}'"
                    )
            else:
                failures.append(
                    f"Noise rejection failed: relevant not found for '{case['query']}'"
                )

        return passed, len(test_cases), failures
