#!/usr/bin/env python3
"""Compatibility entrypoint for staging the canonical `same` Kokoro corpus."""

from __future__ import annotations

from stage_sam_corpus import *  # noqa: F401,F403
from stage_sam_corpus import main


if __name__ == "__main__":
    raise SystemExit(main())
