# OSWorld runners

Python entry point for the Eliza desktop benchmark run.
Install the suite's Python dependencies, provider credentials, and required VM
backend. Run it from `packages/benchmarks/suites/OSWorld` so local imports
and task paths resolve correctly.

No separate build is required. Inspect the Eliza runner's options with:

```bash
python ../../scripts/osworld/python/run_multienv_eliza.py --help
```

Run local adapter tests from the same directory:

```bash
python -m pytest tests
```

Live evaluation needs the configured desktop environment; adapter tests alone
do not establish a benchmark score.
