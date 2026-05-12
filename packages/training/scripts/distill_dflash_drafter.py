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
  - The recipe is the same across tiers; only the student size changes.
    Eliza-1 small tiers use Qwen3.5-compatible students: 0.8B for 2B/4B,
    2B for 9B, and 4B for 27B. Pick the smallest student whose verified
    acceptance window stays above the tier's gate.

Distillation objective: forward KL on the top-k target logits plus a small
cross-entropy floor on the ground-truth token (label smoothing keeps the
student from collapsing onto a single mode):

    loss = (1 - ce_weight) * T^2 * KL(softmax(z_t / T) || softmax(z_s / T))
         + ce_weight * CE(z_s, y)

Usage:

    # Smoke (no real models, no GPU): exercises the pipeline + metadata write
    uv run --extra train python scripts/distill_dflash_drafter.py \
        --tier 0_8b --synthetic-smoke --out-dir /tmp/dflash-smoke

    # Real run for the 0.8B-class drafter (serves the 2B tier)
    uv run --extra train python scripts/distill_dflash_drafter.py \
        --tier 2b \
        --target-checkpoint training/checkpoints/eliza-1-2b-text \
        --target-gguf out/eliza-1-2b/text/eliza-1-2b-32k.gguf \
        --student-base Qwen/Qwen3.5-0.8B \
        --dataset data/distill/eliza1-distill.jsonl \
        --epochs 1 --batch-size 8 --grad-accum 4 \
        --out-dir out/eliza-1-2b/dflash

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
import tempfile
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

# Recommended student base per tier. These defaults intentionally stay within
# the Qwen3.5/Qwen3.6 tokenizer family. The 0.8B tier has no smaller public
# Qwen3.5 student; its drafter is an aggressively quantized, KD-aligned
# self-size drafter and must pass the acceptance/speed gate before release.
DEFAULT_STUDENT_BASE: dict[str, str] = {
    "0_8b": "Qwen/Qwen3.5-0.8B",
    "2b": "Qwen/Qwen3.5-0.8B",
    "4b": "Qwen/Qwen3.5-0.8B",
    "9b": "Qwen/Qwen3.5-2B",
    "27b": "Qwen/Qwen3.5-4B",
    "27b-256k": "Qwen/Qwen3.5-4B",
    # 1M-context variant of the 27B tier: same student base as 27b/27b-256k.
    # The long-context K-cache rides the trellis path (turbo3_tcq); the
    # drafter itself is the same KD recipe.
    "27b-1m": "Qwen/Qwen3.5-4B",
}

# Canonical Eliza-1 text targets that each drafter is allowed to pair with.
# Local training usually passes a checkpoint directory, but release evidence
# should still record the canonical target model id so later bundle validation
# can distinguish "trained against a small-tier-ish directory" from "trained
# against the exact Eliza-1 target".
DEFAULT_TARGET_MODEL: dict[str, str] = {
    "0_8b": "elizaos/eliza-1-0_8b",
    "2b": "elizaos/eliza-1-2b",
    "4b": "elizaos/eliza-1-4b",
    "9b": "elizaos/eliza-1-9b",
    "27b": "elizaos/eliza-1-27b",
    "27b-256k": "elizaos/eliza-1-27b-256k",
    "27b-1m": "elizaos/eliza-1-27b-1m",
}

# Acceptance-rate gate per tier — the drafter is publish-blocking below this.
# These are the *baseline* targets; the eval harness records the measured
# acceptance window into `dflash/target-meta.json`. Tighten only with a
# rebaseline (see training/AGENTS.md §8).
ACCEPTANCE_GATE: dict[str, float] = {
    "0_8b": 0.40,
    "2b": 0.50,
    "4b": 0.52,
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


def _stable_json_sha256(value: Any) -> str:
    return _sha256_text(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    )


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(k): _jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_jsonable(v) for v in value]
        return str(value)


