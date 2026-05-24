#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.morphology_parameters import (  # noqa: E402
    dump_morphology_parameter_catalog_json,
)


def main() -> int:
    print(dump_morphology_parameter_catalog_json(), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
