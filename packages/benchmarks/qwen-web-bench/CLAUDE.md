# QwenWebBench — Agent Guide

QwenWebBench is tracked here as an unavailable external benchmark. The public
runner and dataset have not been released, so this directory is not registered
in the benchmark suite and has no runnable command.

## Current state

- `README.md` summarizes the unavailable integration state.
- `INTEGRATION.md` records checked public-availability evidence, score format,
  expected runner shape, and integration steps for the day upstream ships.
- Do not synthesize a clone from blog descriptions. QwenWebBench scores are
  Elo/Bradley-Terry ratings that depend on the upstream prompt pool, renderer,
  judge, references, and pairing set.

## Verification

There is no local test command for this directory because there is no harness.
For documentation changes, run:

```bash
rg -n "not implemented|TODO|FIXME|unfinished|incomplete|placeholder|stub|no-op|noop|fake|dummy" packages/benchmarks/qwen-web-bench
```

The expected remaining uses are benchmark-subject terms such as "when upstream
ships" or source availability notes, not runnable benchmark code.

## Integration rule

Only add a runner, adapter, registry entry, or score parser after a public
upstream source or dataset is available and its license permits vendoring or
download.
