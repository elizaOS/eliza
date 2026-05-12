"""eliza-format benchmark wrapper.

Wraps `training/scripts/benchmark/eliza_bench.py` so the bench-orchestrator can
schedule it like any other registered benchmark. The underlying script writes
`<out>/summary.json` with per-bucket format/content scores; the score extractor
in `benchmarks.registry` reads that file and returns a weighted score
(`0.5 * format_ok + 0.5 * content_ok`).
"""