def _tokenizer_fingerprint(tokenizer: Any) -> dict[str, Any]:
    """Return a deterministic tokenizer identity record.

    ``get_vocab()`` equality is necessary but not sufficient for DFlash: two
    tokenizers can share token ids while disagreeing on added-token flags,
    special-token ids, chat templates, or normalization/pre-tokenization
    internals. Serializing the tokenizer to a temp directory lets fast
    tokenizers expose their exact tokenizer.json bytes; the structured fields
    make test fixtures and slow-tokenizer fallbacks deterministic.
    """
    with tempfile.TemporaryDirectory(prefix="dflash-tokenizer-") as tmp:
        tmp_dir = Path(tmp)
        tokenizer.save_pretrained(tmp_dir)
        file_hashes: dict[str, str] = {}
        for path in sorted(p for p in tmp_dir.rglob("*") if p.is_file()):
            rel = path.relative_to(tmp_dir).as_posix()
            file_hashes[rel] = _sha256_file(path)

    vocab = tokenizer.get_vocab()
    payload = {
        "class": tokenizer.__class__.__name__,
        "vocabSize": len(vocab),
        "vocabSha256": _stable_json_sha256(dict(sorted(vocab.items(), key=lambda kv: kv[1]))),
        "addedVocabSha256": _stable_json_sha256(
            dict(sorted(tokenizer.get_added_vocab().items()))
        ),
        "specialTokensMap": _jsonable(tokenizer.special_tokens_map),
        "allSpecialIds": _jsonable(list(tokenizer.all_special_ids)),
        "allSpecialTokens": _jsonable(list(tokenizer.all_special_tokens)),
        "chatTemplate": getattr(tokenizer, "chat_template", None),
        "files": file_hashes,
    }
    payload["sha256"] = _stable_json_sha256(payload)
    return payload


def _tokenizer_probe_encodings(tokenizer: Any) -> dict[str, list[int]]:
    probes = {
        "plain": "Eliza-1 DFlash tokenizer parity probe.",
        "unicode": "cafe naive jalapeno 你好 مرحبا",
        "tool_json": '{"tool":"calendar.create","args":{"when":"2026-05-12T09:00:00-07:00"}}',
        "chat_markers": "<|im_start|>user\nping<|im_end|>\n<|im_start|>assistant\n",
    }
    return {
        name: list(tokenizer(text, add_special_tokens=False)["input_ids"])
        for name, text in probes.items()
    }


def _tokenizer_parity_report(target_tokenizer: Any, student_tokenizer: Any) -> dict[str, Any]:
    target = _tokenizer_fingerprint(target_tokenizer)
    student = _tokenizer_fingerprint(student_tokenizer)
    target_probes = _tokenizer_probe_encodings(target_tokenizer)
    student_probes = _tokenizer_probe_encodings(student_tokenizer)
    return {
        "target": target,
        "student": student,
        "matches": target["sha256"] == student["sha256"]
        and target["vocabSha256"] == student["vocabSha256"]
        and target_probes == student_probes,
        "probeEncodingsMatch": target_probes == student_probes,
        "targetProbeEncodingsSha256": _stable_json_sha256(target_probes),
        "studentProbeEncodingsSha256": _stable_json_sha256(student_probes),
    }


def _resolve_student_base(args: argparse.Namespace) -> str | None:
    expected = DEFAULT_STUDENT_BASE.get(args.tier)
    student_base = args.student_base or expected
    if not student_base:
        log.error("no default student base for tier %s; pass --student-base", args.tier)
        return None
    if (
        expected is not None
        and student_base != expected
        and not args.allow_non_default_student_base
    ):
        log.error(
            "student base mismatch for tier %s: got %s, expected %s. "
            "DFlash distillation is fail-closed; pass "
            "--allow-non-default-student-base only for an intentional "
            "rebaseline with tokenizer-parity evidence.",
            args.tier,
            student_base,
            expected,
        )
        return None
    return student_base


