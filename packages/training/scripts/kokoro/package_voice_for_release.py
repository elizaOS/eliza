#!/usr/bin/env python3
"""Wrap the fine-tune outputs into a publish-ready voice bundle.

Inputs:

  --run-dir   <run-dir>/ with checkpoints/best.pt, eval.json, kokoro.onnx,
                       voice.bin (typically all emitted by run_finetune.sh)

Outputs:

  <release-dir>/<voice_name>/
  ├── voice.bin                 # the 256-dim ref_s table, runtime-readable
  ├── kokoro.onnx               # the fine-tuned model (or a hard-link to base)
  ├── voice-preset.json         # the ELZ1 envelope (see voice-preset-format.ts)
  ├── eval.json                 # the gate report
  ├── manifest-fragment.json    # the catalog fragment for publish-time merge
  └── README.md                 # human-readable summary

The "voice-preset.json" envelope matches `voice-preset-format.ts` in the
runtime: it stores the voice id, display name, language, dim, tags, base
model, and a sha256 of voice.bin so the runtime can refuse corrupt packs.

This script intentionally does NOT edit `voice-presets.ts` or
`eliza1_platform_plan.py` in-place. Adding the voice to the runtime catalog
is a code-review step — the manifest-fragment.json is the artifact the
reviewer reads to decide what to merge.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.package")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _copy_if_present(src: Path, dst: Path) -> bool:
    if not src.exists():
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return True


def _voice_preset(
    *,
    voice_name: str,
    display_name: str,
    voice_lang: str,
    voice_tags: list[str],
    voice_bin: Path,
    base_model: str,
    synthetic: bool,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "kind": "elz1-voice-preset",
        "voiceId": voice_name,
        "displayName": display_name,
        "lang": voice_lang,
        "tags": voice_tags,
        "dim": 256,
        "buckets": 510,
        "engine": {
            "kind": "kokoro",
            "baseModel": base_model,
        },
        "blob": {
            "filename": voice_bin.name,
            "sha256": _sha256_file(voice_bin),
            "sizeBytes": voice_bin.stat().st_size,
        },
        "synthetic": synthetic,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _readme(*, voice_name: str, eval_report: dict[str, Any] | None) -> str:
    lines = [
        f"# Kokoro voice pack: {voice_name}",
        "",
        "Fine-tuned via `packages/training/scripts/kokoro/`.",
        "",
        "## Contents",
        "",
        "- `voice.bin` — 256-dim ref_s table, raw float32 LE, shape (510, 1, 256).",
        "- `kokoro.onnx` — fine-tuned model in onnx-community/Kokoro-82M-v1.0-ONNX layout.",
        "- `voice-preset.json` — ELZ1 voice envelope consumed by the runtime.",
        "- `manifest-fragment.json` — catalog fragment to merge at publish time.",
        "- `eval.json` — gate report (UTMOS, WER, speaker similarity, RTF).",
        "",
        "## Eval summary",
        "",
    ]
    if eval_report:
        m = eval_report.get("metrics", {})
        g = eval_report.get("gateResult", {})
        lines.extend(
            [
                f"- UTMOS: {m.get('utmos', 'n/a')}",
                f"- WER:   {m.get('wer', 'n/a')}",
                f"- SpkSim:{m.get('speaker_similarity', 'n/a')}",
                f"- RTF:   {m.get('rtf', 'n/a')}",
                f"- Gates passed: {g.get('passed')}",
                "",
            ]
        )
    else:
        lines.append("(eval.json not found)\n")
    lines.extend(
        [
            "## Runtime hand-off",
            "",
            "1. Copy the bundle into the per-tier release tree at "
            "`<bundle>/tts/<voice_name>/`.",
            "2. Append the `voice` block from `manifest-fragment.json` to "
            "`packages/app-core/src/services/local-inference/voice/kokoro/voice-presets.ts`.",
            "3. Re-run `packages/training/scripts/publish_all_eliza1.sh` "
            "with `--include-voice <voice_name>` (or pass the fragment to "
            "the publish flow per the readiness doc).",
        ]
    )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run-dir", type=Path, required=True)
    p.add_argument("--release-dir", type=Path, required=True)
    p.add_argument("--voice-name", required=True)
    p.add_argument("--voice-display-name", default=None)
    p.add_argument("--voice-lang", default="a")
    p.add_argument("--voice-tags", default="custom,eliza-1")
    p.add_argument("--base-model", default="hexgrad/Kokoro-82M")
    p.add_argument("--allow-missing", action="store_true")
    p.add_argument("--synthetic-smoke", action="store_true")
    args = p.parse_args(argv)

    run_dir = args.run_dir.resolve()
    release = args.release_dir.resolve() / args.voice_name
    release.mkdir(parents=True, exist_ok=True)

    voice_bin_src = run_dir / "voice.bin"
    onnx_src = run_dir / "kokoro.onnx"
    eval_src = run_dir / "eval.json"
    fragment_src = run_dir / "manifest-fragment.json"

    voice_bin_dst = release / "voice.bin"
    onnx_dst = release / "kokoro.onnx"
    eval_dst = release / "eval.json"
    fragment_dst = release / "manifest-fragment.json"

    have_bin = _copy_if_present(voice_bin_src, voice_bin_dst)
    have_onnx = _copy_if_present(onnx_src, onnx_dst)
    have_eval = _copy_if_present(eval_src, eval_dst)
    have_frag = _copy_if_present(fragment_src, fragment_dst)

    missing = []
    if not have_bin:
        missing.append("voice.bin")
    if not have_onnx:
        missing.append("kokoro.onnx")
    if not have_eval:
        missing.append("eval.json")
    if not have_frag:
        missing.append("manifest-fragment.json")
    if missing and not args.allow_missing and not args.synthetic_smoke:
        log.error("release bundle missing required artifacts: %s", missing)
        return 2
    if missing:
        log.warning("release bundle missing (allowed): %s", missing)
        if not have_bin:
            # Smoke: synthesize a zero voice.bin so voice-preset.json can hash it.
            import numpy as np  # noqa: PLC0415

            (np.zeros((510, 1, 256), dtype="<f4")).tofile(str(voice_bin_dst))
            have_bin = True

    preset = _voice_preset(
        voice_name=args.voice_name,
        display_name=args.voice_display_name or args.voice_name,
        voice_lang=args.voice_lang,
        voice_tags=args.voice_tags.split(","),
        voice_bin=voice_bin_dst,
        base_model=args.base_model,
        synthetic=args.synthetic_smoke,
    )
    (release / "voice-preset.json").write_text(json.dumps(preset, indent=2) + "\n")

    eval_report: dict[str, Any] | None = None
    if have_eval:
        try:
            eval_report = json.loads(eval_dst.read_text())
        except Exception:
            eval_report = None
    (release / "README.md").write_text(_readme(voice_name=args.voice_name, eval_report=eval_report))

    log.info("release bundle ready: %s", release)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
