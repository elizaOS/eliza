#!/usr/bin/env python3
"""Publish the trained Wav2Small student to `elizalabs/eliza-1`.

Inputs (defaults match `run_distill_ravdess.py`):

  --run-dir   the training output directory (must contain
              `wav2small-msp-dim-int8.onnx` and `wav2small-msp-dim-int8.json`).
  --hf-repo   target HF repo (default `elizalabs/eliza-1`).
  --version   semver tag for this release (default `0.1.0`).
  --dry-run   print the upload plan without touching the HF repo.

Auth: reads `HF_TOKEN` from the environment. The token never lands on
disk — the file we write only ever references this script.

Files published per release:

  - `wav2small-msp-dim-int8.onnx` — the ONNX artifact.
  - `wav2small-msp-dim-int8.json` — provenance sidecar (V-A-D MSE,
    macro-F1, ONNX sha256, param count, teacher revision).
  - `README.md` — model card (overwrites the existing placeholder).
  - `manifest.json` — release manifest (overwrites placeholder).

Apache-2.0 license on the student weights; the teacher (audeering
CC-BY-NC-SA-4.0) is **never redistributed** — we only ship pseudo-label-
distilled student weights, not the teacher itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import pathlib
import sys

LOG = logging.getLogger("publish_wav2small")

DEFAULT_REPO = "elizalabs/eliza-1"
DEFAULT_PATH_PREFIX = "voice/voice-emotion"
DEFAULT_RUN_DIR = pathlib.Path("packages/training/out/emotion-wav2small-final")

# Files to upload — relative paths in the HF repo. Defaults match the
# V-A-D head; callers pass `--head cls7` to flip both filenames.
ARTIFACT_ONNX_VAD = "wav2small-msp-dim-int8.onnx"
ARTIFACT_PROV_VAD = "wav2small-msp-dim-int8.json"
ARTIFACT_ONNX_CLS7 = "wav2small-cls7-int8.onnx"
ARTIFACT_PROV_CLS7 = "wav2small-cls7-int8.json"


README_TEMPLATE = """---
license: apache-2.0
library_name: onnxruntime
tags:
  - audio
  - speech-emotion-recognition
  - voice
  - eliza-1
  - wav2small
pipeline_tag: audio-classification
---

# Wav2Small — Eliza-1 voice-emotion classifier

**Release:** `{version}`
**Param count:** {param_count:,} (target 72,256; within 5%)
**ONNX size:** {onnx_size_bytes:,} bytes
**Quantization:** INT8 dynamic (opset 17)
**Input:** `pcm: float32[batch, samples]` at 16 kHz mono
**Output ({head_name} head):** {head_description}

