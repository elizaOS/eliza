#!/usr/bin/env python3
"""Push fine-tuned turn-detector artifacts to ``elizaos/eliza-1``.

Uploads (per locale):

  - ``<bundle>/model_q8.onnx`` — quantised ONNX from ``export_onnx``.
  - ``<bundle>/turn-detector-<locale>-q8.gguf`` — GGUF from
    ``convert_to_gguf.py`` (optional; only if present).
  - ``<bundle>/tokenizer.json``, ``tokenizer_config.json``, ``config.json``
    + the rest of the LiveKit sidecar set (via
    ``export_tokenizer_artifacts``).
  - ``<bundle>/eval.json`` — gate report from ``eval_turn_detector.py``.
  - ``README.md`` — model card, written under ``voice/turn-detector``.
  - ``manifest.json`` — updates the existing manifest with real
    ``files[]`` SHA + size for the uploaded locale variant. Other
    variants are left untouched.

The repo-relative layout written here:

    /voice/turn-detector/README.md
    /voice/turn-detector/manifest.json
    /voice/turn-detector/onnx/model_q8.onnx
    /voice/turn-detector/onnx/turn-detector-en-q8.gguf
    /voice/turn-detector/onnx/tokenizer.json + sidecars
    /voice/turn-detector/onnx/eval.json
    /voice/turn-detector/intl/...      ← optional INTL bundle (same layout)

CLI::

    python3 push_to_hf.py \
        --bundle packages/training/out/turn-detector-en-v1/onnx \
        --locale en \
        --repo elizaos/eliza-1 \
        --version 0.2.0 \
        --base-model livekit/turn-detector \
        --base-revision v1.2.2-en \
        --commit-message "feat(H-turn): push fine-tuned ENG turn detector"

Set ``HF_TOKEN`` in the env. The token is never logged or persisted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


_EN_TRAINING_BLOCK: Final[
    str
] = """- Dataset: `OpenRL/daily_dialog` (Apache-2.0 mirror of DailyDialog).
- Prefix augmentation: for each utterance ≥ 3 words, emit a randomly
  truncated prefix (with trailing punctuation stripped) as a negative.
  Resulting train ratio: ≈ 50/50 EOU/non-EOU on ≈ 170 k examples."""

_INTL_TRAINING_BLOCK: Final[
    str
] = """- Dataset: `OpenAssistant/oasst1` (Apache-2.0), `role=prompter` rows
  filtered to the 14 LiveKit v0.4.1-intl locales (en, es, fr, de, it,
  pt, nl, ru, zh, ja, ko, tr, id, hi).
- Per-language cap (default 6 000 utterances) so the corpus isn't 70%
  English. CJK scripts (zh, ja, ko) are character-counted instead of
  whitespace-counted — see `_utterance_unit_count` / `_cjk_prefix_cut`
  in `packages/training/scripts/turn_detector/finetune_turn_detector.py`.
- Prefix augmentation: per utterance, emit a randomly truncated prefix
  (with trailing punctuation — ASCII + fullwidth — stripped) as a
  negative. Resulting train ratio: ≈ 50/50 EOU/non-EOU.
