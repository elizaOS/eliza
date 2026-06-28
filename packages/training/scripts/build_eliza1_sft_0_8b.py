#!/usr/bin/env python3
"""Deprecated compatibility entry point for the retired Eliza-1 0.8B SFT builder.

Use ``scripts/build_eliza1_sft_2b.py``. This wrapper now builds the active
Gemma 4 E2B / ``eliza-1-2b`` SFT dataset.
"""

from __future__ import annotations

from build_eliza1_sft_2b import main


if __name__ == "__main__":
    raise SystemExit(main())
