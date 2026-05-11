#!/usr/bin/env python3
"""Knowledge-distill a small DFlash drafter from an Eliza-1 text checkpoint.

Eliza-1 ships one DFlash drafter per tier (see inference/AGENTS.md §2). The
drafter is a small autoregressive model that proposes N tokens per step; the
target text model verifies them. Acceptance rate — and therefore the speed-up
— depends entirely on how closely the drafter's next-token distribution tracks
the target's. We do NOT train the drafter from scratch on raw text; we
knowledge-distill it from the *exact* text checkpoint it will ship with, so
its logits match the target's on the distributions that matter.

Hard contract (training/AGENTS.md §2 + §9):

  - The drafter and target MUST share a vocabulary. The student base is a
    Qwen3.x model from the same family as the text backbone; this script
    asserts the tokenizers are byte-identical before training.
  - The drafter GGUF MUST record `dflash-draft.target_checkpoint_sha256`:
    the sha256 of the final shipped text GGUF it was distilled to match.
    The publish path (and the runtime doctor) refuse a drafter whose
    recorded hash does not match the text GGUF in the same bundle.
  - The recipe is the same across tiers; only the student size changes
    (`drafter-0_6b.gguf` ≈ 0.15B, `drafter-1_7b.gguf` ≈ 0.6B,
    `drafter-9b.gguf` / `drafter-27b.gguf` ≈ 1.7B). Pick the smallest
    student whose verified acceptance window stays above the tier's gate.

Distillation objective: forward KL on the top-k target logits plus a small
cross-entropy floor on the ground-truth token (label smoothing keeps the
student from collapsing onto a single mode):

    loss = (1 - ce_weight) * T^2 * KL(softmax(z_t / T) || softmax(z_s / T))
         + ce_weight * CE(z_s, y)

Usage:

    # Smoke (no real models, no GPU): exercises the pipeline + metadata write
    uv run --extra train python scripts/distill_dflash_drafter.py \
        --tier 0_6b --synthetic-smoke --out-dir /tmp/dflash-smoke

    # Real run for the 0.6B-class drafter (serves the 1_7b tier)
    uv run --extra train python scripts/distill_dflash_drafter.py \
        --tier 1_7b \
        --target-checkpoint training/checkpoints/eliza-1-1_7b-text \
        --target-gguf out/eliza-1-1_7b/text/eliza-1-1_7b-32k.gguf \
        --student-base Qwen/Qwen3-0.6B \
        --dataset data/distill/eliza1-distill.jsonl \
        --epochs 1 --batch-size 8 --grad-accum 4 \
        --out-dir out/eliza-1-1_7b/dflash

The script writes <out-dir>/drafter-<tier>.gguf and a run manifest
<out-dir>/drafter-<tier>.distill.json recording dataset hashes, the student
base, hyperparameters, the target checkpoint hash, and the training commit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("distill_dflash_drafter")

# sha256 → GGUF metadata key the runtime + publish gate read. Keep this in
# sync with `_GGUF_DRAFTER_TARGET_CHECKPOINT_KEY` in
# scripts/manifest/stage_local_eliza1_bundle.py and the doctor's reader.
GGUF_TARGET_CHECKPOINT_KEY = "dflash-draft.target_checkpoint_sha256"

# Recommended student base per tier. The 0_6b and 1_7b tiers both draft for
# a small target, so the drafter must be a fraction of the target's size to
# pay for itself; the 9b/27b tiers can afford a bigger, more accurate drafter.
DEFAULT_STUDENT_BASE: dict[str, str] = {
    "0_6b": "Qwen/Qwen3-0.6B",  # quantized to ~0.15GB after TurboQuant Q3
    "1_7b": "Qwen/Qwen3-0.6B",
    "9b": "Qwen/Qwen3-1.7B",
    "27b": "Qwen/Qwen3-1.7B",
    "27b-256k": "Qwen/Qwen3-1.7B",
    # 1M-context variant of the 27B tier: same student base as 27b/27b-256k.
    # The long-context K-cache rides the trellis path (turbo3_tcq); the
    # drafter itself is the same KD recipe.
    "27b-1m": "Qwen/Qwen3-1.7B",
}

# Acceptance-rate gate per tier — the drafter is publish-blocking below this.
# These are the *baseline* targets; the eval harness records the measured
# acceptance window into `dflash/target-meta.json`. Tighten only with a
# rebaseline (see training/AGENTS.md §8).
ACCEPTANCE_GATE: dict[str, float] = {
    "0_6b": 0.45,
    "1_7b": 0.50,
    "9b": 0.55,
    "27b": 0.55,
    "27b-256k": 0.55,
    "27b-1m": 0.55,
}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


def _find_convert_script() -> Path | None:
    """Locate the fork's convert_hf_to_gguf.py. The dflash fork checkout
    lives at ~/.cache/eliza-dflash/milady-llama-cpp by default; allow an
    override via MILADY_LLAMACPP_DIR."""
    candidates = []
    env = os.environ.get("MILADY_LLAMACPP_DIR")
    if env:
        candidates.append(Path(env) / "convert_hf_to_gguf.py")
    candidates.append(
        Path.home()
        / ".cache"
        / "eliza-dflash"
        / "milady-llama-cpp"
        / "convert_hf_to_gguf.py"
    )
    for c in candidates:
        if c.exists():
            return c
    return None


def _write_gguf_target_hash(gguf_path: Path, target_sha256: str) -> None:
    """Rewrite the drafter GGUF in place to add the
    `dflash-draft.target_checkpoint_sha256` metadata string. Uses gguf-py's
    new-metadata writer so no tensor data is touched."""
    import gguf  # type: ignore
    from gguf.scripts.gguf_new_metadata import (  # type: ignore
        MetadataDetails,
        copy_with_new_metadata,
    )

    reader = gguf.GGUFReader(str(gguf_path), "r")
    arch_field = reader.fields.get(gguf.Keys.General.ARCHITECTURE)
    arch = (
        str(arch_field.parts[arch_field.data[0]].tobytes().decode("utf-8"))
        if arch_field is not None
        else "qwen3"
    )
    tmp_path = gguf_path.with_suffix(".with-target-hash.gguf")
    writer = gguf.GGUFWriter(str(tmp_path), arch=arch, endianess=reader.endianess)
    copy_with_new_metadata(
        reader,
        writer,
        {
            GGUF_TARGET_CHECKPOINT_KEY: MetadataDetails(
                gguf.GGUFValueType.STRING, target_sha256
            )
        },
        [],
    )
    del reader
    tmp_path.replace(gguf_path)
    log.info("recorded %s=%s into %s", GGUF_TARGET_CHECKPOINT_KEY, target_sha256, gguf_path)


def _dataset_hash(dataset_path: Path) -> str:
    return _sha256_file(dataset_path)


# --------------------------------------------------------------------------
# Synthetic smoke: no torch, no real models. Validates the pipeline shape and
# the GGUF metadata write so CI can exercise it without weights.
# --------------------------------------------------------------------------
def _run_synthetic_smoke(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    drafter_path = out_dir / f"drafter-{args.tier}.gguf"
    # A minimal but real GGUF so the metadata writer + the runtime smoke can
    # both read it.
    try:
        import gguf  # type: ignore
    except ImportError:
        log.error("synthetic smoke needs the `gguf` package (uv --extra train)")
        return 1
    writer = gguf.GGUFWriter(str(drafter_path), arch="qwen3")
    writer.add_name(f"eliza-1-{args.tier}-drafter-synthetic")
    fake_target_sha = _sha256_text(f"synthetic-target-{args.tier}")
    writer.add_string(GGUF_TARGET_CHECKPOINT_KEY, fake_target_sha)
    # one tiny tensor so the file is well-formed
    import numpy as np  # noqa: PLC0415

    writer.add_tensor("token_embd.weight", np.zeros((4, 4), dtype=np.float16))
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    manifest = _build_manifest(
        args=args,
        student_base="<synthetic>",
        target_checkpoint=None,
        target_gguf=None,
        target_sha256=fake_target_sha,
        dataset_hash="<synthetic>",
        n_train_examples=0,
        final_kl=None,
        gate=ACCEPTANCE_GATE.get(args.tier),
        synthetic=True,
    )
    manifest_path = out_dir / f"drafter-{args.tier}.distill.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("synthetic smoke wrote %s and %s", drafter_path, manifest_path)
    return 0


def _build_manifest(
    *,
    args: argparse.Namespace,
    student_base: str,
    target_checkpoint: Path | None,
    target_gguf: Path | None,
    target_sha256: str,
    dataset_hash: str,
    n_train_examples: int,
    final_kl: float | None,
    gate: float | None,
    synthetic: bool,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "kind": "dflash-drafter-distillation",
        "tier": args.tier,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": synthetic,
        "studentBase": student_base,
        "targetCheckpoint": str(target_checkpoint) if target_checkpoint else None,
        "targetGguf": str(target_gguf) if target_gguf else None,
        # The hash the drafter GGUF records and the publish gate checks.
        "targetCheckpointSha256": target_sha256,
        "dataset": {
            "path": str(Path(args.dataset)) if args.dataset else None,
            "sha256": dataset_hash,
            "examples": n_train_examples,
        },
        "hyperparameters": {
            "epochs": args.epochs,
            "batchSize": args.batch_size,
            "gradAccum": args.grad_accum,
            "lr": args.lr,
            "temperature": args.temperature,
            "ceWeight": args.ce_weight,
            "topKLogits": args.top_k_logits,
            "maxSeqLen": args.max_seq_len,
        },
        "acceptanceGate": gate,
        "finalDistillKl": final_kl,
        "trainingCommit": _git_commit(),
        "notes": (
            "Acceptance window is measured by the eval harness against the "
            "shipped target and written into dflash/target-meta.json. This "
            "manifest only records what the distillation run produced."
        ),
    }


# --------------------------------------------------------------------------
# Real distillation
# --------------------------------------------------------------------------
def _run_distillation(args: argparse.Namespace) -> int:
    if not args.target_checkpoint:
        log.error("--target-checkpoint is required for a real run")
        return 2
    if not args.dataset:
        log.error("--dataset is required for a real run")
        return 2
    target_checkpoint = Path(args.target_checkpoint)
    dataset_path = Path(args.dataset)
    if not target_checkpoint.exists():
        log.error("target checkpoint %s does not exist", target_checkpoint)
        return 2
    if not dataset_path.exists():
        log.error("dataset %s does not exist", dataset_path)
        return 2
    target_gguf = Path(args.target_gguf) if args.target_gguf else None
    if target_gguf is not None and not target_gguf.exists():
        log.error("--target-gguf %s does not exist", target_gguf)
        return 2

    student_base = args.student_base or DEFAULT_STUDENT_BASE.get(args.tier)
    if not student_base:
        log.error("no default student base for tier %s; pass --student-base", args.tier)
        return 2

    # The target checkpoint hash the drafter records. Prefer the final
    # shipped text GGUF's sha256 (what dflash/target-meta.json uses); fall
    # back to a deterministic hash of the HF checkpoint's safetensors index.
    if target_gguf is not None:
        target_sha256 = _sha256_file(target_gguf)
    else:
        index = target_checkpoint / "model.safetensors.index.json"
        single = target_checkpoint / "model.safetensors"
        if index.exists():
            target_sha256 = _sha256_file(index)
        elif single.exists():
            target_sha256 = _sha256_file(single)
        else:
            log.error(
                "cannot derive a target checkpoint hash: pass --target-gguf "
                "or ensure %s has model.safetensors[.index.json]",
                target_checkpoint,
            )
            return 2

    import torch  # noqa: PLC0415
    from torch.nn import functional as F  # noqa: PLC0415
    from torch.utils.data import DataLoader  # noqa: PLC0415
    from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: PLC0415

    log.info("loading target tokenizer + model from %s", target_checkpoint)
    tgt_tok = AutoTokenizer.from_pretrained(target_checkpoint)
    log.info("loading student base %s", student_base)
    stu_tok = AutoTokenizer.from_pretrained(student_base)

    # Vocab parity is non-negotiable — speculative decode rejects every
    # drafted token if the two tokenizers disagree (dflash-doctor enforces
    # the catalog-level version of this check).
    if tgt_tok.get_vocab() != stu_tok.get_vocab():
        log.error(
            "tokenizer mismatch: target (%s) and student (%s) do not share a "
            "vocabulary. Pick a student from the same Qwen family as the text "
            "backbone.",
            target_checkpoint,
            student_base,
        )
        return 3

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    target = AutoModelForCausalLM.from_pretrained(
        target_checkpoint, torch_dtype=dtype
    ).to(device)
    target.eval()
    for p in target.parameters():
        p.requires_grad_(False)
    student = AutoModelForCausalLM.from_pretrained(
        student_base, torch_dtype=torch.float32
    ).to(device)
    student.train()

    # Distillation corpus: jsonl with a `text` field (or chat `messages`
    # rendered via the target's chat template). We only need the token
    # sequences the *target* generates over, so this is the same prompt
    # distribution the text model was fine-tuned on — reuse the SFT corpus.
    examples: list[str] = []
    with dataset_path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if "text" in rec and isinstance(rec["text"], str):
                examples.append(rec["text"])
            elif "messages" in rec:
                examples.append(
                    tgt_tok.apply_chat_template(
                        rec["messages"], tokenize=False, add_generation_prompt=False
                    )
                )
    if args.max_samples:
        examples = examples[: args.max_samples]
    if not examples:
        log.error("dataset %s produced 0 usable examples", dataset_path)
        return 2
    log.info("distilling over %d examples", len(examples))

    def collate(batch: list[str]) -> dict[str, torch.Tensor]:
        enc = tgt_tok(
            batch,
            return_tensors="pt",
            padding="max_length",
            truncation=True,
            max_length=args.max_seq_len,
        )
        return {k: v.to(device) for k, v in enc.items()}

    loader = DataLoader(
        examples, batch_size=args.batch_size, shuffle=True, collate_fn=collate
    )
    opt = torch.optim.AdamW(student.parameters(), lr=args.lr)
    temperature = args.temperature
    ce_weight = args.ce_weight
    top_k = args.top_k_logits
    final_kl: float | None = None

    step = 0
    for epoch in range(args.epochs):
        for batch in loader:
            input_ids = batch["input_ids"]
            attn = batch["attention_mask"]
            with torch.no_grad():
                tgt_logits = target(input_ids=input_ids, attention_mask=attn).logits
            stu_logits = student(input_ids=input_ids, attention_mask=attn).logits
            # Shift for next-token prediction.
            tgt_logits = tgt_logits[:, :-1, :]
            stu_logits = stu_logits[:, :-1, :]
            labels = input_ids[:, 1:]
            mask = attn[:, 1:].bool()

            # Top-k KD: restrict the KL to the target's top-k tokens so the
            # student spends capacity where it matters for acceptance.
            topk = torch.topk(tgt_logits, k=min(top_k, tgt_logits.size(-1)), dim=-1)
            tgt_logp = F.log_softmax(topk.values / temperature, dim=-1)
            stu_gathered = torch.gather(stu_logits, -1, topk.indices)
            stu_logp = F.log_softmax(stu_gathered / temperature, dim=-1)
            kl = F.kl_div(stu_logp, tgt_logp, reduction="none", log_target=True).sum(-1)
            kl = (kl * mask).sum() / mask.sum().clamp_min(1)

            ce = F.cross_entropy(
                stu_logits.reshape(-1, stu_logits.size(-1)),
                labels.reshape(-1),
                reduction="none",
            ).reshape(labels.shape)
            ce = (ce * mask).sum() / mask.sum().clamp_min(1)

            loss = (1.0 - ce_weight) * (temperature**2) * kl + ce_weight * ce
            loss = loss / args.grad_accum
            loss.backward()
            if (step + 1) % args.grad_accum == 0:
                torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
                opt.step()
                opt.zero_grad()
            final_kl = float(kl.detach().cpu())
            if step % args.log_every == 0:
                log.info(
                    "epoch=%d step=%d loss=%.4f kl=%.4f ce=%.4f",
                    epoch,
                    step,
                    float(loss.detach().cpu()) * args.grad_accum,
                    final_kl,
                    float(ce.detach().cpu()),
                )
            step += 1

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    hf_out = out_dir / f"drafter-{args.tier}-hf"
    student.save_pretrained(hf_out)
    stu_tok.save_pretrained(hf_out)
    log.info("saved distilled student to %s", hf_out)

    # Convert to GGUF via the fork's converter, then stamp the target hash.
    convert = _find_convert_script()
    drafter_gguf = out_dir / f"drafter-{args.tier}.gguf"
    if convert is None:
        log.warning(
            "convert_hf_to_gguf.py not found (set MILADY_LLAMACPP_DIR). "
            "Skipping GGUF conversion — run it manually then re-run with "
            "--stamp-only --drafter-gguf %s --target-gguf <text gguf>.",
            drafter_gguf,
        )
    else:
        subprocess.run(
            [
                sys.executable,
                str(convert),
                str(hf_out),
                "--outfile",
                str(drafter_gguf),
                "--outtype",
                args.gguf_outtype,
            ],
            check=True,
        )
        _write_gguf_target_hash(drafter_gguf, target_sha256)

    manifest = _build_manifest(
        args=args,
        student_base=student_base,
        target_checkpoint=target_checkpoint,
        target_gguf=target_gguf,
        target_sha256=target_sha256,
        dataset_hash=_dataset_hash(dataset_path),
        n_train_examples=len(examples),
        final_kl=final_kl,
        gate=ACCEPTANCE_GATE.get(args.tier),
        synthetic=False,
    )
    manifest_path = out_dir / f"drafter-{args.tier}.distill.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("wrote distillation manifest %s", manifest_path)
    log.info(
        "NEXT: run the eval harness against the shipped target to measure the "
        "acceptance window and write it into dflash/target-meta.json; the "
        "publish gate blocks below acceptanceGate=%s.",
        ACCEPTANCE_GATE.get(args.tier),
    )
    return 0


def _run_stamp_only(args: argparse.Namespace) -> int:
    if not args.drafter_gguf or not args.target_gguf:
        log.error("--stamp-only requires --drafter-gguf and --target-gguf")
        return 2
    drafter_gguf = Path(args.drafter_gguf)
    target_gguf = Path(args.target_gguf)
    if not drafter_gguf.exists() or not target_gguf.exists():
        log.error("drafter or target GGUF missing")
        return 2
    _write_gguf_target_hash(drafter_gguf, _sha256_file(target_gguf))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--tier",
        required=True,
        choices=sorted(DEFAULT_STUDENT_BASE.keys()),
        help="Eliza-1 tier this drafter ships with.",
    )
    p.add_argument("--target-checkpoint", help="HF dir of the fine-tuned text model.")
    p.add_argument(
        "--target-gguf",
        help="Final shipped text GGUF; its sha256 is recorded in the drafter.",
    )
    p.add_argument("--student-base", help="HF id/dir of the small student base.")
    p.add_argument("--dataset", help="jsonl distillation corpus (text or messages).")
    p.add_argument("--out-dir", required=True)
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--grad-accum", type=int, default=4)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument(
        "--ce-weight",
        type=float,
        default=0.1,
        help="Weight of the ground-truth CE floor vs. the KD KL term.",
    )
    p.add_argument("--top-k-logits", type=int, default=64)
    p.add_argument("--max-seq-len", type=int, default=2048)
    p.add_argument("--max-samples", type=int, default=0, help="0 = all.")
    p.add_argument("--log-every", type=int, default=20)
    p.add_argument("--gguf-outtype", default="f16")
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="No torch/models: validate the pipeline + GGUF metadata write.",
    )
    p.add_argument(
        "--stamp-only",
        action="store_true",
        help="Just write dflash-draft.target_checkpoint_sha256 into an "
        "existing drafter GGUF (needs --drafter-gguf + --target-gguf).",
    )
    p.add_argument("--drafter-gguf", help="For --stamp-only.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.stamp_only:
        return _run_stamp_only(args)
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args)
    return _run_distillation(args)


if __name__ == "__main__":
    raise SystemExit(main())
