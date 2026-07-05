# 14263 sandboxed frame document contract

## Scope

Issue #14263 follows up #14255: sandboxed dynamic/plugin views must load a real
framed HTML document, not the JavaScript module endpoint. After rebasing on the
latest `develop`, the canonical contract is `framePath` / `frameUrl` with
package-local documents served from `/api/views/:id/frame.html`. This branch
adds focused coverage and evidence for that contract.

## What changed

- Remote plugin manifest tests now reject unsafe `framePath` and `frameUrl`.
- A new agent route test registers a real sandboxed dynamic view with
  `framePath`, verifies `/api/views` exposes `frameUrl`, and serves
  `GET`/`HEAD /api/views/:id/frame.html`.
- The route test verifies package-root traversal protection for escaping
  `framePath` values.
- `DynamicViewLoader` coverage verifies sandboxed iframe views use `frameUrl`
  as iframe `src`, do not import `bundleUrl` into the host realm, and still
  broker navigate/storage requests through `SandboxedViewFrame`.
- App-level wiring coverage verifies a frame-only registered route is passed to
  `DynamicViewLoader` with both `bundleUrl` and `frameUrl`.

## Verification run

All commands were run in the isolated worktree:
`.codex-worktrees/14263-sandbox-frame-doc`.

```bash
bunx @biomejs/biome check .github/issue-evidence/14263-sandbox-frame-document.md packages/agent/src/api/views-routes.frame.test.ts packages/core/src/capabilities/index.test.ts packages/ui/src/App.navigate-view-wiring.test.tsx packages/ui/src/components/views/DynamicViewLoader.test.tsx
```

Result: passed, 4 files checked (markdown evidence is ignored by the current
Biome config).

```bash
bun run --cwd packages/agent test -- src/api/views-routes.frame.test.ts
```

Result: passed, 1 file, 2 tests. This covers registry exposure,
`GET /api/views/:id/frame.html`, `HEAD /api/views/:id/frame.html`, HTML
response headers, body content for GET, and package-escaping `framePath`
rejection.

```bash
bun run --cwd packages/ui test -- src/components/views/DynamicViewLoader.test.tsx -t "loads sandboxed dynamic views"
```

Result: passed, 1 focused test, 26 skipped in the filtered file. This covers
`frameUrl` iframe `src` selection, no host-realm bundle import, storage
brokering, and navigate brokering.

```bash
bun run --cwd packages/core test -- src/capabilities/index.test.ts
```

Result: passed, 1 file, 63 tests. This includes rejection for unsafe
`framePath` and unsafe `frameUrl` in remote plugin manifests.

```bash
git diff --check
```

Result: passed.

## Verification gaps

- `bun run --cwd packages/ui test -- src/App.navigate-view-wiring.test.tsx -t "sandboxed frame-only"` could not collect tests in this sparse worktree.
  The local dependency shim is incomplete for the mounted App graph; Vite first
  lacked `@elizaos/capacitor-bun-runtime`, then followed the `motion` cache
  symlink and could not resolve `framer-motion` from that real path. A full
  workspace install should run this newly added App-level frame-only route
  assertion.
- Full `DynamicViewLoader.test.tsx` was not used as the pass/fail signal here.
  The focused new sandbox tests pass; the full file has neighboring existing
  agent-surface grant expectation failures unrelated to this document contract.
- No app audit screenshots or video were captured in this sparse worktree.
  This change does not alter visible shell chrome, but it does affect frontend
  routing behavior; the draft PR should keep rendered proof marked as pending
  until a full app workspace can run `bun run --cwd packages/app audit:app` or an
  equivalent real dynamic-view walkthrough.
