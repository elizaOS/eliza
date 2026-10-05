# REALM-Bench upstream sources

Vendored planning datasets, task definitions, and evaluation metrics from
[REALM-Bench](https://github.com/genglongling/REALM-Bench). Preserve dataset
identities and semantics. [ATTRIBUTION.md](ATTRIBUTION.md) records authors,
citation, provenance, and licensing information.

This tree has no separate build. Install pytest and pytest-asyncio plus the owning suite's Python dependencies
and run its adapter tests from the repository root:

```bash
PYTHONPATH=packages python -m pytest packages/benchmarks/suites/realm/tests
```

Use the [suite README](../README.md) for package builds and benchmark setup.
