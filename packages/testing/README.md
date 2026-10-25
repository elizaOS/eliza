# @elizaos/testing

Private source package for runtime fixtures, scenarios, evidence, and synthetic-world
control. Production packages must not import test fixtures. Live-model scenarios and
GEPA integration require separately configured providers or toolchains.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/testing test   # deterministic fixtures, scenarios, evidence and real-runtime E2E
bun run --cwd packages/benchmarks gepa:setup  # explicit Python/network setup
bun run --cwd packages/benchmarks test:gepa   # genuine optimizer integration
```

No standalone build script is defined; this package is consumed or executed from source.

`createPerfectResultPlugin` (also `createDeterministicModelPlugin`) supplies
scenario-authored model results through real runtime dispatch and persistence.
Declare non-text model types explicitly; unexpected or unconsumed required
fixtures fail. Run `bun test --conditions eliza-source
packages/testing/e2e/perfect-result-runtime.e2e.test.ts` from the root. These
scenarios verify runtime behavior, not model intelligence or audio quality.

Renderer tests import DOM fixtures from `@elizaos/testing/browser-mocks`; the
lightweight root authoring entry does not load browser mocks. Runtime constructors
live in `@elizaos/testing/runtime`, model fixtures in `@elizaos/testing/models`,
scenario discovery in `@elizaos/testing/scenarios`,
and progressive-content contracts in `@elizaos/testing/progressive-content`.

Vitest configuration imports path helpers from `@elizaos/repository-tools`
to avoid loading runtime fixtures and their build dependencies during setup.

`tsconfig.workspace.json` owns source aliases shared by the scenario runner,
scenario corpus, and Cloud E2E. Keep lane-specific compiler options and file
selection in their owning configs.

The native Ollama test provider rejects oversized embedding inputs explicitly.
To verify it against a running local `nomic-embed-text` model (real calls):

```bash
OLLAMA_URL=http://127.0.0.1:11434 OLLAMA_EMBEDDING_MODEL=nomic-embed-text \
  OLLAMA_EMBEDDING_LIVE=1 bun test --conditions=eliza-source \
  packages/testing/e2e/ollama-embedding.e2e.test.ts
```

`createSyntheticTestRuntime` composes real runtime/storage fixtures with a leased
API world. Declare services and seed requests in its world manifest, then use
its `world.endpoints` when constructing SDK clients. Cleanup verifies unmatched
requests and unused faults, stops the runtime and mock servers, and releases the
lease. `runSyntheticScenario` from `@elizaos/testing/scenario-runner` also runs the scenario executor and returns the
report with complete before/after state and API requests. See [synthetic-world](synthetic-world/README.md) for the control protocol.

Vitest live-provider suites import `describeLive` and `buildLiveHarness` from
`@elizaos/testing/live`. Install the selected provider peer; this entry owns
real-runtime startup and teardown and remains separate from Bun test fixtures.
