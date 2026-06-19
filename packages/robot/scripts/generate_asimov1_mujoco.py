#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.mujoco_assets import (  # noqa: E402
    copy_profile_meshes,
    generate_asimov1_mjcf,
)

if __name__ == "__main__":
    copy_profile_meshes()
    print(generate_asimov1_mjcf())
