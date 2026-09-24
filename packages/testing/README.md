# @elizaos/testing

Private evidence tooling, deterministic runtime fixtures and repository-wide scenarios
consumed by `@elizaos/testing/scenario-runner`.

Private source package for runtime fixtures, scenarios, evidence, and synthetic-world
control. Production packages must not import test fixtures. The single test command runs
all owned test lanes; live-model scenarios require separately configured providers.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/testing test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.
