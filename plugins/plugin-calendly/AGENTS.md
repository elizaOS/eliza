# @elizaos/plugin-calendly

Calendly v2 integration for elizaOS agents — event types, scheduled events, cancellations, booking-link handoff, and Calendly-owned assistant message projections.

## Purpose / role

Adds Calendly scheduling capabilities to an Eliza agent: listing the connected user's event types, resolving booking links, canceling scheduled events via the Calendly v2 REST API, and exposing a `CalendlyAdapter` for assistant surfaces such as LifeOps. Auto-enabled when any of `CALENDLY_ACCESS_TOKEN`, `CALENDLY_ACCOUNTS`, or `ELIZA_E2E_CALENDLY_ACCESS_TOKEN` is present. Registered as `"calendly"` in the plugin registry.

## Plugin surface

| Kind | Name | What it does |
|------|------|--------------|
| Service | `CalendlyService` (`serviceType: "calendly"`) | Owns Calendly API access; wraps `calendly-client.ts`; supports N accounts via `accounts.ts`. |
| Provider | `calendlyEventTypes` | Read-only; surfaces connected user's active event types (name, slug, duration, scheduling URL) as JSON context. Active in `connectors` and `productivity` routing contexts. Cache scope: per-turn. |
| Action | `CALENDLY` (exported as `calendlyOpAction`) | Unified router for `subaction: "book"` (URL handoff or own-event booking link) and `subaction: "cancel"` (cancellation with `requireConfirmation` guard). Active in `calendar`, `automation`, `connectors` contexts. Role gate: `ADMIN`. |
| Message adapter | `CalendlyAdapter` | Calendly-owned projection of scheduled events into the core message-triage shape for assistant plugins. |

Note: the plugin registers `actions: []` in the `Plugin` object — `calendlyOpAction` is exported from the package for host apps to compose into their own plugin arrays or action lists. If you want `CALENDLY` in the default plugin surface, add `calendlyOpAction` to the `actions` array in `src/index.ts`.

## Layout

```
src/
  index.ts                        Plugin entry; exports calendlyPlugin + all public types
  types.ts                        Shared types: CalendlyEventType, CalendlyScheduledEvent,
                                  CalendlyAvailability, CalendlyActionResult, CalendlyActions const
  accounts.ts                     Multi-account resolution (env, character settings, CALENDLY_ACCOUNTS JSON)
  calendly-client.ts              Raw Calendly v2 HTTP client (no caching, no retry):
                                    getCalendlyUser, listCalendlyEventTypes,
                                    listCalendlyScheduledEvents, getCalendlyAvailability,
                                    cancelCalendlyScheduledEvent, createCalendlySingleUseLink,
                                    readCalendlyCredentialsFromEnv
  lifeops-message-adapter.ts       CalendlyAdapter for assistant/LifeOps message triage registration
  connector-account-provider.ts   ConnectorAccountManager bridge: list/create/patch/delete accounts,
                                  startOAuth, completeOAuth (PKCE not needed; code flow)
  connector-credential-refs.ts    Credential-ref persistence helper for OAuth tokens
  actions/
    calendly-op.ts                CALENDLY action handler (book + cancel)
  providers/
    calendly-event-types.ts       calendlyEventTypes provider
  services/
    CalendlyService.ts            Service: listEventTypes, listScheduledEvents, getAvailability,
                                  createSingleUseLink, getBookingUrl, cancelBooking,
                                  getCachedUserUri, attach (test hook)
  calendly-client.test.ts         Unit tests for the HTTP client
  calendly-client.contract.test.ts  Contract tests for the HTTP client
  calendly-client.real.test.ts    Live integration tests (gated on CALENDLY_LIVE_TEST=1 or TEST_LANE=post-merge)
  connector-account-provider.test.ts  Unit tests for the connector-account provider
  lifeops-message-adapter.test.ts Unit tests for the LifeOps message adapter
```

## Commands

