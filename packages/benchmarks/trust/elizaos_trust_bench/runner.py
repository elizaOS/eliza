"""Benchmark runner that orchestrates corpus loading, detection, scoring, and reporting."""

from __future__ import annotations

import json
import logging
import warnings

from elizaos_trust_bench.corpus import get_corpus
from elizaos_trust_bench.reporter import format_report
from elizaos_trust_bench.scorer import score_results
from elizaos_trust_bench.types import (
    BenchmarkConfig,
    BenchmarkResult,
    DetectionResult,
    TrustTestCase,
    ThreatCategory,
    TrustHandler,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Category -> detection method mapping
# ---------------------------------------------------------------------------

_DETECTION_CATEGORIES: dict[ThreatCategory, str] = {
    ThreatCategory.PROMPT_INJECTION: "detect_injection",
    ThreatCategory.SOCIAL_ENGINEERING: "detect_social_engineering",
    ThreatCategory.IMPERSONATION: "detect_impersonation",
    ThreatCategory.CREDENTIAL_THEFT: "detect_credential_theft",
    ThreatCategory.PRIVILEGE_ESCALATION: "detect_privilege_escalation",
    ThreatCategory.DATA_EXFILTRATION: "detect_data_exfiltration",
    ThreatCategory.RESOURCE_ABUSE: "detect_resource_abuse",
    ThreatCategory.CONTENT_POLICY: "detect_content_policy_violation",
}

# For benign cases, run through these detectors (all except impersonation)
_BENIGN_DETECTORS: list[str] = [
    "detect_injection",
    "detect_social_engineering",
    "detect_credential_theft",
    "detect_privilege_escalation",
    "detect_data_exfiltration",
    "detect_resource_abuse",
    "detect_content_policy_violation",
]

# All expected method names — used for handler validation
_ALL_HANDLER_METHODS: set[str] = set(_DETECTION_CATEGORIES.values())


def _validate_handler(handler: object) -> list[str]:
    """Validate handler implements expected methods.

    Returns list of warning messages for missing or unexpected methods.
    Does NOT raise — allows partial implementations.
    """
    handler_name = getattr(handler, "name", type(handler).__name__)
    issues: list[str] = []

    # Check which expected methods are missing
    missing = [m for m in _ALL_HANDLER_METHODS if not callable(getattr(handler, m, None))]
    if missing:
        issues.append(
            f"Handler '{handler_name}' is missing methods: {', '.join(sorted(missing))}. "
            f"Those categories will score 0."
        )

    # Check if handler satisfies the Protocol structurally
    if isinstance(handler, TrustHandler):
        logger.debug("Handler '%s' satisfies TrustHandler protocol", handler_name)
    else:
        issues.append(
            f"Handler '{handler_name}' does not fully satisfy the TrustHandler protocol. "
            f"This is OK for partial implementations."
        )

    return issues


def _clamp_confidence(value: float) -> float:
    """Clamp confidence to [0.0, 1.0] range."""
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


def _safe_call_detector(
    handler: object,
    method_name: str,
    *args: str | list[str],
    test_id: str = "",
) -> dict[str, bool | float]:
    """Safely call a handler detection method with error handling.

    Returns {"detected": False, "confidence": 0.0} if the method is missing
    or raises an exception.
    """
    method = getattr(handler, method_name, None)
    if method is None:
        return {"detected": False, "confidence": 0.0}

    if not callable(method):
        logger.warning(
            "Handler attribute '%s' is not callable (test %s)",
            method_name,
            test_id,
        )
        return {"detected": False, "confidence": 0.0}

    try:
        result = method(*args)
    except Exception:
        handler_name = getattr(handler, "name", type(handler).__name__)
        logger.exception(
            "Handler '%s'.%s() raised an exception on test case '%s'",
            handler_name,
            method_name,
            test_id,
        )
        return {"detected": False, "confidence": 0.0}

    # Validate return shape
    if not isinstance(result, dict):
        logger.warning(
            "Handler %s() returned %s instead of dict (test %s)",
            method_name,
            type(result).__name__,
            test_id,
        )
        return {"detected": False, "confidence": 0.0}

    if "detected" not in result or "confidence" not in result:
        logger.warning(
            "Handler %s() returned dict missing 'detected' or 'confidence' keys (test %s)",
            method_name,
            test_id,
        )
        return {"detected": False, "confidence": 0.0}

    # Clamp confidence to valid range
    result["confidence"] = _clamp_confidence(float(result["confidence"]))

    return result


class TrustBenchmarkRunner:
    """Run the trust & security benchmark against a handler.

    Usage:
        from elizaos_trust_bench.runner import TrustBenchmarkRunner
        from elizaos_trust_bench.baselines import PerfectHandler

        runner = TrustBenchmarkRunner()
        result = runner.run(PerfectHandler())
    """

    def __init__(self, config: BenchmarkConfig | None = None) -> None:
        self.config = config or BenchmarkConfig()

    def run(self, handler: object) -> BenchmarkResult:
        """Run the benchmark against the given handler.

        Args:
            handler: An object implementing the TrustHandler protocol
                     (or any subset of its detection methods).

        Returns:
            Scored benchmark result.
        """
        handler_name = getattr(handler, "name", type(handler).__name__)

        # Validate handler and warn about missing methods
        issues = _validate_handler(handler)
        for issue in issues:
            warnings.warn(issue, stacklevel=2)

        # Filter corpus based on config
        corpus = get_corpus(
            categories=self.config.categories,
            difficulties=self.config.difficulties,
            tags=self.config.tags,
        )

        if not corpus:
            warnings.warn(
                "Filtered corpus is empty — no test cases match the configured filters.",
                stacklevel=2,
            )
            return BenchmarkResult(handler_name=handler_name)

        print(f"[TrustBench] Running with handler: {handler_name}")
        print(f"[TrustBench] Test corpus: {len(corpus)} cases")
        print()

        detections = self._run_all(handler, corpus)
        result = score_results(corpus, detections, handler_name=handler_name)
        report = format_report(result, corpus, detections)

        print(report)

        return result

    def run_and_report(
        self,
        handler: object,
        output_path: str | None = None,
    ) -> BenchmarkResult:
        """Run benchmark and optionally write JSON results.

        Args:
            handler: The handler to benchmark.
            output_path: Optional path for JSON output (overrides config).

        Returns:
            Scored benchmark result.
        """
        result = self.run(handler)

        out_path = output_path or self.config.output_path
        if out_path:
            report_dict = _serialize_result(result)
            with open(out_path, "w") as f:
                json.dump(report_dict, f, indent=2, default=str)
            print(f"\n[TrustBench] Results written to {out_path}")

        # Check threshold
        if result.overall_f1 < self.config.fail_threshold:
            print(
                f"\nWARNING: Overall F1 ({result.overall_f1:.1%}) below "
                f"threshold ({self.config.fail_threshold:.1%})"
            )

        return result

    def _run_all(
        self,
        handler: object,
        corpus: list[TrustTestCase],
    ) -> list[DetectionResult]:
        """Run all test cases through the handler."""
        results: list[DetectionResult] = []

        for tc in corpus:
            detection = self._detect_one(handler, tc)
            results.append(
                DetectionResult(
                    test_id=tc.id,
                    detected=bool(detection["detected"]),
                    confidence=_clamp_confidence(float(detection["confidence"])),
                    detected_type=tc.category.value if detection["detected"] else None,
                )
            )

        return results

    def _detect_one(
        self,
        handler: object,
        tc: TrustTestCase,
    ) -> dict[str, bool | float]:
        """Run a single test case through the appropriate detector(s)."""
        if tc.category == ThreatCategory.BENIGN:
            return self._detect_benign(handler, tc)

        if tc.category == ThreatCategory.IMPERSONATION:
            return _safe_call_detector(
                handler,
                "detect_impersonation",
                tc.input,
                tc.existing_users or [],
                test_id=tc.id,
            )

        method_name = _DETECTION_CATEGORIES.get(tc.category)
        if method_name is None:
            return {"detected": False, "confidence": 0.0}

        return _safe_call_detector(handler, method_name, tc.input, test_id=tc.id)

    def _detect_benign(
        self,
        handler: object,
        tc: TrustTestCase,
    ) -> dict[str, bool | float]:
        """For benign cases, run through ALL detectors and flag if ANY fires."""
        max_confidence = 0.0
        any_detected = False

        for detector_name in _BENIGN_DETECTORS:
            result = _safe_call_detector(handler, detector_name, tc.input, test_id=tc.id)
            if result["detected"]:
                any_detected = True
            conf = float(result["confidence"])
            if conf > max_confidence:
                max_confidence = conf

        return {"detected": any_detected, "confidence": max_confidence}


def _serialize_result(result: BenchmarkResult) -> dict[str, object]:
    """Convert result to a JSON-serializable dict."""
    return {
        "handler_name": result.handler_name,
        "overall_f1": result.overall_f1,
        "false_positive_rate": result.false_positive_rate,
        "total_tests": result.total_tests,
        "timestamp": result.timestamp,
        "difficulty_breakdown": {
            "easy": {
                "correct": result.difficulty_breakdown.easy_correct,
                "total": result.difficulty_breakdown.easy_total,
            },
            "medium": {
                "correct": result.difficulty_breakdown.medium_correct,
                "total": result.difficulty_breakdown.medium_total,
            },
            "hard": {
                "correct": result.difficulty_breakdown.hard_correct,
                "total": result.difficulty_breakdown.hard_total,
            },
        },
        "categories": [
            {
                "category": c.category.value,
                "true_positives": c.true_positives,
                "false_positives": c.false_positives,
                "false_negatives": c.false_negatives,
                "true_negatives": c.true_negatives,
                "precision": c.precision,
                "recall": c.recall,
                "f1": c.f1,
                "total": c.total,
            }
            for c in result.categories
        ],
    }
