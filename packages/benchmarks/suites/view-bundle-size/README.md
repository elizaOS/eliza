# view-bundle-size

Device-independent, deterministic **bundle-size regression gate** for the plugin **view bundles**.

This directory is part of `packages/benchmarks`.

This harness runs from source.

Test from the repository root:

```bash
node --test packages/benchmarks/lib/kpi-reporting.test.mjs
```

This command checks the shared report writer. Run `node packages/benchmarks/suites/view-bundle-size/run-all.mjs` with `ELIZA_REPO_DIR` set to a checkout with built view bundles to measure sizes.
