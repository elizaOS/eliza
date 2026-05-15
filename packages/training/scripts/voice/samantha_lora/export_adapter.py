#!/usr/bin/env python3
"""Export a trained Samantha LoRA adapter into the runtime-friendly form.

Two output formats; pick one (or both):

  - ``--mode merged`` (default): merges the LoRA weights into the Kokoro
    base and emits a fresh ``af_same.bin`` (the canonical 510×1×256 fp32
    style tensor the runtime consumes via ``KokoroOnnxRuntime``). This is
    the path the Kokoro inference runtime understands today — no adapter
    plumbing in the FFI yet.

  - ``--mode adapter`` (forward-compat): writes the raw LoRA shards under
    ``out/adapter/`` for a future runtime that loads adapters separately.
    Useful for reproducibility / archive even though the current
    inference path can't consume it directly.

Both modes:

  - Write a manifest sidecar ``out/manifest.json`` recording: the base
    Kokoro version, the LoRA hyperparams, the training git SHA, the
    SHA256 + size of every produced artifact, and the eval gate
    expectations the publish script will check against.

Usage:

    python3 export_adapter.py \\
        --run-dir ~/eliza-training/samantha-lora-baseline \\
        --out ~/eliza-training/samantha-lora-baseline/out \\
        --mode merged

Exit codes:
    0  — export succeeded; out/ has artifacts + manifest.json.
    1  — pipeline error (missing checkpoint, bad shape, etc.).
    2  — invocation error.
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
from typing import Iterable

log = logging.getLogger("samantha_lora.export")

HERE = Path(__file__).resolve().parent
TRAINING_ROOT = HERE.parent.parent.parent
KOKORO_EXTRACT = TRAINING_ROOT / "scripts" / "kokoro" / "extract_voice_embedding.py"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_train_manifest(run_dir: Path) -> dict:
    path = run_dir / "train_manifest.json"
    if not path.is_file():
        raise SystemExit(
            f"[export_adapter] train_manifest.json missing at {path}. Did train_lora.py run?"
        )
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _resolve_best_checkpoint(run_dir: Path) -> Path:
    candidates = [
        run_dir / "checkpoints" / "best",
        run_dir / "checkpoints" / "best.pt",
    ]
    for c in candidates:
        if c.exists():
            return c
    # Otherwise pick the highest-step checkpoint.
    ckpts = sorted((run_dir / "checkpoints").glob("step_*"))
    if not ckpts:
        raise SystemExit(
            f"[export_adapter] no checkpoints under {run_dir / 'checkpoints'}. "
            "Train a LoRA via train_lora.py first."
        )
    return ckpts[-1]


def _export_merged(
    *, run_dir: Path, out_dir: Path, checkpoint: Path, voice_name: str
) -> dict:
    """Merge LoRA into base + write the runtime-shaped voice.bin via the
    existing extract_voice_embedding.py mel-fit path. The path was
    designed exactly for emitting `af_<name>.bin` style tensors that the
    KokoroOnnxRuntime consumes — we re-use it here rather than
    reinventing the merge math.
    """
    if not KOKORO_EXTRACT.is_file():
        raise SystemExit(
            f"[export_adapter] kokoro extract script missing at {KOKORO_EXTRACT}. "
            "Layout changed — update export_adapter.py."
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    voice_bin = out_dir / f"{voice_name}.bin"

    cmd = [
        sys.executable,
        str(KOKORO_EXTRACT),
        "--clips-dir",
        str(run_dir / "processed" / "wavs_norm"),
        "--out",
        str(voice_bin),
        "--init-from-voice",
        "af_bella",
        "--lora-checkpoint",
        str(checkpoint),
        "--steps",
        "400",
    ]
    log.info("merging LoRA into base via extract_voice_embedding.py: %s", " ".join(cmd))
    rc = subprocess.call(cmd)
    if rc != 0:
        raise SystemExit(f"[export_adapter] merge failed: extract returned {rc}")

    return {
        "format": "kokoro_voice_bin",
        "filename": voice_bin.name,
        "sha256": _sha256(voice_bin),
        "size_bytes": voice_bin.stat().st_size,
    }


def _export_adapter_shards(
    *, checkpoint: Path, out_dir: Path
) -> dict:
    """Copy the raw PEFT shards to out/adapter/ for archive."""
    import shutil

    target = out_dir / "adapter"
    target.mkdir(parents=True, exist_ok=True)
    if checkpoint.is_dir():
        for entry in sorted(checkpoint.iterdir()):
            shutil.copy2(entry, target / entry.name)
    else:
        shutil.copy2(checkpoint, target / checkpoint.name)

    files = []
    for f in sorted(target.glob("*")):
        if f.is_file():
            files.append(
                {"filename": f.name, "sha256": _sha256(f), "size_bytes": f.stat().st_size}
            )
    return {"format": "peft_lora_shards", "files": files}


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--mode",
        choices=("merged", "adapter", "both"),
        default="merged",
    )
    parser.add_argument(
        "--voice-name",
        default="af_same",
        help="Kokoro voice id the merged voice.bin targets.",
    )
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=None,
        help="Specific checkpoint to export. Defaults to checkpoints/best (or the latest step).",
    )
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    run_dir = args.run_dir.resolve()
    out_dir = args.out.resolve()

    train_manifest = _load_train_manifest(run_dir)
    checkpoint = args.checkpoint.resolve() if args.checkpoint else _resolve_best_checkpoint(run_dir)
    log.info("exporting from checkpoint: %s", checkpoint)

    artifacts: list[dict] = []
    if args.mode in ("merged", "both"):
        artifacts.append(
            _export_merged(
                run_dir=run_dir,
                out_dir=out_dir,
                checkpoint=checkpoint,
                voice_name=args.voice_name,
            )
        )
    if args.mode in ("adapter", "both"):
        artifacts.append(
            _export_adapter_shards(checkpoint=checkpoint, out_dir=out_dir)
        )

    manifest = {
        "schema": "samantha_lora.export_manifest.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "voice_name": args.voice_name,
        "mode": args.mode,
        "checkpoint": str(checkpoint),
        "train_manifest": train_manifest,
        "artifacts": artifacts,
        "publish_gates": {
            # Mirrored to publish_samantha.sh — values must agree between
            # the two; the publish script reads these as the floor.
            "speaker_similarity_min": 0.55,
            "wer_max": 0.10,
            "utmos_min": 3.5,
            "rtf_min": 5.0,
        },
    }
    out_manifest = out_dir / "manifest.json"
    out_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log.info("wrote export manifest: %s", out_manifest)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
