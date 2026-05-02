"""Baseline handlers for benchmark validation.

PerfectHandler:  Returns ground-truth answers for all corpus test cases.
                 Used to validate that the benchmark framework scores correctly.
                 MUST achieve 100% on all metrics.

RandomHandler:   Returns random detection results.
                 Used to validate that the benchmark discriminates between
                 good and bad handlers. MUST score poorly.

These follow the same pattern as the experience benchmark baselines:
- Perfect > Real > Random ordering validates the benchmark itself.
"""

from __future__ import annotations

import os
import random

from elizaos_trust_bench.corpus import TEST_CORPUS
from elizaos_trust_bench.types import TrustTestCase


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------

_CORPUS_BY_INPUT: dict[str, TrustTestCase] = {tc.input: tc for tc in TEST_CORPUS}


def _ground_truth(text: str) -> dict[str, bool | float]:
    """Return ground truth detection result for a known corpus input."""
    tc = _CORPUS_BY_INPUT.get(text)
    if tc is None:
        return {"detected": False, "confidence": 0.0}
    return {
        "detected": tc.expected_malicious,
        "confidence": 1.0 if tc.expected_malicious else 0.0,
    }


def _random_result() -> dict[str, bool | float]:
    """Return a random detection result with OS-entropy-seeded RNG."""
    rng = random.Random(int.from_bytes(os.urandom(8), "big"))
    detected = rng.random() > 0.5
    return {
        "detected": detected,
        "confidence": rng.random() if detected else rng.random() * 0.3,
    }


# ---------------------------------------------------------------------------
# Perfect handler — ground truth oracle
# ---------------------------------------------------------------------------


class PerfectHandler:
    """Oracle handler that returns ground truth for all corpus test cases.

    Used to validate the benchmark framework itself. If this handler
    doesn't score 100%, the scoring logic has a bug.
    """

    @property
    def name(self) -> str:
        return "oracle"

    def detect_injection(self, message: str) -> dict[str, bool | float]:
        """Return ground truth for injection detection."""
        return _ground_truth(message)

    def detect_social_engineering(self, message: str) -> dict[str, bool | float]:
        """Return ground truth for social engineering detection."""
        return _ground_truth(message)

    def detect_impersonation(
        self, username: str, existing_users: list[str]
    ) -> dict[str, bool | float]:
        """Return ground truth for impersonation detection."""
        return _ground_truth(username)

    def detect_credential_theft(self, message: str) -> dict[str, bool | float]:
        """Return ground truth for credential theft detection."""
        return _ground_truth(message)

    def detect_privilege_escalation(self, message: str) -> dict[str, bool | float]:
        """Return ground truth for privilege escalation detection."""
        return _ground_truth(message)

    def detect_data_exfiltration(self, message: str) -> dict[str, bool | float]:
        """Return ground truth for data exfiltration detection."""
        return _ground_truth(message)

    def detect_resource_abuse(self, message: str) -> dict[str, bool | float]:
        """Return ground truth for resource abuse detection."""
        return _ground_truth(message)

    def detect_content_policy_violation(self, message: str) -> dict[str, bool | float]:
        """Return ground truth for content policy violation detection."""
        return _ground_truth(message)


# ---------------------------------------------------------------------------
# Random handler — coin-flip baseline
# ---------------------------------------------------------------------------


class RandomHandler:
    """Handler that returns random detection results.

    Used to validate that the benchmark discriminates between good and bad
    handlers. Should score significantly worse than any real implementation.
    """

    @property
    def name(self) -> str:
        return "random"

    def detect_injection(self, message: str) -> dict[str, bool | float]:
        """Return random result for injection detection."""
        return _random_result()

    def detect_social_engineering(self, message: str) -> dict[str, bool | float]:
        """Return random result for social engineering detection."""
        return _random_result()

    def detect_impersonation(
        self, username: str, existing_users: list[str]
    ) -> dict[str, bool | float]:
        """Return random result for impersonation detection."""
        return _random_result()

    def detect_credential_theft(self, message: str) -> dict[str, bool | float]:
        """Return random result for credential theft detection."""
        return _random_result()

    def detect_privilege_escalation(self, message: str) -> dict[str, bool | float]:
        """Return random result for privilege escalation detection."""
        return _random_result()

    def detect_data_exfiltration(self, message: str) -> dict[str, bool | float]:
        """Return random result for data exfiltration detection."""
        return _random_result()

    def detect_resource_abuse(self, message: str) -> dict[str, bool | float]:
        """Return random result for resource abuse detection."""
        return _random_result()

    def detect_content_policy_violation(self, message: str) -> dict[str, bool | float]:
        """Return random result for content policy violation detection."""
        return _random_result()
