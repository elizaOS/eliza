#!/usr/bin/env python3
"""L-kokoro-distill — prep sam-distill corpus for finetune_kokoro_full.py.

The sam-distill output of synthesize_distillation_corpus_omnivoice.py +
extend_sam_distill.py is already 24 kHz mono PCM16 LUFS-normalized, so
we don't need prep_ljspeech.py's resample+LUFS step. We just need to:

  1. Symlink (or copy) wavs into <run-dir>/processed/wavs_norm/.
  2. Write <run-dir>/processed/train_list.txt + val_list.txt in the
     `wavs_norm/<id>.wav|<phonemes>|0` format.
  3. Write <run-dir>/processed/phonemes.jsonl with one record per clip
     (clip_id, raw_text, norm_text, phonemes) — misaki[en] g2p.
  4. Write <run-dir>/processed/prep_manifest.json describing the run.

Usage::

    python3 prep_sam_distill.py \\
        --corpus-dir packages/training/data/voice/sam-distill \\
        --run-dir /tmp/kokoro-runs/sam-distilled-v1 \\
        --voice-lang a
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.prep_sam_distill")


def _phonemize_all(items: list[dict], lang: str) -> list[str]:
    from misaki import en  # type: ignore  # noqa: PLC0415

    g2p = en.G2P(trf=False, british=(lang == "b"))
    phonemes: list[str] = []
    for i, rec in enumerate(items):
        text = rec.get("raw_text") or rec.get("norm_text") or ""
        p, _ = g2p(text)
        phonemes.append(p)
        if (i + 1) % 100 == 0:
            log.info("phonemized %d/%d", i + 1, len(items))
    return phonemes


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--corpus-dir", type=Path, required=True,
                   help="sam-distill dir containing wavs_norm/, manifest, train/val lists.")
    p.add_argument("--run-dir", type=Path, required=True,
                   help="Output run dir (will contain processed/).")
    p.add_argument("--voice-lang", type=str, default="a",
                   help="Misaki lang code: 'a' = US English (Kokoro default).")
    p.add_argument("--symlink", action="store_true", default=True,
                   help="Symlink wavs into processed/wavs_norm/ (default; otherwise copy).")
    args = p.parse_args(argv)

    corpus = args.corpus_dir.resolve()
    run_dir = args.run_dir.resolve()
    processed = run_dir / "processed"
    processed.mkdir(parents=True, exist_ok=True)
    out_wavs = processed / "wavs_norm"
    out_wavs.mkdir(exist_ok=True)

    train_in = corpus / "train_list.txt"
    val_in = corpus / "val_list.txt"
    manifest_in = corpus / "synthesis_manifest.jsonl"

    if not train_in.exists() or not val_in.exists() or not manifest_in.exists():
        log.error(
            "corpus missing required files: train=%s val=%s manifest=%s",
            train_in.exists(), val_in.exists(), manifest_in.exists(),
        )
        return 2

    # Load manifest — gives us raw_text + norm_text per clip.
    by_id: dict[str, dict] = {}
    with manifest_in.open() as fh:
        for line in fh:
            if not line.strip():
                continue
            rec = json.loads(line)
            by_id[rec["id"]] = rec

    train_lines = [l for l in train_in.read_text().splitlines() if l.strip()]
    val_lines = [l for l in val_in.read_text().splitlines() if l.strip()]
    log.info("loaded %d train / %d val lines, %d manifest records",
             len(train_lines), len(val_lines), len(by_id))

    # Collect clip ids needed.
    needed_ids: set[str] = set()
    for line in train_lines + val_lines:
        wav_rel = line.split("|", 1)[0]
        cid = Path(wav_rel).stem
        needed_ids.add(cid)

    # Symlink/copy wavs.
    n_linked = 0
    n_missing = 0
    for cid in needed_ids:
        src = corpus / "wavs_norm" / f"{cid}.wav"
        dst = out_wavs / f"{cid}.wav"
        if not src.exists():
            log.warning("source wav missing: %s", src)
            n_missing += 1
            continue
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        if args.symlink:
            os.symlink(src, dst)
        else:
            dst.write_bytes(src.read_bytes())
        n_linked += 1
    log.info("linked %d wavs (%d missing)", n_linked, n_missing)

    # Build records for phonemization.
    ordered_ids = sorted(needed_ids)
    items = []
    for cid in ordered_ids:
        rec = by_id.get(cid)
        if rec is None:
            log.warning("no manifest record for %s; skipping", cid)
            continue
        items.append({
            "clip_id": cid,
            "raw_text": rec.get("transcript", ""),
            "norm_text": rec.get("norm_text", ""),
        })
    log.info("phonemizing %d unique items via misaki[en]", len(items))
    phonemes = _phonemize_all(items, args.voice_lang)
    for it, ph in zip(items, phonemes):
        it["phonemes"] = ph

    # phonemes.jsonl
    with (processed / "phonemes.jsonl").open("w", encoding="utf-8") as fh:
        for it in items:
            fh.write(json.dumps(it, ensure_ascii=False) + "\n")

    # train_list / val_list — keep prior assignment but resolve to the same
    # `wavs_norm/<id>.wav|<phonemes>|0` shape finetune_kokoro_full expects.
    phon_by_id = {it["clip_id"]: it["phonemes"] for it in items}

    def _rewrite(lines: list[str]) -> list[str]:
        out = []
        for line in lines:
            wav_rel = line.split("|", 1)[0]
            cid = Path(wav_rel).stem
            ph = phon_by_id.get(cid)
            if ph is None:
                continue
            out.append(f"wavs_norm/{cid}.wav|{ph}|0")
        return out

    train_out = _rewrite(train_lines)
    val_out = _rewrite(val_lines)
    (processed / "train_list.txt").write_text("\n".join(train_out) + "\n", encoding="utf-8")
    (processed / "val_list.txt").write_text("\n".join(val_out) + "\n", encoding="utf-8")
    log.info("wrote train=%d val=%d processed lists", len(train_out), len(val_out))

    # Manifest.
    manifest = {
        "schemaVersion": 1,
        "kind": "kokoro-prep-manifest",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": True,
        "input": {
            "corpusDir": str(corpus),
            "synthSummaryPath": str(corpus / "synthesis_summary.json"),
        },
        "output": {
            "runDir": str(run_dir),
            "processedDir": str(processed),
            "trainListPath": str(processed / "train_list.txt"),
            "valListPath": str(processed / "val_list.txt"),
        },
        "voiceName": "af_sam",
        "voiceLang": args.voice_lang,
        "sampleRate": 24000,
        "phonemizer": "misaki_en",
        "stats": {
            "totalClips": n_linked,
            "trainClips": len(train_out),
            "valClips": len(val_out),
        },
        "note": (
            "Built by prep_sam_distill.py from OmniVoice-sam distillation corpus. "
            "Wavs were pre-normalized to 24 kHz mono PCM16 LUFS=-23 during synthesis "
            "so prep_ljspeech.py's resample/LUFS pass was skipped."
        ),
    }
    (processed / "prep_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log.info("prep manifest: %s", processed / "prep_manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
