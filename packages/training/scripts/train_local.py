"""Local SFT on a Qwen3 dense base model using TRL + APOLLO.

Single-GPU, bf16, completion-only loss (only the assistant turn contributes
to the loss). Checkpoints land under `training/checkpoints/<run_name>/`.

The base model is resolved from `--registry-key` (see
`training/model_registry.py`); pass `--model <hf-id>` to override. With no
registry key the default is `Qwen/Qwen3-0.6B` — the smallest published
eliza-1 target.

Usage:
    # Smoke test on the smallest eliza-1 tier
    uv run --extra train python scripts/train_local.py \
        --registry-key qwen3-0.6b \
        --max-samples 256 --epochs 1 --run-name eliza-1-0_6b-smoke

    # Real run
    uv run --extra train python scripts/train_local.py \
        --registry-key qwen3-0.6b \
        --epochs 3 --batch-size 4 --grad-accum 8 \
        --run-name eliza-1-0_6b-eliza-native-v1
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from format_for_training import format_record  # noqa: E402
from lib.attn import select_attn_impl  # noqa: E402


def _split_named(
    model: Any, lowrank_names: set[str],
) -> tuple[list[Any], list[Any]]:
    """Walk model.named_parameters() and route by name suffix.

    Used when FSDP1 has wrapped the model into FlatParameters; the
    name (without `_fsdp_wrapped_module.` prefixes) still uniquely
    identifies the original parameter, so we can re-route to APOLLO's
    lowrank vs other groups even though `p.dim()` returns 1.
    """
    lowrank: list[Any] = []
    other: list[Any] = []
    for name, p in model.named_parameters():
        if not p.requires_grad:
            continue
        # Strip FSDP wrapper-prefixes so name matches what we classified
        # against the unwrapped HF model.
        clean = name.replace("_fsdp_wrapped_module.", "")
        if clean in lowrank_names:
            lowrank.append(p)
        else:
            other.append(p)
    return lowrank, other

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("train")


def _triton_runtime_ok() -> bool:
    """True iff Triton can initialize its CUDA backend (it JIT-compiles a small
    `cuda_utils.c` against the interpreter's Python.h + a CUDA toolkit; missing
    `python3.x-dev` headers or a stale toolkit makes that fail at the *first*
    Triton kernel launch). Probed up front so Liger/fused-quant paths fall back
    cleanly instead of crashing mid-run."""
    try:
        from triton.runtime import driver  # type: ignore
        driver.active.get_current_device()
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("Triton runtime probe failed: %s", e)
        return False


def load_jsonl(path: Path, *, max_n: int | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
            if max_n and len(out) >= max_n:
                break
    return out


def _record_shape(record: dict[str, Any]) -> str:
    if record.get("format") == "eliza_native_v1":
        return "eliza_native_v1"
    if record.get("schema") == "eliza.eliza1_trajectory_record.v1":
        return "eliza1_trajectory_record"
    if isinstance(record.get("messages"), list):
        return "chat_messages"
    legacy_fields = {
        "roomName",
        "agentId",
        "memoryEntries",
        "currentMessage",
        "expectedResponse",
        "availableActions",
        "metadata",
    }
    if legacy_fields <= set(record):
        return "legacy_eliza_record"
    return "unknown"


def build_dataset(
    records: list[dict[str, Any]],
    tokenizer: Any,
    *,
    split_name: str,
    max_chars: int | None = None,
) -> Any:
    formatted = []
    skipped = Counter()
    for record in records:
        row = format_record(record)
        if row:
            formatted.append(row)
        else:
            skipped[_record_shape(record)] += 1
    log.info("formatted %s %d/%d records", split_name, len(formatted), len(records))
    if not formatted:
        seen = ", ".join(f"{name}={count}" for name, count in sorted(skipped.items()))
        raise ValueError(
            f"{split_name} split has {len(records)} JSONL record(s), but none "
            "are train_local-compatible after formatting"
            + (f" (seen: {seen})" if seen else "")
            + ". Accepted shapes: eliza_native_v1, trainable "
            "eliza.eliza1_trajectory_record.v1/messages rows, and legacy "
            "flat ElizaRecord rows. repair_eval/failed rows are rejected."
        )
    from datasets import Dataset

    def render(example):
        kwargs = {
            "conversation": example["messages"],
            "tokenize": False,
            "add_generation_prompt": False,
        }
        if "tools" in example and example["tools"] is not None:
            kwargs["tools"] = example["tools"]
        try:
            text = tokenizer.apply_chat_template(**kwargs)
        except TypeError:
            kwargs.pop("tools", None)
            text = tokenizer.apply_chat_template(**kwargs)
        return {"text": text}

    ds = Dataset.from_list(formatted)
    ds = ds.map(render, remove_columns=list(ds.column_names))
    if max_chars:
        before = len(ds)
        ds = ds.filter(lambda ex: len(ex["text"]) <= max_chars)
        log.info("char-filter %d → %d (max_chars=%d)", before, len(ds), max_chars)
        if len(ds) == 0:
            raise ValueError(
                f"{split_name} split has no rows left after --max-chars={max_chars}; "
                "raise the limit or inspect oversized records."
            )
    return ds


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--train-file", default=str(ROOT / "data" / "final" / "train.jsonl"))
    ap.add_argument("--val-file", default=str(ROOT / "data" / "final" / "val.jsonl"))
    ap.add_argument("--out-dir", default=str(ROOT / "checkpoints"))
    ap.add_argument("--run-name", default="qwen35-eliza-native")
    ap.add_argument("--max-samples", type=int, default=0)
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--batch-size", type=int, default=4)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument(
        "--max-seq-len", type=int, default=4096,
        help="Training sequence length. When `--registry-key` is set and the "
             "user did not pass `--max-seq-len`, the registry's `seq_len` "
             "default is used (e.g. 8k for 2B, 16k for 9B, 64k for 27B). "
             "Pass `--max-seq-len <N>` to override the registry default for "
             "a single run — useful for long-context experiments on the 27B "
             "(validate VRAM with `memory_calc.py --shape qwen3.6-27b` first)."
    )
    ap.add_argument("--lora-r", type=int, default=32)
    ap.add_argument("--lora-alpha", type=int, default=64)
    ap.add_argument("--lora-dropout", type=float, default=0.05)
    ap.add_argument("--full-finetune", action="store_true",
                    help="skip LoRA — full-parameter SFT")
    ap.add_argument("--qlora", action="store_true",
                    help="disabled; this entrypoint is full-parameter APOLLO only")
    ap.add_argument(
        "--optimizer",
        choices=["apollo", "apollo_mini"],
        default="apollo",
        help="optimizer to use. This local training entrypoint is APOLLO-only.",
    )
    ap.add_argument("--apollo-rank", type=int, default=256)
    ap.add_argument("--apollo-scale", type=float, default=1.0)
    ap.add_argument("--apollo-update-proj-gap", type=int, default=200)
    ap.add_argument(
        "--max-chars", type=int, default=0,
        help="Drop training records whose rendered chat-template text is "
             "longer than this many characters. 0 = no filter. Recommended "
             "to use ~3.0 * max_seq_len at the local tier for long native "
             "trajectory rows.",
    )
    ap.add_argument(
        "--use-liger", default="auto", choices=("auto", "on", "off"),
        help="Apply Liger fused chunked-CE + RMSNorm/SwiGLU/RoPE kernels. "
             "Cuts the fp32-logits transient ~4–8× (Qwen vocab=248k makes "
             "this dominant) so we can train at 8k–16k seq_len on the same "
             "VRAM. Default `auto` = on when the registry entry says so or "
             "when no registry key is set.",
    )
    ap.add_argument(
        "--registry-key", default=None,
        help="Pull defaults from training/model_registry.py (e.g. qwen3.5-2b). "
             "CLI flags override registry values."
    )
    ap.add_argument(
        "--memory-budget-gb", type=float, default=None,
        help="Override registry memory budget. Run dies if reserved memory "
             "exceeds budget*1.10. Default: registry value or no enforcement."
    )
    args = ap.parse_args()

    from training.model_registry import get as _registry_get  # noqa: E402
    if args.registry_key:
        entry = _registry_get(args.registry_key)
        if (
            entry.unverified_base
            and args.model == ap.get_default("model")
            and os.environ.get("MILADY_ALLOW_UNVERIFIED_BASE") != "1"
        ):
            raise SystemExit(
                f"--registry-key {args.registry_key!r} → hf_id {entry.hf_id!r} "
                "is an UNVERIFIED placeholder with no published checkpoint as of "
                "2026-05; loading it will fail. Use a real key "
                "(qwen3-0.6b / qwen3-1.7b / qwen3-4b → eliza-1-0_6b / eliza-1-1_7b / "
                "eliza-1-4b), pass an explicit --model <real-hf-id>, or set "
                "MILADY_ALLOW_UNVERIFIED_BASE=1 to override."
            )
        if args.model == ap.get_default("model"):
            args.model = entry.hf_id
        if args.batch_size == ap.get_default("batch_size"):
            args.batch_size = entry.micro_batch
        if args.grad_accum == ap.get_default("grad_accum"):
            args.grad_accum = entry.grad_accum
        if args.max_seq_len == ap.get_default("max_seq_len"):
            args.max_seq_len = entry.seq_len
        if args.optimizer == ap.get_default("optimizer"):
            args.optimizer = entry.optimizer
        if args.apollo_rank == ap.get_default("apollo_rank"):
            args.apollo_rank = entry.optimizer_rank
        if args.memory_budget_gb is None:
            args.memory_budget_gb = entry.train_mem_gb_budget
        log.info("registry %s → model=%s batch=%d accum=%d seq=%d optimizer=%s budget=%.0fGB",
                 entry.short_name, args.model, args.batch_size, args.grad_accum,
                 args.max_seq_len, args.optimizer, args.memory_budget_gb or 0)

    if not args.full_finetune:
        log.warning(
            "--optimizer=%s is intended for full-parameter fine-tuning; "
            "auto-enabling --full-finetune",
            args.optimizer,
        )
        args.full_finetune = True
    if args.qlora:
        raise SystemExit(
            "QLoRA is disabled in the APOLLO-only local training pipeline. "
            "Use full-parameter APOLLO fine-tuning."
        )

    import torch
    from peft import LoraConfig, prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("device=%s torch=%s model=%s", device, torch.__version__, args.model)
    if device == "cpu":
        log.warning("no GPU detected — training will be very slow")

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.truncation_side = "left"

    train_recs = load_jsonl(
        Path(args.train_file),
        max_n=args.max_samples or None,
    )
    val_recs = load_jsonl(
        Path(args.val_file),
        max_n=max(1, args.max_samples // 10) if args.max_samples else None,
    )
    if not train_recs:
        log.error("no training records — run pack_dataset.py first")
        return 1

    max_chars = args.max_chars or None
    try:
        train_ds = build_dataset(
            train_recs,
            tokenizer,
            split_name="train",
            max_chars=max_chars,
        )
        val_ds = (
            build_dataset(
                val_recs,
                tokenizer,
                split_name="validation",
                max_chars=max_chars,
            )
            if val_recs
            else None
        )
    except ValueError as exc:
        log.error("%s", exc)
        return 1

    log.info("loading model %s qlora=%s", args.model, args.qlora)
    quant_cfg = None
    if args.qlora and device == "cuda":
        quant_cfg = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
    attn_impl = select_attn_impl(device)
    # device_map='auto' is incompatible with FSDP / DDP — accelerate's
    # `prepare()` rejects models that already have a device map. When we
    # launch under `accelerate launch` (RANK env set), every rank loads
    # to CPU with low_cpu_mem_usage=True; the FSDP launcher's
    # `cpu_ram_efficient_loading=True` plus `sync_module_states=True` keeps
    # peak host RAM low. (Each rank still allocates the full ~50 GB of
    # weights on CPU then they get sharded — this 503 GB Vast instance
    # has plenty.) Without this, each rank would push the full 27B to
    # its own GPU before FSDP shards, OOMing at ~95 GB / 96 GB.
    in_distributed = "RANK" in os.environ
    use_device_map = device == "cuda" and not in_distributed
    model_kwargs = dict(
        torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
        attn_implementation=attn_impl,
    )
    if quant_cfg is not None:
        model_kwargs["quantization_config"] = quant_cfg
    if use_device_map:
        model_kwargs["device_map"] = "auto"
    log.info("loading model (in_distributed=%s)", in_distributed)
    model = AutoModelForCausalLM.from_pretrained(args.model, **model_kwargs)

    # Apply Liger kernel patches before any forward pass so the chunked
    # cross-entropy + fused RMSNorm/SwiGLU/RoPE replace the HF defaults.
    # This is what makes the longer training seq_lens (8k–16k locally,
    # 16k+ on cloud) actually fit in VRAM.
    use_liger = args.use_liger == "on" or (
        args.use_liger == "auto"
        and (args.registry_key is None
             or getattr(_registry_get(args.registry_key), "use_liger", True))
    )
    if use_liger and device == "cuda" and not _triton_runtime_ok():
        # Liger is Triton kernels; if Triton can't JIT-compile its CUDA driver
        # helper (e.g. missing python3.x-dev headers, mismatched CUDA toolkit)
        # it dies at the *first* training step, not at apply time. Probe up
        # front and fall back rather than crash 8 minutes into the run.
        msg = ("Triton runtime probe failed — Liger kernel disabled, falling "
               "back to HF defaults. Fix: install the Python dev headers for "
               "this interpreter (apt install python3.x-dev) and a CUDA "
               "toolkit Triton can use, or run with --use-liger off.")
        if args.use_liger == "on":
            log.warning("--use-liger=on requested but %s", msg)
        else:
            log.warning(msg)
        use_liger = False
    if use_liger and device == "cuda":
        try:
            from liger_kernel.transformers import _apply_liger_kernel_to_instance
        except ImportError:
            if args.use_liger == "on":
                raise SystemExit(
                    "--use-liger=on requested but liger-kernel is not installed. "
                    "Install with: uv add --extra train liger-kernel"
                )
            log.warning(
                "liger-kernel not installed — falling back to HF defaults. "
                "Install with: uv add --extra train liger-kernel"
            )
        else:
            _apply_liger_kernel_to_instance(model=model)
            # FLCE chunk_size = 2^ceil(log2(B*T / (V/H))). For Qwen3.5/3.6
            # H≈2048-5120 / V=248k → V/H≈48-120; B=1, T=16k -> chunk≈512.
            # Liger paper §5.3 reports +25% throughput + 20% lower peak mem
            # on the FLCE step vs the default auto-pick at our shape.
            loss_fn = getattr(model, "loss_function", None)
            if loss_fn is not None and hasattr(loss_fn, "chunk_size"):
                loss_fn.chunk_size = 512
                log.info("Liger FLCE chunk_size set to 512 for our (B,T,V,H) shape")
            log.info("Liger kernel applied (fused CE + RMSNorm + SwiGLU + RoPE)")
    model.config.use_cache = False
    if quant_cfg is not None:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    elif hasattr(model, "gradient_checkpointing_enable"):
        # Selective activation checkpointing: skip every Nth layer so we trade
        # ~5% peak memory for ~10% throughput vs uniform full-block AC. Set
        # MILADY_AC_EVERY=1 (default) for uniform; 2 for "checkpoint every other
        # layer"; 0 to disable AC entirely. PyTorch FSDP blog confirms the win.
        ac_every = int(os.environ.get("MILADY_AC_EVERY", "1"))
        if ac_every <= 0:
            log.info("activation checkpointing DISABLED (MILADY_AC_EVERY=0)")
        else:
            model.gradient_checkpointing_enable(
                gradient_checkpointing_kwargs={"use_reentrant": False},
            )
            if ac_every > 1:
                # Re-walk and disable AC on layers we want to keep alive.
                layers = None
                for path in (("model", "layers"), ("model", "model", "layers")):
                    obj = model
                    ok = True
                    for a in path:
                        obj = getattr(obj, a, None)
                        if obj is None:
                            ok = False
                            break
                    if ok:
                        layers = obj
                        break
                if layers is not None:
                    kept = 0
                    for i, layer in enumerate(layers):
                        if i % ac_every != 0 and hasattr(layer, "gradient_checkpointing"):
                            layer.gradient_checkpointing = False
                            kept += 1
                    log.info(
                        "selective AC: checkpoint every %d layer; %d/%d layers running without AC",
                        ac_every, kept, len(layers),
                    )

    peft_cfg = None
    if not args.full_finetune:
        peft_cfg = LoraConfig(
            r=args.lora_r,
            lora_alpha=args.lora_alpha,
            lora_dropout=args.lora_dropout,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=[
                "q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj",
            ],
        )

    out_dir = Path(args.out_dir) / args.run_name
    out_dir.mkdir(parents=True, exist_ok=True)

    if os.environ.get("MILADY_TRAINER_OPTIM"):
        raise SystemExit(
            "MILADY_TRAINER_OPTIM is disabled. This entrypoint always builds "
            "APOLLO/APOLLO-Mini through the trainer create_optimizer hook."
        )

    # SFTConfig still requires a supported `optim` enum even though the custom
    # Trainer below replaces optimizer creation before that enum is used.
    trainer_optim = "adafactor"
    # TRL's SFTTrainer.tokenize is a single-process dataset.map by default,
    # which on a 1.06M-record corpus at seq_len=8192 takes ~30+ hours to walk
    # before the first training step. Fan out to all CPU cores; cap at 32 to
    # avoid IPC overhead drowning the win on huge boxes (H100 SXM = 24 vCPUs,
    # B200 hosts often expose 48-96).
    _dnp = max(1, min(32, (os.cpu_count() or 1)))
    sft_cfg = SFTConfig(
        output_dir=str(out_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=max(1, args.batch_size // 2),
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        weight_decay=0.0,
        optim=trainer_optim,
        bf16=device == "cuda",
        logging_steps=10,
        save_steps=500,
        save_total_limit=3,
        eval_strategy="steps" if val_ds is not None else "no",
        eval_steps=500,
        max_length=args.max_seq_len,
        packing=False,
        dataset_text_field="text",
        dataset_num_proc=_dnp,
        # When Liger fused chunked-CE is on, the model returns loss but
        # `outputs.logits` is None — SFTTrainer's `completion_only_loss=True`
        # path tries to slice logits manually and crashes. We disable
        # completion-only loss when Liger is active and rely on the chat
        # template + EOS to align target tokens. Set MILADY_FORCE_COL=1 to
        # override (skip Liger if you need strict completion masking).
        completion_only_loss=(
            os.environ.get("MILADY_FORCE_COL", "0") == "1"
            or args.use_liger == "off"
        ),
        report_to=os.environ.get("WANDB_PROJECT", "none") if os.environ.get("WANDB_PROJECT") else "none",
        run_name=args.run_name,
    )

    from training.optimizer import (
        _NON_LOWRANK_NAME_HINTS,
        build_apollo_mini_optimizer_from_groups,
        build_apollo_optimizer_from_groups,
    )

    # Classify 2-D vs 1-D BEFORE FSDP wrap. Under FSDP1 (even with
    # use_orig_params=True on this PyTorch build), `named_parameters()`
    # post-wrap returns 1-D FlatParameters and APOLLO's shape-based
    # routing fails. The unwrapped HF model exposes the real shapes,
    # so we save the 2-D weight NAMES here and route by name suffix
    # in create_optimizer.
    lowrank_names: set[str] = set()
    for name, p in model.named_parameters():
        if not p.requires_grad:
            continue
        lname = name.lower()
        if any(h in lname for h in _NON_LOWRANK_NAME_HINTS):
            continue
        if p.dim() == 2:
            lowrank_names.add(name)
    log.info(
        "pre-FSDP APOLLO classification: %d lowrank (2-D) names of %d total",
        len(lowrank_names),
        sum(1 for _ in model.named_parameters()),
    )

    if args.optimizer == "apollo":
        def apollo_builder(m):
            # Walk wrapped or unwrapped model, route by name suffix.
            lowrank, other = _split_named(m, lowrank_names)
            return build_apollo_optimizer_from_groups(
                lowrank, other,
                lr=args.lr, weight_decay=sft_cfg.weight_decay,
                rank=args.apollo_rank, scale=args.apollo_scale,
                update_proj_gap=args.apollo_update_proj_gap,
            )
    else:
        def apollo_builder(m):
            lowrank, other = _split_named(m, lowrank_names)
            return build_apollo_mini_optimizer_from_groups(
                lowrank, other,
                lr=args.lr, weight_decay=sft_cfg.weight_decay,
            )

    # Optional Transformer Engine FP8 swap. No-op everywhere except H200 (sm_90)
    # unless MILADY_FP8_TRAIN=1 forces the swap. When enabled, every train_step
    # runs inside `te.fp8_autocast`, which we install via a one-line trainer hook
    # below. Master weights stay bf16, gradients stay bf16 — see te_fp8.py.
    fp8_handle = None
    if os.environ.get("MILADY_DISABLE_FP8") != "1":
        from training.te_fp8 import maybe_enable_fp8
        fp8_handle = maybe_enable_fp8(model)
        if fp8_handle.enabled:
            log.info("TE FP8 enabled — %d Linear modules swapped", fp8_handle.n_replaced)
        elif fp8_handle.reason_skipped:
            log.info("TE FP8 skipped: %s", fp8_handle.reason_skipped)

    # SFTTrainer's compute_loss always slices `outputs.logits[..., :-1, :]`
    # which fails when Liger fused chunked-CE returns logits=None. When the
    # model already produces `outputs.loss` (Liger or model-side loss), use
    # that directly. Also handles the FSDP+APOLLO `create_optimizer` rebuild.
    class _MiladySFTTrainer(SFTTrainer):
        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            # Forward — pass labels so the model computes loss internally
            # (Liger's chunked CE does this and skips the logits tensor).
            inputs = {k: v for k, v in inputs.items()}
            if "labels" not in inputs and "input_ids" in inputs:
                inputs["labels"] = inputs["input_ids"]
            outputs = model(**inputs)
            if outputs.loss is not None:
                loss = outputs.loss
                return (loss, outputs) if return_outputs else loss
            return super().compute_loss(model, inputs, return_outputs=return_outputs,
                                        num_items_in_batch=num_items_in_batch)

        def create_optimizer(self, model=None):
            # transformers 5.7 calls `create_optimizer(model)`; older releases
            # call `create_optimizer()` — accept both.
            if self.optimizer is None:
                target = model or self.model
                # Diagnostic: when use_orig_params is on FSDP keeps 2-D shapes
                # in named_parameters(); when off, all params are 1-D
                # FlatParameters and APOLLO can't route them.
                n2d = sum(1 for n, p in target.named_parameters()
                          if p.requires_grad and p.dim() == 2)
                n_total = sum(1 for n, p in target.named_parameters() if p.requires_grad)
                first_5 = [(n, list(p.shape)) for n, p in
                           list(target.named_parameters())[:5]]
                log.info("create_optimizer: target=%s n_total=%d n2d=%d first_5=%s",
                         type(target).__name__, n_total, n2d, first_5)
                self.optimizer = apollo_builder(target)
                return self.optimizer
            return self.optimizer

    trainer_cls = _MiladySFTTrainer

    trainer = trainer_cls(
        model=model,
        processing_class=tokenizer,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        args=sft_cfg,
        peft_config=peft_cfg,
    )

    if fp8_handle is not None and fp8_handle.enabled:
        # Wrap training_step in fp8_autocast. Equivalent to the upstream pattern
        # in nanochat/scripts/base_train.py — the autocast context is cheap to
        # enter per-step and Trainer's gradient_accumulation already aggregates
        # across micro-steps.
        _orig_training_step = trainer.training_step
        _autocast = fp8_handle.autocast

        def _fp8_training_step(*args, **kwargs):  # type: ignore[no-untyped-def]
            with _autocast():
                return _orig_training_step(*args, **kwargs)

        trainer.training_step = _fp8_training_step  # type: ignore[assignment]

    from training.instrumentation import (
        InstrumentationConfig, log_environment, make_hf_callback,
    )
    log_environment(
        out_dir,
        run_meta={
            "model": args.model, "optimizer": args.optimizer,
            "batch_size": args.batch_size, "grad_accum": args.grad_accum,
            "max_seq_len": args.max_seq_len, "lr": args.lr,
            "registry_key": args.registry_key,
        },
    )
    if args.memory_budget_gb:
        trainer.add_callback(make_hf_callback(InstrumentationConfig(
            out_dir=str(out_dir),
            seq_len=args.max_seq_len,
            effective_batch_size=args.batch_size * args.grad_accum,
            memory_budget_gb=float(args.memory_budget_gb),
            log_every_steps=sft_cfg.logging_steps,
        )))
        log.info("instrumentation enabled, budget=%.0fGB", args.memory_budget_gb)

    trainer.train()
    trainer.save_model(str(out_dir / "final"))
    tokenizer.save_pretrained(str(out_dir / "final"))
    log.info("done. adapter at %s", out_dir / "final")
    return 0


if __name__ == "__main__":
    sys.exit(main())
