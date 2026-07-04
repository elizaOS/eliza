# #12269 Plugin SQL Init Error Policy

## Scope

This chunk covers the `plugin-sql` entry points that decide whether to create a
database adapter during plugin initialization:

- `plugins/plugin-sql/src/index.ts`
- `plugins/plugin-sql/src/index.node.ts`
- `plugins/plugin-sql/src/index.browser.ts`

Before this change, unexpected adapter detection/readiness errors could be
treated like "no adapter registered", causing plugin init to create a replacement
adapter and hide the original failure. The entry points now only treat the known
`Database adapter not registered` runtime error as an absent-adapter signal.
Other failures are logged and rethrown as `ElizaError` with
`DB_ADAPTER_READY_CHECK_FAILED`.

## Error Path Evidence

Command run after rebasing on `origin/develop`:

```bash
bun run --cwd plugins/plugin-sql test -- __tests__/unit/plugin-init-error-policy.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       3 passed (3)
```

The test induces unexpected adapter detection/readiness failures for all three
entry points and asserts:

- plugin init throws `ElizaError`;
- the error code is `DB_ADAPTER_READY_CHECK_FAILED`;
- the original failure is preserved on `.cause`;
- `registerDatabaseAdapter` is not called after a real readiness/detection
  failure.

The browser entry point also emitted the structured backend log line:

```text
[PLUGIN:SQL] Browser database adapter readiness check failed
```

## Verification Commands

Passed:

```bash
git fetch origin && git rebase --autostash origin/develop
bun run --cwd plugins/plugin-sql test -- __tests__/unit/plugin-init-error-policy.test.ts
bun run --cwd plugins/plugin-sql typecheck
bun run --cwd plugins/plugin-sql lint:check
bun run --cwd plugins/plugin-sql build
bun run audit:error-policy-ratchet
```

Root verify was attempted:

```bash
bun run verify
```

It progressed through the initial AGENTS/CLAUDE check, type-safety ratchet,
error-policy ratchet, and 88 Turbo tasks before failing in unrelated cloud API
typecheck:

```text
Failed: @elizaos/cloud-api#typecheck
packages/cloud/api/__tests__/hf-proxy-route.test.ts(259,38): error TS2769
packages/cloud/shared/src/lib/services/market-preview.ts: missing exports from @elizaos/shared
```

The touched SQL package passed its focused test, typecheck, lint, build, and
the error-policy ratchet.

## Evidence Matrix

- Screenshots: N/A - no UI surface changed.
- Video walkthrough: N/A - no UI flow changed.
- Frontend console/network logs: N/A - no frontend surface changed.
- Real-LLM trajectories: N/A - no prompt, model, action, provider, or agent
  behavior changed.
- Backend logs: included above from the induced plugin init failure.
- Domain artifacts: plugin init does not create persistent domain artifacts;
  the test proves adapter registration is skipped when readiness fails.
