# Evidence — #10957 OAuth accounts SSE status stream leaks access+refresh tokens

Fix: `packages/agent/src/auth/oauth-flow.ts` — `FlowState.account` is now the
credential-free `FlowAccountSummary` (`Omit<AccountCredentialRecord, "credentials">`),
type-enforcing that tokens can never enter the SSE-broadcast state. The
in-process `OAuthFlowHandle.completion` promise and the on-disk record keep the
full credentials.

## 1. The bug, demonstrated (mutation check — tests run against the UNFIXED code)

The new tests drive the real `startCodexOAuthFlow` → `startGenericFlow` →
`persistAccount` → emit path (only the vendor OAuth network layer faked) and
assert on `JSON.stringify(state)` — byte-for-byte what
`handleOAuthStatusSse` writes to the wire. Against the pre-fix
`oauth-flow.ts` they fail, showing the cleartext tokens inside the SSE frame:

```
❯ src/auth/oauth-flow.test.ts (4 tests | 2 failed) 36ms
AssertionError: expected '{"sessionId":"29ee950b-59e2-4388-a0a3…' not to contain 'codex-access-token-SECRET'
Received: "{"sessionId":"29ee950b-59e2-4388-a0a3-399ab3a1e280","providerId":"openai-codex",
"status":"success","authUrl":"https://auth.openai.com/authorize?fake","needsCodeSubmission":false,
"startedAt":1782935651233,"account":{"id":"acct-2","providerId":"openai-codex","label":"Work",
"source":"oauth","credentials":{"access":"codex-access-token-SECRET",
"refresh":"codex-refresh-token-SECRET","expires":1782935711233},
"createdAt":1782935651233,"updatedAt":1782935651233},"endedAt":1782935651233}"
```

That `credentials` blob is exactly what every
`GET /api/accounts/:provider/oauth/status` subscriber received.

## 2. The fix, verified (same tests against the fixed code)

```
✓ src/auth/oauth-flow.test.ts (4 tests) — Tests 4 passed (4)
  ✓ emits a success state without the OAuth tokens
  ✓ replays a token-free terminal state to late subscribers
  ✓ keeps the full credentials on the completion promise and on disk
  ✓ emits an account-free error state when the exchange fails
```

Full auth suite (`packages/agent/src/auth`): `Test Files 2 passed (2), Tests 14 passed (14)`.

## 3. No regressions

- **Typecheck:** `bun run --cwd packages/agent typecheck` error sets diffed
  pristine-HEAD vs with-fix: **identical** (66 pre-existing environmental
  errors in unrelated packages — unbuilt `@elizaos/cloud-routing` workspace dep
  etc.; zero introduced).
- **Biome:** `biome check` clean on both touched files.
- **Consumers audited:** no code reads `FlowState.account.credentials`
  anywhere (repo-wide grep). The UI already types the frame's `account` as
  credential-free `LinkedAccountConfig`, and both `onCreated` consumers
  (`AccountList.tsx`, `AccountConnectBlock.tsx`) ignore the argument and
  refetch — so the redaction is invisible to the client. The token-needing
  paths (CLI/pool via `OAuthFlowHandle.completion`, `onAccountSaved`,
  `saveAccount` on disk) are unchanged and covered by test 3.

## N/A rows

- Screenshots / video / frontend logs: **N/A** — backend-only redaction of an
  SSE payload field the UI never read or rendered; no user-visible pixel
  changes.
- Live-LLM trajectory: **N/A** — no agent/action/provider/prompt/model
  behavior involved; this is HTTP credential-surface hygiene.
- Real vendor OAuth exchange: **N/A** — completing a live Anthropic/OpenAI
  browser login is inherently interactive; the vendor boundary is the only
  faked seam, and everything downstream of it (flow registry, persistence,
  emit, wire serialization) runs real in the tests.
