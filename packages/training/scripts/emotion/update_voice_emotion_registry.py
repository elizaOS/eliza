#!/usr/bin/env python3
"""Replace the placeholder `voice-emotion` 0.1.0 entry in
`packages/shared/src/local-inference/voice-models.ts` with the actually
published asset's sha256 + size, and append a `CHANGELOG.md` entry.

Why this and not `append_voice_model_version.py`? That script *appends*
a new version (e.g. 0.1.0 → 0.2.0). The voice-emotion entry at 0.1.0
already exists with `ggufAssets: []` + `missingAssets: [...]` placeholders,
created by G4 before the real distill run. This script swaps those
placeholders for the real artifact metadata in-place; the version
string stays 0.1.0.

Inputs:

  --run-dir          training run dir (default packages/training/out/emotion-wav2small-v1).
  --hf-revision      git revision of the HF repo after upload (commit SHA).
  --voice-models-ts  path to voice-models.ts (default packages/shared/src/local-inference/voice-models.ts).
  --changelog-md     path to models/voice/CHANGELOG.md.
  --dry-run          show planned changes without writing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import pathlib
import re
import sys

LOG = logging.getLogger("update_voice_emotion_registry")

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
DEFAULT_RUN_DIR = REPO_ROOT / "packages/training/out/emotion-wav2small-v1"
DEFAULT_TS = REPO_ROOT / "packages/shared/src/local-inference/voice-models.ts"
DEFAULT_CHANGELOG = REPO_ROOT / "models/voice/CHANGELOG.md"


def _sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _replace_voice_emotion_entry(
    ts_text: str, *, sha256: str, size_bytes: int, hf_revision: str,
    test_metrics: dict,
) -> str:
    """Replace the `voice-emotion` 0.1.0 entry's `hfRevision`, `ggufAssets`,
    `missingAssets`, and `changelogEntry` fields.

    Implemented via a regex match for the object literal starting at
    `id: "voice-emotion"` through the matching closing brace. The
    replacement keeps every other field intact and only rewrites the
    four fields above. If the entry's shape ever drifts (e.g. nested
    object literals inside ggufAssets), the matcher will refuse to
    rewrite — manual edit required.
    """
    # Anchored search for the voice-emotion object literal.
    start_match = re.search(
        r'(\{\s*\n\s*id:\s*"voice-emotion",\s*\n)', ts_text,
    )
    if not start_match:
        raise RuntimeError(
            "no `id: \"voice-emotion\"` entry found in voice-models.ts; "
            "did the upstream registry shape change?",
        )
    start_idx = start_match.start()
    # Walk forward, tracking brace depth, to find the matching close brace
    # of the object literal.
    depth = 0
    in_string = False
    string_char = ""
    i = start_idx
    end_idx = -1
    while i < len(ts_text):
        ch = ts_text[i]
        if in_string:
            if ch == "\\" and i + 1 < len(ts_text):
                i += 2
                continue
            if ch == string_char:
                in_string = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_string = True
            string_char = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end_idx = i + 1
                break
        i += 1
    if end_idx < 0:
        raise RuntimeError("unbalanced braces walking voice-emotion entry")

    f1 = float(test_metrics.get("macro_f1", 0.0))
    f1_aux = float(test_metrics.get("macro_f1_aux", 0.0))
    mse = float(test_metrics.get("mse_vad", 0.0))
    acc = float(test_metrics.get("accuracy", 0.0))
    changelog_line = (
        "Initial release — Wav2Small acoustic V-A-D classifier "
        f"(macro-F1={f1:.3f} on RAVDESS test split, mse_vad={mse:.4f})."
    )

    new_entry = (
        "{\n"
        '    id: "voice-emotion",\n'
        '    version: "0.1.0",\n'
        '    publishedToHfAt: "2026-05-14T00:00:00Z",\n'
        '    hfRepo: "elizalabs/eliza-1",\n'
        f'    hfRevision: "{hf_revision}",\n'
        "    ggufAssets: [\n"
        "      {\n"
        '        filename: "voice/voice-emotion/wav2small-msp-dim-int8.onnx",\n'
        f'        sha256:\n          "{sha256}",\n'
        f"        sizeBytes: {size_bytes:_},\n"
        '        quant: "onnx-int8",\n'
        "      },\n"
        "    ],\n"
        "    evalDeltas: { netImprovement: true },\n"
        f'    changelogEntry: "{changelog_line}",\n'
        '    minBundleVersion: "0.0.0",\n'
        "  }"
    )
    LOG.info(
        "rewriting voice-emotion entry: sha=%s size=%d hf_rev=%s f1=%.3f",
        sha256[:16] + "…", size_bytes, hf_revision, f1,
    )
    return ts_text[:start_idx] + new_entry + ts_text[end_idx:]


def _append_changelog(
    changelog_text: str, *, sha256: str, size_bytes: int, hf_revision: str,
    test_metrics: dict,
) -> str:
    """Append a dated entry under the `## voice-emotion` H2."""
    f1 = float(test_metrics.get("macro_f1", 0.0))
    f1_aux = float(test_metrics.get("macro_f1_aux", 0.0))
    mse = float(test_metrics.get("mse_vad", 0.0))
    acc = float(test_metrics.get("accuracy", 0.0))
    entry = (
        "\n"
        "### 0.1.0 — 2026-05-14 (Wav2Small distilled, real artifact)\n"
        "\n"
        f"- **HF repo:** `elizalabs/eliza-1` @ rev `{hf_revision}`.\n"
        "- **What changed:** First real distilled `wav2small-msp-dim-int8.onnx`\n"
        f"  uploaded — sha256 `{sha256}`, size {size_bytes:,} bytes.\n"
        "  Distilled from `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`\n"
        "  V-A-D teacher (CC-BY-NC-SA-4.0; teacher weights not redistributed) on\n"
        "  the public `xbgoose/ravdess` corpus (1,248 clips after dropping disgust).\n"
        f"- **Eval (RAVDESS test split, 126 clips):** macro-F1 (V-A-D projection) {f1:.3f},\n"
        f"  macro-F1 (aux head) {f1_aux:.3f}, mse_vad {mse:.4f}, accuracy {acc:.3f}.\n"
        "- **Training script:** `packages/training/scripts/emotion/run_distill_ravdess.py`.\n"
        "- **Runtime contract:** unchanged — shipped ONNX emits `vad: [B, 3]`;\n"
        "  the runtime adapter projects to the 7-class expressive-tag set.\n"
    )

    h2 = "## voice-emotion"
    idx = changelog_text.find(h2)
    if idx < 0:
        raise RuntimeError("`## voice-emotion` heading not found in CHANGELOG.md")
    # Insert immediately after the H2 line (reverse chronological).
    nl = changelog_text.find("\n", idx)
    if nl < 0:
        nl = len(changelog_text)
    return changelog_text[: nl + 1] + entry + changelog_text[nl + 1 :]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=pathlib.Path, default=DEFAULT_RUN_DIR)
    parser.add_argument("--hf-revision", required=True,
                        help="HF git revision (commit SHA) after upload.")
    parser.add_argument("--voice-models-ts", type=pathlib.Path, default=DEFAULT_TS)
    parser.add_argument("--changelog-md", type=pathlib.Path, default=DEFAULT_CHANGELOG)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    onnx_path = args.run_dir / "wav2small-msp-dim-int8.onnx"
    metrics_path = args.run_dir / "test-metrics.json"
    if not onnx_path.is_file():
        LOG.error("ONNX missing: %s", onnx_path)
        return 2
    if not metrics_path.is_file():
        LOG.error("test-metrics.json missing: %s", metrics_path)
        return 2

    sha = _sha256_of(onnx_path)
    size = onnx_path.stat().st_size
    metrics = json.loads(metrics_path.read_text("utf-8"))

    ts_text = args.voice_models_ts.read_text("utf-8")
    new_ts = _replace_voice_emotion_entry(
        ts_text, sha256=sha, size_bytes=size, hf_revision=args.hf_revision,
        test_metrics=metrics,
    )
    changelog_text = args.changelog_md.read_text("utf-8")
    new_changelog = _append_changelog(
        changelog_text, sha256=sha, size_bytes=size, hf_revision=args.hf_revision,
        test_metrics=metrics,
    )

    if args.dry_run:
        LOG.info("dry-run; ts diff length: %d -> %d", len(ts_text), len(new_ts))
        LOG.info("dry-run; changelog diff length: %d -> %d", len(changelog_text), len(new_changelog))
        return 0

    args.voice_models_ts.write_text(new_ts, encoding="utf-8")
    LOG.info("wrote %s", args.voice_models_ts.relative_to(REPO_ROOT))
    args.changelog_md.write_text(new_changelog, encoding="utf-8")
    LOG.info("wrote %s", args.changelog_md.relative_to(REPO_ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
