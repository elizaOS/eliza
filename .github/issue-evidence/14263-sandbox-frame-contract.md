# Issue #14263 - sandboxed frame document contract

## Scope

- Added explicit `framePath` / `frameUrl` view manifest fields for
  `surface.isolation: "sandboxed-iframe"` views.
- Kept `bundleUrl` as the host-realm JavaScript module contract.
- Added local `GET/HEAD /api/views/:id/frame.html` serving for packaged frame
  documents.
- Normalized remote `framePath` through the capability asset route.
- Updated UI routing and `DynamicViewLoader` so sandboxed iframe views use
  `frameUrl` and fail closed when it is missing.

## Verification

- `bunx @biomejs/biome check <16 touched files>` - pass.
- `git diff --check` - pass.
- `bunx tsc --noEmit --pretty false -p packages/core/tsconfig.json` - pass.
- `bun --conditions=eliza-source test packages/core/src/capabilities/index.test.ts` - pass.
- `bun --conditions=eliza-source test packages/agent/src/__tests__/views-registry-integration.test.ts --test-name-pattern "frameUrl|frame.html"` - pass.
- `bun --conditions=eliza-source test packages/agent/src/services/remote-capability-router.test.ts --test-name-pattern "frame URLs|multiple remote capability endpoints"` - pass.
- `bun --conditions=eliza-source test packages/agent/src/services/remote-plugin-adapter.test.ts --test-name-pattern "real local capability HTTP server"` - pass.
- `bun run --cwd packages/ui test src/components/views/DynamicViewLoader.test.tsx -t "sandboxed"` - pass.
- `bun run --cwd packages/ui test src/App.navigate-view-wiring.test.tsx -t "frame-only"` - pass.

## Incomplete Required Evidence

- `bun run --cwd packages/app audit:app` - attempted, but did not reach
  Playwright capture in the sparse worktree. The build failed in
  `@elizaos/shared#build` because `prepare-package-dist.mjs` could not resolve
  the workspace dependency `@elizaos/registry`.
- Desktop/mobile screenshots - not captured; blocked by the app audit build
  failure above.
- Video walkthrough - not captured; blocked by the app audit build failure
  above.
- Frontend console/network logs - not captured; blocked by the app audit build
  failure above.
- Backend logs - N/A for current local verification; no server was successfully
  launched by the audit command.
- Real-LLM trajectories - N/A; this change does not alter prompts, actions,
  providers, model selection, or agent generation behavior.
- Domain artifacts - N/A; this change does not create memories, knowledge rows,
  DB rows, scheduled tasks, wallet artifacts, chain transactions, generated
  user files, or device output.

## Notes

This PR should remain draft or unmerged until the app audit and visual evidence
are captured from a full workspace checkout.