def _resolve_target_model_id(args: argparse.Namespace) -> str | None:
    expected = DEFAULT_TARGET_MODEL.get(args.tier)
    target_model_id = args.target_model_id or expected
    if args.target_model_id and expected and args.target_model_id != expected:
        log.error(
            "target model mismatch for tier %s: got %s, expected %s",
            args.tier,
            args.target_model_id,
            expected,
        )
        return None
    return target_model_id


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
    """Locate the fork's convert_hf_to_gguf.py. Order: $MILADY_LLAMACPP_DIR /
    $LLAMA_CPP_DIR → the in-repo fork submodule (packages/inference/llama.cpp,
    the single canonical llama.cpp checkout) → the standalone clone at
    ~/.cache/eliza-dflash/eliza-llama-cpp."""
    candidates: list[Path] = []
    for var in ("MILADY_LLAMACPP_DIR", "LLAMA_CPP_DIR"):
        env = os.environ.get(var)
        if env:
            candidates.append(Path(env) / "convert_hf_to_gguf.py")
    for p in Path(__file__).resolve().parents:
        cand = p / "packages" / "inference" / "llama.cpp"
        if cand.is_dir():
            candidates.append(cand / "convert_hf_to_gguf.py")
            break
    candidates.append(
        Path.home() / ".cache" / "eliza-dflash" / "eliza-llama-cpp" / "convert_hf_to_gguf.py"
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
        target_model_id=DEFAULT_TARGET_MODEL.get(args.tier),
        target_checkpoint=None,
        target_gguf=None,
        target_sha256=fake_target_sha,
        tokenizer_parity=None,
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
    target_model_id: str | None,
    target_checkpoint: Path | None,
    target_gguf: Path | None,
    target_sha256: str,
    tokenizer_parity: dict[str, Any] | None,
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
        "expectedStudentBase": DEFAULT_STUDENT_BASE.get(args.tier),
        "targetModelId": target_model_id,
        "targetCheckpoint": str(target_checkpoint) if target_checkpoint else None,
        "targetGguf": str(target_gguf) if target_gguf else None,
        # The hash the drafter GGUF records and the publish gate checks.
        "targetCheckpointSha256": target_sha256,
        "tokenizerParity": tokenizer_parity,
        "targetTokenizerSha256": (
            tokenizer_parity["target"]["sha256"] if tokenizer_parity else None
        ),
        "studentTokenizerSha256": (
            tokenizer_parity["student"]["sha256"] if tokenizer_parity else None
        ),
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

    student_base = _resolve_student_base(args)
    if not student_base:
        return 3
    target_model_id = _resolve_target_model_id(args)
    if target_model_id is None:
        return 3

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
    tokenizer_parity = _tokenizer_parity_report(tgt_tok, stu_tok)
    if not tokenizer_parity["matches"]:
        log.error(
            "tokenizer mismatch: target (%s, sha256=%s) and student (%s, "
            "sha256=%s) are not byte-equivalent. Pick the exact Eliza-1 "
            "target/student pairing or rebaseline intentionally.",
            target_checkpoint,
            tokenizer_parity["target"]["sha256"],
            student_base,
            tokenizer_parity["student"]["sha256"],
        )
        return 3
    if args.verify_tokenizers_only:
        log.info(
            "tokenizer parity verified for tier=%s targetTokenizerSha256=%s "
            "studentTokenizerSha256=%s",
            args.tier,
            tokenizer_parity["target"]["sha256"],
            tokenizer_parity["student"]["sha256"],
        )
        return 0

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
        target_model_id=target_model_id,
        target_checkpoint=target_checkpoint,
        target_gguf=target_gguf,
        target_sha256=target_sha256,
        tokenizer_parity=tokenizer_parity,
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


def _run_verify_tokenizers_only(args: argparse.Namespace) -> int:
    if not args.target_checkpoint:
        log.error("--verify-tokenizers-only requires --target-checkpoint")
        return 2
    student_base = _resolve_student_base(args)
    if not student_base:
        return 3
    if _resolve_target_model_id(args) is None:
        return 3
    target_checkpoint = Path(args.target_checkpoint)
    if not target_checkpoint.exists():
        log.error("target checkpoint %s does not exist", target_checkpoint)
        return 2

    from transformers import AutoTokenizer  # noqa: PLC0415

    tgt_tok = AutoTokenizer.from_pretrained(target_checkpoint)
    stu_tok = AutoTokenizer.from_pretrained(student_base)
    parity = _tokenizer_parity_report(tgt_tok, stu_tok)
    print(json.dumps(parity, indent=2, sort_keys=True))
    if not parity["matches"]:
        log.error(
            "tokenizer mismatch: targetTokenizerSha256=%s "
            "studentTokenizerSha256=%s",
            parity["target"]["sha256"],
            parity["student"]["sha256"],
        )
        return 3
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
    p.add_argument(
        "--allow-non-default-student-base",
        action="store_true",
        help="Permit a non-default student base after an intentional rebaseline.",
    )
    p.add_argument(
        "--target-model-id",
        help="Canonical Eliza-1 target model id; defaults to the exact tier target.",
    )
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
    p.add_argument(
        "--verify-tokenizers-only",
        action="store_true",
        help="Load target/student tokenizers, emit hashes, and fail closed before training.",
    )
    p.add_argument("--drafter-gguf", help="For --stamp-only.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.stamp_only:
        return _run_stamp_only(args)
    if args.verify_tokenizers_only:
        return _run_verify_tokenizers_only(args)
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args)
    return _run_distillation(args)


if __name__ == "__main__":
    raise SystemExit(main())
