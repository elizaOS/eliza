# OSWorld monitor

Flask dashboard for benchmark task status, screenshots, videos, and results.
Start it after the benchmark runner has begun writing results. Configure
TASK_CONFIG_PATH, EXAMPLES_BASE_PATH, and RESULTS_BASE_PATH for that run;
FLASK_HOST and FLASK_PORT control the listener.

No compilation is required. From this directory:

```bash
python -m pip install -r requirements.txt
python main.py
```

The monitor has no dedicated automated test suite. The owning OSWorld adapter
is tested with `python -m pytest tests` from
`packages/benchmarks/suites/OSWorld`; inspect the dashboard against a real run
to validate monitor behavior.
