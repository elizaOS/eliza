"""Local SFT on a Gemma 4 dense base model using TRL + APOLLO.

Single-GPU, bf16, completion-only loss (only the assistant turn contributes
to the loss). Checkpoints land under `training/checkpoints/<run_name>/`.

The base model is resolved from `--registry-key` (see
`training/model_registry.py`); pass `--model <hf-id>` to override. With no
registry key the default is `google/gemma-4-E2B` — the smallest published
eliza-1 target.

Usage:
    # Smoke test on the smallest eliza-1 tier
    uv run --extra train python scripts/train_local.py \
        --registry-key gemma4-e2b \
        --max-samples 256 --epochs 1 --run-name eliza-1-2b-smoke

    # Real run
    uv run --extra train python scripts/train_local.py \
        --registry-key gemma4-e2b \
        --epochs 3 --batch-size 4 --grad-accum 8 \
        --run-name eliza-1-2b-eliza-native-v1
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
    matched_lowrank_names: set[str] = set()
    for name, p in model.named_parameters():
        if not p.requires_grad:
            continue
        # Strip FSDP wrapper-prefixes so name matches what we classified
        # against the unwrapped HF model.
        clean = name.replace("_fsdp_wrapped_module.", "")
        if clean in lowrank_names:
            lowrank.append(p)
            matched_lowrank_names.add(clean)
        else:
            other.append(p)
    missing_lowrank_names = lowrank_names - matched_lowrank_names
    if missing_lowrank_names:
        examples = ", ".join(sorted(missing_lowrank_names)[:5])
        raise RuntimeError(
            "APOLLO low-rank routing mismatch after FSDP wrap: "
            f"matched {len(matched_lowrank_names)}/{len(lowrank_names)} "
            "pre-FSDP 2-D parameter names. Missing examples: "
            f"{examples}. This usually means FSDP flattened or renamed "
            "parameters before optimizer construction; fix FSDP name "
            "preservation before training."
        )
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

    def _coerce_tool_call_arguments(messages):
        # The Gemma 4 chat template iterates
        # `tool_call.arguments | items`, which requires a mapping (dict).
        # OpenAI-ChatML ToolCalls (what format_for_training.py emits, what
        # eliza-1-sft-0_6b carries) store `arguments` as a JSON-encoded
        # string. Convert string → dict at render time so the template
        # renders cleanly. (2026-05-12 incident: SFT crashed at 76% of
        # dataset Map() with `TypeError: Can only get item pairs from a
        # mapping.` on a record whose arguments was a string.)
        import json as _json
        out = []
        for m in messages:
            if isinstance(m, dict) and isinstance(m.get("tool_calls"), list):
                fixed_tool_calls = []
                for tc in m["tool_calls"]:
                    if not isinstance(tc, dict):
                        fixed_tool_calls.append(tc)
                        continue
                    fc = dict(tc)
                    fn = fc.get("function")
                    if isinstance(fn, dict) and isinstance(fn.get("arguments"), str):
                        try:
                            fn = {**fn, "arguments": _json.loads(fn["arguments"]) or {}}
                        except (ValueError, TypeError):
                            fn = {**fn, "arguments": {}}
                        fc["function"] = fn
                    if isinstance(fc.get("arguments"), str):
                        try:
                            fc["arguments"] = _json.loads(fc["arguments"]) or {}
                        except (ValueError, TypeError):
                            fc["arguments"] = {}
                    fixed_tool_calls.append(fc)
                m = {**m, "tool_calls": fixed_tool_calls}
            out.append(m)
        return out

    def render(example):
        kwargs = {
            "conversation": _coerce_tool_call_arguments(example["messages"]),
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

    # pyarrow requires homogeneous column types across all rows. The smoke
    # corpus mixes records with nested message shapes (Vercel-AI-SDK tool-call
    # blocks vs OpenAI/ChatML tool_calls vs plain string content) which trips
    # "cannot mix list and non-list, non-null values" in Dataset.from_list.
    # Surfaced 2026-05-14 in the smoke v2 H200 run — 4/4 SFT tiers crashed
    # immediately after `formatted train 314/314 records` with this error.
    # Fix: pre-render to {"text": str} so the only column is a string column;
    # arrow has no trouble with that. The render() call also surfaces rows
    # whose content shape Gemma 4's chat template can't apply (e.g. assistant
    # content as a list of tool-call blocks instead of string + tool_calls
    # field) — we log + skip those rather than fail the whole split, since
    # format_record's translation layer is the real long-term fix.
    pre_rendered: list[dict[str, str]] = []
    template_skipped: dict[str, int] = {}
    for row in formatted:
        try:
            pre_rendered.append(render(row))
        except Exception as e:  # noqa: BLE001
            key = type(e).__name__
            template_skipped[key] = template_skipped.get(key, 0) + 1
    if template_skipped:
        log.warning(
            "render-time skips on %s split: %d row(s) dropped (%s); accepted=%d/%d",
            split_name,
            sum(template_skipped.values()),
            ", ".join(f"{k}={v}" for k, v in sorted(template_skipped.items())),
            len(pre_rendered),
            len(formatted),
        )
    if not pre_rendered:
        raise ValueError(
            f"{split_name} split had {len(formatted)} format_record-valid rows "
            "but every row failed apply_chat_template — the corpus uses a "
            "content shape the active chat template can't render. Inspect "
            "format_for_training.format_record translation of tool_call blocks."
        )
    ds = Dataset.from_list(pre_rendered)
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


# Tracked-by-merge args have argparse default=None so we can distinguish
# "user passed it" from "argparse filled it in". The fallback values that
# argparse used to inject sit in _FALLBACK_DEFAULTS and are applied AFTER
# the registry + preset merges if the value is still None at that point.
_TRACKED_DESTS = (
    "model", "batch_size", "grad_accum", "max_seq_len", "optimizer",
    "apollo_rank", "max_samples", "epochs", "memory_budget_gb",
    "max_grad_norm", "train_dtype",
)
_SUPPORTED_TRAIN_DTYPES = {"bf16"}
_LIGER_SUPPORTED_MODEL_TYPES = {"gemma4"}

_FALLBACK_DEFAULTS: dict[str, Any] = {
    "model": "google/gemma-4-E2B",
    "batch_size": 4,
    "grad_accum": 8,
    "max_seq_len": 4096,
    "optimizer": "apollo",
    "apollo_rank": 256,
    "max_samples": 0,
    "epochs": 3.0,
    "max_grad_norm": 1.0,
    "train_dtype": "bf16",
    # memory_budget_gb intentionally stays None — downstream treats None
    # as "no enforcement", matching the original behavior.
}


def build_parser() -> argparse.ArgumentParser:
    """Build the train_local CLI parser.

    Factored out so unit tests can drive the same merge pipeline as
    `main()` without duplicating the argparse layout by hand.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=None)
    ap.add_argument("--train-file", default=str(ROOT / "data" / "final" / "train.jsonl"))
    ap.add_argument("--val-file", default=str(ROOT / "data" / "final" / "val.jsonl"))
    ap.add_argument("--out-dir", default=str(ROOT / "checkpoints"))
    ap.add_argument("--run-name", default="gemma4-eliza-native")
    ap.add_argument(
        "--max-samples", type=int, default=None,
        help="Cap the number of training records loaded. 0 = no cap. Default "
             "None means: fall back to registry default if --registry-key is "
             "set, else 0 (no cap). Explicit 0 from the caller is honored as "
             "'no cap' and is NOT overridden by --low-vram-smoke."
    )
    ap.add_argument(
        "--epochs", type=float, default=None,
        help="Training epochs. Default None means: fall back to registry "
             "default if --registry-key is set, else 3.0. Explicit value "
             "from the caller is honored and is NOT overridden by "
             "--low-vram-smoke (including --epochs 3.0)."
    )
    ap.add_argument(
        "--max-steps", type=int, default=0,
        help="Hard cap on training steps. 0 = use --epochs. Use this to "
             "budget-bound a run when wall-clock matters more than completing "
             "an epoch (e.g. 1500 steps fits a 12h H200 budget at ~25 s/iter "
             "with eval passes; see 2026-05-13 v4 incident in .swarm/STATUS.md).",
    )
    ap.add_argument(
        "--resume-from-checkpoint", default=None,
        help="Resume SFT from an existing checkpoint dir (e.g. "
             "checkpoints/eliza-1-2b-apollo-fullcorpus-h200-1778619044/"
             "checkpoint-1000). The Trainer restores model + optimizer + LR "
             "scheduler + global_step from the checkpoint; combine with "
             "--max-steps to extend training past the original cap. Path "
             "forwarded to Trainer.train(resume_from_checkpoint=...).",
    )
    ap.add_argument("--batch-size", type=int, default=None)
    ap.add_argument("--grad-accum", type=int, default=None)
    ap.add_argument(
        "--max-grad-norm", type=float, default=None,
        help="Gradient clipping norm forwarded to TRL SFTConfig. Default "
             "None falls back to the registry tier value, or 1.0 when no "
             "registry key is set. Pass 0 to disable HF Trainer clipping."
    )
    ap.add_argument(
        "--train-dtype", default=None,
        help="Training dtype. Default None falls back to the registry tier "
             "value, or bf16 when no registry key is set. Only bf16 is "
             "implemented in this entrypoint; other values fail loud."
    )
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument(
        "--max-seq-len", type=int, default=None,
        help="Training sequence length. When `--registry-key` is set and the "
             "user did not pass `--max-seq-len`, the registry's `seq_len` "
             "default is used (8k for 2B/4B, 16k for 9B, 64k for 27B). "
             "Default None falls back to 4096 when no registry key is set. "
             "Pass `--max-seq-len <N>` to override the registry default for "
             "a single run — useful for long-context experiments "
             "(validate VRAM with `memory_calc.py --shape gemma4-e4b` first)."
    )
    ap.add_argument("--full-finetune", action="store_true",
                    help="Compatibility flag; this entrypoint is always full-parameter APOLLO SFT.")
    ap.add_argument(
        "--preflight-only",
        action="store_true",
        help="Validate split files and APOLLO-only configuration without loading model weights.",
    )
    ap.add_argument(
        "--optimizer",
        choices=["apollo", "apollo_mini"],
        default=None,
        help="optimizer to use. This local training entrypoint is APOLLO-only. "
             "Default None falls back to registry value, or 'apollo' when no "
             "registry key is set."
    )
    ap.add_argument("--apollo-rank", type=int, default=None)
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
        "--chat-template-from", default=None,
        help="Model/tokenizer id to borrow a chat_template from when the base "
             "--model tokenizer ships none (Gemma-4 base models do). Default: "
             "'<model>-it' (the instruct variant).",
    )
    ap.add_argument(
        "--use-liger", default="auto", choices=("auto", "on", "off"),
        help="Apply Liger fused chunked-CE + RMSNorm/SwiGLU/RoPE kernels. "
             "Cuts the fp32-logits transient ~4–8× (Gemma 4 vocab=262k makes "
             "this dominant) so we can train at 8k–16k seq_len on the same "
             "VRAM. Default `auto` = on when the registry entry says so or "
             "when no registry key is set.",
    )
    ap.add_argument(
        "--registry-key", default=None,
        help="Pull defaults from training/model_registry.py (e.g. gemma4-e2b). "
             "CLI flags override registry values."
    )
    ap.add_argument(
        "--memory-budget-gb", type=float, default=None,
        help="Override registry memory budget. Run dies if reserved memory "
             "exceeds budget*1.10. Default: registry value or no enforcement."
    )
    ap.add_argument(
        "--low-vram-smoke", action="store_true",
        help="Preset bundle for full-parameter SFT smoke runs on a 12 GB "
             "consumer GPU (RTX 3060 / 4070 class). Overrides the registry "
             "defaults to seq_len=2048, batch=1, grad_accum=16, "
             "memory_budget_gb=11.5, and defaults --max-samples to 1000 "
             "and --epochs to 1 when the caller did not pass them. Liger "
             "fused chunked-CE stays on. Trades training context window "
             "for VRAM headroom; do NOT use the resulting checkpoint as a "
             "publishable artifact — this is for path-validation only."
    )
    return ap


