"""Standard public LLM benchmarks.

Adapters that wrap public/community runners (lm-evaluation-harness,
bigcode-evaluation-harness) and emit results in the elizaOS benchmark
registry shape.

Each adapter exposes:

* A ``BenchmarkRunner`` class (the actual runner)
* A ``main`` function used as the ``python -m benchmarks.standard.<name>``
  CLI entrypoint
* A common result schema:

  ```json
  {
    "benchmark": "<id>",
    "model": "<endpoint or model id>",
    "endpoint": "<OpenAI-compatible URL>",
    "dataset_version": "<sha or tag>",
    "n": int,
    "metrics": {
      "score": 0.0..1.0,
      ...
    },
    "raw_json": { ... }
  }
  ```
"""
