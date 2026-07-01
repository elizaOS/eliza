# Issue 9940 Evidence: Remote Plugin Bridge Validation

Date: 2026-06-29

## Scope

This chunk addresses the high-priority trust-boundary item from #9940:

- Removed the six production `as unknown as` laundering casts from `packages/agent/src/services/remote-plugin-bridge.ts`.
- Added zod validation for remote action results, remote route handler results, and host-rpc runtime argument shapes before they enter the runtime.
- Added negative tests proving malformed action results, route handler results, and `createMemory` host-rpc payloads are rejected at the bridge boundary.

The broader empty-fallback cleanup and smell-budget CI guard remain follow-up work under #9940.

## Local Verification

Passed:

```text
bunx @biomejs/biome check packages/agent/src/services/remote-plugin-bridge.ts packages/agent/src/services/remote-plugin-bridge.test.ts
Checked 2 files in 1095ms. No fixes applied.
```

```text
bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/services/remote-plugin-bridge.test.ts
Test Files  1 passed (1)
Tests       8 passed (8)
```

```text
git diff --check
```

```text
rg -n "as unknown as" packages/agent/src/services/remote-plugin-bridge.ts
no matches
```

Additional check:

```text
node node_modules\@typescript\native-preview\bin\tsgo --noEmit -p packages\agent\tsconfig.json --pretty false 2>&1 | Select-String -Pattern "remote-plugin-bridge"
no remote-plugin-bridge diagnostics
```

Attempted but blocked by the Windows worktree dependency state:

```text
bun install
timed out after 300s with no useful output; the hung install process was stopped.
```

```text
bun run verify
[type-safety-ratchet] scanned 9861 tracked production source files
[type-safety-ratchet] as unknown as: 77 / 82
[type-safety-ratchet] baseline can shrink: as unknown as 82 -> 77
Error: spawn ...\node_modules\.bin\turbo ENOENT
```

Package-level verify is blocked because the install did not produce `node_modules/.bin/turbo`. The filtered check above confirms the touched bridge file is no longer contributing diagnostics, and the ratchet output confirms this chunk reduces the production `as unknown as` count.

## Evidence N/A

- Real-LLM trajectory: N/A, no model behavior changed.
- Screenshots/video/audio: N/A, no UI or voice surface changed.