Only scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-calendly build      # tsup ESM build + tsc declarations
bun run --cwd plugins/plugin-calendly test       # vitest run
bun run --cwd plugins/plugin-calendly typecheck  # tsgo --noEmit
bun run --cwd plugins/plugin-calendly clean      # rm -rf dist .turbo
```

## Config / env vars

| Env var | Required | Purpose |
|---------|----------|---------|
| `CALENDLY_ACCESS_TOKEN` | Required (or `CALENDLY_ACCOUNTS`) | Personal access token for a single Calendly account |
| `ELIZA_CALENDLY_TOKEN` | Alt alias | Fallback alias for `CALENDLY_ACCESS_TOKEN` (checked second) |
| `CALENDLY_ACCOUNTS` | Alt to above | JSON array/object of multiple account configs (each with `accountId` + `accessToken`) |
| `CALENDLY_ACCOUNT_ID` | Optional | Explicit account ID when using single-token mode |
| `CALENDLY_DEFAULT_ACCOUNT_ID` | Optional | Default account when multiple accounts are configured |
| `CALENDLY_USER_URI` | Optional | Override user URI (skips `/users/me` lookup) |
| `ELIZA_CALENDLY_USER_URI` | Optional | Fallback alias for `CALENDLY_USER_URI` |
| `CALENDLY_ORGANIZATION_URI` | Optional | Override organization URI |
| `ELIZA_CALENDLY_ORG_URI` | Optional | Fallback alias for `CALENDLY_ORGANIZATION_URI` |
| `CALENDLY_OAUTH_CLIENT_ID` | Required for OAuth | Calendly OAuth app client ID |
| `CALENDLY_OAUTH_CLIENT_SECRET` | Required for OAuth | Calendly OAuth app client secret |
| `CALENDLY_OAUTH_REDIRECT_URI` | Required for OAuth | OAuth redirect URI registered in Calendly app |
| `ELIZA_E2E_CALENDLY_ACCESS_TOKEN` | E2E only | Fallback token for integration tests |
| `ELIZA_MOCK_CALENDLY_BASE` | Test only | Override `https://api.calendly.com` base URL for mocking |
| `CALENDLY_LIVE_TEST` | Test only | Set to `1` to enable live integration tests in `calendly-client.real.test.ts` |

The `autoEnable.envKeys` check uses `CALENDLY_ACCESS_TOKEN`, `CALENDLY_ACCOUNTS`, and `ELIZA_E2E_CALENDLY_ACCESS_TOKEN`.

## How to extend

**Add an action:**
1. Create `src/actions/<name>.ts` implementing `Action` from `@elizaos/core`.
2. Use `runtime.getService<CalendlyService>(CALENDLY_SERVICE_TYPE)` to access the service.
3. Export from `src/index.ts` and add to `calendlyPlugin.actions`.

**Add a provider:**
1. Create `src/providers/<name>.ts` implementing `Provider`.
2. Inject `CALENDLY_SERVICE_TYPE` via `runtime.getService<CalendlyService>(...)`.
3. Export from `src/index.ts` and add to `calendlyPlugin.providers`.

**Add a CalendlyService method:**
- Add to `src/services/CalendlyService.ts` — call through to `calendly-client.ts` functions; map normalized types to the domain types in `src/types.ts`.

**Add a calendly-client function:**
- Add to `src/calendly-client.ts` — use `calendlyRequest<T>()` for all API calls. Export the normalized interface and the async function. Re-export from `src/index.ts` if public.

## Conventions / gotchas

- **`actions: []` is intentional.** `calendlyOpAction` is exported but not registered in the default plugin surface. Consumers opt in explicitly. If adding it to the plugin, update `src/index.ts`.
- **Multi-account:** `accounts.ts` resolves accounts from three sources in priority order: character `settings.calendly.accounts`, `CALENDLY_ACCOUNTS` JSON env var, and legacy `CALENDLY_ACCESS_TOKEN`. Account ID defaults to `"default"`.
- **Cancel requires confirmation.** `CALENDLY_OP` cancel uses `requireConfirmation` — the action returns `requiresConfirmation: true` on first call; proceed only after the user confirms.
- **No retry / caching in client.** `calendly-client.ts` is intentionally thin. All caching, retry, and interpretation live in `CalendlyService` and actions above.
- **Role gate.** `calendlyOpAction` requires `minRole: "ADMIN"`. Agents without that role cannot invoke it.
- **Context gate.** `calendlyEventTypesProvider` only injects into `connectors` and `productivity` routing contexts. `CALENDLY` action is gated to `calendar`, `automation`, `connectors`.
- **Test mock URL.** Set `ELIZA_MOCK_CALENDLY_BASE` in tests to redirect all `https://api.calendly.com` calls to a local server.
- **`attach()` is a test hook.** `CalendlyService.attach()` bypasses env resolution and registers credentials directly — use only in tests.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
