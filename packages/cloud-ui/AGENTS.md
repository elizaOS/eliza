# @elizaos/cloud-ui — agent guide

The **Eliza Cloud product UI** as a standalone package, split out of `@elizaos/ui`
(arch #12092 item 23). Read `README.md` first for the boundary rationale.

## The one rule that defines this package

**Dependencies point one way: `@elizaos/cloud-ui` → `@elizaos/ui`. Never the
reverse.** The trunk (`@elizaos/ui`) keeps only the registries + the
`CloudRouterShell` mount seam and must never import this package. If you find a
trunk module importing `@elizaos/cloud-ui`, that is the bug — fix the direction,
do not add a shim.

## How a surface joins the cloud UI

Each feature area **self-registers** at import time via the shared registries in
`@elizaos/ui`:

- routes → `registerCloudRoute(...)` from
  `@elizaos/ui/cloud/shell/cloud-route-registry`;
- settings panes → `registerSettingsSection(...)` from
  `@elizaos/ui/components/settings/settings-section-registry`.

Both registries are keyed on a process-global symbol, so registration works
across lazy-chunk / package module-identity splits. Add the module's
registration call to `src/index.ts`'s `registerCloudUiSurfaces()` (idempotent)
and export its public surface from the barrel.

## Do NOT

- Do not import this package from `@elizaos/ui`, `@elizaos/app-core`, or any
  native/mobile entry path — it is web-cloud-only and must stay tree-shakeable.
- Do not re-introduce build-config passthrough stubs for cloud-free builds. The
  package boundary is the exclusion mechanism now: cloud-free builds simply do
  not import it.
- Do not reach back into `@elizaos/ui` internals with deep relative paths
  (`../../ui/src/...`). Import trunk code through `@elizaos/ui/*` subpaths only.

## Build / test

```bash
bun run --cwd packages/cloud-ui build      # tsc --noCheck emit to dist/
bun run --cwd packages/cloud-ui test       # vitest (reuses @elizaos/ui test config)
bun run --cwd packages/cloud-ui typecheck  # tsgo --noEmit
```
