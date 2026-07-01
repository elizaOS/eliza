# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and follow-up watcher for Eliza agents.

## Purpose / role

Adds the inbox-zero workflow to an agent: a single `INBOX` umbrella action (op-based dispatch), `INBOX_TRIAGE` + `CROSS_CHANNEL_CONTEXT` providers that surface unresolved threads to the planner each turn, and a registered `/inbox` view for human review. Aggregates threads across email, Discord, Telegram, WhatsApp, Slack, X, Farcaster, iMessage, and similar non-SMS channels. Android SMS stays in `@elizaos/plugin-messages`.

This package is being extracted from `plugin-lifeops`. The current scaffold is a stub — actions return `not_implemented` and providers return empty results, but every handler has a TODO comment pointing at the file in `plugin-lifeops` it will absorb. See `README.md` for the migration mapping.

## Plugin surface

### Action

- `INBOX` (`src/actions/inbox.ts`) — single umbrella action with op-based dispatch. Accepted ops: `list`, `triage`, `reply`, `snooze`, `archive`, `approve`. Contexts: `inbox`, `messaging`, `communication`. Each op currently returns a `not_implemented` failure with the source path to port from.

### Providers

- `INBOX_TRIAGE` (`src/providers/inbox-triage.ts`) — position `-4`. Will emit the user's pending cross-channel triage queue.
- `CROSS_CHANNEL_CONTEXT` (`src/providers/cross-channel-context.ts`) — position `-3`. Will emit recent activity for the current counterparty across other channels.

### Schema

- `inboxSchema` (`src/db/schema.ts`) — `pgSchema("app_inbox")` with the three
  inbox-triage tables carved out of PA's `app_lifeops` (column shape verbatim):
  - `life_inbox_triage_entries` — per-thread triage decisions + draft replies.
  - `life_inbox_triage_examples` — owner-labeled few-shot classification examples.
  - `life_email_unsubscribes` — email unsubscribe attempts + outcomes.
  Registered via the plugin `schema` field; `InboxMigrationService`
  (`src/inbox/migration.ts`) does the non-destructive `app_lifeops -> app_inbox`
  copy (skip if source missing / target non-empty, never drop the source). PA
  auto-registers this plugin (`ensureLifeOpsInboxPluginRegistered`) so the schema
  exists + the migration runs whenever PA is loaded. The gmail sync/projection
  tables (`life_gmail_*`, `life_inbox_messages`) are NOT part of this domain —
  they stay PA-owned in `app_lifeops`.

### View

- `inbox` — `InboxView` component, path `/inbox`, bundle at `dist/views/bundle.js`. Minimal placeholder (header, channel filter chips, empty thread list) until the full UI ports over.

## Layout

```
src/
  index.ts                            Public API barrel
  plugin.ts                           inboxPlugin definition (action + providers + schema + view)
  types.ts                            TriageDecision, ThreadSummary, channel + decision enums
  actions/
    inbox.ts                          INBOX umbrella action — op dispatch (STUB)
  providers/
    inbox-triage.ts                   INBOX_TRIAGE provider (STUB)
    cross-channel-context.ts          CROSS_CHANNEL_CONTEXT provider (STUB)
  db/
    index.ts                          re-exports schema.ts
    schema.ts                         drizzle pgSchema('app_inbox') + 3 tables
  components/
    inbox/
      InboxView.tsx                   Minimal React inbox view (placeholder)
      inbox-view-bundle.ts            Vite bundle entry — re-exports InboxView
```

## Commands

```bash
bun run --cwd plugins/plugin-inbox typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-inbox lint         # biome check src/
bun run --cwd plugins/plugin-inbox test         # vitest run
bun run --cwd plugins/plugin-inbox build        # build:js + build:views + build:types
bun run --cwd plugins/plugin-inbox build:js     # tsup
bun run --cwd plugins/plugin-inbox build:views  # vite build (overlay bundle)
bun run --cwd plugins/plugin-inbox build:types  # tsc declaration emit
bun run --cwd plugins/plugin-inbox clean        # rm -rf dist
```

## Config / env vars

None at the scaffold stage. Channel credentials are read from each provider plugin (`plugin-discord`, `plugin-telegram`, etc.).

## How to extend

**Port an op from plugin-lifeops:** open the corresponding `case` block in `src/actions/inbox.ts`, follow the TODO comment to the source file in `plugins/plugin-personal-assistant/`, and replace the `not_implemented` failure with the ported logic. Keep the op enum in `src/types.ts` in sync.

**Add a new op:** add the name to `INBOX_ACTIONS` in `src/types.ts`, add a `case` to the `switch` in `src/actions/inbox.ts`, and (if the op needs new parameters) extend the `parameters` array on `inboxAction`.

**Add a provider:** create `src/providers/<name>.ts` exporting a `Provider`, then add it to the `providers` array in `src/plugin.ts`.

**Add a service:** define the class in `src/service.ts`, add it to the `services` array in `src/plugin.ts`, and export it from `src/index.ts` so callers can resolve it via `runtime.getService`.

## Conventions / gotchas

- **Scaffold, not feature-complete.** Every action op currently returns a `not_implemented` failure with the source path it should pull from. Treat this package as the registration shell; the live triage logic still runs out of `plugin-lifeops` until the follow-up migration pass.
- **`@elizaos/plugin-sql` must be loaded first.** The schema registration relies on the runtime's `runtime.db`. The plugin declares this in `dependencies: ["@elizaos/plugin-sql"]`.
- **No Android SMS.** SMS routing intentionally stays in `plugin-messages`. Do not add SMS channel handling here.
- **Schema name is `app_inbox`** (not `inbox`) to avoid collisions with any host-app `inbox` table the runtime might also surface.
- **Two build steps.** The JS/types build (tsup + tsc) and the Vite views build are separate. The views bundle (`dist/views/bundle.js`) is what the view registration's `bundlePath` points to. Both must be run for a complete build.
- **Peer deps.** React 19 and react-dom 19 are peer dependencies. The host app must provide them.
- See the root `AGENTS.md` for repo-wide architecture rules, logger requirements, ESM/module standards, and the cloud-frontend visual-review gate (if any of this plugin's UI ends up in `cloud-frontend`).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
