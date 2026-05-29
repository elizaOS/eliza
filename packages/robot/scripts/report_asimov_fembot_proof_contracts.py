#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_proofs import dump_fembot_proof_contract_report_json  # noqa: E402


def main() -> int:
    print(dump_fembot_proof_contract_report_json(), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
