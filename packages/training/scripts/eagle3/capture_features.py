#!/usr/bin/env python3
"""Capture teacher features for EAGLE3 drafter training.

The real path runs the target model with hidden states enabled and writes one
feature tensor file per dataset row. Synthetic mode remains a small deterministic
fixture path for CI.
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
    read_jsonl,
    require_module,
    sha256_file,
    utc_now_iso,
    validate_existing_dir,
    validate_existing_file,
    write_json,
    write_jsonl,
)

log = configure_logging("eagle3.capture_features")


def _feature_index(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    indexed: list[dict[str, Any]] = []
    for i, record in enumerate(records):
        indexed.append(
            {
                "id": record.get("id", f"record-{i:05d}"),
                "feature_file": None,
                "hidden_state_shape": [0],
                "logits_shape": [0],
                "labels_shape": [len(record.get("target_token_ids") or [])],
                "synthetic": True,
            }
        )
    return indexed


def _record_text(record: dict[str, Any]) -> str:
    prompt = str(record.get("prompt") or "").strip()
    response = str(record.get("response") or "").strip()
    if prompt or response:
        return f"{prompt}\n{response}".strip()
    messages = record.get("messages")
    if isinstance(messages, list):
        return "\n".join(str(m.get("content", "")) for m in messages).strip()
    return ""


def _manifest(
    *,
    args: argparse.Namespace,
    synthetic: bool,
    dry_run: bool,
    dataset: Path,
    feature_index_path: Path | None,
    examples: int,
) -> dict[str, Any]:
    return {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "kind": "eagle3-feature-capture",
        "pipeline": "eagle3",
        "stage": "capture-features",
        "tier": args.tier,
        "generatedAt": utc_now_iso(),
        "synthetic": synthetic,
        "dryRun": dry_run,
        "targetCheckpoint": args.target_checkpoint,
        "dataset": {
            "path": str(dataset),
            "sha256": sha256_file(dataset),
            "examples": examples,
        },
        "featureIndex": (
            {"path": str(feature_index_path), "sha256": sha256_file(feature_index_path)}
            if feature_index_path is not None
            else None
        ),
    }


def _run_synthetic(args: argparse.Namespace) -> int:
    dataset = validate_existing_file(args.dataset, "--dataset", log)
    if dataset is None:
        return 2
    records = read_jsonl(dataset)
    out_dir = Path(args.out_dir)
    feature_index_path = out_dir / "features.index.jsonl"
    write_jsonl(feature_index_path, _feature_index(records))
    manifest = _manifest(
        args=args,
        synthetic=True,
        dry_run=False,
        dataset=dataset,
        feature_index_path=feature_index_path,
        examples=len(records),
    )
    write_json(out_dir / "features.manifest.json", manifest)
    log.info("wrote synthetic EAGLE3 feature index %s and manifest", feature_index_path)
    return 0


def _run_dry_run(args: argparse.Namespace) -> int:
    target_checkpoint = validate_existing_dir(
        args.target_checkpoint, "--target-checkpoint", log
    )
    dataset = validate_existing_file(args.dataset, "--dataset", log)
    if target_checkpoint is None or dataset is None:
        return 2
    records = read_jsonl(dataset)
    manifest = _manifest(
        args=args,
        synthetic=False,
        dry_run=True,
        dataset=dataset,
        feature_index_path=None,
        examples=len(records),
    )
    write_json(Path(args.out_dir) / "features.manifest.json", manifest)
    log.info("wrote dry-run EAGLE3 feature manifest only")
    return 0


def _run_real(args: argparse.Namespace) -> int:
    target_checkpoint = validate_existing_dir(
        args.target_checkpoint, "--target-checkpoint", log
    )
    dataset = validate_existing_file(args.dataset, "--dataset", log)
    if target_checkpoint is None or dataset is None:
        return 2
    torch = require_module("torch", "torch", log)
    transformers = require_module("transformers", "transformers", log)
    if torch is None or transformers is None:
        return ENVIRONMENT_EXIT

    try:
        tokenizer = transformers.AutoTokenizer.from_pretrained(
            args.tokenizer or str(target_checkpoint),
            trust_remote_code=args.trust_remote_code,
        )
        model = transformers.AutoModelForCausalLM.from_pretrained(
            str(target_checkpoint),
            torch_dtype=(torch.bfloat16 if args.dtype == "bf16" else None),
            trust_remote_code=args.trust_remote_code,
        )
    except Exception as exc:
        log.error("failed to load target model/tokenizer for EAGLE3 capture: %s", exc)
        return ENVIRONMENT_EXIT

    device = torch.device(args.device)
    model.to(device)
    model.eval()

    records = read_jsonl(dataset)
    if args.max_samples:
        records = records[: args.max_samples]
    features_dir = Path(args.out_dir) / "features"
    features_dir.mkdir(parents=True, exist_ok=True)
    index_rows: list[dict[str, Any]] = []

    with torch.no_grad():
        for i, record in enumerate(records):
            text = _record_text(record)
            if not text:
                log.error("dataset record %s has no prompt/response text", record.get("id", i))
                return 2
            encoded = tokenizer(
                text,
                return_tensors="pt",
                truncation=True,
                max_length=args.max_seq_len,
            )
            encoded = {k: v.to(device) for k, v in encoded.items()}
            outputs = model(**encoded, output_hidden_states=True)
            hidden = outputs.hidden_states[-1].detach().to("cpu", dtype=torch.float32).squeeze(0)
            logits = outputs.logits.detach().to("cpu", dtype=torch.float32).squeeze(0)
            labels = torch.tensor(record.get("target_token_ids") or [], dtype=torch.long)
            feature_path = features_dir / f"{record.get('id', f'record-{i:05d}')}.pt"
            torch.save(
                {
                    "id": record.get("id", f"record-{i:05d}"),
                    "hidden": hidden,
                    "logits": logits,
                    "labels": labels,
                    "input_ids": encoded["input_ids"].detach().cpu().squeeze(0),
                },
                feature_path,
            )
            index_rows.append(
                {
                    "id": record.get("id", f"record-{i:05d}"),
                    "feature_file": str(feature_path),
                    "sha256": sha256_file(feature_path),
                    "hidden_state_shape": list(hidden.shape),
                    "logits_shape": list(logits.shape),
                    "labels_shape": list(labels.shape),
                    "synthetic": False,
                }
            )

    feature_index_path = Path(args.out_dir) / "features.index.jsonl"
    write_jsonl(feature_index_path, index_rows)
    manifest = _manifest(
        args=args,
        synthetic=False,
        dry_run=False,
        dataset=dataset,
        feature_index_path=feature_index_path,
        examples=len(index_rows),
    )
    write_json(Path(args.out_dir) / "features.manifest.json", manifest)
    log.info("wrote EAGLE3 feature index %s and %d tensor files", feature_index_path, len(index_rows))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", required=True, choices=ACTIVE_TIERS)
    parser.add_argument("--dataset", required=True, help="JSONL from prepare_distill_dataset.py.")
    parser.add_argument("--target-checkpoint", help="HF directory for the target model.")
    parser.add_argument("--tokenizer", help="Tokenizer path/name. Defaults to --target-checkpoint.")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--dtype", choices=("fp32", "bf16"), default="fp32")
    parser.add_argument("--max-seq-len", type=int, default=2048)
    parser.add_argument("--max-samples", type=int, default=0, help="0 means all records.")
    parser.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Write deterministic feature metadata from a synthetic dataset.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and write a manifest, but no feature index.",
    )
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Pass trust_remote_code=True when loading the target model/tokenizer.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.max_samples < 0 or args.max_seq_len <= 0:
        log.error("--max-samples must be >= 0 and --max-seq-len must be > 0")
        return 2
    if args.synthetic_smoke:
        return _run_synthetic(args)
    if args.dry_run:
        return _run_dry_run(args)
    return _run_real(args)


if __name__ == "__main__":
    raise SystemExit(main())
