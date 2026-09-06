# @elizaos/shared

Shared contracts, configuration, utilities, and assets used by runtime hosts,
UI, Cloud services, and plugins. Repository rules in the
[root guide](../../CLAUDE.md) apply.

## Ownership and entry points

This package depends on core and registry. Keep host assembly in agent/app-core,
view rendering in UI, and provider integration in its plugin. Importing an
application host here can introduce a boot-time dependency cycle.

The root [barrel](src/index.ts) includes Node-specific Cloud TTS helpers through
`src/elizacloud/index.ts`. It is not an environment-neutral leaf. Browser
consumers must use appropriate subpaths or their host's explicit bundler
configuration. Keep React hooks out of the root so server consumers do not
initialize React UI state.

Check [package.json](package.json) before changing an export. Preserve published
compatibility deliberately: search consumers, generated templates, and compiled
declarations. Subpaths such as brand, local-inference persistence, and Steward
session helpers express real runtime boundaries and should not be collapsed
into the root solely for import uniformity.

## Source map

| Location | Responsibility |
| --- | --- |
| `src/api/`, `src/contracts/` | Cross-package request, response, and domain contracts |
| `src/config/` | Configuration types, validation, environment aliases, and boot state |
| `src/local-inference/` | Model catalog and policies; separate filesystem verification/persistence modules |
| `src/elizacloud/` | Cloud URL, provisioning, and server TTS helpers |
| `src/steward-session-client/` | Browser session synchronization and credential clearing |
| `src/apps/` | App detail/overlay extension registration contracts |
| `src/brand/`, `assets/` | Shared tokens and source brand assets |
| `src/i18n/keywords/` | Hand-authored keyword inputs |
| `src/i18n/generated/` | Generated keyword output |
| `src/utils/` | Utilities shared by multiple consumers |

## Changes and validation

- Add API contracts to their domain module and export through the relevant
  barrel. Keep protocol values and domain computation in their owning layer.
- Add configuration fields to the owning `types.*.ts` module and update the
  corresponding validation schema. Preserve the established environment alias
  precedence rather than introducing direct reads at new call sites.
- Keep browser-compatible metadata separate from Node filesystem operations.
  `src/local-inference/index.ts` exports verification types; actual verification
  and routing persistence have dedicated subpaths.
- Edit keyword inputs and run `build:i18n`; edit brand assets and run `sync`.
  Generated output is produced by its script, never patched manually.
- Synthetic environment and subprocess namespaces share
  `isSyntheticEnvironmentNamespace`: 1–512 non-control characters, without
  silently trimming caller input.

Run from the repository root:

```bash
bun run --cwd packages/shared build
bun run --cwd packages/shared typecheck
bun run --cwd packages/shared lint:check
bun run --cwd packages/shared test
```

`build` regenerates keyword data and emits the publishable ESM distribution;
`build:dist` emits the distribution only. Validate changed contracts through
actual consuming packages as well as focused unit tests. Root verification,
guide parity, and contribution evidence requirements remain applicable.
