# #13419 evidence — cloud-connector status three-state slice

Successor slice to #12784 for `packages/ui/src/cloud/**`. Non-visual scope: the
shared cloud-connector status **probe hook** + the shared `ConnectionCard`
render contract that every token-credential connector (Twilio / WhatsApp /
Blooio / Telegram) renders through. Focused unit/component tests per the
accepted #13227 / #13434 / #13444 / #13463 precedent (no screenshot-gated .tsx
page surfaces changed in a way that alters a visual page's happy path).

## Path / pattern / verdict

| path | pattern | verdict |
| --- | --- | --- |
| `cloud/connectors/use-connection-status.ts` | failed status probe collapsed into `status=null` + a transient toast; no durable error signal | **FIX** — added `isError`/`errorMessage` three-state; `// error-policy:J4` on the probe-failure branch |
| `cloud-ui/components/connection-card.tsx` | only `loading` / `not-configured` / `connected` / `disconnected` states — no error surface | **FIX** — added `"error"` status + `role="alert"` block + optional `onRetry` |
| `cloud/connectors/twilio-connection.tsx` | `status={status?.connected ? "connected" : "disconnected"}` rendered the setup form on a FAILED probe | **FIX** — prefer `"error"`, wire `errorMessage`/`onRetry` |
| `cloud/connectors/whatsapp-connection.tsx` | same | **FIX** — same |
| `cloud/connectors/blooio-connection.tsx` | same | **FIX** — same |
| `cloud/connectors/telegram-connection.tsx` | same | **FIX** — same |
| `cloud/lib/api-client.ts` | transport/parse layer | audited-clean — already throws structured `ApiError`, 401→refresh nudge, `readPayload` fails closed |
| `cloud/admin/data/use-admin-gate.ts` | admin authorization gate | audited-clean — `isAdmin ?? false` fail-closed + exposes `isError` |
| `cloud/lib/use-session-auth.ts`, `jwt.ts` | auth resolution | audited-clean — `null` = signed-out is the correct fail-closed designed state |

## The fabrication (root cause)

`useConnectionStatus` (shared by all four token-credential connectors) caught a
failed status fetch, showed a transient `toast.error`, and left `status` at
`null` with `isLoading=false`. Consumers render
`status={status?.connected ? "connected" : "disconnected"}`, so a
transport / 5xx / parse / auth failure of `GET /api/v1/<connector>/status`
rendered the **"disconnected" setup form** — byte-identical to a genuinely
unconfigured connector, even though the backend was unreachable. The only signal
was a toast that vanishes. Classic #12784 three-state collapse: `error` folded
into `designed-empty`.

## The fix

- **Hook**: `isError: boolean` + `errorMessage: string | null`. A failed probe
  sets them (`// error-policy:J4`, toast retained for immediacy); a successful
  probe clears them so the surface leaves the error state. A healthy
  `connected:false` stays a real status (NOT an error) — the setup form still
  shows for a genuinely-disconnected connector.
- **ConnectionCard**: new `"error"` status renders a distinguishable
  `role="alert"` block (`errorMessage` + optional `Retry` button via `onRetry`),
  never the setup form.
- **Consumers**: render `"error"` when `isError`, pass the connector-specific
  fetch-failed i18n string, and wire `onRetry` → `refetch`. Reused existing
  `cloud.<connector>.statusFetchFailed` i18n keys → zero locale churn.

## Tests (focused, green)

```
packages/ui $ bunx vitest run \
  src/cloud/connectors/use-connection-status.test.ts \
  src/cloud-ui/components/connection-card.error.test.tsx

 ✓ src/cloud/connectors/use-connection-status.test.ts (4 tests)
 ✓ src/cloud-ui/components/connection-card.error.test.tsx (3 tests)

 Test Files  2 passed (2)
      Tests  7 passed (7)
```

- `use-connection-status.test.ts`: success → readable status, no error; failure →
  `isError`/`errorMessage`/toast (regression guard: a failed probe never reads as
  a healthy "not connected"); non-ApiError falls back to the default message;
  successful retry clears the error and a `connected:false` result is treated as a
  real status.
- `connection-card.error.test.tsx`: `status="error"` renders the alert and NOT
  the setup/connected content; `status="disconnected"` still renders the setup
  form with no alert; `onRetry` fires on the retry button.

## Gates

- `tsgo --noEmit -p packages/ui/tsconfig.json` → **0 errors** (whole package clean).
- `bunx @biomejs/biome check <8 touched files>` → clean.
- `bun run audit:error-policy-ratchet` → `no new fallback-slop in touched files`.
- `git diff --check` → clean; only the 8 intended files staged, no forbidden
  files (vite.config / index.html / client-base.ts / bun.lock / dist).

## N/A rows

- Model trajectories / audio — N/A (no changed cloud view invokes those flows).
- before/after page screenshots — the changed surface is the shared status
  **hook + card contract**, verified at the component/state level; the four
  connector pages' happy paths (loading / connected / disconnected) are
  unchanged, only the previously-invisible error path is now rendered.

## Scope note

`packages/ui/src/cloud/**` is large (per the issue inventory ~100+ files across
instances / applications / billing / organization / …). This slice takes the
shared connector-status contract — the highest-leverage single fabrication in
the connectors area. Issue stays open for the remaining cloud UI surfaces.

— [sol-orch]