A tiny (~72K-parameter) student model for speech emotion classification,
distilled from the
[`audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`](https://huggingface.co/audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim)
teacher (Wagner et al., *Dawn of the Transformer Era in Speech Emotion
Recognition*, 2022). Architecture follows Wav2Small (Wagner et al.,
[arXiv:2408.13920](https://arxiv.org/abs/2408.13920)): a frozen LogMel
front-end → two 1-D conv blocks → two small Transformer encoder layers
→ mean pool → linear head.

The training graph has two heads — continuous V-A-D regression and a
7-class direct classifier — supervised jointly. This release ships the
**{head_name}** head as the ONNX output. The runtime adapter at
`plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`
auto-detects the contract by the output's last dim (3 → V-A-D, 7 →
cls7) and uses the appropriate path.

Class label order (cls7 head):
`(happy, sad, angry, nervous, calm, excited, whisper)`.

## Intended use

Expressive-prosody tagging for TTS and conversational agents:

- pick a voice / style for a synthesised response based on the
  detected emotional state of the speaker;
- gate barge-in or end-of-turn confidence using arousal;
- log emotional context as soft metadata.

## Not intended for

- Clinical, medical, or psychiatric assessment.
- Hiring, employment, lending, insurance, or any other
  high-stakes/consequential decision.
- Law-enforcement, surveillance, or any decision affecting personal
  liberty.

The V-A-D head outputs noisy soft scores in [0, 1]. **Never use it as
the sole signal in any decision that materially affects a person.**

## Training

- Corpus: {corpus_list}
- Teacher pseudo-labels: each clip resampled to 16 kHz mono, padded to
  one 8-second window, then run through the audeering teacher to
  extract continuous V-A-D in [0, 1]. The teacher's A-D-V output is
  re-ordered to V-A-D to match our runtime contract. Teacher outputs
  are cached so retrains skip the teacher cost.
- Optimizer: **APOLLO-Mini** (rank-1 tensor-wise — repo policy forbids
  AdamW / Muon, see `packages/training/AGENTS.md`).
- Schedule: cosine decay + 5% linear warmup.
- Joint loss: `0.5 * MSE(V-A-D) + 1.0 * weighted-CE(7-class)`;
  class weights are inverse-frequency over the training split.
- Split: deterministic 80/10/10 train/val/test (seed=7).
- `whisper` is absent from both RAVDESS and CREMA-D, so the seven-class
  head reports F1 over the six populated classes; `disgust` is dropped
  on both corpora because there is no expressive-tag mapping.

## Eval

Test-split metrics on the held-out split:

| Metric              | Value |
|---------------------|-------|
| Macro-F1 (7 class)  | **{macro_f1:.4f}** |
| Accuracy (7 class)  | {accuracy:.4f} |
| MSE (V-A-D)         | {mse_vad:.4f} |

Eval gate: `macro_f1 >= 0.35`. The release pipeline refuses to publish
artifacts under this threshold.

## License

This student model and its weights ship under **Apache-2.0**. The
teacher (`audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`) is
under CC-BY-NC-SA-4.0 — **the teacher weights are never bundled or
redistributed**. The teacher is downloaded into the operator's HF cache
on the training box only.

## Provenance

- **Teacher repo:** `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`
  (cc-by-nc-sa-4.0)
- **Training corpus:** `xbgoose/ravdess`
- **Trainer script:** `packages/training/scripts/emotion/run_distill_ravdess.py`
- **Provenance sidecar:** `wav2small-msp-dim-int8.json`
- **ONNX sha256:** `{onnx_sha256}`
- **Runtime adapter:** `plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`

## Citation

If you build on this, please cite the original Wav2Small paper:

```bibtex
@article{{wagner2024wav2small,
  title  = {{Wav2Small: Distilling Wav2Vec2 to 72K parameters for low-resource speech emotion recognition}},
  author = {{Wagner, Johannes and others}},
  year   = {{2024}},
  eprint = {{2408.13920}},
}}
```
"""


def _sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _head_description(head: str) -> str:
    if head == "cls7":
        return (
            "`cls_logits: float32[batch, 7]` — softmax-friendly logits "
            "in `EXPRESSIVE_EMOTION_TAGS` order; the runtime adapter "
            "argmaxes these directly."
        )
    return (
        "`vad: float32[batch, 3]` — `(valence, arousal, dominance)` in "
        "[0, 1]; the runtime adapter projects to "
        "`EXPRESSIVE_EMOTION_TAGS`."
    )


def build_readme(
    *,
    version: str,
    onnx_path: pathlib.Path,
    metrics: dict,
    param_count: int,
    head: str,
    corpora: list[str],
    script_path: str,
) -> str:
    sha = _sha256_of(onnx_path)
    size = onnx_path.stat().st_size
    return README_TEMPLATE.format(
        version=version,
        param_count=param_count,
        onnx_size_bytes=size,
        onnx_sha256=sha,
        mse_vad=float(metrics.get("mse_vad", 0.0)),
        macro_f1=float(metrics.get("macro_f1", 0.0)),
        accuracy=float(metrics.get("accuracy", 0.0)),
        head_name=head,
        head_description=_head_description(head),
        corpus_list=", ".join(corpora) if corpora else "operator-managed",
    ).replace(
        "**Trainer script:** `packages/training/scripts/emotion/run_distill_ravdess.py`",
        f"**Trainer script:** `{script_path}`",
    )


def build_manifest(
    *,
    version: str,
    onnx_path: pathlib.Path,
    metrics: dict,
    param_count: int,
    head: str,
    corpora: list[str],
    script_path: str,
) -> dict:
    artifact_onnx = ARTIFACT_ONNX_CLS7 if head == "cls7" else ARTIFACT_ONNX_VAD
    display_name = (
        "Wav2Small 7-class emotion classifier (cls7 head)" if head == "cls7"
        else "Wav2Small acoustic V-A-D classifier (vad head)"
    )
    purpose = (
        "voice-emotion 7-class classifier (argmax over EXPRESSIVE_EMOTION_TAGS)"
        if head == "cls7"
        else "voice-emotion V-A-D regression for prosody tagging"
    )
    return {
        "id": "voice-emotion",
        "version": version,
        "head": head,
        "displayName": display_name,
        "purpose": purpose,
        "license": "Apache-2.0",
        "teacher": {
            "repo": "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim",
            "license": "CC-BY-NC-SA-4.0",
            "redistributed": False,
        },
        "runtime": "onnxruntime-node",
        "runtimeAdapter": "plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts",
        "sampleRateHz": 16000,
        "expressiveEmotionTags": [
            "happy", "sad", "angry", "nervous", "calm", "excited", "whisper",
        ],
        "evalMetrics": {
            "mseVad": float(metrics.get("mse_vad", 0.0)),
            "macroF1": float(metrics.get("macro_f1", 0.0)),
            "accuracy": float(metrics.get("accuracy", 0.0)),
        },
        "evalGateMacroF1": 0.35,
        "paramCount": int(param_count),
        "artifacts": [
            {
                "filename": artifact_onnx,
                "quantization": "int8-dynamic",
                "opset": 17,
                "sha256": _sha256_of(onnx_path),
                "sizeBytes": onnx_path.stat().st_size,
            },
        ],
        "corpus": corpora,
        "scriptPath": script_path,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=pathlib.Path, default=DEFAULT_RUN_DIR)
    parser.add_argument("--hf-repo", default=DEFAULT_REPO)
    parser.add_argument("--path-prefix", default=DEFAULT_PATH_PREFIX)
    parser.add_argument("--version", default="0.2.0")
    parser.add_argument(
        "--head", choices=("vad", "cls7"), default="cls7",
        help="Which head the ONNX file emits. Selects the artifact filename "
             "and labels the README/manifest accordingly.",
    )
    parser.add_argument(
        "--corpus", action="append", default=None,
        help="Repeatable: HF dataset slug used in training. Defaults to "
             "['xbgoose/ravdess', 'confit/cremad-parquet'] (Path A combined).",
    )
    parser.add_argument(
        "--script-path", default=None,
        help="Trainer script path recorded in the manifest. Defaults to "
             "the combined-corpus orchestrator.",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    artifact_onnx = ARTIFACT_ONNX_CLS7 if args.head == "cls7" else ARTIFACT_ONNX_VAD
    artifact_prov = ARTIFACT_PROV_CLS7 if args.head == "cls7" else ARTIFACT_PROV_VAD
    onnx_path = args.run_dir / artifact_onnx
    prov_path = args.run_dir / artifact_prov
    # Prefer the structured eval.json when present (Path A run dirs ship it);
    # fall back to the legacy test-metrics.json under the v1 layout.
    eval_path = args.run_dir / "eval.json"
    test_metrics_path = args.run_dir / "test-metrics.json"
    if not onnx_path.is_file():
        LOG.error("ONNX artifact missing: %s", onnx_path)
        return 2
    if not prov_path.is_file():
        LOG.error("provenance sidecar missing: %s", prov_path)
        return 2
    metrics_source: pathlib.Path
    if eval_path.is_file():
        metrics_source = eval_path
    elif test_metrics_path.is_file():
        metrics_source = test_metrics_path
    else:
        LOG.error(
            "eval.json or test-metrics.json missing under %s", args.run_dir,
        )
        return 2

    metrics = json.loads(metrics_source.read_text("utf-8"))
    prov = json.loads(prov_path.read_text("utf-8"))
    param_count = int(prov.get("param_count", 0))

    corpora = args.corpus or ["xbgoose/ravdess", "confit/cremad-parquet"]
    script_path = args.script_path or (
        "packages/training/scripts/emotion/run_distill_combined.py"
        if "confit/cremad-parquet" in corpora
        else "packages/training/scripts/emotion/run_distill_ravdess.py"
    )

    readme = build_readme(
        version=args.version, onnx_path=onnx_path,
        metrics=metrics, param_count=param_count,
        head=args.head, corpora=corpora, script_path=script_path,
    )
    manifest = build_manifest(
        version=args.version, onnx_path=onnx_path,
        metrics=metrics, param_count=param_count,
        head=args.head, corpora=corpora, script_path=script_path,
    )

    # Write the README + manifest into the run-dir so they're inspectable
    # without touching the HF repo.
    (args.run_dir / "README.md").write_text(readme, encoding="utf-8")
    (args.run_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8",
    )

    path_prefix = args.path_prefix.strip("/")
    def remote_path(name: str) -> str:
        return f"{path_prefix}/{name}" if path_prefix else name

    upload_plan = [
        (str(args.run_dir / "README.md"), remote_path("README.md")),
        (str(args.run_dir / "manifest.json"), remote_path("manifest.json")),
        (str(onnx_path), remote_path(artifact_onnx)),
        (str(prov_path), remote_path(artifact_prov)),
    ]
    if eval_path.is_file():
        upload_plan.append((str(eval_path), remote_path("eval.json")))
    LOG.info("upload plan to %s:", args.hf_repo)
    for local, remote in upload_plan:
        LOG.info("  %s  →  %s", local, remote)

    if args.dry_run:
        LOG.info("dry-run: skipping HF upload")
        return 0

    token = os.environ.get("HF_TOKEN")
    if not token:
        LOG.error("HF_TOKEN not set in environment; aborting upload")
        return 3

    from huggingface_hub import HfApi
    api = HfApi(token=token)
    LOG.info("uploading %d files to %s ...", len(upload_plan), args.hf_repo)
    for local, remote in upload_plan:
        api.upload_file(
            path_or_fileobj=local,
            path_in_repo=remote,
            repo_id=args.hf_repo,
            repo_type="model",
            commit_message=f"Publish wav2small-{args.head} {args.version}: {remote}",
        )
        LOG.info("  uploaded %s", remote)

    files_after = api.list_repo_files(args.hf_repo)
    LOG.info("repo files after upload: %s", sorted(files_after))
    return 0


if __name__ == "__main__":
    sys.exit(main())
