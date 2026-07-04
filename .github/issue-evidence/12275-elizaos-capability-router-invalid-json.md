# #12275 capability-router invalid JSON response evidence

## Scope

- Chunk for issue #12275.
- `elizaos capability-router connect` no longer treats a malformed JSON body from a successful agent API response as an empty success object.
- Non-2xx responses with malformed JSON bodies still surface the HTTP status fallback instead of hiding the API failure.

## Verification

```bash
bun run --cwd packages/elizaos test -- src/commands/capability-router.test.ts
```

Result: passed, 1 file / 21 tests.

```bash
bun run --cwd packages/elizaos typecheck
```

Result: passed.

```bash
bun run --cwd packages/elizaos lint:check
```

Result: passed.

```bash
bun run --cwd packages/elizaos build
```

Result: passed.

```bash
bun run audit:error-policy-ratchet
```

Result: passed.

```bash
bun run verify
```

Result: failed in unrelated `@elizaos/cloud-shared#lint` formatting check:

```text
packages/cloud/shared/src/lib/types/cloud-api.ts:451
Formatter would print:
return value === "super_admin" || value === "moderator" || value === "viewer";
```

The root verify run reached 125 successful Turbo tasks before this lint failure.

## Built CLI Transcript

This used the built `packages/elizaos/dist/cli.js` against a local HTTP server
that returned malformed JSON from the real `/api/capability-router/connect`
path.

```text
$ NO_COLOR=1 node /Users/shawwalters/.codex/worktrees/8855/eliza/packages/elizaos/dist/cli.js capability-router connect --api-base http://127.0.0.1:56132 --endpoint-url https://capability.example.test
server POST /api/capability-router/connect
Agent API returned invalid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)
exit=1
```

## Evidence Matrix

- Backend logs: N/A - CLI command boundary only; transcript includes the local agent API request and response path.
- Frontend screenshots/video: N/A - no UI changes.
- Real-LLM trajectories: N/A - no model, prompt, provider, action, or evaluator behavior changed.
- Domain artifacts: N/A - no database, memory, wallet, scheduled task, generated file, or connector artifact changed.
