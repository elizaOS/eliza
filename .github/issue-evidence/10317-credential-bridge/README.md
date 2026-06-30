# Issue #10317 - sub-agent credential bridge wiring

Branch: `feat/10317-credential-bridge-wiring`

## What changed

- Adds additive tunnel routing metadata to sensitive-request delivery envelopes.
- Adds a parent-side `createSubAgentCredentialBridgeAdapter` over the existing one-shot `CredentialTunnelService`.
- Registers the credential bridge under both runtime service names on parent runtimes, plus the core `subAgentCredentialsPlugin` actions.
- Adds owner-authenticated `POST /api/credential-tunnel/submit`.
- Updates `SensitiveRequestBlock` so tunnel-routed submissions call `client.tunnelCredential` and never call `updateSecrets`.
- Updates orchestrator credential bridge routes to require a real active session, dispatch the inline tunnel-routed sensitive request, and post a resolution follow-up.

## Evidence

After the final pre-PR sync, `origin/develop` moved from `8681dc7cf8` to
`fa83361b9f` with unrelated issue-evidence-only changes. The branch rebased
cleanly, `git diff --check` still passed, and the focused test suites below
were rerun on the rebased branch.

```bash
bunx vitest run src/services/credential-tunnel-service.test.ts src/api/credential-tunnel-routes.test.ts src/runtime/sub-agent-credential-bridge-wiring.test.ts
```

Result from `packages/app-core`: 3 files passed, 26 tests passed.

```bash
bunx vitest run src/components/chat/MessageContent.sensitive-request.test.tsx
```

Result from `packages/ui`: 1 file passed, 10 tests passed.

```bash
bunx vitest run __tests__/unit/bridge-routes.test.ts
```

Result from `plugins/plugin-agent-orchestrator`: 1 file passed, 14 tests passed.

```bash
bunx vitest run src/features/sub-agent-credentials/**/*.test.ts
bunx vitest run src/features/sub-agent-credentials/plugin.test.ts
```

Result from `packages/core`: 5 files passed, 15 tests passed.

```bash
bun run --cwd packages/app audit:app
```

Result: 369 passed. Audit summary: `broken=0`, `needs-work=0`, `minimalism-budget-failures=0`.

Chat viewport artifacts are in `app-audit-chat/`:

- `builtin-chat-mobile-portrait.png` + manual review
- `builtin-chat-mobile-landscape.png` + manual review
- `builtin-chat-desktop-landscape.png` + manual review
- `builtin-chat-ipad-portrait.png` + manual review

```bash
git diff --check
```

Result: passed.

## Broader Check Caveats

Scoped package typechecks were attempted after `bun run install:light`, but current `develop` has unrelated typecheck drift outside this branch:

- `packages/ui` fails at `src/state/startup-phase-hydrate.voice-control.test.ts:71` and `:76` on Vitest mock listener typing.
- `packages/app-core` / `packages/agent` fail on missing workspace package declarations such as `@elizaos/plugin-background-runner`, `@elizaos/capacitor-bun-runtime`, `@elizaos/tui`, `@elizaos/cloud-routing`, plus existing `ios-runtime-bridge.ts` `unknown` narrowing errors.
- `plugins/plugin-agent-orchestrator` typecheck fails through `packages/app-core/src/services/coding-account-bridge.ts` on missing `@elizaos/agent/utils/atomic-json`.

These failures are not introduced by the credential-bridge diff; the focused suites above exercise the changed code paths.

## Scope Note

This PR wires the deterministic parent-runtime bridge, inline sensitive-request submit path, and loopback redemption path. A live parent/child ACP scenario with real connector DM capture and live-model trajectory still requires a running orchestrator session and connector credentials; the local evidence here covers the production code seams that can be exercised without those external credentials.
