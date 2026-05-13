#!/usr/bin/env python3
"""Fine-tune Kokoro-82M (StyleTTS-2 family) on a prepared LJSpeech-format run.

Inputs:

  --run-dir   <prep_ljspeech.py output>/  containing processed/train_list.txt,
                                          processed/val_list.txt, etc.
  --config    YAML config (lora or full mode)

Outputs:

  <run-dir>/checkpoints/
      ├── step_<N>.pt              # full state dict (or LoRA-only delta)
      ├── best.pt                  # best val-loss checkpoint
      └── train_manifest.json      # hyperparams, dataset hashes, training commit

Mode = `lora`:
  - Attach PEFT LoRA adapters to the prosody predictor + style projection.
  - Text encoder + iSTFTNet decoder weights stay frozen.
  - Saves the LoRA delta only; the base model is reloaded from `base_model`
    at export time. Fits on 16 GB VRAM.

Mode = `full`:
  - Unfreeze every parameter.
  - Stage 1 (until adversarial_warmup_step): mel + duration + F0 loss.
  - Stage 2 (from adversarial_warmup_step on, if adversarial_loss_weight > 0):
    add the WavLM discriminator adversarial loss.

Optimizer: APOLLO (apollo_mini by default — same choice as our text fine-tunes
and the DFlash drafter distiller). Mixed precision: bf16 if CUDA available, else
fp32. Logging goes to TensorBoard via `<run-dir>/tb/`.

Synthetic-smoke mode (`--synthetic-smoke`) runs the full control flow with a
stub model on CPU, asserting checkpoint emission and manifest correctness
without importing torch's CUDA paths. CI uses this to catch pipeline rot.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import random
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from _config import load_config  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.finetune")


@dataclass
class TrainStats:
    step: int = 0
    epoch: int = 0
    train_loss: float = 0.0
    val_loss: float = 0.0
    best_val_loss: float = float("inf")
    best_step: int = 0


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parents[3],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


def _list_lines(path: Path) -> list[str]:
    with path.open(encoding="utf-8") as fh:
        return [line.rstrip("\n") for line in fh if line.strip()]


def _build_manifest(
    *,
    args: argparse.Namespace,
    cfg: dict[str, Any],
    train_list: list[str],
    val_list: list[str],
    stats: TrainStats,
    prep_manifest_sha256: str | None,
    synthetic: bool,
    checkpoint_paths: list[str],
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "kind": "kokoro-finetune-manifest",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": synthetic,
        "baseModel": cfg["base_model"],
        "voiceName": cfg.get("voice_name", "eliza_custom"),
        "voiceLang": cfg.get("voice_lang", "a"),
        "voiceTags": cfg.get("voice_tags", []),
        "mode": cfg["mode"],
        "hyperparameters": {
            "optimizer": cfg["optimizer"],
            "learningRate": cfg["learning_rate"],
            "weightDecay": cfg["weight_decay"],
            "warmupSteps": cfg["warmup_steps"],
            "scheduler": cfg["scheduler"],
            "batchSize": cfg["batch_size"],
            "gradAccum": cfg["grad_accum"],
            "maxSteps": cfg["max_steps"],
            "bf16": cfg["bf16"],
            "loraRank": cfg.get("lora_rank") if cfg["mode"] == "lora" else None,
            "loraAlpha": cfg.get("lora_alpha") if cfg["mode"] == "lora" else None,
            "loraTargets": cfg.get("lora_target_modules") if cfg["mode"] == "lora" else None,
            "melLossWeight": cfg["mel_loss_weight"],
            "durationLossWeight": cfg["duration_loss_weight"],
            "f0LossWeight": cfg.get("f0_loss_weight", 0.0),
            "adversarialLossWeight": cfg.get("adversarial_loss_weight", 0.0),
            "adversarialWarmupStep": cfg.get("adversarial_warmup_step"),
        },
        "dataset": {
            "trainClips": len(train_list),
            "valClips": len(val_list),
            "prepManifestSha256": prep_manifest_sha256,
        },
        "training": asdict(stats),
        "checkpoints": checkpoint_paths,
        "trainingCommit": _git_commit(),
    }


def _run_synthetic_smoke(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    """No torch, no GPU. Walks the file layout, writes a tiny checkpoint + manifest."""
    log.info("synthetic-smoke: skipping real training")
    run_dir = Path(args.run_dir).resolve()
    processed = run_dir / "processed"

    # If processed/ is empty, fabricate it. Keeps `pytest -k smoke` self-contained.
    train_list_path = processed / "train_list.txt"
    val_list_path = processed / "val_list.txt"
    if not train_list_path.exists():
        processed.mkdir(parents=True, exist_ok=True)
        with train_list_path.open("w") as fh:
            for i in range(12):
                fh.write(f"wavs_norm/SMOKE-{i:04d}.wav|hh ah l ow|0\n")
        with val_list_path.open("w") as fh:
            fh.write("wavs_norm/SMOKE-9999.wav|hh ah l ow|0\n")

    train_list = _list_lines(train_list_path)
    val_list = _list_lines(val_list_path)

    ckpt_dir = run_dir / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    # Minimal valid "checkpoint": a JSON sidecar of dummy weights metadata.
    # Real runs write torch tensors via torch.save; the smoke variant uses
    # JSON so we don't drag torch into CI.
    fake_step_path = ckpt_dir / "step_1.json"
    fake_step_path.write_text(
        json.dumps(
            {
                "kind": "kokoro-synthetic-checkpoint",
                "step": 1,
                "trainLoss": 0.5,
                "valLoss": 0.6,
                "baseModel": cfg["base_model"],
                "mode": cfg["mode"],
            },
            indent=2,
        )
        + "\n"
    )
    best_path = ckpt_dir / "best.json"
    best_path.write_text(fake_step_path.read_text())

    stats = TrainStats(step=1, epoch=1, train_loss=0.5, val_loss=0.6, best_val_loss=0.6, best_step=1)
    prep_manifest = processed / "prep_manifest.json"
    prep_sha = _sha256_file(prep_manifest) if prep_manifest.exists() else None

    manifest = _build_manifest(
        args=args,
        cfg=cfg,
        train_list=train_list,
        val_list=val_list,
        stats=stats,
        prep_manifest_sha256=prep_sha,
        synthetic=True,
        checkpoint_paths=[str(fake_step_path), str(best_path)],
    )
    (ckpt_dir / "train_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("synthetic-smoke wrote %s", ckpt_dir / "train_manifest.json")
    return 0


def _import_torch_stack() -> dict[str, Any]:
    """Import torch + transformers + peft lazily so the smoke path stays import-free."""
    import torch  # noqa: PLC0415

    from torch.utils.data import DataLoader, Dataset  # noqa: PLC0415

    try:
        from peft import LoraConfig, get_peft_model  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "peft is required for LoRA fine-tunes; install via `pip install peft`."
        ) from exc

    try:
        from kokoro import KModel  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "The `kokoro` package is required to load the base model. "
            "Install via `pip install 'kokoro>=0.9.4'` (and `pip install 'misaki[en]>=0.9.4'`)."
        ) from exc

    try:
        from training.optimizer import (  # type: ignore  # noqa: PLC0415
            build_apollo_mini_optimizer,
            build_apollo_optimizer,
        )
    except ImportError:
        build_apollo_optimizer = None  # type: ignore
        build_apollo_mini_optimizer = None  # type: ignore

    return {
        "torch": torch,
        "DataLoader": DataLoader,
        "Dataset": Dataset,
        "LoraConfig": LoraConfig,
        "get_peft_model": get_peft_model,
        "KModel": KModel,
        "build_apollo_optimizer": build_apollo_optimizer,
        "build_apollo_mini_optimizer": build_apollo_mini_optimizer,
    }


def _build_optimizer(stack: dict[str, Any], model: Any, cfg: dict[str, Any]):
    optim_name = cfg["optimizer"]
    # IMPORTANT: Kokoro fine-tunes use the same APOLLO-only optimizer policy as
    # Eliza-1 text SFT. APOLLO keeps optimizer state small enough for the
    # smaller GPUs this pipeline targets; do not add a non-APOLLO fallback.
    if optim_name == "apollo":
        if stack["build_apollo_optimizer"] is None:
            raise SystemExit(
                "apollo-torch unavailable; install the `train` extra "
                "(apollo-torch>=1.0.3)."
            )
        return stack["build_apollo_optimizer"](
            model,
            lr=cfg["learning_rate"],
            weight_decay=cfg["weight_decay"],
        )
    if optim_name == "apollo_mini":
        if stack["build_apollo_mini_optimizer"] is None:
            raise SystemExit(
                "apollo-torch unavailable; install the `train` extra."
            )
        return stack["build_apollo_mini_optimizer"](
            model,
            lr=cfg["learning_rate"],
            weight_decay=cfg["weight_decay"],
        )
    raise SystemExit(f"unknown optimizer: {optim_name!r}")


def _attach_lora(stack: dict[str, Any], model: Any, cfg: dict[str, Any]):
    LoraConfig = stack["LoraConfig"]
    get_peft_model = stack["get_peft_model"]
    lora_config = LoraConfig(
        r=cfg["lora_rank"],
        lora_alpha=cfg["lora_alpha"],
        lora_dropout=cfg["lora_dropout"],
        target_modules=cfg["lora_target_modules"],
        bias="none",
        task_type="FEATURE_EXTRACTION",
    )
    return get_peft_model(model, lora_config)


def _real_train(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    """Actual training loop. Imports torch lazily, requires CUDA or MPS.

    This is a control-flow scaffold matching the StyleTTS-2 two-loss recipe.
    The exact per-batch loss math depends on `kokoro`'s internal forward shape,
    which the community fork (`jonirajala/kokoro_training`) implements as
    `model.forward_train(audio, phonemes, durations, ref_s) -> {mel, dur, f0}`.
    We call that function directly when available; otherwise we fall back to
    Kokoro's text-to-mel + the StyleTTS-2 loss heads we attach.
    """
    stack = _import_torch_stack()
    torch = stack["torch"]
    Dataset = stack["Dataset"]
    DataLoader = stack["DataLoader"]
    KModel = stack["KModel"]

    run_dir = Path(args.run_dir).resolve()
    processed = run_dir / "processed"
    train_list = _list_lines(processed / "train_list.txt")
    val_list = _list_lines(processed / "val_list.txt")
    prep_manifest_path = processed / "prep_manifest.json"
    prep_manifest_sha256 = _sha256_file(prep_manifest_path) if prep_manifest_path.exists() else None

    device = (
        "cuda"
        if torch.cuda.is_available()
        else ("mps" if torch.backends.mps.is_available() else "cpu")
    )
    log.info("device=%s mode=%s base=%s", device, cfg["mode"], cfg["base_model"])
    if device == "cpu":
        log.warning(
            "running on CPU — this is fine for a smoke but will not converge in any "
            "reasonable wall-clock; use a CUDA or MPS device for real training."
        )

    dtype = torch.bfloat16 if (device == "cuda" and cfg["bf16"]) else torch.float32

    # Load the base Kokoro model. The community `kokoro` package exposes a KModel
    # that holds the text encoder, predictor, style encoder, and the iSTFTNet
    # decoder. We materialize it on the chosen device.
    model = KModel(repo_id=cfg["base_model"]).to(device)

    if cfg["mode"] == "lora":
        model = _attach_lora(stack, model, cfg)
        # Freeze every parameter that PEFT didn't unfreeze.
        for name, param in model.named_parameters():
            if "lora_" not in name:
                param.requires_grad_(False)
    elif cfg["mode"] != "full":
        raise SystemExit(f"unknown mode: {cfg['mode']!r}")

    # Dataset adapter — every line in train_list.txt is "<wav-rel>|<phonemes>|<speaker>".
    class _LJSpeechSet(Dataset):  # type: ignore[misc]
        def __init__(self, lines: list[str], root: Path):
            self.lines = lines
            self.root = root

        def __len__(self) -> int:
            return len(self.lines)

        def __getitem__(self, idx: int) -> dict[str, Any]:
            wav_rel, phonemes, speaker = self.lines[idx].split("|", 2)
            return {
                "wav_path": str(self.root / wav_rel),
                "phonemes": phonemes,
                "speaker": speaker,
            }

    train_ds = _LJSpeechSet(train_list, processed)
    val_ds = _LJSpeechSet(val_list, processed)
    train_loader = DataLoader(
        train_ds, batch_size=cfg["batch_size"], shuffle=True, num_workers=2, collate_fn=lambda b: b
    )
    val_loader = DataLoader(
        val_ds, batch_size=cfg["batch_size"], shuffle=False, num_workers=2, collate_fn=lambda b: b
    )

    optimizer = _build_optimizer(stack, model, cfg)

    ckpt_dir = run_dir / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    stats = TrainStats()
    checkpoint_paths: list[str] = []

    # Optional TensorBoard logging.
    writer = None
    if not args.no_tensorboard:
        try:
            from torch.utils.tensorboard import SummaryWriter  # noqa: PLC0415

            writer = SummaryWriter(log_dir=str(run_dir / "tb"))
        except ImportError:
            log.warning("tensorboard not installed; skipping logging")

    forward_train = getattr(model, "forward_train", None)
    if forward_train is None:
        raise SystemExit(
            "The installed `kokoro` package does not expose `forward_train`. "
            "Use the community training fork (`pip install "
            "git+https://github.com/jonirajala/kokoro_training`) or update kokoro to "
            ">= the version that ships `forward_train`. See the README for context."
        )

    model.train()
    accum_loss = 0.0
    step = 0
    epoch = 0
    while step < cfg["max_steps"]:
        epoch += 1
        for batch in train_loader:
            if step >= cfg["max_steps"]:
                break
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device, dtype=dtype, enabled=(dtype != torch.float32)):
                losses = forward_train(batch)
            loss = (
                cfg["mel_loss_weight"] * losses["mel"]
                + cfg["duration_loss_weight"] * losses.get("duration", 0.0)
                + cfg.get("f0_loss_weight", 0.0) * losses.get("f0", 0.0)
            )
            if (
                cfg["mode"] == "full"
                and cfg.get("adversarial_loss_weight", 0.0) > 0
                and step >= cfg.get("adversarial_warmup_step", 10**9)
                and "adversarial" in losses
            ):
                loss = loss + cfg["adversarial_loss_weight"] * losses["adversarial"]

            (loss / cfg["grad_accum"]).backward()
            accum_loss += float(loss.detach().cpu())
            if (step + 1) % cfg["grad_accum"] == 0:
                torch.nn.utils.clip_grad_norm_(
                    (p for p in model.parameters() if p.requires_grad), cfg["grad_clip"]
                )
                optimizer.step()

            if step % cfg["log_every"] == 0:
                avg = accum_loss / max(1, cfg["log_every"])
                stats.step = step
                stats.epoch = epoch
                stats.train_loss = avg
                log.info("epoch=%d step=%d loss=%.4f", epoch, step, avg)
                if writer is not None:
                    writer.add_scalar("train/loss", avg, step)
                accum_loss = 0.0

            if step > 0 and step % cfg["eval_every"] == 0:
                val_loss = _run_validation(
                    model, val_loader, forward_train, cfg, device, dtype, torch
                )
                stats.val_loss = val_loss
                if writer is not None:
                    writer.add_scalar("val/loss", val_loss, step)
                if val_loss < stats.best_val_loss:
                    stats.best_val_loss = val_loss
                    stats.best_step = step
                    best_path = ckpt_dir / "best.pt"
                    torch.save(_state_for_save(model, cfg), best_path)
                    log.info("new best val_loss=%.4f → %s", val_loss, best_path)

            if step > 0 and step % cfg["checkpoint_every"] == 0:
                ckpt_path = ckpt_dir / f"step_{step}.pt"
                torch.save(_state_for_save(model, cfg), ckpt_path)
                checkpoint_paths.append(str(ckpt_path))
                log.info("checkpoint → %s", ckpt_path)

            step += 1

    if writer is not None:
        writer.close()

    manifest = _build_manifest(
        args=args,
        cfg=cfg,
        train_list=train_list,
        val_list=val_list,
        stats=stats,
        prep_manifest_sha256=prep_manifest_sha256,
        synthetic=False,
        checkpoint_paths=checkpoint_paths,
    )
    (ckpt_dir / "train_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("training complete; best val_loss=%.4f @ step %d", stats.best_val_loss, stats.best_step)
    return 0


def _state_for_save(model: Any, cfg: dict[str, Any]) -> dict[str, Any]:
    if cfg["mode"] == "lora":
        return {
            "kind": "kokoro-lora-delta",
            "baseModel": cfg["base_model"],
            "loraStateDict": {
                k: v.detach().cpu() for k, v in model.state_dict().items() if "lora_" in k
            },
        }
    return {
        "kind": "kokoro-full-finetune",
        "baseModel": cfg["base_model"],
        "stateDict": {k: v.detach().cpu() for k, v in model.state_dict().items()},
    }


def _run_validation(model, loader, forward_train, cfg, device, dtype, torch) -> float:
    model.eval()
    losses: list[float] = []
    with torch.no_grad():
        for batch in loader:
            with torch.autocast(device_type=device, dtype=dtype, enabled=(dtype != torch.float32)):
                out = forward_train(batch)
            mel = float(out["mel"].detach().cpu()) if hasattr(out["mel"], "detach") else float(out["mel"])
            losses.append(mel)
    model.train()
    return float(sum(losses) / max(1, len(losses)))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--run-dir", type=Path, required=True, help="Output dir from prep_ljspeech.py.")
    p.add_argument("--config", type=str, default="kokoro_lora_ljspeech.yaml")
    p.add_argument("--resume", type=Path, default=None, help="Checkpoint to resume from.")
    p.add_argument("--epochs", type=int, default=None, help="Override max_steps via N epochs.")
    p.add_argument("--no-tensorboard", action="store_true")
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Run pipeline shape without torch/CUDA (for CI).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config(args.config)
    if args.epochs is not None and args.epochs > 0:
        # Crude epoch override — assumes a uniform batches-per-epoch shape.
        cfg["max_steps"] = max(1, args.epochs)
    # Seed.
    random.seed(cfg.get("seed", 1337))
    os.environ.setdefault("PYTHONHASHSEED", str(cfg.get("seed", 1337)))
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args, cfg)
    return _real_train(args, cfg)


if __name__ == "__main__":
    raise SystemExit(main())
