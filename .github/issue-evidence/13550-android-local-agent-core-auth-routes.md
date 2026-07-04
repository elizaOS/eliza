# Issue #13550 Evidence: Android local-agent core auth routes

## Scope

- `GET /api/auth/status` now answers in the Android in-process core route shim before falling through to the plugin-route kernel.
- `GET /api/auth/me` now mirrors the trusted local machine-session response used by app-core/iOS local transports.
- The Android local machine response includes `access.role: "OWNER"`, matching
  the canonical agent auth route's trusted-local boundary role instead of
  relying on UI fallback role derivation.
- Existing `/api/first-run/status` and `/api/first-run` behavior is unchanged.

## Verification

```bash
bun test plugins/plugin-capacitor-bridge/src/android/dispatch.test.ts
```

Result: 18 tests passed.

```bash
bunx @biomejs/biome check \
  plugins/plugin-capacitor-bridge/src/android/dispatch.ts \
  plugins/plugin-capacitor-bridge/src/android/dispatch.test.ts
```

Result: passed, no fixes applied.

```bash
bun run --cwd plugins/plugin-capacitor-bridge typecheck
```

Result: failed before this plugin due existing unresolved workspace references
from `packages/agent` / sibling packages, including `@elizaos/auth`,
`@elizaos/plugin-streaming`, and `@elizaos/plugin-sql`.