- Eval split: language-stratified (≤ 200 rows per language); per-locale
  F1 lives in `intl/eval.json` under `f1ByLang`."""


def _render_model_card(
    *,
    version: str,
    base_model: str,
    base_revision: str,
    eval_en: dict[str, Any] | None,
    eval_intl: dict[str, Any] | None,
    locale: str = "en",
) -> str:
    en_block = (
        json.dumps(eval_en, indent=2)
        if eval_en is not None
        else "_(not measured for this release)_"
    )
    intl_block = (
        json.dumps(eval_intl, indent=2)
        if eval_intl is not None
        else "_(not measured for this release)_"
    )
    if locale == "intl":
        arch_note = (
            "The model is a 24-layer Qwen2-0.5B causal LM, ~500M params "
            "with a shared 151k-token tokenizer covering 14 languages."
        )
        training_block = _INTL_TRAINING_BLOCK
        files_block = (
            "- `intl/model_q8.onnx` — INT8 dynamic-quantised multilingual ONNX.\n"
            "- `intl/turn-detector-intl-q8.gguf` — Q8_0 GGUF (when staged).\n"
            "- `intl/tokenizer.json`, `intl/tokenizer_config.json`, "
            "`intl/config.json`, `intl/special_tokens_map.json`, "
            "`intl/vocab.json`, `intl/merges.txt`, `intl/added_tokens.json` "
            "— inherited from the LiveKit `v0.4.1-intl` base, required by "
            "the runtime (`@huggingface/transformers` tokenizer loads "
            "`local_files_only=true`).\n"
            "- `intl/eval.json` — held-out F1 + mean inference latency "
            "(language-stratified `f1ByLang` map for the supported locales)."
        )
    else:
        arch_note = "The model is a 4-layer SmolLM2-135M LLaMA-style causal LM."
        training_block = _EN_TRAINING_BLOCK
        files_block = (
            "- `onnx/model_q8.onnx` — INT8 dynamic-quantised English ONNX.\n"
            "- `onnx/turn-detector-en-q8.gguf` — Q8_0 GGUF (when staged).\n"
            "- `onnx/tokenizer.json`, `onnx/tokenizer_config.json`, "
            "`onnx/config.json`, `onnx/special_tokens_map.json`, "
            "`onnx/vocab.json`, `onnx/merges.txt` — inherited from the "
            "LiveKit base, required by the runtime "
            "(`@huggingface/transformers` tokenizer loads "
            "`local_files_only=true`).\n"
            "- `onnx/eval.json` — held-out F1 + mean inference latency in "
            "`eval_turn_detector.gate_report` shape."
        )
    return f"""---
license: apache-2.0
library_name: onnx
tags:
- end-of-turn
- voice
- elizaos
- eliza-1
- semantic-turn-detection
base_model: {base_model}
---

# Eliza-1 Voice Turn Detector — v{version}