def apply_resolved_defaults(args: argparse.Namespace) -> None:
    """Apply the registry → preset → fallback merge to a parsed namespace.

    Mutates `args` in place. Tracked-by-merge args use argparse default=None
    so "user passed it" is unambiguous: anything still None after
    `parse_args()` came from argparse, not the CLI. Registry and preset
    merges only touch None values, so explicit CLI flags always win — even
    when the caller passed a value that happens to equal the historical
    argparse default (e.g. --epochs 3.0, --max-samples 0).

    Merge order:
      1. --registry-key fills None values with registry entries
      2. --low-vram-smoke preset fills any still-None values from the
         tracked set with preset constants
      3. _FALLBACK_DEFAULTS fills anything still None with the historical
         argparse defaults (used when no registry key is set and no
         preset fired)
    """
    user_passed = {dest: getattr(args, dest) is not None for dest in _TRACKED_DESTS}

    from training.model_registry import get as _registry_get  # noqa: E402
    if args.registry_key:
        entry = _registry_get(args.registry_key)
        if (
            entry.unverified_base
            and not user_passed["model"]
            and os.environ.get("ELIZA_ALLOW_UNVERIFIED_BASE") != "1"
        ):
            raise SystemExit(
                f"--registry-key {args.registry_key!r} → hf_id {entry.hf_id!r} "
                "is an UNVERIFIED registry entry with no published checkpoint as of "
                "2026-05; loading it will fail. Use a real key "
                "(gemma4-e2b / gemma4-e4b / gemma4-12b / gemma4-31b → "
                "eliza-1-2b / eliza-1-4b / eliza-1-9b / eliza-1-27b), "
                "pass an explicit --model <real-hf-id>, or set "
                "ELIZA_ALLOW_UNVERIFIED_BASE=1 to override."
            )
        if not user_passed["model"]:
            args.model = entry.hf_id
        if not user_passed["batch_size"]:
            args.batch_size = entry.micro_batch
        if not user_passed["grad_accum"]:
            args.grad_accum = entry.grad_accum
        if not user_passed["max_seq_len"]:
            args.max_seq_len = entry.seq_len
        if not user_passed["optimizer"]:
            args.optimizer = entry.optimizer
        if not user_passed["apollo_rank"]:
            args.apollo_rank = entry.optimizer_rank
        if not user_passed["memory_budget_gb"]:
            args.memory_budget_gb = entry.train_mem_gb_budget
        if not user_passed["max_grad_norm"]:
            args.max_grad_norm = entry.max_grad_norm
        if not user_passed["train_dtype"]:
            args.train_dtype = entry.train_dtype
        log.info("registry %s → model=%s batch=%d accum=%d seq=%d optimizer=%s budget=%.0fGB max_grad_norm=%.3g dtype=%s",
                 entry.short_name, args.model, args.batch_size, args.grad_accum,
                 args.max_seq_len, args.optimizer, args.memory_budget_gb or 0,
                 args.max_grad_norm, args.train_dtype)

    # --low-vram-smoke overrides applied AFTER the registry merge so the
    # preset wins regardless of which registry key was passed. The numbers
    # target a 12 GB RTX 3060 / 4070-class GPU: seq_len=2048 keeps the fp32
    # logits transient + activations inside ~7 GB at the 2B size with Liger
    # fused chunked-CE on; grad_accum=16 holds the effective batch at 16 so
    # the loss signal is comparable to the registry default; memory budget
    # is 11.5 GB (1.5 GB headroom under the card's 12 GB). The preset is
    # explicitly NOT for publishable runs — it is a path-validation smoke
    # for the SFT entrypoint on commodity hardware.
    if args.low_vram_smoke:
        if not user_passed["max_seq_len"]:
            args.max_seq_len = 2048
        if not user_passed["batch_size"]:
            args.batch_size = 1
        if not user_passed["grad_accum"]:
            args.grad_accum = 16
        if not user_passed["max_samples"]:
            args.max_samples = 1000
        if not user_passed["epochs"]:
            args.epochs = 1.0
        if not user_passed["memory_budget_gb"]:
            args.memory_budget_gb = 11.5

    # Fill anything still None with the historical argparse fallback.
    # Reached when no registry key is set and (for max-samples / epochs)
    # the preset didn't fire either.
    for dest, fallback in _FALLBACK_DEFAULTS.items():
        if getattr(args, dest) is None:
            setattr(args, dest, fallback)

    if args.train_dtype not in _SUPPORTED_TRAIN_DTYPES:
        raise SystemExit(
            f"--train-dtype {args.train_dtype!r} is not implemented in "
            "train_local.py. Supported dtype(s): "
            + ", ".join(sorted(_SUPPORTED_TRAIN_DTYPES))
            + ". Update the dtype path before changing the registry."
        )

    if args.low_vram_smoke:
        log.info(
            "low-vram-smoke preset → seq=%d batch=%d accum=%d max_samples=%d "
            "epochs=%.1f budget=%.1fGB (effective_batch=%d)",
            args.max_seq_len, args.batch_size, args.grad_accum, args.max_samples,
            args.epochs, args.memory_budget_gb, args.batch_size * args.grad_accum,
        )


