# Upstream MINT Attribution

This directory contains small Apache-2.0 components copied from the upstream
UIUC MINT benchmark:

https://github.com/xingyaoww/mint-bench

The upstream license is preserved in [`LICENSE`](./LICENSE). Large upstream
data/assets are intentionally not vendored here. Full MINT runs lazy-fetch the
compact processed JSONL files from upstream `data/processed/<subtask>/` into
the local MINT cache, while smoke tests use a tiny official-format fixture.
