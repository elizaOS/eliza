#!/usr/bin/env python3
"""OpenClaw CompactBench runner entry."""

from __future__ import annotations

import sys

from run_cerebras import main as run_cerebras_main


def main() -> int:
    if not any(arg == "--method" or arg.startswith("--method=") for arg in sys.argv[1:]):
        sys.argv.extend(
            [
                "--method",
                "eliza_compactbench/openclaw_compactor.py:OpenClawNativeToolCompactor",
            ]
        )
    return run_cerebras_main()


if __name__ == "__main__":
    sys.exit(main())
