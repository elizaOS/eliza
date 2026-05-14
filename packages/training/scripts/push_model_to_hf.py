"""DEPRECATED — use ``packages/training/scripts/publish/publish_model.py``.

Historically two paths existed for pushing a trained eliza-1 checkpoint to
HuggingFace:

  - ``scripts/push_model_to_hf.py``               (this file, legacy)
  - ``scripts/publish/publish_eliza1_model_repo.py``  (canonical bundle uploader)

The audit (wave1/huggingface.md §6.3, training.md §3.1) flagged this as
duplicate. The canonical bundle uploader is the only path called by the
publish orchestrator. This file is now a thin redirect.

Callers should switch to::

    python -m scripts.publish.publish_model --checkpoint <dir> [--bundle-dir <dir>] ...

or, if a fully-staged bundle is on disk::

    python -m scripts.publish.orchestrator --bundle-dir <dir> --tier <tier>
"""

from __future__ import annotations

import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("push_model")


_REDIRECT_MESSAGE = (
    "push_model_to_hf.py is deprecated. Use one of:\n"
    "  - python -m scripts.publish.publish_model "
    "(unified per-tier checkpoint/bundle/optimized publisher)\n"
    "  - python -m scripts.publish.orchestrator "
    "(full bundle gate + publish flow)\n"
    "See packages/training/scripts/HF_PUBLISHING.md."
)


def main() -> int:
    log.error("%s", _REDIRECT_MESSAGE)
    return 2


if __name__ == "__main__":
    sys.exit(main())
