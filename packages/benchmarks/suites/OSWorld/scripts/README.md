# OSWorld runners

Python and shell entry points for model-specific desktop benchmark runs.
Install the suite's Python dependencies, provider credentials, and required VM
backend. Run scripts from `packages/benchmarks/suites/OSWorld` so local imports
and task paths resolve correctly.

No separate build is required. Inspect the Eliza runner's options with:

```bash
python scripts/python/run_multienv_eliza.py --help
```

Run local adapter tests from the same directory:

```bash
python -m pytest tests
```

Live evaluation needs the configured desktop environment; adapter tests alone
do not establish a benchmark score.
