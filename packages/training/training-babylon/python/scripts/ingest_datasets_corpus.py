#!/usr/bin/env python3
"""
Ingest training data from the workspace datasets/ pipeline into babylon training-data/.

The datasets/ directory produces deduplicated, augmented training corpora in
final/train-mixes/{full,balanced,attack-heavy}/. This script reads from
that pipeline and writes a merged corpus into babylon's training-data/
directory in the format expected by the training pipeline.

Usage:
    python3 scripts/ingest_datasets_corpus.py
    python3 scripts/ingest_datasets_corpus.py --mix balanced
    python3 scripts/ingest_datasets_corpus.py --mix attack-heavy --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent


def _find_workspace_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / "datasets").exists() and (candidate / "babylon").exists():
            return candidate
        if (candidate / "scambench").exists():
            return candidate
    raise RuntimeError(f"Could not locate workspace root from {start}")


WORKSPACE_ROOT = _find_workspace_root(SCRIPT_DIR)
DATASETS_ROOT = WORKSPACE_ROOT / "datasets"
BABYLON_ROOT = (
    WORKSPACE_ROOT / "babylon"
    if (WORKSPACE_ROOT / "babylon").exists()
    else _find_workspace_root(SCRIPT_DIR)
)
TRAINING_DATA_ROOT = BABYLON_ROOT / "training-data"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def resolve_datasets_mix(mix_name: str) -> Path:
    """Resolve path to a specific train-mix variant."""
    mix_dir = DATASETS_ROOT / "final" / "train-mixes" / mix_name
    if not mix_dir.exists():
        available = [
            d.name for d in (DATASETS_ROOT / "final" / "train-mixes").iterdir() if d.is_dir()
        ]
        raise FileNotFoundError(
            f"Train-mix '{mix_name}' not found at {mix_dir}. Available: {available}"
        )
    return mix_dir


def load_datasets_corpus(mix_dir: Path) -> list[dict[str, Any]]:
    """Load training examples from the datasets pipeline output."""
    data_dir = mix_dir / "data"
    training_file = data_dir / "training_examples.jsonl"

    if not training_file.exists():
        raise FileNotFoundError(f"Training examples not found at {training_file}")

    records = []
    with open(training_file, encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                records.append(record)
            except json.JSONDecodeError as e:
                logger.warning(f"Skipping malformed line {line_num}: {e}")

    logger.info(f"Loaded {len(records)} records from {training_file}")
    return records


def convert_to_babylon_format(record: dict[str, Any]) -> dict[str, Any]:
    """Convert a datasets pipeline record into babylon training format.

    The datasets/ pipeline format has fields like:
        id, semantic_id, source_dataset, scenario_category,
        system_prompt, messages (JSON string), chosen_action,
        decision_class, reasoning_trace, etc.

    The babylon training format expects:
        scenario_id, category, prompt, user_prompt (conversation),
        response, chosen_action, explanation, available_actions,
        private_analysis, reasoning fields, etc.
    """
    messages_raw = record.get("messages", "[]")
    if isinstance(messages_raw, str):
        try:
            messages = json.loads(messages_raw)
        except json.JSONDecodeError:
            messages = []
    else:
        messages = messages_raw

    tools_raw = record.get("available_tools", "[]")
    if isinstance(tools_raw, str):
        try:
            available_tools = json.loads(tools_raw)
        except json.JSONDecodeError:
            available_tools = []
    else:
        available_tools = tools_raw

    tool_calls_raw = record.get("tool_calls", "[]")
    if isinstance(tool_calls_raw, str):
        try:
            tool_calls = json.loads(tool_calls_raw)
        except json.JSONDecodeError:
            tool_calls = []
    else:
        tool_calls = tool_calls_raw

    secret_classes_raw = record.get("secret_classes", "[]")
    if isinstance(secret_classes_raw, str):
        try:
            secret_classes = json.loads(secret_classes_raw)
        except json.JSONDecodeError:
            secret_classes = []
    else:
        secret_classes = secret_classes_raw

    # Map scenario_category to babylon category names
    category_map = {
        "benign": "benign",
        "prompt-injection": "prompt-injection",
        "social-engineering": "social-engineering",
        "secret-exfiltration": "secret-exfiltration",
        "credential-theft": "credential-theft",
        "impersonation": "impersonation",
        "research-assisted": "research-assisted",
        "phishing-link": "social-engineering",
        "malicious-tool": "prompt-injection",
        "interpersonal-abuse": "social-engineering",
        "advance-fee-fraud": "social-engineering",
    }

    scenario_category = record.get("scenario_category", "benign")
    babylon_category = category_map.get(scenario_category, scenario_category)

    # Determine intent
    should_trigger = record.get("should_trigger_scam_defense", False)
    intent = "attack" if should_trigger else "legitimate"

    return {
        "scenario_id": record.get("id", record.get("semantic_id", "")),
        "category": babylon_category,
        "intent": intent,
        "prompt": record.get("system_prompt", ""),
        "user_prompt": json.dumps(messages),
        "response": record.get("response_text", ""),
        "chosen_action": record.get("chosen_action", ""),
        "decision_class": record.get("decision_class", ""),
        "operation_class": record.get("operation_class", ""),
        "authority_context": record.get("authority_context", "none"),
        "explanation": record.get("explanation", ""),
        "available_actions": json.dumps(available_tools),
        "tool_calls": json.dumps(tool_calls),
        "leaked_secret": record.get("leaked_secret", False),
        "secret_classes": json.dumps(secret_classes),
        "private_analysis": record.get("reasoning_trace", ""),
        "raw_reasoning_trace": record.get("reasoning_trace", ""),
        "reasoning_source": record.get("reasoning_source", ""),
        "reasoning_available": bool(record.get("reasoning_trace")),
        "source_dataset": record.get("source_dataset", ""),
        "source_pipeline": "datasets",
        "style_variant": record.get("style_variant", "plain"),
        "agent_name": record.get("agent_name", ""),
        "language": record.get("language", "en"),
    }


def write_babylon_corpus(
    records: list[dict[str, Any]],
    output_dir: Path,
    mix_name: str,
    dry_run: bool = False,
) -> Path:
    """Write converted records to babylon training-data directory."""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    corpus_dir = output_dir / "datasets-corpus" / f"{mix_name}-{timestamp}"

    if dry_run:
        logger.info(f"[DRY RUN] Would write {len(records)} records to {corpus_dir}")
        # Count categories
        categories: dict[str, int] = {}
        intents: dict[str, int] = {}
        for r in records:
            cat = r.get("category", "unknown")
            categories[cat] = categories.get(cat, 0) + 1
            intent = r.get("intent", "unknown")
            intents[intent] = intents.get(intent, 0) + 1
        logger.info(f"  Categories: {json.dumps(categories, indent=2)}")
        logger.info(f"  Intents: {json.dumps(intents, indent=2)}")
        return corpus_dir

    corpus_dir.mkdir(parents=True, exist_ok=True)

    # Write training examples
    examples_path = corpus_dir / "training_examples.jsonl"
    with open(examples_path, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # Write manifest
    categories: dict[str, int] = {}
    intents: dict[str, int] = {}
    for r in records:
        cat = r.get("category", "unknown")
        categories[cat] = categories.get(cat, 0) + 1
        intent = r.get("intent", "unknown")
        intents[intent] = intents.get(intent, 0) + 1

    manifest = {
        "source": "datasets-pipeline",
        "mix": mix_name,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "totalRecords": len(records),
        "categoryCounts": categories,
        "intentCounts": intents,
        "reasoningCoverage": sum(1 for r in records if r.get("reasoning_available")),
        "datasetsRoot": str(DATASETS_ROOT),
    }

    manifest_path = corpus_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    # Update symlink for latest
    latest_link = output_dir / "datasets-corpus" / f"{mix_name}-latest"
    if latest_link.is_symlink() or latest_link.exists():
        latest_link.unlink()
    latest_link.symlink_to(corpus_dir.name)

    logger.info(
        f"Wrote {len(records)} records to {corpus_dir}\n"
        f"  Categories: {json.dumps(categories)}\n"
        f"  Intents: {json.dumps(intents)}\n"
        f"  Manifest: {manifest_path}\n"
        f"  Latest symlink: {latest_link}"
    )

    return corpus_dir


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest datasets/ corpus into babylon training-data/"
    )
    parser.add_argument(
        "--mix",
        default="balanced",
        choices=["full", "balanced", "attack-heavy"],
        help="Which train-mix variant to ingest (default: balanced)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be ingested without writing files",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help=f"Override output directory (default: {TRAINING_DATA_ROOT})",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir) if args.output_dir else TRAINING_DATA_ROOT

    logger.info(f"Ingesting datasets/{args.mix} train-mix into babylon training-data/")
    logger.info(f"  Datasets root: {DATASETS_ROOT}")
    logger.info(f"  Output dir: {output_dir}")

    # Resolve and load
    mix_dir = resolve_datasets_mix(args.mix)
    raw_records = load_datasets_corpus(mix_dir)

    # Convert format
    converted = [convert_to_babylon_format(r) for r in raw_records]
    logger.info(f"Converted {len(converted)} records to babylon format")

    # Write
    corpus_dir = write_babylon_corpus(converted, output_dir, args.mix, dry_run=args.dry_run)

    if not args.dry_run:
        logger.info(f"Done. Corpus available at: {corpus_dir}")
        logger.info(f"Use with training: --source-dir {corpus_dir}")


if __name__ == "__main__":
    main()
