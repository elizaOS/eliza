# @elizaos/container-control-plane

Node/Bun sidecar that runs the container mutations Cloudflare Workers can't.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/services/container-control-plane typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
