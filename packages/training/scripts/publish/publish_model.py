"""Unified eliza-1 model publisher entry point.

This is one of three canonical operator-facing publishers in
``packages/training/scripts/publish/``:

  - ``publish_model.py``    — this file. Pushes trained weights / GGUF
                              bundles to HuggingFace under the consolidated
                              ``elizalabs/eliza-1`` repo (or, for the legacy
                              fused-GGUF flow, to ``elizaos/<base>-optimized``).
  - ``publish_dataset.py``  — pushes the SFT dataset bundles to
                              ``elizalabs/eliza-1-training`` (and siblings).
  - ``publish_pipeline.py`` — pushes the training-pipeline source tree to
                              ``elizalabs/eliza-1-pipeline``.

This script is a thin dispatcher that picks the right concrete uploader for
the chosen mode:

  - ``--mode bundle``    → ``python -m scripts.publish.orchestrator``
                          (full bundle gate + push, the canonical release path)
  - ``--mode tier``      → ``scripts.publish.publish_eliza1_model_repo``
                          (per-tier ``elizalabs/eliza-1/bundles/<tier>/`` upload
                          when the gate ran elsewhere)
  - ``--mode optimized`` → ``scripts.publish_eliza1_model``
                          (single fused-GGUF publish, legacy nightly path
                          targeting ``elizaos/<base>-optimized``)

Use ``--mode bundle`` for new work. The other modes exist for back-compat
with the nightly CI publish (``.github/workflows/local-inference-bench.yml``)
and with operator-driven staged uploads.
"""

from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve()
_TRAINING_ROOT = _HERE.parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("publish_model")


def _run(cmd: list[str]) -> int:
    log.info("dispatch: %s", " ".join(cmd))
    return subprocess.run(cmd, cwd=str(_TRAINING_ROOT)).returncode


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--mode",
        required=True,
        choices=("bundle", "tier", "optimized"),
        help=(
            "bundle = full gated publish (scripts.publish.orchestrator); "
            "tier = per-tier bundle upload (publish_eliza1_model_repo); "
            "optimized = legacy single-GGUF (publish_eliza1_model)."
        ),
    )
    args, rest = ap.parse_known_args(argv)
    interpreter = os.environ.get("PYTHON", sys.executable)
    if args.mode == "bundle":
        return _run([interpreter, "-m", "scripts.publish.orchestrator", *rest])
    if args.mode == "tier":
        return _run(
            [interpreter, "-m", "scripts.publish.publish_eliza1_model_repo", *rest]
        )
    if args.mode == "optimized":
        return _run([interpreter, "scripts/publish_eliza1_model.py", *rest])
    raise AssertionError(f"unhandled mode: {args.mode}")


if __name__ == "__main__":
    sys.exit(main())
