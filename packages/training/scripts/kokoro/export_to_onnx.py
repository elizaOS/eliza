#!/usr/bin/env python3
"""Export a fine-tuned Kokoro checkpoint to ONNX.

The runtime's Kokoro inference backend
(`packages/app-core/src/services/local-inference/voice/kokoro/`) loads ONNX
artifacts in the same layout as `onnx-community/Kokoro-82M-v1.0-ONNX`:

    <out-dir>/
    ├── kokoro.onnx        # full model (or model_q4.onnx / model_fp16.onnx)
    ├── tokens_to_phonemes.json   # phoneme vocab the tokenizer uses
    └── voice.bin          # ref_s table (from extract_voice_embedding.py)

This script:

1. Loads the base model from `--base-model` (or local dir).
2. Optionally applies the LoRA delta from `--lora-checkpoint`.
3. Traces the forward path with example phoneme + ref_s inputs.
4. Writes the ONNX file at `--out-dir/kokoro.onnx`.
5. Emits a manifest fragment (`--out-dir/manifest-fragment.json`) that the
   Eliza-1 catalog publish flow can stitch into the bundle (see
   `package_voice_for_release.py` for the final voice-preset packaging).

Synthetic-smoke mode (`--synthetic-smoke`) writes a minimal-but-valid ONNX
placeholder (a single identity node) so downstream wiring tests pass without
torch or a real model.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.export")


def _manifest_fragment(
    *,
    voice_name: str,
    voice_display_name: str,
    voice_lang: str,
    voice_tags: list[str],
    onnx_path: Path,
    voice_bin_path: Path | None,
    base_model: str,
    synthetic: bool,
    lora_checkpoint: Path | None,
) -> dict[str, Any]:
    """Return a fragment that slots into the Eliza-1 catalog under `voices`.

    Schema mirrors the runtime preset format documented in
    `packages/app-core/src/services/local-inference/voice/voice-preset-format.ts`
    (see also voice-presets.ts for the bundled voice catalog shape).
    """
    return {
        "schemaVersion": 1,
        "kind": "eliza-1-kokoro-voice-fragment",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": synthetic,
        "voice": {
            "id": voice_name,
            "displayName": voice_display_name,
            "lang": voice_lang,
            "file": f"tts/{voice_name}.bin",
            "dim": 256,
            "tags": voice_tags,
        },
        "engine": {
            "kind": "kokoro",
            "onnxPath": f"tts/{onnx_path.name}",
            "baseModel": base_model,
            "loraCheckpoint": (str(lora_checkpoint) if lora_checkpoint else None),
        },
        "artifacts": [
            {"role": "voice-onnx", "path": f"tts/{onnx_path.name}"},
            {
                "role": "voice-preset",
                "path": f"tts/{voice_bin_path.name}" if voice_bin_path else None,
            },
        ],
        "integration": {
            "runtimeBackendDir": (
                "packages/app-core/src/services/local-inference/voice/kokoro/"
            ),
            "voicePresetFormat": (
                "packages/app-core/src/services/local-inference/voice/voice-preset-format.ts"
            ),
            "catalogTable": (
                "packages/app-core/src/services/local-inference/voice/kokoro/voice-presets.ts"
            ),
            "notes": (
                "Append the `voice` block to KOKORO_VOICE_PACKS, copy the .onnx + "
                ".bin into the per-tier bundle under tts/, and re-run the publish "
                "preflight (packages/training/scripts/publish_all_eliza1.sh)."
            ),
        },
    }


def _write_synthetic_onnx(path: Path) -> None:
    """Emit a minimal-but-valid ONNX file (one Identity node) for smoke runs."""
    import numpy as np  # noqa: PLC0415
    import onnx  # noqa: PLC0415
    from onnx import TensorProto, helper  # noqa: PLC0415

    x = helper.make_tensor_value_info("phonemes", TensorProto.INT64, ["batch", "seq"])
    y = helper.make_tensor_value_info("audio", TensorProto.INT64, ["batch", "seq"])
    node = helper.make_node("Identity", inputs=["phonemes"], outputs=["audio"])
    graph = helper.make_graph([node], "kokoro_smoke", [x], [y])
    opset = onnx.helper.make_opsetid("", 17)
    model = helper.make_model(graph, opset_imports=[opset])
    model.ir_version = 8
    onnx.save(model, str(path))


def _run_synthetic_smoke(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "kokoro.onnx"
    try:
        _write_synthetic_onnx(onnx_path)
    except ImportError as exc:
        raise SystemExit(
            "synthetic-smoke needs the `onnx` package; install via "
            "`pip install onnx>=1.17.0`."
        ) from exc

    fragment = _manifest_fragment(
        voice_name=args.voice_name,
        voice_display_name=args.voice_display_name,
        voice_lang=args.voice_lang,
        voice_tags=args.voice_tags.split(",") if args.voice_tags else [],
        onnx_path=onnx_path,
        voice_bin_path=Path(args.voice_bin) if args.voice_bin else None,
        base_model=args.base_model,
        synthetic=True,
        lora_checkpoint=Path(args.lora_checkpoint) if args.lora_checkpoint else None,
    )
    frag_path = out_dir / "manifest-fragment.json"
    frag_path.write_text(json.dumps(fragment, indent=2) + "\n")
    log.info("synthetic-smoke wrote %s + %s", onnx_path, frag_path)
    return 0


def _real_export(args: argparse.Namespace) -> int:
    try:
        import torch  # noqa: PLC0415
        from kokoro import KModel  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "Real export needs torch + the `kokoro` package."
        ) from exc

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "kokoro.onnx"

    device = "cpu"  # ONNX export is faster + more portable on CPU.
    model = KModel(repo_id=args.base_model).to(device).eval()

    if args.lora_checkpoint:
        ckpt = torch.load(str(args.lora_checkpoint), map_location=device)
        if ckpt.get("kind") not in ("kokoro-lora-delta", "kokoro-full-finetune"):
            log.warning(
                "checkpoint kind=%r is unexpected; proceeding optimistically", ckpt.get("kind")
            )
        state = ckpt.get("loraStateDict") or ckpt.get("stateDict") or {}
        missing, unexpected = model.load_state_dict(state, strict=False)
        log.info("loaded checkpoint: missing=%d unexpected=%d", len(missing), len(unexpected))

    # Dummy inputs matching Kokoro's expected forward signature. The exact shape
    # depends on the kokoro package version; the community ONNX export uses
    # (batch=1, seq) int64 phoneme ids + a (256,) ref_s float32 + speed scalar.
    phonemes = torch.zeros((1, 32), dtype=torch.long)
    ref_s = torch.zeros((1, 256), dtype=torch.float32)
    speed = torch.tensor(1.0, dtype=torch.float32)

    forward = getattr(model, "forward_inference", None) or model.forward
    torch.onnx.export(
        model,
        (phonemes, ref_s, speed),
        str(onnx_path),
        input_names=["phonemes", "ref_s", "speed"],
        output_names=["audio"],
        dynamic_axes={
            "phonemes": {0: "batch", 1: "seq"},
            "ref_s": {0: "batch"},
            "audio": {0: "batch", 1: "audio_len"},
        },
        opset_version=17,
        do_constant_folding=True,
    )
    log.info("wrote %s", onnx_path)

    fragment = _manifest_fragment(
        voice_name=args.voice_name,
        voice_display_name=args.voice_display_name,
        voice_lang=args.voice_lang,
        voice_tags=args.voice_tags.split(",") if args.voice_tags else [],
        onnx_path=onnx_path,
        voice_bin_path=Path(args.voice_bin) if args.voice_bin else None,
        base_model=args.base_model,
        synthetic=False,
        lora_checkpoint=Path(args.lora_checkpoint) if args.lora_checkpoint else None,
    )
    frag_path = out_dir / "manifest-fragment.json"
    frag_path.write_text(json.dumps(fragment, indent=2) + "\n")
    log.info("wrote manifest fragment %s", frag_path)
    # forward var marks the optional inference path; reference to keep linters quiet
    _ = forward
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--base-model", default="hexgrad/Kokoro-82M")
    p.add_argument("--lora-checkpoint", type=Path, default=None)
    p.add_argument("--voice-bin", type=Path, default=None, help="Companion voice.bin path.")
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--voice-name", default="eliza_custom")
    p.add_argument("--voice-display-name", default="Eliza Custom Voice")
    p.add_argument("--voice-lang", default="a")
    p.add_argument("--voice-tags", default="custom,eliza-1")
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Write a minimal placeholder ONNX without torch (CI smoke).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.synthetic_smoke:
        return _run_synthetic_smoke(args)
    return _real_export(args)


if __name__ == "__main__":
    raise SystemExit(main())
