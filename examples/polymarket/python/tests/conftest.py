from __future__ import annotations

import pathlib
import sys


HERE = pathlib.Path(__file__).resolve()
PROJECT_DIR = HERE.parents[1]
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

REPO_ROOT = HERE.parents[4]
for rel in ("packages/python", "plugins/plugin-evm/python", "plugins/plugin-polymarket/python"):
    p = REPO_ROOT / rel
    if p.exists():
        sys.path.insert(0, str(p))

