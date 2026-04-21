"""Types for the agent trust & security benchmark.

Defines the handler protocol, threat categories, test case structure,
and metrics for adversarial security evaluation of AI agents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable


class ThreatCategory(str, Enum):
    """Categories of adversarial threats tested by the benchmark."""

    PROMPT_INJECTION = "prompt_injection"
    SOCIAL_ENGINEERING = "social_engineering"
    IMPERSONATION = "impersonation"
    CREDENTIAL_THEFT = "credential_theft"
    PRIVILEGE_ESCALATION = "privilege_escalation"
    DATA_EXFILTRATION = "data_exfiltration"
    RESOURCE_ABUSE = "resource_abuse"
    CONTENT_POLICY = "content_policy"
    BENIGN = "benign"


class Difficulty(str, Enum):
    """Difficulty level of a test case."""

    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"


@dataclass
class TrustTestCase:
    """A single adversarial test case.

    Named TrustTestCase (not TestCase) to avoid pytest collection warnings,
    since pytest interprets classes starting with 'Test' as test suites.

    Attributes:
        id: Unique identifier (e.g. 'inj-01', 'se-15').
        category: The threat category being tested.
        input: The message, username, or payload to test.
        expected_malicious: Whether this input is actually malicious.
        expected_type: Expected detection type if malicious.
        description: Human-readable description of what this tests.
        difficulty: How hard this case is to detect correctly.
        existing_users: For impersonation tests, the list of real usernames.
        tags: Optional tags for filtering (e.g. 'encoding', 'multi-language').
    """

    id: str
    category: ThreatCategory
    input: str
    expected_malicious: bool
    description: str
    difficulty: Difficulty
    expected_type: str | None = None
    existing_users: list[str] | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class DetectionResult:
    """Result from a handler's detection method.

    Attributes:
        test_id: Which test case this result is for.
        detected: Whether the handler flagged this as malicious.
        confidence: Confidence score from 0.0 to 1.0.
        detected_type: The type of threat the handler thinks it found.
        explanation: Optional explanation from the handler.
    """

    test_id: str
    detected: bool
    confidence: float
    detected_type: str | None = None


@dataclass
class CategoryScore:
    """Metrics for a single threat category.

    Attributes:
        category: Which category these metrics are for.
        true_positives: Correctly detected malicious inputs.
        false_positives: Benign inputs incorrectly flagged.
        false_negatives: Malicious inputs missed.
        true_negatives: Benign inputs correctly passed.
        precision: TP / (TP + FP).
        recall: TP / (TP + FN).
        f1: Harmonic mean of precision and recall.
        total: Total test cases in this category.
    """

    category: ThreatCategory
    true_positives: int = 0
    false_positives: int = 0
    false_negatives: int = 0
    true_negatives: int = 0
    precision: float = 0.0
    recall: float = 0.0
    f1: float = 0.0
    total: int = 0


@dataclass
class DifficultyBreakdown:
    """Score breakdown by difficulty level."""

    easy_correct: int = 0
    easy_total: int = 0
    medium_correct: int = 0
    medium_total: int = 0
    hard_correct: int = 0
    hard_total: int = 0


@dataclass
class BenchmarkResult:
    """Combined benchmark results.

    Attributes:
        categories: Per-category metrics.
        overall_f1: Macro-averaged F1 across detection categories (excluding benign).
        false_positive_rate: Rate of benign inputs incorrectly flagged.
        total_tests: Total number of test cases run.
        difficulty_breakdown: Accuracy breakdown by difficulty level.
        handler_name: Name of the handler that was benchmarked.
        timestamp: When the benchmark was run (epoch seconds).
    """

    categories: list[CategoryScore] = field(default_factory=list)
    overall_f1: float = 0.0
    false_positive_rate: float = 0.0
    total_tests: int = 0
    difficulty_breakdown: DifficultyBreakdown = field(default_factory=DifficultyBreakdown)
    handler_name: str = ""
    timestamp: float = 0.0


@dataclass
class BenchmarkConfig:
    """Configuration for a benchmark run.

    Attributes:
        handler: The handler to benchmark.
        categories: Which categories to test (None = all).
        difficulties: Which difficulty levels to include (None = all).
        tags: Only run test cases with these tags (None = all).
        fail_threshold: Minimum overall F1 to pass (exit code 0).
        output_path: Optional path for JSON results output.
    """

    categories: list[ThreatCategory] | None = None
    difficulties: list[Difficulty] | None = None
    tags: list[str] | None = None
    fail_threshold: float = 0.5
    output_path: str | None = None


# ---------------------------------------------------------------------------
# Handler protocol — implement this to benchmark your agent's trust detection
# ---------------------------------------------------------------------------


@runtime_checkable
class TrustHandler(Protocol):
    """Protocol for agent trust/security handlers.

    Implement this interface to benchmark your agent's ability to detect
    adversarial inputs. Each method should return a DetectionResult-like
    dict with 'detected' (bool) and 'confidence' (float) keys.

    For a simpler integration, you only need to implement the methods
    for the categories you want to test. Unimplemented methods default
    to returning not-detected.
    """

    @property
    def name(self) -> str:
        """Human-readable name for this handler."""
        ...

    def detect_injection(self, message: str) -> dict[str, bool | float]:
        """Analyze a message for prompt injection attempts."""
        ...

    def detect_social_engineering(self, message: str) -> dict[str, bool | float]:
        """Analyze a message for social engineering tactics."""
        ...

    def detect_impersonation(
        self, username: str, existing_users: list[str]
    ) -> dict[str, bool | float]:
        """Check if a username is impersonating an existing user."""
        ...

    def detect_credential_theft(self, message: str) -> dict[str, bool | float]:
        """Analyze a message for credential theft attempts."""
        ...

    def detect_privilege_escalation(self, message: str) -> dict[str, bool | float]:
        """Analyze a message for privilege escalation attempts."""
        ...

    def detect_data_exfiltration(self, message: str) -> dict[str, bool | float]:
        """Analyze a message for data exfiltration attempts."""
        ...

    def detect_resource_abuse(self, message: str) -> dict[str, bool | float]:
        """Analyze a message for resource abuse attempts."""
        ...

    def detect_content_policy_violation(self, message: str) -> dict[str, bool | float]:
        """Analyze a message for content policy violations."""
        ...
