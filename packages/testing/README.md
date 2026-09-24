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

`createPerfectResultPlugin` (also `createDeterministicModelPlugin`) supplies
scenario-authored model results through real runtime dispatch and persistence.
Declare non-text model types explicitly; unexpected or unconsumed required
fixtures fail. Run `bun test --conditions eliza-source
packages/testing/e2e/perfect-result-runtime.e2e.test.ts` from the root. These
scenarios verify runtime behavior, not model intelligence or audio quality.

Renderer tests import DOM fixtures from `@elizaos/testing/browser-mocks`; the
root runtime-fixture entry does not load browser mocks.

Vitest configuration imports path helpers from `@elizaos/testing/package-paths`
to avoid loading runtime fixtures and their build dependencies during setup.
