# @elizaos/plugin-cloud-apps

Lets an Eliza agent **manage the user's Eliza Cloud Apps from any connector**
(in-app chat, Discord, Telegram, cloud-hosted) through the shared AgentRuntime
pipeline. One plugin registration exposes the whole app lifecycle — list,
create, deploy (with a live-verification gate), monetize, take/withdraw
earnings, rotate keys, buy + manage custom domains, and the growth surfaces
(frontend hosting, ad slots, influencer bookings) — as planner actions plus a
context provider.

It is a **client of `@elizaos/cloud-sdk`** (`ElizaCloudClient`), not of the
cloud backend directly. Read the root `AGENTS.md` for repo-wide rules; this doc
is specific to the plugin.

## Auth

Reads `ELIZAOS_CLOUD_API_KEY` (+ optional `ELIZAOS_CLOUD_BASE_URL`, defaults to
`https://www.elizacloud.ai/api/v1`) via `runtime.getSetting` — the same
credentials `plugin-elizacloud` uses. With no key, `validate` returns false,
every action degrades gracefully with a "no key" message, and the provider
stays empty. Construction lives in `src/client.ts` (`getCloudClient`).

## Layout

```
src/
  index.ts               Plugin registration: the actions[] array + CLOUD_APPS provider.
  client.ts              getCloudClient (SDK construction), resolveCloudApiKey/BaseUrl/SiteBaseUrl,
                         app-reference resolution (matchAppByReference/resolveApp — id → exact
                         name/slug → whole-word-in-sentence → fragment; ties = ambiguous),
                         and the app formatters (formatAppLine/formatAppDetail).
  safety.ts              Two-phase confirm state machine for destructive/paid actions:
                         readStructuredConfirmation (planner boolean, NEVER prose parsing),
                         persist/find/deleteCloudAppConfirmation (task-backed, room-scoped),
                         confirmationPrompt, buildConnectorCta (label+https URL only — never a
                         secret/amount). CloudAppConfirmationAction is the gated-action union.
  deploy-gate.ts         runDeployGate: poll deploy status → READY, then reachability-probe the
                         authoritative production_url before claiming live (pure + injectable).
  reachability.ts        probeReachable + respondedLive (2xx / non-gateway-down = live).
  app-facts.ts           record/removeAppDeployFact — durable "app is live at <url>" memory fact.
  domain-facts.ts        record/remove/hasInterruptedDomainPurchase — durable marker for a 502
                         persist_failed_recoverable buy so the free recovery stays reachable.
  domain-intent.ts       Pure domain helpers: extractDomainReferences (boundary-guarded),
                         resolveDomainTargetApp (sole-app default), cloudErrorInfo (duck-typed
                         CloudApiError), usdFromCents, formatDomainLine.
  providers/cloud-apps.ts  CLOUD_APPS provider (app inventory into planner context) + a 60s
                         WeakMap cache with invalidateAppsCache(runtime).
  actions/               One file per action (see below).
__tests__/               bun test suites (helpers.ts fakes ONLY the SDK boundary).
test/scenarios/          cloud-apps-structured-confirm.scenario.ts — real SDK over a loopback
                         cloud, proving the two-phase confirm on the pr-deterministic lane.
```

## Actions

**Read-core**
- `LIST_CLOUD_APPS` — list the user's apps (name / url / status).
- `GET_APP` — details for one app by name or id.
- Provider `CLOUD_APPS` — injects the app inventory into planner context.

**Create → deploy → live loop + safe delete**
- `CREATE_APP` — create from name/description/monetization intent.
- `DEPLOY_APP` — deploy + COMPLETION GATE (READY, then `/health` 2xx on the
  authoritative `production_url`) before claiming live; records a deploy fact.
- `GET_APP_DEPLOY_STATUS` — DRAFT/BUILDING/DEPLOYING/READY/ERROR + url.
- `DELETE_APP` — DESTRUCTIVE: two-phase connector-agnostic confirm; honest
  partial-failure reporting; invalidates cache + removes the deploy fact.

**Manage (edit / monetize / earnings / money-out / key rotation)**
- `UPDATE_APP` — rename / edit description, logo, website, email.
- `UPDATE_MONETIZATION` — enable/disable + markup % / purchase share %; range-guarded.
- `GET_APP_EARNINGS` — READ-ONLY: withdrawable / pending / lifetime / withdrawn.
- `WITHDRAW_APP_EARNINGS` — MONEY-OUT: two-phase confirm + dashboard CTA; the
  safe, idempotent, server-gated request endpoint fires on confirm.
