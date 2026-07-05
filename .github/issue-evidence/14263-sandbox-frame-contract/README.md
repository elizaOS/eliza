# #14263 sandbox frame contract evidence

Evidence captured on `origin/develop` at `39cb84b6730` after the sandbox frame
contract PRs merged. The browser proof uses the shipped developer-only
`sandbox-probe` view with Developer Mode enabled, the app Vite dev server on
`http://127.0.0.1:2138`, and the existing UI-smoke API stub on
`http://127.0.0.1:31337`.

## Focused checks

```bash
node packages/app-core/scripts/ensure-shared-i18n-data.mjs
bun run --cwd packages/cloud/routing build
bun run --cwd packages/agent test -- src/__tests__/views-system-smoke.test.ts
bun run --cwd packages/ui test -- src/components/views/DynamicViewLoader.sandboxed-frame.test.tsx src/components/views/SandboxedViewFrame.test.tsx
bunx @biomejs/biome@2.5.1 check packages/agent/src/__tests__/views-system-smoke.test.ts packages/ui/src/components/views/DynamicViewLoader.sandboxed-frame.test.tsx packages/ui/src/components/views/SandboxedViewFrame.test.tsx packages/ui/src/components/views/sandbox-probe-view.tsx
```

Results:

- Agent route smoke: 31 passed, including `/api/views/:id/frame.html` serving
  HTML and refusing the old bundle-as-frame fallback.
- UI frame/broker tests: 10 passed, including frameUrl selection, fail-closed
  missing-frame behavior, denied navigate/storage, granted navigate/storage,
  source-window identity gating, and bad-payload failure.
- Biome: clean.

## Browser proof

Captured with Playwright in Chromium:

- `desktop-probe.png`, `mobile-probe.png` — the real app route
  `/apps/sandbox-probe` renders the sandboxed iframe.
- `desktop-storage.png`, `mobile-storage.png` — clicking the framed document's
  storage request button returns `storage serviced: {"ok":true}`.
- `desktop-navigate.png`, `mobile-navigate.png` — clicking the framed document's
  navigate request changes the shell path to `/apps/chat`.
- `desktop-result.json`, `mobile-result.json` — machine-readable proof:
  `sandbox: "allow-scripts"`, no `allow-same-origin`, namespaced storage key
  `eliza:sbxview:sandbox-probe:probe` equals `hello`, raw `probe` is `null`,
  and post-navigate path is `/apps/chat`.
- `desktop-console.log`, `mobile-console.log` and matching `*-network.log` —
  console/network capture for the run. The logs include expected UI-smoke stub
  501s for unrelated app endpoints; the sandbox probe route itself renders and
  its broker actions complete.

This covers the remaining rendered-evidence blocker for #14263 without relying
on the old JavaScript bundle URL as an iframe document.
