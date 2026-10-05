# @elizaos/coding-remote-runner

A small, single-file Bun HTTP runner that exposes a sandboxed workspace (filesystem +
process execution) over HTTP.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/services/coding-remote-runner test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.
