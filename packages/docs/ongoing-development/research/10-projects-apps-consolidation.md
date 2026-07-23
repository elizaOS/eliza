# Projects ⇄ Apps consolidation — research report + implementation plan

**Status:** research + plan (no implementation yet). **Date:** 2026-07-23.
**Directive:** consolidate "My Apps" into Projects. Every project is publishable;
publishing is available only when connected to Eliza Cloud; a published project
shows a tag and exposes all of its app info (URL, affiliate, payments,
analytics) on a per-project publish page. Projects don't have to be published.
The word "app" disappears from the product vocabulary for things you make:
**an app is a published project.**

---

## 1. Executive summary

The codebase already contains the seam this consolidation needs. A first-class
`ProjectRecord` exists in core (`packages/core/src/utils/project-registry.ts:36`)
and **already carries `cloudAppId`** — "the Eliza Cloud app this project owns"
(`project-registry.ts:57-60`, #14119). The orchestrator already writes that
binding when a coding task registers a Cloud app
(`plugins/plugin-agent-orchestrator/src/services/project-binding.ts:192`).
The Cloud product docs already state the split we want to formalize: *"Use a
**project** for deployable product workspace state… Use the **Cloud app** `id`
when calling app-scoped APIs"* (`packages/docs/cloud/apps.mdx`).

What is missing is everything around that seam:

- Three separate user surfaces (**My Apps**, **Projects/tasks**, the native
  **Cloud Apps studio**) present fragments of one lifecycle as three products.
- Three unrelated "app" data models (installed registry app plugins,
  agent-`BuiltAppRecord`s, Cloud `apps` rows) with no reconciliation.
- No way for a user or the agent to say "publish this project" as one gesture;
  the binding only happens as a side effect of coding-task spawns.
- No agent-facing project CRUD at all (no action, provider, or HTTP create).

The plan: make **Project the one durable user-facing object**. "Published" is a
*state* of a project (its `cloudAppId` is set and the Cloud record is active),
not a different object. The launcher gets **one Projects tile**; the Projects
surface owns creation, coding activity, run/stop, and a Cloud-gated **Publish**
panel per project that reuses the existing applications-domain components
(monetization, earnings, domains, analytics, users, hosting). The agent gets
first-class `PUBLISH_PROJECT` / `GET_PUBLISHED_PROJECT` / `UNPUBLISH_PROJECT`
verbs plus project-registry actions. Cloud API and DB names (**`apps`** routes
and tables) stay exactly as they are — this is a product-model and vocabulary
consolidation, not a wire-protocol rename.

---

## 2. Current state — what exists today

### 2.1 Six concepts, three of them named "app"

| Concept | Type / owner | Persistence | Identity |
| --- | --- | --- | --- |
| **Project** | `ProjectRecord`, core (`project-registry.ts:36`) | `<stateDir>/projects.json` (atomic JSON, pre-boot readable) | `localPath` (realpath) |
| **Coding task** | `OrchestratorTaskRecord`, orchestrator (`orchestrator-task-types.ts:52`) | DB table or JSON fallback | `id`; optional `projectId` |
| **Workspace** | `WorkspaceResult` + disk ledger (`workspace-registry.ts:26`) | `~/.eliza/workspaces/…`, in-memory ledger | absolute path |
| **Installed app** | registry app plugin ∩ installed plugins (`app-manager.ts:2210-2246`) | `<stateDir>/plugins/installed`; runs in `<stateDir>/apps/runs.v2.json` | package name/slug |
| **Agent-built app** | `BuiltAppRecord` (`built-apps-registry.ts:37`) | runtime cache `orchestrator:built-apps` (cap 200) | target+slug; has `sessionId`, **no `projectId`** |
| **Cloud app** | `apps` row, Eliza Cloud (`packages/cloud/shared/src/db/schemas/apps.ts:81-262`) | Cloud Postgres | `id` (uuid) — bound via `ProjectRecord.cloudAppId` |

Plus a **naming collision**: `elizaos create` scaffolds a *template* "project"
(codegen tree, unrelated to `ProjectRecord`), and the workbench VFS has a
`projectId` that is deliberately unrelated (`project-registry.ts:19-21`).

### 2.2 Three surfaces

**My Apps** (`my-apps` tab, `/apps/my-apps`) —
`packages/ui/src/components/pages/MyAppsView.tsx:46` wrapping
`AppsManagementSection` (`packages/ui/src/components/settings/AppsManagementSection.tsx:102`):
installed inventory with launch/stop/relaunch, **Create new app** (natural-language
intent → template scaffold → coding sub-agent → verification;
`apps-routes.ts:1696` → the `APP` action's create mode,
`plugins/plugin-app-control/src/actions/views-create.ts:149-349`), and **Load
from directory** (manifest registration only, `apps-routes.ts:1560-1677`). On
this branch it gained a Cloud-gated "Cloud Apps" row that deep-links to the
native studio.

**Projects** (`tasks` tab, `/apps/tasks`) —
`packages/ui/src/components/pages/TasksPageView.tsx:19` hosting
`CodingAgentTasksPanel` (plugin-task-coordinator): coding-task threads filtered
by the **active project** (`CodingAgentTasksPanel.tsx:670-675`), with a
`ProjectSwitcher` that reads `/api/projects` and self-hides at ≤1 project
(`ProjectSwitcher.tsx:181`, #14112). This branch retitles it from "Tasks" to
"Projects" (`navigation/index.ts:616-619`); tab id and route stay stable.

**Cloud Apps studio** (`cloud-apps` page, `/cloud-apps`, native-only) —
`packages/app/src/cloud-apps-view.ts:31-43` lazily mounting
`NativeAppsStudio` → the applications domain in
`packages/ui/src/cloud/applications/`: app list + a 9-tab detail
(overview, monetize, earnings, hosting, domains, analytics, promote, users,
settings — `components/app-details-tabs.tsx:38-101`). The **web** console has
already retired this surface (`AppsMovedRoute` redirect,
`packages/ui/src/cloud/register-all.ts:74-83`). Its empty state says apps are
created *by the agent in chat*, not from the console
(`ApplicationsPage.tsx:81-88`).

### 2.3 The bridge that already exists

- `ProjectRecord.cloudAppId` (`project-registry.ts:57-60`) is written by
  `bindProjectCloudApp` (`project-binding.ts:192-204`) when the sub-agent broker
  successfully runs `apps.create` for a project-bound coding session
  (`parent-agent-broker.ts:1324`), and read back so later tasks **update** the
  existing Cloud app instead of duplicating it (`app-deploy-guidance.ts:239`).
- The agent already has the full Cloud app lifecycle as actions in
  `@elizaos/plugin-cloud-apps` (`plugins/plugin-cloud-apps/src/index.ts:134-171`):
  create/deploy/frontend-publish/rollback/update/monetize/earnings/withdraw/
  domains/delete, with a two-phase confirm machine (`src/safety.ts`) and a
  deploy-liveness gate (`src/deploy-gate.ts`). None of these verbs take a
  `projectId`.
- Cloud backend + SDK are complete for the publish page's needs: registration
  (`POST /api/v1/apps`), monetization (`PUT …/monetization`, review-gated,
  `apps/[id]/monetization/route.ts:135-148`), earnings + withdraw, analytics,
  users, domains (subdomain under `*.apps.elizacloud.ai` + custom + buy),
  managed static frontend hosting with versioned rollback
  (`app-frontend-deployments.ts:79-132`), and container deploy (production-gated
  behind `APPS_DEPLOY_ENABLED` + org allowlist, `apps/[id]/deploy/route.ts:35-82`).

### 2.4 What's already in flight on this branch

Uncommitted, presentational-only groundwork: "Tasks"→"Projects" retitle
(view, widget, `titleForTab`), Cloud Apps studio de-tiled from the launcher
(`LAUNCHER_HIDDEN_IDS`), My Apps as the single launcher apps destination with a
gated Cloud Apps row. No data-model or routing changes. This is P0 of the plan
below, already done.

---

## 3. Why consolidate

1. **One lifecycle, three products.** Creating (My Apps) → building (Projects)
   → publishing (Cloud studio) is one user journey artificially split across
   three tiles, three backends (`/api/apps/*`, `/api/orchestrator/*` +
   `/api/projects`, `/api/v1/apps/*`), and three vocabularies. "Create new app"
   *already* spawns a coding task in a workspace — the exact substrate the
   Projects surface manages (`views-create.ts:296-349`) — but the user watches
   it from a different tab than the one that shows its progress.
2. **"App" means three unrelated things** (installed package, built artifact,
   Cloud record), and the automation glossary — the declared source of truth
   for naming (`docs/automation-glossary.md`) — has no entry for any of them.
   Users can't form a stable mental model; neither can the planner.
3. **The binding is accidental.** Project⇄Cloud-app linkage happens only as a
   broker side effect during coding-task spawns. A user who built something
   locally has no "publish" gesture; an agent asked to "publish my project" has
   no verb for it.
4. **The publish surface is stranded on native.** The studio is native-only
   (web redirected away), reached through a settings-style row, and its list
   page duplicates what a project list should already know.
5. **Fragmentation is already causing drift**: two `InstalledAppInfo` shapes
   (`shared/contracts/apps.ts:389` vs `ui/api/client-types-cloud.ts:491`,
   the latter with never-populated fields), `BuiltAppRecord` without
   `projectId`, and scaffolded app directories that never become projects.

---

## 4. Target model

### 4.1 The object model

**Project** is the one durable, user-facing object:

```
ProjectRecord (unchanged storage: <stateDir>/projects.json)
  id, name, localPath (identity), repoUrl?, defaultBranch?,
  worldId? (per-agent memory partition), bookmark?,
  cloudAppId?          ← the ONLY publish linkage (already exists)
  createdAt, lastOpenedAt
```

- **Published** = `cloudAppId` is set and the Cloud `apps` row is active.
  Publish state, URL, monetization, analytics are **fetched live** from Cloud
  (three-state UI: loading / designed-empty / error — never a fabricated
  healthy-empty), not cached into `projects.json`. The file stays the single
  source of truth for the *binding*, Cloud stays the single source of truth for
  the *published artifact* (preserves the "no second store" invariant,
  `project-binding.ts:192-204`).
- **A project does not need to be published.** Local-only projects are fully
  functional (build, run, iterate). Publishing is an optional, Cloud-gated
  transition.
- The Cloud-side record keeps its name (`apps` table, `/api/v1/apps/*` routes,
  `AppDto`, `plugin-cloud-apps` action names). **No wire/DB renames.** The
  consolidation is the product model and the copy, not the protocol.

### 4.2 What "app" still means (and where the word survives)

- **User-facing copy in the created-things domain: "project" everywhere.**
  "My Apps" → gone; "Create new app" → "New project"; the published thing is
  "your published project" with its public URL. The one place "app" remains
  acceptable in copy is describing the *published artifact from the consumer's
  side* (e.g. the Cloud consumer marketplace), and "the app" meaning the
  Eliza/Milady host application itself — that sense is out of scope and must
  not be swept (release center, connection overlays, third-party Meta/Discord
  "app" strings).
- **Installed third-party packages** (registry app plugins you installed but
  did not author — no local directory, no workspace) are *not* projects. They
  are "Installed" items: launchable, stoppable, uninstallable. They keep living
  in the launcher grid and get a compact "Installed" section on the Projects
  surface (recommendation; see Open question 1).

### 4.3 The Projects surface (one tile)

`tasks` tab (label "Projects", route `/apps/tasks` — ids stay stable for
telemetry) becomes the single destination:

```
Projects
├── [New project] [Add from folder]
├── Project cards: name · repo/path · Published tag (when cloudAppId live)
│   · last activity · running indicator (when its app run is live)
│   └── opens Project detail (in-surface, ?projectId= like /orchestrator?taskId=)
│       ├── Overview   — path, repo, recent coding-task threads (existing panel,
│       │                already projectId-filtered)
│       ├── Activity   — coding tasks / sessions (existing CodingAgentTasksPanel)
│       ├── Run        — launch/stop/relaunch + run health (existing /api/apps
│       │                lifecycle, joined by the project's package slug)
│       └── Publish    — Cloud-gated panel (see 4.4)
└── Installed — compact list of third-party installed packages (launch/stop)
```

- The `my-apps` tile is removed from `LAUNCHER_APPS_ORDER`; `/apps/my-apps`
  becomes a redirect alias to `/apps/tasks` for deep-link stability.
- Where the orchestrator backend is absent (web/iOS/store builds), the surface
  degrades exactly as today: coding-task areas render their designed empty
  state (404→empty, `CodingAgentTasksPanel.tsx:690-697`); project list, Run,
  and Publish still work.

### 4.4 The per-project Publish page

Gated on `state.elizaCloudConnected` (`state/types.ts:478`) — signed-out users
see a designed "Connect Eliza Cloud to publish" state, not a broken form.

**Not yet published:** one primary CTA — *Publish* — a short wizard: name +
description (prefilled from the project), then frontend upload (managed static
hosting, the live ungated path) or container deploy when the org is allowlisted
(`APPS_DEPLOY_ENABLED`). On success: create the Cloud record if absent
(`createApp`), deploy, bind `cloudAppId` (`bindProjectCloudApp` — the same
single write path the broker uses), patch `app_url`/`allowed_origins`.

**Published:** the project card shows a **Published** tag; the panel shows
everything the studio detail shows today, reusing the existing components from
`packages/ui/src/cloud/applications/` rather than rebuilding:

| Section | Reused component | Backend |
| --- | --- | --- |
| Status + URL(s) | `app-overview.tsx` info rows | `apps` row, `production_url`, `deriveAppPublicUrl` (`app-url.ts:28-36`) |
| Hosting versions + rollback | `app-frontend-hosting.tsx` | `/api/v1/apps/:id/frontend*` |
| Domains (subdomain, custom, buy) | `app-domains.tsx`, `BuyDomainCard` | `/api/v1/apps/:id/domains*` |
| Monetization (markup, purchase share, review gate) | `app-monetization-settings.tsx` | `GET/PUT …/monetization`, `POST …/review` |
| Earnings + withdraw | `app-earnings-dashboard.tsx`, `withdraw-dialog.tsx` | `GET …/earnings`, `POST …/earnings/withdraw` |
| Analytics (requests, visitors, logs) | `app-analytics.tsx` | `GET …/analytics*` |
| Users | `app-users.tsx` | `GET …/users` |
| API key (one-time + regenerate) | overview key card, `one-time-app-api-key.ts` | `POST …/regenerate-api-key` |
| Affiliate | account-level affiliate code + link | SDK affiliate methods (`client.ts:683-704`) |
| Danger zone: Unpublish / Delete | (new) + `app-settings.tsx` | `PATCH` `is_active:false` / `DELETE` |

Notes grounded in what's actually live:
- Lead with **managed frontend hosting** — it is the ungated, production-real
  publish path. Container deploy renders as "available when enabled for your
  organization" when the gate says no (`apps/[id]/deploy/route.ts:35-44`).
- **Affiliate codes and redeemable earnings are user-level**, spanning all
  projects (`affiliates.ts:24-56`, `redeemable-earnings.ts:68-172`). The
  publish page shows them as account context ("your affiliate code · your
  redeemable balance"), not as per-project settings. Known gap to surface
  honestly: `X-Affiliate-Code` is not read by the app-scoped chat route yet
  (documented in `cloud/apps.mdx`).
- **Unpublish** is a new, non-destructive verb: deactivate the Cloud record
  (`is_active:false`) and keep the binding so republish is one click. Delete
  stays the destructive path with the existing confirm flow.

### 4.5 Agent capabilities

New verbs live where the machinery already is:

- **`plugin-cloud-apps`** gains project-keyed actions:
  `PUBLISH_PROJECT` (resolve `ProjectRecord` → reuse `CREATE_APP` +
  `DEPLOY_FRONTEND`/`DEPLOY_APP` → `bindProjectCloudApp` → verify liveness via
  the existing deploy gate), `GET_PUBLISHED_PROJECT` (status, URL, top-line
  analytics/earnings), `UNPUBLISH_PROJECT`, plus the missing read parity verbs
  `GET_APP_ANALYTICS` and `LIST_APP_USERS` (endpoints and broker commands
  already exist — `parent-agent-broker.ts:189,206` — only parent actions are
  missing). Money/destructive paths keep the two-phase confirm (`safety.ts`).
- **Project registry actions + provider** (owner: `plugin-agent-orchestrator`,
  which already imports the registry): `LIST_PROJECTS`, `GET_PROJECT`,
  `SET_ACTIVE_PROJECT`, and a provider injecting the active project +
  `cloudAppId` into planner context — so "publish my project" resolves without
  the user naming an id.
- **Creation mints projects.** The `APP` create flow registers the scaffolded
  workdir as a `ProjectRecord` (`upsertProject`) at scaffold time, and
  `load_from_directory` registers one when the directory is a real workspace
  the user owns. `BuiltAppRecord` gains `projectId` so completion artifacts
  attach to the project.
- **Skills + glossary**: `eliza-cloud`, `build-monetized-app`,
  `eliza-app-development` updated to speak "publish project"; add
  **project / published project / publish** entries to
  `docs/automation-glossary.md` (the declared naming source of truth), keeping
  "coding task" and "workflow" frozen at their existing meanings.

### 4.6 Ideal UX paths

**Create.** Chat-first: "build me a habit tracker" → agent creates a coding
task; the task's workspace is registered as a project; the Projects surface
shows it building (this is literally today's create-app flow, re-homed).
Explicit: Projects → *New project* (intent form, same backend) or *Add from
folder*. Either way the user lands on one card that tracks everything.

**Build.** Coding tasks bound to the project (existing LOCKED workdir binding,
`project-binding.ts:128-167`). The Activity tab is today's task panel.

**Run.** Launch/stop from the project card or Run tab (existing
`/api/apps/launch|stop` lifecycle where the project has a launchable package).

**Publish.** Cloud-gated one-gesture publish, by button or by asking the agent
("publish this"). Card gains the Published tag; the publish panel is the
management home: URL, domains, monetization, earnings, analytics, users,
hosting versions.

**Manage.** Update metadata, roll back a hosting version, watch analytics,
withdraw earnings, unpublish — from the panel or via the agent verbs, both
driving the same endpoints.

---

## 5. Implementation plan

Phases are independently shippable PRs against `develop`, each with the full
evidence bar (screenshots desktop+mobile, video, logs, real-LLM trajectories
where agent behavior changes). File lists name the load-bearing touchpoints,
not every ripple.

### P0 — label groundwork (already in the working tree)

"Tasks"→"Projects" retitles; `cloud-apps` de-tiled; My Apps as the single apps
destination with the gated Cloud Apps row. Files: `TasksPageView.tsx`,
`orchestrator-task-widget.tsx`, `navigation/index.ts`, `MyAppsView.tsx`,
`launcher-curation.ts`, `cloud-apps-view.ts` + their tests and
`launcher-cloud-gating.spec.ts`. **Action: commit and PR this as-is.**

### P1 — make the project registry real (backend seams, no UI change)

1. Mint `ProjectRecord`s where projects are actually born:
   - `plugin-app-control` create flow: after scaffold, `upsertProject({name,
     localPath: workdir})` (`views-create.ts` around the workdir resolution,
     `:234-301`).
   - `load-from-directory` (`apps-routes.ts:1560-1677`): register a project for
     owner-loaded workspace directories alongside the manifest registration.
2. Add a deliberate registration write path: `POST /api/projects/register`
   (`packages/agent/src/api/project-routes.ts` — today list+switch only by
   design, `:12-16`; the restriction gets a documented exception, not silent
   removal). No HTTP delete; archival comes later if needed.
3. `ProjectSummary` DTO gains `cloudAppId` (`client-types-cloud.ts:916-923`,
   `project-routes.ts:103`).
4. `BuiltAppRecord` gains `projectId` (`built-apps-registry.ts:37-52`, write
   site `registerBuiltAppsForCompletion`).
5. Reconcile the `InstalledAppInfo` drift: collapse the UI-local shape
   (`client-types-cloud.ts:491`) onto the wire shape
   (`shared/contracts/apps.ts:389`), deleting the never-populated fields.

Invariants preserved: `projects.json` stays file-based/atomic/pre-boot
(`project-registry.ts:10-13,256-272`); `localPath` realpath identity
(`:284-317`); `cloudAppId` single write path.

### P2 — one Projects surface

1. Rebuild the `tasks` view as the project-centric surface of §4.3:
   project cards (from `/api/projects` + run join), in-surface detail via
   `?projectId=`, New project / Add from folder entry points (reusing the
   existing `/api/apps/create` and `/api/apps/load-from-directory` backends),
   Installed section (today's `AppsManagementSection` inventory, trimmed).
   Owner: `plugin-task-coordinator` panel + `packages/ui` view shell.
2. Remove the `my-apps` tile (`launcher-curation.ts:37-61`); alias
   `/apps/my-apps` → `/apps/tasks`; retire `MyAppsView` after the alias lands
   (its Cloud Apps row moves into the Publish panel entry point).
3. Update the pinned tests: `launcher-curation.test.ts` (tile set + label
   lints, `:225-244,418-473,661-744`), `MyAppsView.test.tsx` (retire/replace),
   `apps-session-route-cases.ts:47-70` (route now redirects),
   `launcher-cloud-gating.spec.ts` (one Projects tile, no my-apps tile),
   `TasksPageView.test.tsx`.
4. Graceful degradation matrix: web/iOS (no orchestrator backend) shows
   projects + Run + Publish, empty-state coding areas; AOSP/native full.

### P3 — the Publish panel

1. `ProjectPublishPanel` in `packages/ui`, mounted as the Publish tab of
   project detail; Cloud-gated (`elizaCloudConnected`); wizard for first
   publish (frontend upload first; container deploy shown gated); reuse the
   applications-domain components per the §4.4 table (they already live in
   `packages/ui/src/cloud/applications/` and are portable — the native studio
   proves they run outside the web console).
2. Published tag on project cards (live fetch of the bound app's status;
   three-state rendering, no fabricated healthy-empty).
3. Keep `/cloud-apps` working as a deep-link redirect into the Projects
   surface (deep link `eliza://apps/deploy` per `MyAppsView.test.tsx:113-114`);
   retire `NativeAppsStudio` once the panel reaches parity.
4. Unpublish verb: `PATCH /api/v1/apps/:id {is_active:false}` via existing
   `updateApp`; republish reactivates.

### P4 — agent verbs + skills

1. `plugin-cloud-apps`: `PUBLISH_PROJECT`, `GET_PUBLISHED_PROJECT`,
   `UNPUBLISH_PROJECT`, `GET_APP_ANALYTICS`, `LIST_APP_USERS` (+ promote the
   broker-only domain verbs to parent actions where read-safe). All resolve
   projects via the registry; publish reuses `deploy-gate.ts` liveness checks;
   confirms via `safety.ts`.
2. Project actions + provider in `plugin-agent-orchestrator`
   (`LIST_PROJECTS` / `GET_PROJECT` / `SET_ACTIVE_PROJECT` + context provider).
3. Skills: update `eliza-cloud` (intent table gains publish-project),
   `build-monetized-app` (flow starts from a project), `eliza-app-development`;
   add glossary entries (project / publish / published project).
4. Evidence: real-LLM trajectories for "publish my project", "how is my
   project doing" (analytics), "unpublish it".

### P5 — terminology sweep + docs

1. Scoped i18n sweep (en.json + locales): `settings.sections.apps.*`,
   `cloud.apps.*`, `cloud.nav.myApps`, `nav.apps` description, orchestrator
   "app runs" strings → project vocabulary. **Explicitly out of scope:** "the
   app" = host application (release center, overlays, relaunch), third-party
   platform "app" strings (Meta/Discord/Telegram/Slack), `appsview.*` catalog
   strings for installed third-party items (they stay "Installed"/catalog).
2. Docs: `cloud/apps.mdx`, `monetized-apps.mdx`, `app-domains.mdx` reframed as
   "publishing a project" (API nouns unchanged); dashboard nav copy
   (`cloud.nav.myApps`) aligned.
3. Cleanup: delete dead My Apps code paths after the alias window; consider
   renaming `ElizaOsAppsView.tsx` (the AOSP phone-surfaces file whose name
   collides with this domain) as an unrelated hygiene follow-up.

### Explicit non-goals

- No renames of Cloud API routes, DB tables, SDK methods, or
  `plugin-cloud-apps` action names.
- No second store for the project⇄app relation; no caching of publish state
  into `projects.json`.
- No changes to the launcher game runtime (`AppsPageView`/`appsSubTab`), the
  VFS `projectId`, or the workspace disk ledger's ownership rules (#13803).
- No changes to `orchestrator_tasks` vocabulary ("coding task" stays).

---

## 6. Invariants the implementation must preserve

1. `localPath` realpath is project identity; upsert canonicalizes + de-dupes
   (`project-registry.ts:284-317`).
2. Task→project workdir binding stays LOCKED (`project-binding.ts:128-167`,
   #13776/#14108).
3. `projects.json` stays a pre-boot-readable atomic JSON file — never a DB
   table (`project-registry.ts:10-13`).
4. Per-project memory partition (`worldId`, #14171) survives the merge.
5. `cloudAppId` write-back remains the single source of truth for the binding
   (`project-binding.ts:192-204`) — UI publish and agent publish share it.
6. Orchestrator absence degrades to designed empty states (404→empty), never
   errors, never fabricated data.
7. Tab ids (`tasks`, and `my-apps` until retired), `/apps/tasks` route, and
   telemetry stay stable under relabeling.
8. Review gate on monetization stays server-enforced
   (`monetization/route.ts:135-148`); the panel mirrors, never bypasses.
9. Money/destructive agent actions keep two-phase confirmation (`safety.ts`).
10. Launcher curation invariants evolve deliberately with their tests — the
    "one apps destination" guard becomes "one Projects destination".

## 7. Risks

- **Installed-vs-project ambiguity.** A user's own project can *also* be an
  installed launchable package. Mitigation: join by package slug where the
  project's `package.json` name matches an installed app; show Run affordances
  on the project card and keep the item out of the Installed section.
- **Web parity.** The publish panel must work on web (the studio never did).
  The applications components are already environment-agnostic
  (`NativeAppsStudio` mounts them in a `MemoryRouter`); the risk is auth
  context differences — verify `steward` session flows on both.
- **Stranded Cloud features.** Purchase-share / per-app credit pools are
  partially stranded (#8253); the panel must not present dead controls as
  live. Lead with markup + hosting + domains; show purchase share only where
  the backend actually credits it.
- **Test surface churn.** The launcher/Playwright/route-case tests pin today's
  topology tightly; each phase updates them in the same PR (never skipped).
- **Deep links.** `eliza://apps/deploy` and `/cloud-apps` must keep resolving
  through every phase.

## 8. Open questions (need a product ruling)

1. **Installed third-party packages**: compact "Installed" section on the
   Projects surface (recommended — one destination) vs. launcher-grid only?
2. **`my-apps` tab id**: keep as redirect alias indefinitely (recommended —
   telemetry continuity) or retire after one release?
3. **Cloud web console** (`elizacloud.ai` dashboard): adopt the same
   "published projects" vocabulary in this pass, or defer? (The console
   already redirected its apps studio away, so the blast radius is nav copy.)
4. **Unpublish semantics**: `is_active:false` keep-binding (recommended) vs.
   delete-and-unbind?
5. **Marketplace naming**: does the consumer-facing marketplace keep calling
   published projects "apps"? (Creator-side copy says "published project";
   consumer-side may still say "app".)

## 9. Source research

Four parallel code audits (local apps domain; projects/coding-tasks domain;
cloud publishing/monetization domain; agent-side capabilities) produced the
file:line inventory backing every claim above. Key anchors:
`project-registry.ts:36-63,284-354` · `project-binding.ts:128-204` ·
`orchestrator-task-types.ts:52-101,598-718` · `built-apps-registry.ts:37-52` ·
`apps-routes.ts:950-1768` · `app-manager.ts:1859-2246` ·
`views-create.ts:149-349` · `plugin-cloud-apps/src/index.ts:134-171` ·
`parent-agent-broker.ts:122-672,1324` · `cloud/shared/src/db/schemas/apps.ts:81-262`
· `applications/components/app-details-tabs.tsx:38-101` ·
`launcher-curation.ts:37-130` · `navigation/index.ts:368,616-619` ·
`cloud-apps-view.ts:31-43` · `register-all.ts:74-83` ·
`docs/cloud/{apps,monetized-apps,app-domains,containers}.mdx`.