Semantic end-of-utterance (EOU) classifier for the Eliza-1 voice pipeline.
Fine-tuned from [`{base_model}`](https://huggingface.co/{base_model}) at
revision `{base_revision}` on a prefix-augmented EOU corpus (every full
utterance contributes a positive (EOU=1) and a randomly truncated
mid-utterance prefix as a negative (EOU=0)).

{arch_note} The runtime
(`plugins/plugin-local-inference/src/services/voice/eot-classifier.ts`)
scores end-of-turn probability as
`softmax(logits[:, last_real_pos, :])[<|im_end|>]` — same shape as the
upstream LiveKit ONNX, drop-in compatible.

## Files

- `onnx/model_q8.onnx` — INT8 dynamic-quantised English ONNX.
- `onnx/turn-detector-en-q8.gguf` — Q8_0 GGUF (when staged).
- `onnx/tokenizer.json`, `onnx/tokenizer_config.json`, `onnx/config.json`,
  `onnx/special_tokens_map.json`, `onnx/vocab.json`, `onnx/merges.txt` —
  inherited from the LiveKit base. These files describe the tokenizer
  expected by upstream LiveKit consumers; the Eliza runtime no longer
  loads them directly (the legacy @huggingface/transformers tokenizer
  path was removed; a ggml/llama.cpp-backed tokenizer will replace it).
- `onnx/eval.json` — held-out F1 + mean inference latency in
  `eval_turn_detector.gate_report` shape.

The other tier lives under the sibling sub-directory (`onnx/` for the
English `v1.2.2-en` fine-tune, `intl/` for the multilingual `v0.4.1-intl`
fine-tune).

## Training

- Base: `{base_model}` @ `{base_revision}` (Apache-2.0).
- Optimizer: APOLLO-Mini (rank-1 tensor-wise scaling, smallest optimizer
  state — see `packages/training/AGENTS.md` §1).
- Loss: binary cross-entropy on
  `(im_end_logit - logsumexp(other_logits))` at the last real token
  position. This is the same quantity the runtime softmax-projects.
{training_block}

## Eval

English (`v1.2.2-en` base, `onnx/eval.json`):

```json
{en_block}
```

Multilingual (`v0.4.1-intl` base, `intl/eval.json`):

```json
{intl_block}
```

Gate (per `packages/inference/AGENTS.md` §8 and the runtime manifest
validator in `plugins/plugin-local-inference/src/services/manifest/schema.ts`):

- `f1 ≥ 0.85`
- `meanLatencyMs ≤ 30`

## License

Apache-2.0 on the fine-tune. The base architecture is LiveKit's
`turn-detector` (CC-BY-NC-4.0 weights at `v1.2.2-en` / `v0.4.1-intl`);
we publish only our re-trained weights here, not LiveKit's. Downstream
commercial use is permitted under Apache-2.0.

## Citation

```text
@misc{{elizaos-voice-turn-{version},
  title = {{Eliza-1 Voice Turn Detector v{version}}},
  author = {{Eliza Labs}},
  year = {{2026}},
  howpublished = {{\\url{{https://huggingface.co/elizaos/eliza-1/tree/main/voice/turn-detector}}}}
}}
```
"""


def _merge_manifest(
    *,
    existing: dict[str, Any],
    locale: str,
    onnx_filename: str,
    onnx_sha: str,
    onnx_size: int,
    gguf_filename: str | None,
    gguf_sha: str | None,
    gguf_size: int | None,
    version: str,
    eval_metrics: dict[str, Any] | None,
) -> dict[str, Any]:
    role = "primary-weights-en" if locale == "en" else "primary-weights-intl"
    name = (
        "turn-detector-en-int8.onnx"
        if locale == "en"
        else "turn-detector-intl-int8.onnx"
    )
    out = dict(existing)
    out["version"] = version
    files = list(out.get("files", []))
    found = False
    for entry in files:
        if entry.get("filename") == name or entry.get("role") == role:
            entry["filename"] = name
            entry["role"] = role
            entry["sha256"] = onnx_sha
            entry["sizeBytes"] = onnx_size
            entry["approxSizeBytes"] = onnx_size
            entry["assetStatus"] = "available"
            entry["quant"] = "onnx-int8"
            entry["format"] = "onnx"
            entry["sourceFilename"] = onnx_filename
            found = True
            break
    if not found:
        files.append(
            {
                "filename": name,
                "role": role,
                "sha256": onnx_sha,
                "sizeBytes": onnx_size,
                "approxSizeBytes": onnx_size,
                "assetStatus": "available",
                "quant": "onnx-int8",
                "format": "onnx",
                "sourceFilename": onnx_filename,
            }
        )
    if gguf_filename is not None and gguf_sha is not None and gguf_size is not None:
        gguf_role = (
            "primary-weights-en-gguf" if locale == "en" else "primary-weights-intl-gguf"
        )
        for entry in files:
            if entry.get("role") == gguf_role:
                entry["filename"] = gguf_filename
                entry["sha256"] = gguf_sha
                entry["sizeBytes"] = gguf_size
                entry["approxSizeBytes"] = gguf_size
                entry["assetStatus"] = "available"
                break
        else:
            files.append(
                {
                    "filename": gguf_filename,
                    "role": gguf_role,
                    "sha256": gguf_sha,
                    "sizeBytes": gguf_size,
                    "approxSizeBytes": gguf_size,
                    "assetStatus": "available",
                    "quant": "Q8_0",
                    "format": "gguf",
                }
            )
    out["files"] = files
    if eval_metrics is not None:
        em = dict(out.get("evalMetrics", {}))
        if locale == "en":
            em["f1En"] = round(float(eval_metrics["f1"]), 4)
            em["meanLatencyMsEn"] = round(float(eval_metrics["meanLatencyMs"]), 4)
        else:
            em["f1Multilingual"] = round(float(eval_metrics["f1"]), 4)
            em["meanLatencyMsMultilingual"] = round(
                float(eval_metrics["meanLatencyMs"]), 4
            )
        out["evalMetrics"] = em
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--bundle",
        type=Path,
        required=True,
        help=(
            "Path to the locally-staged ONNX bundle dir (contains "
            "model_q8.onnx and tokenizer sidecars)."
        ),
    )
    ap.add_argument("--locale", choices=("en", "intl"), required=True)
    ap.add_argument("--repo", default="elizaos/eliza-1")
    ap.add_argument("--path-in-repo", default="voice/turn-detector")
    ap.add_argument("--version", required=True)
    ap.add_argument("--base-model", default="livekit/turn-detector")
    ap.add_argument("--base-revision", default="v1.2.2-en")
    ap.add_argument(
        "--commit-message",
        default="feat(turn-detector): push fine-tuned weights",
    )
    ap.add_argument(
        "--gguf",
        type=Path,
        default=None,
        help="Optional GGUF artifact to upload alongside the ONNX.",
    )
    ap.add_argument(
        "--eval-json",
        type=Path,
        default=None,
        help="Optional eval.json (gate report) to upload + merge into the manifest.",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN must be set in the env")

    try:
        from huggingface_hub import HfApi, hf_hub_download, upload_folder
    except ImportError as exc:
        raise RuntimeError("huggingface_hub is required") from exc

    api = HfApi(token=token)

    onnx_path = args.bundle / "model_q8.onnx"
    if not onnx_path.is_file():
        raise SystemExit(f"missing ONNX: {onnx_path}")

    onnx_sha = _sha256_file(onnx_path)
    onnx_size = onnx_path.stat().st_size

    gguf_sha = None
    gguf_size = None
    gguf_filename = None
    if args.gguf is not None:
        if not args.gguf.is_file():
            raise SystemExit(f"missing GGUF: {args.gguf}")
        gguf_sha = _sha256_file(args.gguf)
        gguf_size = args.gguf.stat().st_size
        gguf_filename = (
            f"onnx/turn-detector-{args.locale}-q8.gguf"
            if args.locale == "en"
            else f"intl/turn-detector-{args.locale}-q8.gguf"
        )

    eval_metrics: dict[str, Any] | None = None
    if args.eval_json is not None and args.eval_json.is_file():
        eval_metrics = json.loads(args.eval_json.read_text(encoding="utf-8"))

    # Pull the existing manifest from HF, merge, write locally.
    try:
        manifest_local = hf_hub_download(
            args.repo,
            f"{args.path_in_repo}/manifest.json",
            token=token,
        )
        existing = json.loads(Path(manifest_local).read_text(encoding="utf-8"))
    except Exception:
        existing = {
            "$schema": "https://elizaos.dev/schemas/voice-sub-model/v1.json",
            "id": "turn-detector",
            "version": args.version,
            "hfRepo": args.repo,
            "displayName": "Eliza-1 Voice Turn Detector",
            "purpose": "End-of-turn detection for the Eliza-1 voice pipeline",
            "license": "Apache-2.0",
            "files": [],
            "evalMetrics": {},
        }

    onnx_relname = (
        "turn-detector-en-int8.onnx"
        if args.locale == "en"
        else "turn-detector-intl-int8.onnx"
    )
    merged = _merge_manifest(
        existing=existing,
        locale=args.locale,
        onnx_filename=onnx_relname,
        onnx_sha=onnx_sha,
        onnx_size=onnx_size,
        gguf_filename=gguf_filename,
        gguf_sha=gguf_sha,
        gguf_size=gguf_size,
        version=args.version,
        eval_metrics=eval_metrics,
    )

    # Stage upload tree.
    stage_root = args.bundle.parent / f"_hf-stage-{args.locale}"
    if stage_root.exists():
        import shutil

        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True)
    sub = "onnx" if args.locale == "en" else "intl"
    (stage_root / sub).mkdir()
    # Copy the bundle contents (model_q8.onnx + tokenizer sidecars) into
    # the sub-directory. Use rename via hardlink-then-copy fallback so
    # we never alter the original bundle.
    import shutil

    for child in args.bundle.iterdir():
        if child.is_file():
            shutil.copy2(child, stage_root / sub / child.name)
    if args.gguf is not None:
        shutil.copy2(args.gguf, stage_root / sub / args.gguf.name)
    if args.eval_json is not None and args.eval_json.is_file():
        shutil.copy2(args.eval_json, stage_root / sub / "eval.json")
    (stage_root / "manifest.json").write_text(
        json.dumps(merged, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    # Pull existing eval (other locale) for the model card.
    eval_en = eval_metrics if args.locale == "en" else None
    eval_intl = eval_metrics if args.locale == "intl" else None
    card = _render_model_card(
        version=args.version,
        base_model=args.base_model,
        base_revision=args.base_revision,
        eval_en=eval_en,
        eval_intl=eval_intl,
        locale=args.locale,
    )
    (stage_root / "README.md").write_text(card, encoding="utf-8")

    if args.dry_run:
        print(
            json.dumps(
                {
                    "stage_root": str(stage_root),
                    "manifest_preview": merged,
                    "onnx_sha": onnx_sha,
                    "onnx_size": onnx_size,
                    "gguf_sha": gguf_sha,
                    "gguf_size": gguf_size,
                },
                indent=2,
                sort_keys=False,
            )
        )
        return 0

    commit_info = upload_folder(
        repo_id=args.repo,
        folder_path=str(stage_root),
        path_in_repo=args.path_in_repo,
        commit_message=args.commit_message,
        token=token,
    )
    print(f"committed: {commit_info.commit_url}")
    print(f"oid: {commit_info.oid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
