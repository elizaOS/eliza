# 8932 Orchestrator Scenario Evidence

Command:

```bash
bun run --cwd packages/scenario-runner test:orchestrator:pr:e2e
```

Result:

- Run id: `5aefb799-3234-457a-a022-8d699a9215e2`
- Provider: `deterministic-llm-proxy`
- Scenarios: 3 passed, 0 failed, 0 skipped
- Viewer: `viewer/index.html`
- Matrix report: `matrix.json`
- Native export: `native.jsonl` plus `native.manifest.json`

Note: the PR lane uses deterministic orchestrator action fixtures so it can run
in CI without live model secrets. The runner still executes the official
`--export-native` path; the manifest records zero trajectory rows for this lane
because no trajectory DB files are produced by the deterministic action harness.
