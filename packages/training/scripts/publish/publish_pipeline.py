"""Canonical eliza-1 pipeline (training-source) publisher.

Thin wrapper that dispatches to
``packages/training/scripts/publish_pipeline_to_hf.py``. Lives under
``packages/training/scripts/publish/`` so all three publisher entry points
(model, dataset, pipeline) sit together as the consolidated operator surface.

The pipeline repo (``elizalabs/eliza-1-pipeline``) packages the training
``scripts/`` tree so a fresh Vast.ai / Nebius box can ``hf download`` it,
``uv sync --extra train``, and run ``train_vast.sh`` end-to-end without a
local source checkout.
"""

from __future__ import annotations

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
log = logging.getLogger("publish_pipeline")


def main(argv: list[str] | None = None) -> int:
    interpreter = os.environ.get("PYTHON", sys.executable)
    cmd = [interpreter, "scripts/publish_pipeline_to_hf.py", *(argv or sys.argv[1:])]
    log.info("dispatch: %s", " ".join(cmd))
    return subprocess.run(cmd, cwd=str(_TRAINING_ROOT)).returncode


if __name__ == "__main__":
    sys.exit(main())
