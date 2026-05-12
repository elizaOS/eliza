#!/usr/bin/env python3
"""Build a DFlash drafter distillation corpus for a given Eliza-1 tier.

DFlash drafters are knowledge-distilled (see ../distill_dflash_drafter.py) from
the exact Eliza-1 text checkpoint they ship with. The student must train on the
*target's* output distribution over the same prompt distribution the target was
fine-tuned on — anything else hurts acceptance. This script prepares that
corpus by:

  1. Loading a conversational source corpus (a local jsonl, or a HF dataset
     like HuggingFaceH4/ultrachat_200k).
  2. Re-tokenizing every sample with the target model's exact tokenizer.
     This is the load-bearing "vocab-alignment" step: the drafter must share
     a vocabulary with the target, and the easiest way to guarantee that at
     dataset time is to tokenize with the target's tokenizer up front.
  3. Optionally generating greedy teacher continuations from the target model
     so the distillation loop in distill_dflash_drafter.py can train on the
     *target's own* token distribution (the highest-signal KD setup).
  4. Emitting `<out-dir>/distill.jsonl` (one record per line) plus a small
     `<out-dir>/dataset.manifest.json` with hashes + source provenance.

The synthetic-smoke path validates the pipeline shape without loading any real
model — it emits ~100 deterministic dummy records so downstream scripts
(distill_dflash_drafter.py, validate_drafter.py) can read the file.

Hard rule (training/AGENTS.md §2): the target and student tokenizers must be
byte-identical. distill_dflash_drafter.py reasserts this at training time, but
preparing the corpus with the target tokenizer keeps that contract trivially
true.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("prepare_distill_dataset")

# Mirrors distill_dflash_drafter.DEFAULT_STUDENT_BASE / DEFAULT_TARGET_MODEL —
# the canonical Eliza-1 tier set lives in that script. Listed here so the prep
# step refuses an unknown tier early.
KNOWN_TIERS = ("0_8b", "2b", "4b", "9b", "27b", "27b-256k", "27b-1m")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_jsonl(records: list[dict[str, Any]], path: Path) -> None:
    with path.open("w") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _run_synthetic_smoke(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    n = args.synthetic_samples
    records: list[dict[str, Any]] = []
    for i in range(n):
        # `messages` is the canonical record shape distill_dflash_drafter.py
        # expects; the real path also supports `text`.
        records.append(
            {
                "messages": [
                    {"role": "user", "content": f"Synthetic prompt {i}"},
                    {
                        "role": "assistant",
                        "content": (
                            "Synthetic teacher response "
                            f"{i} — used only to validate the pipeline shape."
                        ),
                    },
                ],
                "_synthetic": True,
            }
        )
    out_path = out_dir / "distill.jsonl"
    _write_jsonl(records, out_path)

    manifest = {
        "schemaVersion": 1,
        "kind": "dflash-drafter-distill-dataset",
        "tier": args.tier,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": True,
        "source": "synthetic-smoke",
        "targetCheckpoint": None,
        "targetTokenizer": None,
        "examples": n,
        "datasetSha256": _sha256_file(out_path),
        "notes": (
            "Synthetic smoke output. NOT for training. Replace with the real "
            "prep run (drop --synthetic-smoke) before the distillation job."
        ),
    }
    manifest_path = out_dir / "dataset.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("synthetic smoke wrote %s (%d records) and %s", out_path, n, manifest_path)
    return 0


def _load_source_records(args: argparse.Namespace) -> list[dict[str, Any]]:
    """Load a conversational corpus into `messages`-shaped records.

    Two paths:
      - `--source-jsonl path.jsonl`: read directly. Each line is either
        `{"text": "..."}` or `{"messages": [...]}`.
      - `--hf-dataset name [--hf-split split]`: load via `datasets`. The default
        adapter handles UltraChat / OpenAssistant / ShareGPT-style schemas; for
        anything else, pass `--text-field` to point at the raw text column.
    """
    if args.source_jsonl:
        path = Path(args.source_jsonl)
        if not path.exists():
            log.error("source jsonl %s does not exist", path)
            sys.exit(2)
        records: list[dict[str, Any]] = []
        with path.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                records.append(json.loads(line))
        return records
    if args.hf_dataset:
        try:
            from datasets import load_dataset  # noqa: PLC0415
        except ImportError:
            log.error("--hf-dataset requires the `datasets` package; install --extra train")
            sys.exit(2)
        ds = load_dataset(args.hf_dataset, split=args.hf_split)
        records = []
        for row in ds:
            if "messages" in row:
                records.append({"messages": row["messages"]})
            elif args.text_field and args.text_field in row:
                records.append({"text": row[args.text_field]})
            elif "text" in row:
                records.append({"text": row["text"]})
        return records
    log.error("must pass either --source-jsonl or --hf-dataset")
    sys.exit(2)


def _run_real(args: argparse.Namespace) -> int:
    if args.tier not in KNOWN_TIERS:
        log.error("unknown tier %s (expected one of %s)", args.tier, KNOWN_TIERS)
        return 2
    if not args.target_checkpoint:
        log.error("--target-checkpoint is required for a real run")
        return 2
    target_checkpoint = Path(args.target_checkpoint)
    if not target_checkpoint.exists():
        log.error("target checkpoint %s does not exist", target_checkpoint)
        return 2

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Imports here so --synthetic-smoke does not need transformers/datasets.
    from transformers import AutoTokenizer  # noqa: PLC0415

    log.info("loading target tokenizer from %s", target_checkpoint)
    tok = AutoTokenizer.from_pretrained(target_checkpoint)

    raw = _load_source_records(args)
    if args.max_samples:
        raw = raw[: args.max_samples]
    if not raw:
        log.error("source produced 0 records")
        return 2
    log.info("loaded %d source records", len(raw))

    records: list[dict[str, Any]] = []
    teacher_model = None
    if args.with_teacher_continuations:
        # Only import torch + the model when teacher mode is explicitly on.
        import torch  # noqa: PLC0415
        from transformers import AutoModelForCausalLM  # noqa: PLC0415

        log.info("loading target model for greedy teacher continuations")
        teacher_model = AutoModelForCausalLM.from_pretrained(
            target_checkpoint,
            torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        )
        if torch.cuda.is_available():
            teacher_model = teacher_model.to("cuda")
        teacher_model.eval()

    for i, rec in enumerate(raw):
        if "messages" in rec:
            text = tok.apply_chat_template(
                rec["messages"], tokenize=False, add_generation_prompt=False
            )
        elif "text" in rec:
            text = rec["text"]
        else:
            continue
        ids = tok(text, add_special_tokens=False, truncation=True, max_length=args.max_seq_len)[
            "input_ids"
        ]
        out_rec: dict[str, Any] = {"text": text, "input_ids": ids}
        if teacher_model is not None:
            # Run greedy teacher continuation from the prompt. This is the
            # highest-signal KD path (target's own next-token sequence). We
            # store the *token ids* the teacher emits; the trainer can either
            # use them directly or re-derive logits at training time.
            import torch  # noqa: PLC0415

            input_tensor = torch.tensor([ids], device=teacher_model.device)
            with torch.no_grad():
                gen = teacher_model.generate(
                    input_tensor,
                    max_new_tokens=args.teacher_continuation_tokens,
                    do_sample=False,
                    temperature=1.0,
                )
            out_rec["teacher_continuation_ids"] = gen[0].tolist()[len(ids) :]
        records.append(out_rec)
        if i % 1000 == 0 and i > 0:
            log.info("prepared %d/%d records", i, len(raw))

    out_path = out_dir / "distill.jsonl"
    _write_jsonl(records, out_path)
    manifest = {
        "schemaVersion": 1,
        "kind": "dflash-drafter-distill-dataset",
        "tier": args.tier,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": False,
        "source": (
            {"jsonl": str(Path(args.source_jsonl)), "sha256": _sha256_file(Path(args.source_jsonl))}
            if args.source_jsonl
            else {"hfDataset": args.hf_dataset, "split": args.hf_split}
        ),
        "targetCheckpoint": str(target_checkpoint),
        "targetTokenizerClass": tok.__class__.__name__,
        "vocabSize": len(tok.get_vocab()),
        "withTeacherContinuations": args.with_teacher_continuations,
        "maxSeqLen": args.max_seq_len,
        "examples": len(records),
        "datasetSha256": _sha256_file(out_path),
    }
    (out_dir / "dataset.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("wrote %s (%d records)", out_path, len(records))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--tier",
        required=True,
        choices=KNOWN_TIERS,
        help="Eliza-1 tier this corpus targets.",
    )
    p.add_argument(
        "--target-checkpoint",
        help="HF dir of the fine-tuned text model (used for tokenization).",
    )
    p.add_argument(
        "--source-jsonl",
        help="Local jsonl source corpus ({text} or {messages} per line).",
    )
    p.add_argument(
        "--hf-dataset",
        help="HF dataset id, e.g. HuggingFaceH4/ultrachat_200k.",
    )
    p.add_argument("--hf-split", default="train_sft", help="HF dataset split.")
    p.add_argument(
        "--text-field",
        help="HF dataset field holding raw text (when not `text`/`messages`).",
    )
    p.add_argument("--out-dir", required=True)
    p.add_argument("--max-seq-len", type=int, default=2048)
    p.add_argument("--max-samples", type=int, default=0, help="0 = all.")
    p.add_argument(
        "--with-teacher-continuations",
        action="store_true",
        help="Run greedy teacher generation per sample (GPU + slow). Off by default.",
    )
    p.add_argument(
        "--teacher-continuation-tokens",
        type=int,
        default=256,
        help="New tokens per teacher continuation.",
    )
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="No tokenizer, no model: emit deterministic dummy records.",
    )
    p.add_argument(
        "--synthetic-samples",
        type=int,
        default=100,
        help="Synthetic record count (only with --synthetic-smoke).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args)
    return _run_real(args)


if __name__ == "__main__":
    raise SystemExit(main())
