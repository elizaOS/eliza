#!/usr/bin/env python3
"""Delete all superseded ONNX files from the elizaos/eliza-1 HuggingFace repo.

Every file listed in ONNX_FILES_TO_DELETE has a GGUF replacement already
published in the same repo. This script removes the ONNX files to reclaim
storage and prevent the runtime downloader from surfacing deprecated paths.

Usage:
    # Dry run — list what would be deleted, touch nothing:
    python packages/training/scripts/voice/delete_onnx_from_hf.py --dry-run

    # Real deletion (uses HF_TOKEN env var):
    HF_TOKEN=hf_... python packages/training/scripts/voice/delete_onnx_from_hf.py

    # Real deletion (explicit token):
    python packages/training/scripts/voice/delete_onnx_from_hf.py --token hf_...

DO NOT run without explicit confirmation — deleted HF files can be recovered
from git history, but a cleanup is disruptive to any in-flight downloads.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Final

try:
    from huggingface_hub import HfApi
except ModuleNotFoundError as exc:
    raise SystemExit(
        "huggingface_hub is required; install the training deps or run:\n"
        "  pip install huggingface_hub"
    ) from exc

REPO_ID: Final[str] = "elizaos/eliza-1"
REPO_TYPE: Final[str] = "model"
COMMIT_MESSAGE: Final[str] = (
    "Remove superseded ONNX files — all replaced by GGUF equivalents"
)

# Full list of ONNX files to delete from the repo.
# Every entry here has a GGUF replacement already published.
ONNX_FILES_TO_DELETE: Final[tuple[str, ...]] = (
    # VAD — replaced by silero-vad-v5.gguf in each bundle
    "bundles/0_6b/vad/silero-vad-int8.onnx",
    "bundles/0_8b/vad/silero-vad-int8.onnx",
    "bundles/1_7b/vad/silero-vad-int8.onnx",
    "bundles/2b/vad/silero-vad-int8.onnx",
    "bundles/4b/vad/silero-vad-int8.onnx",
    "bundles/9b/vad/silero-vad-int8.onnx",
    "bundles/27b/vad/silero-vad-int8.onnx",
    "bundles/27b-256k/vad/silero-vad-int8.onnx",
    "voice/vad/silero-vad-int8.onnx",
    # TTS (Kokoro) — replaced by omnivoice GGUF
    "bundles/0_8b/tts/kokoro/model_q4.onnx",
    "bundles/2b/tts/kokoro/model_q4.onnx",
    "bundles/4b/tts/kokoro/model_q4.onnx",
    "bundles/9b/tts/kokoro/model_q4.onnx",
    "voice/kokoro/kokoro-v1.0-q4.onnx",
    # Turn detector (EN) — replaced by voice/turn-detector/onnx/turn-detector-en-q8.gguf
    "voice/turn-detector/onnx/model_q8.onnx",
    "voice/turn-detector/turn-detector-en-int8.onnx",
    # Turn detector (intl) — replaced by voice/turn/intl/turn-detector-intl-q8.gguf
    "voice/turn-detector/intl/model_q8.onnx",
    "voice/turn-detector/turn-detector-intl-int8.onnx",
    # TurnSense fallback — to be replaced with GGUF
    "voice/turn-detector/turnsense-fallback-int8.onnx",
    # Diarizer — to be replaced by voice/diarizer/pyannote-segmentation-3.0.gguf
    "voice/diarizer/pyannote-segmentation-3.0-fp32.onnx",
    "voice/diarizer/pyannote-segmentation-3.0-int8.onnx",
    # Speaker encoder — to be replaced by voice/speaker-encoder/wespeaker-resnet34-lm.gguf
    "voice/speaker-encoder/wespeaker-resnet34-lm.onnx",
    # Voice emotion — to be replaced by voice/voice-emotion/wav2small-msp-dim.gguf
    "voice/voice-emotion/wav2small-cls7-int8.onnx",
    "voice/voice-emotion/wav2small-msp-dim-fp32.onnx",
    "voice/voice-emotion/wav2small-msp-dim-fp32.onnx.data",
    "voice/voice-emotion/wav2small-msp-dim-int8.onnx",
    "voice/emotion/wav2small-cls7-int8.onnx",
    # Wake word — replaced by openwakeword.gguf
    "voice/wakeword/embedding_model.onnx",
    "voice/wakeword/hey-eliza-int8.onnx",
    "voice/wakeword/melspectrogram.onnx",
)

RETRY_ATTEMPTS: Final[int] = 3
RETRY_BASE_DELAY_SEC: Final[float] = 2.0


def file_exists_on_hf(api: HfApi, repo_id: str, path_in_repo: str) -> bool:
    """Return True if the file exists in the repo at HEAD."""
    try:
        files = list(api.list_repo_files(repo_id, repo_type=REPO_TYPE))
        return path_in_repo in files
    except Exception:
        return False


def delete_with_retry(
    api: HfApi,
    *,
    repo_id: str,
    path_in_repo: str,
    commit_message: str,
    token: str | None,
) -> dict:
    last_error: Exception | None = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            result = api.delete_file(
                path_in_repo=path_in_repo,
                repo_id=repo_id,
                repo_type=REPO_TYPE,
                commit_message=commit_message,
                token=token,
            )
            return {"path": path_in_repo, "status": "deleted", "commitUrl": str(result)}
        except Exception as exc:
            last_error = exc
            if attempt < RETRY_ATTEMPTS - 1:
                time.sleep(RETRY_BASE_DELAY_SEC * (attempt + 1))
    return {
        "path": path_in_repo,
        "status": "error",
        "error": str(last_error),
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="List files that would be deleted without actually deleting them.",
    )
    ap.add_argument(
        "--token",
        default=None,
        help=(
            "HuggingFace API token. Falls back to HF_TOKEN env var. "
            "Required for non-dry-run deletion."
        ),
    )
    ap.add_argument(
        "--repo",
        default=REPO_ID,
        help=f"HuggingFace repo id to target. Default: {REPO_ID}",
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    token = args.token or os.environ.get("HF_TOKEN")
    repo_id = args.repo

    if not args.dry_run and not token:
        print(
            "ERROR: --token or HF_TOKEN env var is required for non-dry-run deletion.",
            file=sys.stderr,
        )
        return 1

    api = HfApi(token=token)

    print(f"Repository: {repo_id}")
    print(f"Files to delete: {len(ONNX_FILES_TO_DELETE)}")
    print(f"Dry run: {args.dry_run}")
    print()

    results: list[dict] = []
    skipped = 0
    deleted = 0
    errors = 0

    for path_in_repo in ONNX_FILES_TO_DELETE:
        if args.dry_run:
            # In dry-run mode, check existence so the operator knows what
            # is still present before committing to deletion.
            exists = file_exists_on_hf(api, repo_id, path_in_repo)
            status = "would_delete" if exists else "not_found"
            print(f"  [{status}] {path_in_repo}")
            results.append({"path": path_in_repo, "status": status})
            if exists:
                deleted += 1
            else:
                skipped += 1
            continue

        # Real deletion: check existence first to avoid spurious errors.
        exists = file_exists_on_hf(api, repo_id, path_in_repo)
        if not exists:
            print(f"  [not_found] {path_in_repo}")
            results.append({"path": path_in_repo, "status": "not_found"})
            skipped += 1
            continue

        result = delete_with_retry(
            api,
            repo_id=repo_id,
            path_in_repo=path_in_repo,
            commit_message=f"{COMMIT_MESSAGE}: {path_in_repo}",
            token=token,
        )
        results.append(result)
        if result["status"] == "deleted":
            print(f"  [deleted] {path_in_repo}")
            deleted += 1
        else:
            print(f"  [ERROR] {path_in_repo}: {result.get('error', '(unknown)')}")
            errors += 1

    print()
    if args.dry_run:
        print(
            f"Dry-run summary: {deleted} files would be deleted, "
            f"{skipped} not found on HF."
        )
    else:
        print(
            f"Summary: {deleted} deleted, {skipped} not found (skipped), "
            f"{errors} errors."
        )
        if errors:
            print("Some deletions failed — check the output above and retry.", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
