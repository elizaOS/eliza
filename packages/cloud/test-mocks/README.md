# @elizaos/cloud-test-mocks

Stateful, in-process mocks of the third-party cloud APIs that Eliza Cloud talks to.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/test-mocks typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.
