#!/usr/bin/env python3
"""Prepare an EAGLE3 distillation dataset.

The real path normalizes chat/text JSONL into prompt/response records and, when
Transformers is available, records target-token ids from the target tokenizer.
Synthetic mode remains a deterministic CI fixture path.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from scripts.eagle3.common import (
    ACTIVE_TIERS,
    ENVIRONMENT_EXIT,
    MANIFEST_SCHEMA_VERSION,
    configure_logging,
    count_jsonl,
    positive_int,
    read_jsonl,
    require_module,
    sha256_file,
    utc_now_iso,
    validate_existing_dir,
    validate_existing_file,
    write_json,
    write_jsonl,
)

log = configure_logging("eagle3.prepare_distill_dataset")


def _message_text(messages: list[dict[str, Any]], role: str) -> str:
    chunks = [str(m.get("content", "")) for m in messages if m.get("role") == role]
    return "\n".join(chunk for chunk in chunks if chunk).strip()


def _normalize_source_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    messages = record.get("messages")
    if isinstance(messages, list):
        prompt = _message_text(messages, "user")
        response = _message_text(messages, "assistant")
    else:
        prompt = str(record.get("prompt") or record.get("instruction") or record.get("text") or "").strip()
        response = str(record.get("response") or record.get("completion") or record.get("output") or "").strip()
    if not prompt or not response:
        raise ValueError(f"record {index} must contain prompt/response text or user/assistant messages")
    return {
        "id": str(record.get("id") or f"eagle3-source-{index:05d}"),
        "prompt": prompt,
        "response": response,
        "messages": [
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": response},
        ],
        "source": {k: v for k, v in record.items() if k not in {"messages", "prompt", "instruction", "text", "response", "completion", "output"}},
    }


def _synthetic_records(tier: str, n: int) -> list[dict[str, Any]]:
    return [
        {
            "id": f"eagle3-synthetic-{tier}-{i:05d}",
            "messages": [
                {"role": "user", "content": f"Synthetic EAGLE3 prompt {i}"},
                {
                    "role": "assistant",
                    "content": f"Synthetic EAGLE3 teacher response {i}",
                },
            ],
            "target_token_ids": [1000 + i, 2000 + i, 3000 + i],
            "draft_acceptance_mask": [True, True, False],
            "synthetic": True,
        }
        for i in range(n)
    ]


def _manifest(
    *,
    args: argparse.Namespace,
    synthetic: bool,
    dry_run: bool,
    records_path: Path | None,
    examples: int,
    source_sha256: str | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "kind": "eagle3-distill-dataset",
        "pipeline": "eagle3",
        "stage": "prepare-distill-dataset",
        "tier": args.tier,
        "generatedAt": utc_now_iso(),
        "synthetic": synthetic,
        "dryRun": dry_run,
        "examples": examples,
        "targetCheckpoint": args.target_checkpoint,
        "source": (
            {"type": "synthetic-smoke"}
            if synthetic
            else {"type": "jsonl", "path": args.source_jsonl, "sha256": source_sha256}
        ),
        "records": (
            {
                "path": str(records_path),
                "sha256": sha256_file(records_path),
            }
            if records_path is not None
            else None
        ),
        "tokenizer": getattr(args, "tokenizer", None) or args.target_checkpoint,
    }


def _run_synthetic(args: argparse.Namespace) -> int:
    if not positive_int(args.synthetic_samples, "--synthetic-samples", log):
        return 2
    out_dir = Path(args.out_dir)
    records_path = out_dir / "eagle3_distill.jsonl"
    examples = write_jsonl(records_path, _synthetic_records(args.tier, args.synthetic_samples))
    manifest = _manifest(
        args=args,
        synthetic=True,
        dry_run=False,
        records_path=records_path,
        examples=examples,
    )
    write_json(out_dir / "dataset.manifest.json", manifest)
    log.info("wrote synthetic EAGLE3 dataset %s and manifest", records_path)
    return 0


def _run_dry_run(args: argparse.Namespace) -> int:
    target_checkpoint = validate_existing_dir(
        args.target_checkpoint, "--target-checkpoint", log
    )
    source_jsonl = validate_existing_file(args.source_jsonl, "--source-jsonl", log)
    if target_checkpoint is None or source_jsonl is None:
        return 2
    examples = count_jsonl(source_jsonl)
    if args.max_samples:
        examples = min(examples, args.max_samples)
    manifest = _manifest(
        args=args,
        synthetic=False,
        dry_run=True,
        records_path=None,
        examples=examples,
        source_sha256=sha256_file(source_jsonl),
    )
    write_json(Path(args.out_dir) / "dataset.manifest.json", manifest)
    log.info("wrote dry-run EAGLE3 dataset manifest only")
    return 0


def _run_real(args: argparse.Namespace) -> int:
    target_checkpoint = validate_existing_dir(
        args.target_checkpoint, "--target-checkpoint", log
    )
    source_jsonl = validate_existing_file(args.source_jsonl, "--source-jsonl", log)
    if target_checkpoint is None or source_jsonl is None:
        return 2
    transformers = require_module("transformers", "transformers", log)
    if transformers is None:
        return ENVIRONMENT_EXIT
    try:
        tokenizer = transformers.AutoTokenizer.from_pretrained(
            args.tokenizer or str(target_checkpoint),
            trust_remote_code=args.trust_remote_code,
        )
    except Exception as exc:
        log.error("failed to load tokenizer for EAGLE3 dataset prep: %s", exc)
        return ENVIRONMENT_EXIT

    records: list[dict[str, Any]] = []
    for index, raw in enumerate(read_jsonl(source_jsonl)):
        if args.max_samples and len(records) >= args.max_samples:
            break
        try:
            normalized = _normalize_source_record(raw, index)
        except ValueError as exc:
            log.error("%s", exc)
            return 2
        tokenized = tokenizer(normalized["response"], add_special_tokens=False)
        normalized["target_token_ids"] = [int(t) for t in tokenized["input_ids"]]
        normalized["synthetic"] = False
        records.append(normalized)

    out_dir = Path(args.out_dir)
    records_path = out_dir / "eagle3_distill.jsonl"
    examples = write_jsonl(records_path, records)
    manifest = _manifest(
        args=args,
        synthetic=False,
        dry_run=False,
        records_path=records_path,
        examples=examples,
        source_sha256=sha256_file(source_jsonl),
    )
    write_json(out_dir / "dataset.manifest.json", manifest)
    log.info("wrote EAGLE3 dataset %s and manifest", records_path)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", required=True, choices=ACTIVE_TIERS)
    parser.add_argument("--target-checkpoint", help="HF directory for the target model.")
    parser.add_argument("--tokenizer", help="Tokenizer path/name. Defaults to --target-checkpoint.")
    parser.add_argument("--source-jsonl", help="JSONL corpus to adapt for EAGLE3.")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--max-samples", type=int, default=0, help="0 means all records.")
    parser.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Write deterministic fixture records and a dataset manifest.",
    )
    parser.add_argument(
        "--synthetic-samples",
        type=int,
        default=16,
        help="Synthetic record count for --synthetic-smoke.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate local inputs and write a manifest, but no records.",
    )
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Pass trust_remote_code=True when loading the target tokenizer.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.max_samples < 0:
        log.error("--max-samples must be >= 0")
        return 2
    if args.synthetic_smoke:
        return _run_synthetic(args)
    if args.dry_run:
        return _run_dry_run(args)
    return _run_real(args)


if __name__ == "__main__":
    raise SystemExit(main())
