#!/usr/bin/env python3
"""Deprecated compatibility entry point for the retired 0.6B SFT builder.

The active smallest Eliza-1 text tier is 0.8B on Qwen3.5. This wrapper keeps
old automation from failing immediately while routing all work to the 0.8B
builder and emitting only 0.8B dataset paths.
"""

from __future__ import annotations

from build_eliza1_sft_0_8b_impl import main


if __name__ == "__main__":
    raise SystemExit(main())
