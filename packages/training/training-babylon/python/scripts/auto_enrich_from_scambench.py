#!/usr/bin/env python3
"""
Auto-Enrich Training Data from ScamBench Results

Analyzes ScamBench evaluation results and automatically adjusts the training
data mix for the next run. If a specific attack category regresses (e.g.,
social-engineering score drops), this script boosts that category's
representation in the training corpus.

Usage:
    # After a ScamBench run:
    python scripts/auto_enrich_from_scambench.py \
        --scambench-report runs/scambench-eval/latest.json \
        --baseline-report runs/scambench-eval/baseline.json \
        --corpus-dir training-data/datasets-corpus/balanced-latest \
        --output-dir training-data/enriched

    # Or integrated into run_pipeline.py:
    from auto_enrich_from_scambench import analyze_and_enrich
    enriched_dir = analyze_and_enrich(scambench_report, baseline_report, corpus_dir)
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Category names as they appear in ScamBench reports
SCAMBENCH_CATEGORIES = [
    "prompt-injection",
    "social-engineering",
    "secret-exfiltration",
    "credential-theft",
    "impersonation",
    "research-assisted",
    "advance-fee-fraud",
]

# Default boost factor when a category regresses
DEFAULT_BOOST_FACTOR = 2.0
# Minimum score delta to trigger enrichment (absolute points)
REGRESSION_THRESHOLD = -2.0


def load_scambench_report(path: Path) -> dict[str, Any]:
    """Load a ScamBench report JSON."""
    with open(path) as f:
        return json.load(f)


def extract_category_scores(report: dict[str, Any]) -> dict[str, float]:
    """Extract per-category scores from a ScamBench report."""
    scores: dict[str, float] = {}

    # ScamBench reports have categoryResults or results.categoryResults
    category_results = report.get("categoryResults", {})
    if not category_results:
        category_results = report.get("results", {}).get("categoryResults", {})

    for category, data in category_results.items():
        if isinstance(data, dict):
            scores[category] = data.get("avgOverallScore", data.get("score", 0.0))
        elif isinstance(data, (int, float)):
            scores[category] = float(data)

    return scores


def compute_deltas(
    trained_scores: dict[str, float],
    baseline_scores: dict[str, float],
) -> dict[str, float]:
    """Compute score deltas (trained - baseline) per category."""
    deltas: dict[str, float] = {}
    all_categories = set(trained_scores.keys()) | set(baseline_scores.keys())

    for category in all_categories:
        trained = trained_scores.get(category, 0.0)
        baseline = baseline_scores.get(category, 0.0)
        deltas[category] = trained - baseline

    return deltas


def identify_regressions(
    deltas: dict[str, float],
    threshold: float = REGRESSION_THRESHOLD,
) -> list[tuple[str, float]]:
    """Identify categories that regressed beyond the threshold."""
    regressions = []
    for category, delta in deltas.items():
        if delta < threshold:
            regressions.append((category, delta))

    # Sort by severity (most regressed first)
    regressions.sort(key=lambda x: x[1])
    return regressions


def compute_boost_factors(
    regressions: list[tuple[str, float]],
    base_factor: float = DEFAULT_BOOST_FACTOR,
) -> dict[str, float]:
    """Compute boost factors proportional to regression severity."""
    factors: dict[str, float] = {}
    for category, delta in regressions:
        # More severe regression → higher boost
        severity = abs(delta) / 10.0  # Normalize to 0-1 range roughly
        factor = base_factor * (1.0 + severity)
        factors[category] = min(factor, 5.0)  # Cap at 5x boost

    return factors


def enrich_corpus(
    corpus_dir: Path,
    output_dir: Path,
    boost_factors: dict[str, float],
    dry_run: bool = False,
) -> dict[str, Any]:
    """
    Create an enriched corpus by duplicating records from regressed categories.

    For each regressed category, duplicate its training examples by the
    boost factor. This increases representation without removing other data.
    """
    training_file = corpus_dir / "training_examples.jsonl"
    if not training_file.exists():
        raise FileNotFoundError(f"Training examples not found: {training_file}")

    # Load and categorize records
    records_by_category: dict[str, list[str]] = {}
    all_records: list[str] = []

    with open(training_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            all_records.append(line)

            try:
                record = json.loads(line)
                category = record.get("category", record.get("scenario_category", "unknown"))
                if category not in records_by_category:
                    records_by_category[category] = []
                records_by_category[category].append(line)
            except json.JSONDecodeError:
                continue

    # Compute enrichment
    enriched_records = list(all_records)  # Start with all original records
    enrichment_stats: dict[str, dict[str, Any]] = {}

    for category, factor in boost_factors.items():
        category_records = records_by_category.get(category, [])
        if not category_records:
            # Try matching with different naming conventions
            for alt_name, records in records_by_category.items():
                if category.replace("-", "_") in alt_name.replace("-", "_"):
                    category_records = records
                    break

        if not category_records:
            logger.warning(f"No records found for category '{category}' — skipping boost")
            enrichment_stats[category] = {
                "boost_factor": factor,
                "original_count": 0,
                "added_count": 0,
                "reason": "no_matching_records",
            }
            continue

        # Duplicate records by (factor - 1) times (1x already in corpus)
        duplications = int(len(category_records) * (factor - 1))
        import random

        random.seed(42)  # Deterministic for reproducibility
        added = random.choices(category_records, k=duplications)
        enriched_records.extend(added)

        enrichment_stats[category] = {
            "boost_factor": factor,
            "original_count": len(category_records),
            "added_count": len(added),
            "new_total": len(category_records) + len(added),
        }

        logger.info(
            f"Boosted '{category}': {len(category_records)} → "
            f"{len(category_records) + len(added)} records ({factor:.1f}x)"
        )

    if dry_run:
        return {
            "dry_run": True,
            "original_count": len(all_records),
            "enriched_count": len(enriched_records),
            "boost_factors": boost_factors,
            "enrichment_stats": enrichment_stats,
        }

    # Write enriched corpus
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "training_examples.jsonl"

    # Shuffle to prevent clustering of boosted records
    import random

    random.seed(42)
    random.shuffle(enriched_records)

    with open(output_file, "w") as f:
        for line in enriched_records:
            f.write(line + "\n")

    # Write manifest
    manifest = {
        "source": "auto-enrichment",
        "enrichedAt": datetime.now(timezone.utc).isoformat(),
        "sourceCorpus": str(corpus_dir),
        "originalCount": len(all_records),
        "enrichedCount": len(enriched_records),
        "boostFactors": boost_factors,
        "enrichmentStats": enrichment_stats,
        "categoryDistribution": {cat: len(recs) for cat, recs in records_by_category.items()},
    }

    with open(output_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

    return manifest


def analyze_and_enrich(
    scambench_report_path: Path,
    baseline_report_path: Path,
    corpus_dir: Path,
    output_dir: Path | None = None,
    dry_run: bool = False,
) -> Path | None:
    """
    End-to-end: analyze ScamBench results and auto-enrich the corpus.

    Returns the enriched corpus directory, or None if no enrichment needed.
    """
    trained_report = load_scambench_report(scambench_report_path)
    baseline_report = load_scambench_report(baseline_report_path)

    trained_scores = extract_category_scores(trained_report)
    baseline_scores = extract_category_scores(baseline_report)

    deltas = compute_deltas(trained_scores, baseline_scores)
    regressions = identify_regressions(deltas)

    if not regressions:
        logger.info("No category regressions detected — no enrichment needed")
        return None

    logger.warning(
        f"Detected {len(regressions)} category regressions: "
        + ", ".join(f"{cat} ({delta:+.1f})" for cat, delta in regressions)
    )

    boost_factors = compute_boost_factors(regressions)

    if output_dir is None:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        output_dir = corpus_dir.parent / f"enriched-{timestamp}"

    result = enrich_corpus(corpus_dir, output_dir, boost_factors, dry_run=dry_run)

    if dry_run:
        logger.info(
            f"[DRY RUN] Would enrich {result['original_count']} → {result['enriched_count']} records"
        )
        return None

    logger.info(
        f"Enriched corpus written to {output_dir}: "
        f"{result['originalCount']} → {result['enrichedCount']} records"
    )
    return output_dir


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    parser = argparse.ArgumentParser(description="Auto-enrich training data from ScamBench results")
    parser.add_argument(
        "--scambench-report",
        required=True,
        help="Path to ScamBench report JSON (trained model)",
    )
    parser.add_argument(
        "--baseline-report",
        required=True,
        help="Path to ScamBench report JSON (baseline model)",
    )
    parser.add_argument(
        "--corpus-dir",
        required=True,
        help="Path to current training corpus directory",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Path for enriched corpus output",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    result = analyze_and_enrich(
        scambench_report_path=Path(args.scambench_report),
        baseline_report_path=Path(args.baseline_report),
        corpus_dir=Path(args.corpus_dir),
        output_dir=Path(args.output_dir) if args.output_dir else None,
        dry_run=args.dry_run,
    )

    if result:
        print(f"Enriched corpus: {result}")
    else:
        print("No enrichment needed (or dry run)")


if __name__ == "__main__":
    main()
