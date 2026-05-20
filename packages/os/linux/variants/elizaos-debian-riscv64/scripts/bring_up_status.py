#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Thin wrapper around the chip tape-out readiness aggregator.

The chip aggregator at
``packages/chip/scripts/aggregate_tapeout_readiness.py`` already carries
this variant's gates under ``subsystem=os_rv64``. This wrapper lets an
operator working inside the OS RV64 variant query the unified chip +
OS bring-up dashboard without leaving the variant directory.

It does not duplicate logic, it does not invent a new report schema,
and it preserves the chip aggregator's ``claim_boundary``. The script
imports the aggregator module via absolute path and delegates to its
``main()``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

# Repo layout: packages/os/linux/variants/elizaos-debian-riscv64/scripts/...
# -> ../../../../../chip/scripts/aggregate_tapeout_readiness.py
HERE = Path(__file__).resolve().parent
AGGREGATOR_PATH = (
    HERE.parents[4] / "chip/scripts/aggregate_tapeout_readiness.py"
).resolve()


def _load_aggregator():
    if not AGGREGATOR_PATH.is_file():
        raise FileNotFoundError(
            f"chip aggregator not found at {AGGREGATOR_PATH}. "
            "The OS RV64 bring-up dashboard requires the chip package."
        )
    module_name = "chip_aggregate_tapeout_readiness"
    spec = importlib.util.spec_from_file_location(module_name, AGGREGATOR_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load aggregator spec from {AGGREGATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    # Register before exec so ``@dataclass`` reflection (which looks up the
    # owning module via ``sys.modules[cls.__module__]``) can resolve names.
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> int:
    aggregator = _load_aggregator()
    return aggregator.main(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
