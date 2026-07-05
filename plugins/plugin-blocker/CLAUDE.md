# @elizaos/plugin-blocker

Focus / distraction control for Eliza agents — website blocking via a
SelfControl-style hosts engine and macOS / mobile app blocking.

## Purpose / role

Provides the focus surface for an Eliza agent: two read-only providers that
surface the user's current block state, two Service classes that own the
platform engine lifecycle, a drizzle `pgSchema('app_blocker')`, and a `focus`
overlay view rendered by the dashboard shell. The `BLOCK` umbrella action is
host-adapted by `@elizaos/plugin-personal-assistant`.

This package was split out of `@elizaos/plugin-personal-assistant`. The
providers, services, schema, and view are owned here. The `BLOCK` action remains
PA-resident to keep one owner-gated scheduler/chat dispatch path.

## Plugin surface

### Actions
- None registered here. `BLOCK` is registered by
  `@elizaos/plugin-personal-assistant`.

### Providers
- `WEBSITE_BLOCKER` (`src/providers/website-blocker.ts`) — active website block
  sessions and override state. Position `-3`, contexts `focus` / `automation`.
- `APP_BLOCKER` (`src/providers/app-blocker.ts`) — active app block sessions.

### Services
- `WebsiteBlockerService` (`src/services/website-blocker.ts`,
  `serviceType = "website-blocker"`).
- `AppBlockerService` (`src/services/app-blocker.ts`,
  `serviceType = "app-blocker"`).

### Schema
- `pgSchema('app_blocker')` (`src/db/schema.ts`) — tables `block_rules`,
  `active_sessions`, `allow_list`.

### View
- `focus` — `FocusView` component, path `/focus`, bundle
  `dist/views/bundle.js`, icon `ShieldOff`.

## Layout

```
src/
  plugin.ts                       blockerPlugin definition
  index.ts                        Public export barrel
  types.ts                        Constants + Block* types
  providers/
    website-blocker.ts            WEBSITE_BLOCKER provider (stub)
    app-blocker.ts                APP_BLOCKER provider (stub)
  services/
    website-blocker.ts            WebsiteBlockerService (stub)
    app-blocker.ts                AppBlockerService (stub)
  db/
    index.ts                      Re-exports schema
    schema.ts                     pgSchema('app_blocker') + tables
  components/
    focus/
      FocusView.tsx               Schedule + active-session overlay view
      focus-view-bundle.ts        Vite view bundle entry
```

## Commands

```bash
bun run --cwd plugins/plugin-blocker typecheck    # tsc --noEmit -p tsconfig.json
bun run --cwd plugins/plugin-blocker lint         # biome check src/
bun run --cwd plugins/plugin-blocker test         # vitest run
bun run --cwd plugins/plugin-blocker build        # build:js + build:views + build:types
bun run --cwd plugins/plugin-blocker build:js     # tsup
bun run --cwd plugins/plugin-blocker build:views  # vite — focus view bundle
bun run --cwd plugins/plugin-blocker build:types  # tsc declarations
bun run --cwd plugins/plugin-blocker clean        # rm -rf dist
```

## Config / env vars

This plugin reads no environment variables and has no settings keys yet. Once
the real services are migrated, the SelfControl admin permission flow and the
macOS app-blocker bundle-id allow-list will pick up the same env contract as
the lifeops implementations they replace.

## How to extend

- **Add a Service method:** add to `WebsiteBlockerService` / `AppBlockerService`
  in `src/services/`. Use `this.runtime.db` (typed via drizzle) once schema
  tables are wired through.
- **Add a provider:** create `src/providers/<name>.ts` and add to the
  `providers` array in `src/plugin.ts`.
- **Add a view:** add a component under `src/components/`, re-export from the
  view bundle entry, add a view declaration in `src/plugin.ts` `views`.

## Conventions / gotchas

- Do not add a second `BLOCK` action here unless the PA-hosted owner gating,
  scheduler hooks, and chat dispatch behavior move with parity tests.
- `@elizaos/plugin-sql` is required at runtime — schema registration in the
  Plugin object tells the SQL plugin to migrate `app_blocker`.
- The view bundle is built independently of the JS / type build (`build:views`
  vs `build:js` + `build:types`) — both must run for a complete release.
- All services log with the `[Blocker]` prefix.
- See the root `AGENTS.md` for repo-wide architecture rules, logger
  conventions, and ESM standards.

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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
