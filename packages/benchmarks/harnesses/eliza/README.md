# eliza-adapter

Python bridge that connects benchmark runners (Python) to the elizaOS agent runtime (TypeScript) over HTTP.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```

The default Bun launcher explicitly selects `eliza-source` exports so packages supporting that condition execute their checkout sources. The Node/tsx fallback uses built packages; build them first and retain build provenance when comparing results. `ELIZA_BENCH_SERVER_CMD` overrides must explicitly select their intended source or build resolution.

## DeepSWE / Pier native coding

Install the optional `datacurve-pier==0.3.1` runner in Python 3.12+. Use the
[official DeepSWE tasks](https://github.com/datacurve-ai/deep-swe), pinned to a
recorded revision. Keep `tests/` and `solution/` outside the agent container;
Pier owns the separate verifier and collects committed changes.

Build a Linux runtime bundle from the source revision being evaluated:

```bash
python packages/benchmarks/harnesses/eliza/build_pier_runtime.py \
  --repository "$PWD" --revision <git-revision> \
  --output "$PWD/test-results/eliza-pier-runtime/<new-run>"
```

Use `pier run --no-delete --agent-import-path eliza_adapter.pier_agent:ElizaAgent`, with
`packages/` and `packages/benchmarks/harnesses/eliza/` on `PYTHONPATH`. Set an
explicit model and provide `runtime_bundle`, `runtime_sha256`, and
`runtime_revision` agent kwargs from the generated `bundle.json`. Configure
`provider` (`cerebras` or `openai-compatible`), its HTTPS `provider_url`, and the
corresponding key via Pier's agent environment configuration. Never put the key
in kwargs or committed job files.

The adapter uses the production Eliza CLI and coding tools inside the task
container, private runtime state, provider-scoped egress, and retained complete
native trajectories. It does not create commits for the agent or award scores.
A completed turn is execution evidence; only the official verifier determines
correctness. Compare with Pier's native Codex lane on identical task revisions
and recorded budgets; different models/providers are configured-system
comparisons. Parent TASKS/ACP orchestration is a separate execution mode and is
not implied by this direct coding adapter.

For repeated Docker runs, `--no-delete` removes task containers while retaining
images; Pier 0.3.1 otherwise removes referenced images and may repeatedly hit
registry quotas. Pin and record the official image digest before each campaign.
