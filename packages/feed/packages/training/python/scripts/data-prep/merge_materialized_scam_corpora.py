#!/usr/bin/env python3
"""
Merge multiple materialized scam/prompt-injection corpora into a single Babylon-
shaped training/scenario bundle.
"""

from __future__ import annotations

import argparse
import json
import logging
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

LOGGER = logging.getLogger(__name__)


def read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def stable_signature(parts: list[str]) -> str:
    normalized = " ".join(part.strip().lower() for part in parts if part and part.strip())
    return normalized


def merge_jsonl_corpus(
    input_dirs: list[Path],
    filename: str,
    signature_fields: list[str],
) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    for input_dir in input_dirs:
        path = input_dir / filename
        if not path.exists():
            continue
        for row in read_jsonl(path):
            signature = stable_signature([str(row.get(field, "")) for field in signature_fields])
            if signature in seen:
                continue
            seen.add(signature)
            merged.append(row)
    return merged


def merge_training_examples(input_dirs: list[Path]) -> list[dict]:
    return merge_jsonl_corpus(
        input_dirs,
        "training_examples.jsonl",
        ["scenario_id", "prompt", "user_prompt", "response"],
    )


def merge_detector_rows(input_dirs: list[Path]) -> list[dict]:
    return merge_jsonl_corpus(
        input_dirs,
        "detector_corpus.jsonl",
        ["sourceDataset", "sourceFile", "rowIndex", "dedupHash"],
    )


def merge_conversation_rows(input_dirs: list[Path]) -> list[dict]:
    return merge_jsonl_corpus(
        input_dirs,
        "conversation_corpus.jsonl",
        ["sourceDataset", "sourceFile", "rowIndex", "dedupHash"],
    )


def merge_sft_rows(input_dirs: list[Path]) -> list[dict]:
    return merge_jsonl_corpus(
        input_dirs,
        "sft_corpus.jsonl",
        ["sourceDataset", "sourceFile", "rowIndex", "dedupHash"],
    )


def merge_reasoning_donor_rows(input_dirs: list[Path]) -> list[dict]:
    return merge_jsonl_corpus(
        input_dirs,
        "reasoning_donor_corpus.jsonl",
        ["sourceDataset", "sourceFile", "rowIndex", "donorHash"],
    )


def merge_scenario_seeds(input_dirs: list[Path]) -> list[dict]:
    return merge_jsonl_corpus(
        input_dirs,
        "scambench_scenario_seeds.jsonl",
        ["id", "sourceDataset", "sourceFile"],
    )


def merge_scenarios(input_dirs: list[Path]) -> list[dict]:
    merged: list[dict] = []
    seen_ids: set[str] = set()
    seen_content: set[str] = set()
    for input_dir in input_dirs:
        path = input_dir / "scambench_curated_scenarios.json"
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        for scenario in payload.get("scenarios", []):
            scenario_id = str(scenario.get("id", ""))
            first_stage = scenario.get("stages", [{}])[0]
            first_text = " ".join(
                message.get("content", "") for message in first_stage.get("incoming", [])
            )
            signature = stable_signature(
                [
                    scenario.get("suite", ""),
                    scenario.get("category", ""),
                    scenario.get("register", ""),
                    first_text,
                ]
            )
            if scenario_id in seen_ids or signature in seen_content:
                continue
            seen_ids.add(scenario_id)
            seen_content.add(signature)
            merged.append(scenario)
    return merged


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge multiple materialized scam corpora.")
    parser.add_argument(
        "--input-dir",
        action="append",
        required=True,
        help="Materialized corpus directory. Pass multiple times.",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to write the merged corpus into.",
    )
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )

    try:
        input_dirs = [Path(item).resolve() for item in args.input_dir]
        missing_dirs = [path for path in input_dirs if not path.exists() or not path.is_dir()]
        if missing_dirs:
            missing_text = ", ".join(str(path) for path in missing_dirs)
            raise FileNotFoundError(f"Materialized corpus directories not found: {missing_text}")
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        default_output = (
            Path(__file__).resolve().parents[4]
            / "training-data"
            / "merged-threat-materialized"
            / timestamp
        )
        output_dir = Path(args.output_dir).resolve() if args.output_dir else default_output
        output_dir.mkdir(parents=True, exist_ok=True)
        LOGGER.info("Merging %d materialized corpora into %s", len(input_dirs), output_dir)

        training_examples = merge_training_examples(input_dirs)
        detector_rows = merge_detector_rows(input_dirs)
        conversation_rows = merge_conversation_rows(input_dirs)
        sft_rows = merge_sft_rows(input_dirs)
        reasoning_donor_rows = merge_reasoning_donor_rows(input_dirs)
        scenario_seeds = merge_scenario_seeds(input_dirs)
        scenarios = merge_scenarios(input_dirs)

        write_jsonl(output_dir / "training_examples.jsonl", training_examples)
        write_jsonl(output_dir / "detector_corpus.jsonl", detector_rows)
        write_jsonl(output_dir / "conversation_corpus.jsonl", conversation_rows)
        write_jsonl(output_dir / "sft_corpus.jsonl", sft_rows)
        write_jsonl(output_dir / "reasoning_donor_corpus.jsonl", reasoning_donor_rows)
        write_jsonl(output_dir / "scambench_scenario_seeds.jsonl", scenario_seeds)
        (output_dir / "scambench_curated_scenarios.json").write_text(
            json.dumps({"scenarios": scenarios}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

        manifest = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "inputDirs": [str(path) for path in input_dirs],
            "detectorCount": len(detector_rows),
            "conversationCount": len(conversation_rows),
            "sftCount": len(sft_rows),
            "reasoningDonorCount": len(reasoning_donor_rows),
            "trainingExampleCount": len(training_examples),
            "scenarioSeedCount": len(scenario_seeds),
            "scenarioCount": len(scenarios),
            "scenarioCategoryCounts": dict(Counter(scenario["category"] for scenario in scenarios)),
            "scenarioSuiteCounts": dict(Counter(scenario["suite"] for scenario in scenarios)),
        }
        (output_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2),
            encoding="utf-8",
        )
        (output_dir / "summary.md").write_text(
            "\n".join(
                [
                    "# Merged Threat Materialization",
                    "",
                    f"- Generated: `{manifest['generatedAt']}`",
                    f"- Detector rows: `{manifest['detectorCount']}`",
                    f"- Conversation rows: `{manifest['conversationCount']}`",
                    f"- SFT rows: `{manifest['sftCount']}`",
                    f"- Reasoning donors: `{manifest['reasoningDonorCount']}`",
                    f"- Training examples: `{manifest['trainingExampleCount']}`",
                    f"- Scenario seeds: `{manifest['scenarioSeedCount']}`",
                    f"- Curated scenarios: `{manifest['scenarioCount']}`",
                    "",
                    "## Inputs",
                    "",
                    *[f"- `{path}`" for path in manifest["inputDirs"]],
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        LOGGER.info(
            "Merged corpus ready at %s with %d training rows", output_dir, len(training_examples)
        )
        print(
            json.dumps(
                {
                    "output_dir": str(output_dir),
                    "detector_count": len(detector_rows),
                    "conversation_count": len(conversation_rows),
                    "sft_count": len(sft_rows),
                    "reasoning_donor_count": len(reasoning_donor_rows),
                    "training_example_count": len(training_examples),
                    "scenario_seed_count": len(scenario_seeds),
                    "scenario_count": len(scenarios),
                },
                indent=2,
            )
        )
        return 0
    except Exception:
        LOGGER.exception("Materialized corpus merge failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
