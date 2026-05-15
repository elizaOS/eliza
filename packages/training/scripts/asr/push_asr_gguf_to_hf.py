"""Publish the Qwen3-ASR K-quant ladder + Q8_0 mmproj to HuggingFace.

Target: ``elizaos/eliza-1-voice-asr`` (Apache-2.0, public).

Inputs:

- ``--quant-dir`` directory of ``eliza-1-asr-{Q3_K_M,Q4_K_M,Q5_K_M,Q6_K,
  Q8_0}.gguf`` plus ``eliza-1-asr-mmproj-Q8_0.gguf`` and ``eval.json`` /
  ``gguf_asr.json`` sidecars (the output of ``gguf_asr_apply.py``
  followed by ``eval_asr_wer.py``).
- ``--readme`` rendered Markdown README to push verbatim.
- ``--repo`` HF repo id (default ``elizaos/eliza-1-voice-asr``).

The wrapper:

1. Verifies every expected file exists.
2. Creates the repo (idempotent) and sets ``license=apache-2.0``.
3. Uploads each GGUF + the eval.json + sidecar + README via
   ``upload_file`` with explicit ``path_in_repo`` so the published
   layout is flat.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

log = logging.getLogger("push_asr_gguf_to_hf")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--quant-dir", required=True, type=Path)
    ap.add_argument("--readme", required=True, type=Path)
    ap.add_argument("--repo", default="elizaos/eliza-1-voice-asr")
    ap.add_argument("--quants", default="Q3_K_M,Q4_K_M,Q5_K_M,Q6_K,Q8_0")
    ap.add_argument("--mmproj-quant", default="Q8_0")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    from huggingface_hub import HfApi, create_repo

    token = os.environ.get("HF_TOKEN")
    if not token:
        log.error("HF_TOKEN env var is required")
        return 2

    quant_dir: Path = args.quant_dir
    expected: list[tuple[Path, str]] = []
    for level in [q.strip() for q in args.quants.split(",") if q.strip()]:
        local = quant_dir / f"eliza-1-asr-{level}.gguf"
        repo_path = f"qwen3-asr-{level.lower()}.gguf"
        expected.append((local, repo_path))
    expected.append(
        (
            quant_dir / f"eliza-1-asr-mmproj-{args.mmproj_quant}.gguf",
            f"qwen3-asr-audio-mmproj-{args.mmproj_quant.lower()}.gguf",
        )
    )
    expected.append((quant_dir / "eval.json", "eval.json"))
    expected.append((quant_dir / "gguf_asr.json", "gguf_asr.json"))
    expected.append((args.readme, "README.md"))

    missing = [str(p) for p, _ in expected if not p.exists()]
    if missing:
        log.error("missing files:\n  %s", "\n  ".join(missing))
        return 2

    if args.dry_run:
        log.info("would upload to %s:", args.repo)
        for local, repo_path in expected:
            log.info("  %s -> %s (%d B)", local, repo_path, local.stat().st_size)
        return 0

    api = HfApi(token=token)
    create_repo(
        args.repo,
        token=token,
        exist_ok=True,
        repo_type="model",
        private=False,
    )

    for local, repo_path in expected:
        log.info("uploading %s -> %s:%s", local, args.repo, repo_path)
        api.upload_file(
            path_or_fileobj=str(local),
            path_in_repo=repo_path,
            repo_id=args.repo,
            repo_type="model",
            commit_message=f"upload {repo_path}",
        )
    log.info("done; repo: https://huggingface.co/%s", args.repo)
    return 0


if __name__ == "__main__":
    sys.exit(main())
