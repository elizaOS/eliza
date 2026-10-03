"""
elizaOS Benchmarks

This package contains benchmark implementations for evaluating elizaOS agents.

TypeScript benchmark packages (not importable from Python — listed here
for discoverability):

- ``suites/eliza-1`` — quality + perf bench for the eliza-1 model line (response
  handler, planner, per-action tasks).
- ``suites/vision-language`` — vision-language + UI-grounding eval for eliza-1
  tiers across TextVQA, DocVQA, ChartQA, ScreenSpot, and OSWorld. See
  ``suites/vision-language/README.md`` for layout and run commands.
"""

# Suites live under suites/; extend the package search path so historical
# `benchmarks.<suite>` imports resolve to suites/<suite>.
from pathlib import Path as _Path

__path__.append(str(_Path(__file__).resolve().parent / "suites"))