def resolve_liger_arch_gate(
    *,
    use_liger: bool,
    requested_mode: str,
    model_type: str,
    architectures: list[str],
) -> bool:
    """Apply the Gemma 4 Liger allowlist after model config is loaded."""
    if not use_liger:
        return False
    normalized_model_type = model_type.lower()
    if (
        "gemma4_unified" in normalized_model_type
        or any("Gemma4Unified" in arch for arch in architectures)
    ):
        reason = (
            "Liger kernel is not validated for gemma4_unified; fused kernels "
            "can corrupt the 12B/31B forward and produce NaN checkpoints."
        )
    elif normalized_model_type not in _LIGER_SUPPORTED_MODEL_TYPES:
        reason = (
            f"Liger kernel is not allowlisted for model_type={model_type!r}. "
            "Add an explicit validation before enabling fused kernels for this arch."
        )
    else:
        return True

    if requested_mode == "on":
        raise SystemExit(f"--use-liger=on requested but {reason}")
    log.warning("%s Disabling Liger for this run.", reason)
    return False


def main() -> int:
    args = build_parser().parse_args()
    apply_resolved_defaults(args)

    train_recs = load_jsonl(
        Path(args.train_file),
        max_n=args.max_samples or None,
    )
    val_recs = load_jsonl(
        Path(args.val_file),
        max_n=max(1, args.max_samples // 10) if args.max_samples else None,
    )
    if not train_recs:
        log.error("no training records — run pack_dataset.py or prepare_eliza1_trajectory_dataset.py first")
        return 1

    if args.preflight_only:
        train_ok = sum(1 for rec in train_recs if format_record(rec))
        val_ok = sum(1 for rec in val_recs if format_record(rec))
        if train_ok == 0:
            log.error("preflight failed: training split formats to zero train-local rows")
            return 1
        if val_recs and val_ok == 0:
            log.error("preflight failed: validation split formats to zero train-local rows")
            return 1
        log.info(
            "preflight ok: train=%d/%d validation=%d/%d optimizer=%s rank=%d",
            train_ok, len(train_recs), val_ok, len(val_recs),
            args.optimizer, args.apollo_rank,
        )
        log.info(
            "APOLLO/APOLLO-Mini is the only optimizer path; full-parameter fine-tuning is required."
        )
        return 0

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    # PyTorch 2.6+ defaults `torch.load(weights_only=True)`, which the Trainer
    # uses on the optimizer state pickle when resuming. APOLLO's optimizer
    # state holds an `apollo_torch.random_projector.GradientProjector` instance
    # per parameter group; with weights_only=True those globals are rejected
    # and resume crashes with:
    #   _pickle.UnpicklingError: Weights only load failed. ...
    #     GLOBAL apollo_torch.random_projector.GradientProjector was not an
    #     allowed global by default.
    # Pre-register the class so Trainer.train(resume_from_checkpoint=...) can
    # deserialize the optimizer state. Safe globals are idempotent — no harm
    # registering on fresh runs. The import is best-effort: APOLLO is only
    # actually used downstream when args.optimizer in (apollo, apollo_mini).
    if args.resume_from_checkpoint:
        try:
            from apollo_torch.random_projector import GradientProjector
            torch.serialization.add_safe_globals([GradientProjector])
            log.info("registered apollo_torch.random_projector.GradientProjector as a torch safe global for weights_only resume")
        except ImportError:
            log.warning("apollo_torch not importable — skipping safe-globals registration; resume may fail with PyTorch 2.6+ weights_only")

    if torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    log.info("device=%s torch=%s model=%s", device, torch.__version__, args.model)
    if device == "cpu":
        log.warning("no GPU detected — training will be very slow")

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.truncation_side = "left"
    # Base Gemma-4 tokenizers (google/gemma-4-{E2B,E4B,12B,31B}) ship NO
    # chat_template, but SFT renders every row through apply_chat_template — with
    # no template every row raises ValueError and the run aborts with
    # "accepted=0/N". Borrow the official template from the matching -it instruct
    # variant (the target we're instruction-tuning the base toward, and the
    # source the MTP -it-assistant drafters derive from). Explicit override wins.
    if not getattr(tokenizer, "chat_template", None):
        template_src = args.chat_template_from or f"{args.model}-it"
        try:
            src_tok = AutoTokenizer.from_pretrained(
                template_src, trust_remote_code=True
            )
            if getattr(src_tok, "chat_template", None):
                tokenizer.chat_template = src_tok.chat_template
                log.info(
                    "chat_template borrowed from %s (base %s tokenizer had none)",
                    template_src,
                    args.model,
                )
            else:
                log.error(
                    "%s has no chat_template either — SFT render will fail",
                    template_src,
                )
        except Exception as exc:  # noqa: BLE001
            log.error(
                "could not load chat_template from %s: %s", template_src, exc
            )

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

    log.info("loading model %s for full-parameter APOLLO SFT", args.model)
    attn_impl = select_attn_impl(device)
    # device_map='auto' is incompatible with FSDP / DDP — accelerate's
    # `prepare()` rejects models that already have a device map. When we
    # launch under `accelerate launch` (RANK env set), every rank loads
    # to CPU with low_cpu_mem_usage=True; the FSDP launcher's
    # `cpu_ram_efficient_loading=True` plus `sync_module_states=True` keeps
    # peak host RAM low. Without this, each rank would push a full copy
    # to its own GPU before FSDP shards, causing avoidable OOM risk.
    in_distributed = "RANK" in os.environ
    use_device_map = device == "cuda" and not in_distributed
    # bf16 is the only implemented training dtype; CPU still loads fp32 so the
    # preflight/test path does not pretend to exercise bf16 kernels.
    train_dtype = torch.bfloat16 if args.train_dtype == "bf16" and device in ("cuda", "mps") else torch.float32
    model_kwargs = dict(
        torch_dtype=train_dtype,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
        attn_implementation=attn_impl,
    )
    if use_device_map:
        model_kwargs["device_map"] = "auto"
    log.info("loading model (in_distributed=%s)", in_distributed)
    model = AutoModelForCausalLM.from_pretrained(args.model, **model_kwargs)

    # Apply Liger kernel patches before any forward pass so the chunked
    # cross-entropy + fused RMSNorm/SwiGLU/RoPE replace the HF defaults.
    # This is what makes the longer training seq_lens (8k–16k locally,
    # 16k+ on cloud) actually fit in VRAM.
    from training.model_registry import get as _registry_get  # noqa: E402
    use_liger = args.use_liger == "on" or (
        args.use_liger == "auto"
        and (args.registry_key is None
             or getattr(_registry_get(args.registry_key), "use_liger", True))
    )
    if use_liger and device not in ("cuda",):
        # Liger requires Triton/CUDA — disable on MPS/CPU
        log.info("Liger kernel disabled (device=%s, requires CUDA)", device)
        use_liger = False
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
    _model_type = str(getattr(model.config, "model_type", "")).lower()
    _arch_names = getattr(model.config, "architectures", None) or []
    use_liger = resolve_liger_arch_gate(
        use_liger=use_liger,
        requested_mode=args.use_liger,
        model_type=_model_type,
        architectures=list(_arch_names),
    )
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
            # FLCE chunk_size = 2^ceil(log2(B*T / (V/H))). For Gemma 4
            # H≈2048-5120 / V=248k → V/H≈48-120; B=1, T=16k -> chunk≈512.
            # Liger paper §5.3 reports +25% throughput + 20% lower peak mem
            # on the FLCE step vs the default auto-pick at our shape.
            loss_fn = getattr(model, "loss_function", None)
            if loss_fn is not None and hasattr(loss_fn, "chunk_size"):
                loss_fn.chunk_size = 512
                log.info("Liger FLCE chunk_size set to 512 for our (B,T,V,H) shape")
            log.info("Liger kernel applied (fused CE + RMSNorm + SwiGLU + RoPE)")
    model.config.use_cache = False
    if hasattr(model, "gradient_checkpointing_enable"):
        # Selective activation checkpointing: skip every Nth layer so we trade
        # ~5% peak memory for ~10% throughput vs uniform full-block AC. Set
        # ELIZA_AC_EVERY=1 (default) for uniform; 2 for "checkpoint every other
        # layer"; 0 to disable AC entirely. PyTorch FSDP blog confirms the win.
        ac_every = int(os.environ.get("ELIZA_AC_EVERY", "1"))
        if ac_every <= 0:
            log.info("activation checkpointing DISABLED (ELIZA_AC_EVERY=0)")
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

    out_dir = Path(args.out_dir) / args.run_name
    out_dir.mkdir(parents=True, exist_ok=True)

    if os.environ.get("ELIZA_TRAINER_OPTIM"):
        raise SystemExit(
            "ELIZA_TRAINER_OPTIM is disabled. This entrypoint always builds "
            "APOLLO/APOLLO-Mini through the trainer create_optimizer hook."
        )

    # IMPORTANT: do not add a second optimizer path here. APOLLO is what lets
    # full-parameter Eliza-1 fine-tuning fit smaller GPUs by shrinking optimizer
    # state; _ElizaSFTTrainer.create_optimizer below is the only optimizer hook.
    # TRL's SFTTrainer.tokenize is a single-process dataset.map by default,
    # which on a 1.06M-record corpus at seq_len=8192 takes ~30+ hours to walk
    # before the first training step. Fan out to all CPU cores; cap at 32 to
    # avoid IPC overhead drowning the win on huge boxes (H100 SXM = 24 vCPUs,
    # B200 hosts often expose 48-96).
    _dnp = max(1, min(32, (os.cpu_count() or 1)))
    sft_cfg = SFTConfig(
        output_dir=str(out_dir),
        num_train_epochs=args.epochs,
        max_steps=args.max_steps if args.max_steps > 0 else -1,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=max(1, args.batch_size // 2),
        gradient_accumulation_steps=args.grad_accum,
        max_grad_norm=args.max_grad_norm,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        weight_decay=0.0,
        bf16=args.train_dtype == "bf16" and device == "cuda",
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
        # template + EOS to align target tokens. Set ELIZA_FORCE_COL=1 to
        # override (skip Liger if you need strict completion masking).
        completion_only_loss=(
            os.environ.get("ELIZA_FORCE_COL", "0") == "1"
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
    # unless ELIZA_FP8_TRAIN=1 forces the swap. When enabled, every train_step
    # runs inside `te.fp8_autocast`, which we install via a one-line trainer hook
    # below. Master weights stay bf16, gradients stay bf16 — see te_fp8.py.
    fp8_handle = None
    if os.environ.get("ELIZA_DISABLE_FP8") != "1":
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
    from training.instrumentation import assert_finite_loss

    class _ElizaSFTTrainer(SFTTrainer):
        def compute_loss(self, model, inputs, return_outputs=False, num_items_in_batch=None):
            # Forward — pass labels so the model computes loss internally
            # (Liger's chunked CE does this and skips the logits tensor).
            inputs = {k: v for k, v in inputs.items()}
            if "labels" not in inputs and "input_ids" in inputs:
                inputs["labels"] = inputs["input_ids"]
            outputs = model(**inputs)
            if outputs.loss is not None:
                loss = outputs.loss
                assert_finite_loss(loss, context="SFT model loss")
                return (loss, outputs) if return_outputs else loss
            computed = super().compute_loss(
                model,
                inputs,
                return_outputs=return_outputs,
                num_items_in_batch=num_items_in_batch,
            )
            loss = computed[0] if return_outputs else computed
            assert_finite_loss(loss, context="SFT trainer loss")
            return computed

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

    trainer_cls = _ElizaSFTTrainer

    trainer = trainer_cls(
        model=model,
        processing_class=tokenizer,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        args=sft_cfg,
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
        InstrumentationConfig,
        assert_finite_checkpoint,
        log_environment,
        make_finite_weights_callback,
        make_hf_callback,
    )
    # Materialize the exact tokenizer this run trains with (including any chat-
    # template override applied above) to a stable path so its artifact hash is
    # captured in the reproducibility manifest. This is the actual tokenizer the
    # model sees, not just the base-model source.
    tokenizer_dir = out_dir / "tokenizer"
    tokenizer.save_pretrained(str(tokenizer_dir))
    log_environment(
        out_dir,
        run_meta={
            "model": args.model, "optimizer": args.optimizer,
            "batch_size": args.batch_size, "grad_accum": args.grad_accum,
            "max_seq_len": args.max_seq_len, "lr": args.lr,
            "registry_key": args.registry_key,
        },
        # Reproducibility manifest (AGENTS.md §9): hash the exact inputs. A bare
        # HF repo id for --model won't resolve to a local path and is skipped;
        # a local base checkpoint is hashed.
        dataset_files=[args.train_file, args.val_file],
        tokenizer_path=tokenizer_dir,
        base_checkpoint=args.model,
    )
    # Post-step finite-weights guard — registered unconditionally. A divergent
    # run (e.g. a fused kernel that doesn't model an arch's layer layout) must
    # die within one logging interval instead of completing and persisting an
    # all-NaN checkpoint. Not gated on --memory-budget-gb.
    trainer.add_callback(
        make_finite_weights_callback(sft_cfg.logging_steps)
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

    trainer.train(
        resume_from_checkpoint=args.resume_from_checkpoint
        if args.resume_from_checkpoint
        else None,
    )
    trainer.save_model(str(out_dir / "final"))
    tokenizer.save_pretrained(str(out_dir / "final"))
    numerics_report = assert_finite_checkpoint(out_dir / "final")
    (out_dir / "final" / "numerics_scan.json").write_text(
        json.dumps(numerics_report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    log.info(
        "checkpoint numerics scan passed: %s",
        out_dir / "final" / "numerics_scan.json",
    )
    log.info("done. full-parameter APOLLO checkpoint at %s", out_dir / "final")
    return 0


if __name__ == "__main__":
    sys.exit(main())