- `REGENERATE_APP_API_KEY` — SECURITY: two-phase confirm; new key shown ONCE, never logged.

**Domains (check → buy → list)**
- `CHECK_APP_DOMAIN` — READ-ONLY availability + purchase/renewal price quote.
- `BUY_APP_DOMAIN` — MONEY-OUT: read-only quote first, two-phase confirm with a
  15-min quote TTL + confirm-time price re-check; maps the server's idempotent
  replay / refund-on-registrar-failure / no-charge-recovery outcomes to honest
  replies; interrupted purchases are tracked in `domain-facts.ts`.
- `LIST_APP_DOMAINS` — READ-ONLY: registrar/status/SSL/verification per domain
  (with the exact `_eliza-cloud-verify` TXT record for unverified external domains).

**Growth surfaces**
- `DEPLOY_FRONTEND` / `ROLLBACK_FRONTEND` / `LIST_FRONTEND_DEPLOYMENTS` — managed
  frontend hosting (publish/rollback app frontends on Cloud).
- `CREATE_AD_SLOT` / `LIST_AD_SLOTS` — SSP ad inventory for monetized apps.
- `CREATE_INFLUENCER_PROFILE` / `LIST_INFLUENCERS` / `BOOK_INFLUENCER` — influencer
  marketing marketplace.
- `BACKUP_APP` — export an app's config snapshot.

## Commands

```bash
bun run --cwd plugins/plugin-cloud-apps test        # bun test __tests__ (SDK boundary faked)
bun run --cwd plugins/plugin-cloud-apps typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-cloud-apps lint        # biome check --write
bun run --cwd plugins/plugin-cloud-apps build       # bun build.ts
```

## Conventions / gotchas

- **Every money/destructive action uses the `safety.ts` two-phase confirm.** The
  first ask NEVER mutates — it runs read-only pre-checks and returns a
  confirmation prompt naming the exact target (+ amount/domain/price), storing a
  room-scoped pending task. The mutation fires only when a later turn carries the
  planner's structured `confirm: true` for that pending task, using the params
  FROZEN at the first ask — never re-parsed from the follow-up text, never from
  English keyword matching (so non-English confirmations work).
- **Secrets/money never transit the connector.** CTAs (`buildConnectorCta`) carry
  a label + an https URL only. Created/rotated API keys are surfaced once and
  never logged.
- **Cache invalidation is an invariant.** Any action that mutates app inventory
  or deploy/monetization state calls `invalidateAppsCache(runtime)`; server-side
  writes that change `apps` rows must evict `appsService` caches too (the app row
  is cached ~5 min via `getById`; a missed eviction was a real payment-gate
  staleness bug — #11213).
- **`validate` is only the API-key check.** All real validation lives in the
  handler; every exit calls `callback` AND returns an `ActionResult` with
  `userFacingText` (and `verifiedUserFacing: true` on truthful outcomes).
- **Deploy "done" ≠ 202-accepted.** It is READY status + a live reachability
  probe of the authoritative `production_url` (`deploy-gate.ts`).
- **Tests fake ONLY the SDK.** `__tests__/helpers.ts` provides `FakeElizaCloudClient`
  + keyed/unkeyed/memory runtimes; the actions/formatters/confirm-machine run for
  real. Adding an SDK method means adding its `*Fn`/state/setter/fake method.
- **Live e2e:** the app lifecycle + charges + attribution run against real staging
  in `packages/cloud/api/test/e2e/group-i/l/n`; see that dir's live-staging runbook.

## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)** — read
it. Nothing here is *done* until a reviewer can confirm it works **without reading
the code**, from the artifacts you attach: real-LLM trajectories for
action/prompt changes (`packages/scenario-runner/bin/eliza-scenarios run …`
against a **live** model, read by hand), the real request→response traces + the
domain artifacts the change produced (app rows, deploy status, credit/earnings
ledger rows, domain records), and — for anything user-exercisable — before/after
UI proof. "Tests pass" and "CI green" are not proof. No TODOs, stubs, or
"follow-ups"; clear blockers by the hard path. Artifacts →
`.github/issue-evidence/<issue#>-<slug>.<ext>`, or mark a row `N/A - <reason>`.
