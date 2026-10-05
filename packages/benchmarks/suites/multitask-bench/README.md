# MultitaskBench

Concurrency-interference benchmark: one long-lived agent drives N interleaved LifeOps tasks (N=1/5/10) and the headline metric is the per-task score delta at N versus the N=1 baseline over identical `(scenario, seed)` pairs.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```
