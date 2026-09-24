# @elizaos/cloud-test-mocks

Stateful, in-process mocks of the third-party cloud APIs that Eliza Cloud talks to.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/test-mocks typecheck  # static validation
bun run --cwd packages/cloud/test-mocks test       # local protocol and subprocess tests
```

No standalone build script is defined; this package is consumed or executed from source.

The required server test lane runs this package’s local protocol and subprocess tests.
