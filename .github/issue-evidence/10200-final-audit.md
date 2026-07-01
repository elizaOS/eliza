# Final audit - issue #10200

Audit date: 2026-07-01

Branch: `chore/10200-final-audit`
Synced base: `origin/develop` at `caacfd052a54`
Audit commit before this evidence file: `498e5ed3b837`

## Issue status

Issue #10200 is still open and should remain open. The direct script-declutter
work has landed, but the issue thread still documents one residual item:
`run-all-tests.mjs` / dev-orchestrator consolidation. That item was explicitly
deferred in the merged evidence, so closing the umbrella would overstate the
state of the repo.

## Direct #10200 PR review

| PR | State | Review result |
|---|---|---|
| #10360 `docs(build): root-script inventory + dead-script audit` | merged | Covered acceptance criterion 1 for the root/packages/scripts inventory and produced the initial audit baseline. |
| #10361 `chore(build): remove the dead harness root script` | merged | Removed a proven duplicate root alias with no tracked callers. |
| #10384 `build(scripts): de-larp build:core + shared-helper self-tests + packages/app inventory` | merged | Implemented the main distinctive scope: metadata-driven `build:core`, packages/app script inventory, plugin-build self-tests, and duplicate alias removals. Correct direction. |
| #10403 `fix(scripts): harden #10200 build helpers after adversarial review` | merged | Hardened helper resolution, externals tests, dependency-selector parsing, and actionable `build:core` output. Correct follow-up. |
| #10413 `fix(core): build logger before core declarations` | merged | Fixed a real package-local build-order hole found while validating #10200 commands. |
| #10479 `chore(scripts): remove two verified-dead scripts` | merged | Removed two tracked-zero-reference dead scripts. |

Related umbrella work was also accounted for: #10194 removed the large dead
report-builder cluster, #10096 closed the mobile/desktop build decomposition,
and #10078 carried the broader build.ts consolidation line.

## Current inventory

Fresh measurements from the rebased tree:

```text
root scripts: 201
packages/app scripts: 82
checked-in packages/scripts/*.mjs: 87 files, 25,787 LOC
orphan packages/scripts/*.mjs by reachability: 27 files, 5,048 LOC
root scripts with no detected automated caller: 132
packages/app scripts with no detected automated caller: 54
checked-in build.ts files under packages/ + plugins/: 68
build.ts files using the shared plugin-build helper: 59
build.ts files not using plugin-build: 9
direct Bun.build mentions in build.ts files: 19
tsup mentions in build.ts files: 0
tsc mentions in build.ts files: 24
```

The remaining non-plugin-build `build.ts` files are package-specific or template
drivers:

```text
packages/cloud/sdk/build.ts
packages/core/build.ts
packages/elizaos/build.ts
packages/elizaos/templates/plugin/build.ts
packages/examples/_plugin/build.ts
packages/feed/packages/sim/cli/commands/build.ts
plugins/plugin-sql/src/build.ts
plugins/plugin-wallet/src/chains/evm/build.ts
plugins/plugin-wallet/src/chains/solana/build.ts
```

Alias review after the merged work:

```text
harness: removed
dev:web:ui: removed
dev:cloud:full: removed
test:cloud:playwright: preserved -> bun run --cwd packages/app test:e2e
test:cloud:full: preserved -> bun run test:cloud && bun run test:cloud:e2e
lint:all: preserved -> bun run lint:check && bun run typecheck
```

## Fixes in this final audit PR

This PR clears verification regressions found while reviewing and validating the
merged #10200 work:

- `packages/core/src/runtime.ts`: removes one avoidable `?? {}` pattern so the
  type-safety ratchet remains below baseline.
- `packages/core/src/index.browser.ts`: exports sub-agent credential primitives
  from the browser entrypoint to keep the public core surface consistent.
- `turbo.json`: makes dependency ordering deterministic for
  `@elizaos/plugin-polymarket#typecheck` and
  `@elizaos/plugin-personal-assistant#typecheck`.
- `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/src/components/LandingPage.tsx`:
  replaces ambiguous `here` links with descriptive link text.
- `packages/registry/generated-registry.json` and `tsconfig.dist-paths.json`:
  regenerated outputs required by the current verification gates.

## Validation

Commands run after rebasing onto `origin/develop`:

```text
bun install
bun run verify
bun run audit:scripts:inventory
```

Additional focused validation from the audit pass:

```text
bun test packages/scripts/__tests__/build-core.test.ts packages/scripts/__tests__/plugin-build.test.ts packages/scripts/__tests__/audit-scripts-inventory.test.ts
bun run audit:scripts
bun run audit:scripts:self-test
bun run audit:build-model
bun run build:core -- --dry
bun run --cwd packages/core build
bun run --cwd packages/app-core typecheck
bun run --cwd packages/app-core build
bun test --coverage-reporter=lcov packages/core/src/features/sub-agent-credentials packages/app-core/src/runtime/sub-agent-credential-bridge-wiring.test.ts packages/app-core/src/services/credential-tunnel-service.test.ts packages/app-core/src/api/credential-tunnel-routes.test.ts
bun run --cwd plugins/plugin-commands build
bun run --cwd plugins/plugin-telegram build
bun run --cwd packages/cloud/api lint
bun test v1/coding-containers/route.test.ts
bun run --cwd packages/cloud/shared lint
bun test src/db/repositories/__tests__/agent-billing-reactivation.test.ts
bun run --cwd packages/ui lint
bun run --cwd plugins/plugin-linear lint
bun run --cwd plugins/plugin-polymarket typecheck
bun run --cwd plugins/plugin-calendar clean
bun run --cwd plugins/plugin-goals clean
node packages/scripts/run-turbo.mjs run typecheck --filter=@elizaos/plugin-personal-assistant --concurrency=4
bun run typecheck:dist
```

`bun install` reported the artifact bundle already current at `2026-06-18.1`.

## Visual evidence

The only visible UI text change in this final PR is the Solana trajectory viewer
link text. I captured it against the real local Vite app:

```text
bun run --cwd packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer start -- --host 127.0.0.1 --port 4178
```

Artifacts:

- Screenshot: `10200-final-audit-trajectory-viewer-links.png`
- Screen recording: `10200-final-audit-trajectory-viewer.webm`

Manual review:

- DOM check confirmed both revised link texts are present:
  `in their swap benchmark analysis.` and
  `through the Solana benchmark funding form`.
- Screenshot was opened and reviewed.
- Video metadata was checked with `ffprobe`: VP8, 1280x720, 2.52 seconds.
- A frame extracted from the video showed the revised benchmark-analysis link.

`packages/app audit:app` is not applicable here: this final audit PR does not
change `packages/app` runtime UI behavior or a shared UI component that bleeds
into it.

## Close decision

Do not close #10200 yet. The implementation direction is right and the merged
PRs cover most acceptance criteria, but the documented `run-all-tests.mjs` /
dev-orchestrator consolidation residual means the issue is not 100 percent done.
