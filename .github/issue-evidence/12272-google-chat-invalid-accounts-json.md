# Issue #12272 - Google Chat invalid accounts JSON

## Scope

This chunk fixes the Google Chat connector account-config slop called out in issue #12272: malformed `GOOGLE_CHAT_ACCOUNTS` no longer resolves to `{}` and silently boots the connector as if no accounts were configured. The parser now throws an `ElizaError` with:

- `code`: `GOOGLE_CHAT_CONFIG_INVALID`
- `context`: `{ "setting": "GOOGLE_CHAT_ACCOUNTS" }`
- `severity`: `fatal`
- `cause`: the original `SyntaxError`

The Google Chat Vitest shim for `@elizaos/core` now also exports the real structured-error symbols so connector unit tests exercise the same error type used by production imports.

## Verification

Run on July 3, 2026 from branch `codex/fix-12272-google-chat-invalid-accounts`.

```bash
bun run --cwd plugins/plugin-google-chat test -- src/accounts.test.ts
```

Result: passed, 1 file / 6 tests.

```bash
bun run --cwd plugins/plugin-google-chat test
```

Result: passed, 2 files / 11 tests.

```bash
bunx @biomejs/biome check \
  plugins/plugin-google-chat/src/accounts.ts \
  plugins/plugin-google-chat/src/accounts.test.ts \
  packages/test/vitest/shims/elizaos-core-connector.ts
```

Result: passed, 3 files checked.

```bash
bun run --cwd plugins/plugin-google-chat typecheck
```

Result: passed.

```bash
bun run --cwd plugins/plugin-google-chat build
```

Result: passed.

```bash
bun run audit:error-policy-ratchet
```

Result: passed. The ratchet reported 1 changed production source file and no new fallback slop.

```bash
bun run verify
```

Result: failed on an unrelated existing lint issue in `@elizaos/cloud-ui#lint` after 104 successful tasks. The reported files were `packages/cloud-ui/src/approvals/ApprovalsRoute.tsx`, `packages/cloud-ui/src/approvals/components/approvals-tab.tsx`, `packages/cloud-ui/src/approvals/components/ballots-tab.tsx`, `packages/cloud-ui/src/approvals/components/sensitive-tab.tsx`, `packages/cloud-ui/src/approvals/index.ts`, `packages/cloud-ui/src/approvals/lib/approvals.ts`, and `packages/cloud-ui/src/index.ts`, all import/export ordering or formatting findings outside this branch's touched files.

## Evidence Matrix

- Backend logs: N/A - this is a startup/config parsing failure covered by a direct package regression test before any Google Chat API client or route runs.
- Frontend screenshots/video: N/A - no UI surface changed.
- Live Google Chat round-trip: N/A - the fixed path rejects malformed local configuration before a connector account can be constructed or a platform request can be made.
- Real-LLM trajectories: N/A - no agent action, provider, prompt, model, or message-turn behavior changed.
- Domain artifact: the failing config input `{not json` now produces the typed fatal error asserted in `plugins/plugin-google-chat/src/accounts.test.ts`.
