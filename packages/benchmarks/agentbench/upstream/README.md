# AgentBench upstream data

The ignored `data/` tree is pinned to THUDM/AgentBench commit
`d1e4a10db08c87075c78972e48ecc182be03e2d5`. `SOURCE.json` records the
official split counts and SHA-256 hashes checked by the loader.

Provision or repair it without invoking a benchmark model:

```bash
python -m elizaos_agentbench.cli data fetch
python -m elizaos_agentbench.cli data verify
```

Fixture data is available only through the explicit `--data-mode fixture`
smoke-test option. Normal and full runs never substitute fixtures when the
pinned source data is absent or corrupt.
