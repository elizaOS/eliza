# @elizaos/plugin-personal-assistant

Personal assistant plugin: chat-first owner operations, executive workflows, scheduled tasks, calendar, inbox, documents, reminders, money admin, approvals, and owner-facing views for an Eliza agent.

## Purpose / role

LifeOps is the personal and executive assistant interface. It owns the assistant workspace, cross-domain planning, owner approvals, scheduled-task operating loops, calendar/inbox/document/reminder/money workflows, and the chat/voice-first UI that lets Eliza act like a chief-of-staff for the owner.

LifeOps must not become the implementation home for adjacent domains:

- **Health / sleep / circadian / screen-time planning** belongs in `@elizaos/plugin-health`. LifeOps may expose thin owner-access wrappers and assistant intents that call plugin-health factories.
- **Connector, adapter, bridge, and transport clients** belong in their relevant plugins (`plugin-google`, `plugin-whatsapp`, `plugin-x`, `plugin-browser`, `plugin-phone`, `plugin-calendly`, etc.). LifeOps may keep registries, owner policies, and normalized personal-assistant projections.
- **Native Apple Calendar / Reminders bridge policy** belongs in native packages (`@elizaos/capacitor-calendar`, `@elizaos/macosreminders`). LifeOps may call those helpers and map results into assistant DTOs.
- **Personal assistant code, views, scenarios, default packs, owner policy, approvals, and executive workflows** belong here.

The plugin is opt-in; add `@elizaos/plugin-personal-assistant` to the agent's plugin list. It depends on `@elizaos/plugin-google` for current calendar/inbox projections (auto-registered at init if absent).

## Plugin surface

### Actions (registered via `promoteSubactionsToActions`)

| Action name | File | What it does |
|---|---|---|
| `BLOCK` | `src/actions/block.ts` | Website/app block and unblock (SelfControl + OS APIs) |
| `CALENDAR` | `src/actions/calendar.ts` | Calendar read/write, event creation, scheduling |
| `CONNECTOR` | `src/actions/connector.ts` | Personal-assistant connector status/control facade; connector clients live in their plugins |
| `CREDENTIALS` | `src/actions/credentials.ts` | Credential lookup and autofill |
| `OWNER_DOCUMENTS` | `src/actions/document.ts` | Document search, review, signature workflows |
| `INBOX` | `src/actions/inbox.ts` | Email/messaging inbox triage |
| `OWNER_REMINDERS` | `src/actions/owner-surfaces.ts` | Reminders (Apple Reminders, Google Tasks) |
| `OWNER_ALARMS` | `src/actions/owner-surfaces.ts` | Alarms |
| `OWNER_GOALS` | `src/actions/owner-surfaces.ts` | Goals CRUD |
| `OWNER_TODOS` | `src/actions/owner-surfaces.ts` | Todos |
| `OWNER_ROUTINES` | `src/actions/owner-surfaces.ts` | Daily routines |
| `OWNER_HEALTH` | `src/actions/owner-surfaces.ts` | Thin wrapper around `@elizaos/plugin-health` health actions |
| `OWNER_SCREENTIME` | `src/actions/owner-surfaces.ts` | Thin wrapper around `@elizaos/plugin-health` screen-time planning (macOS only; platform-gated) |
| `OWNER_FINANCES` | `src/actions/owner-surfaces.ts` | Finance dashboard, transactions |
| `PERSONAL_ASSISTANT` | `src/actions/owner-surfaces.ts` | Cross-domain assistant orchestration |
| `ENTITY` | `src/actions/entity.ts` | Entity (contact/person/org) CRUD |
| `BRIEF` | `src/actions/brief.ts` | Morning/evening brief generation |
| `PRIORITIZE` | `src/actions/prioritize.ts` | Priority-score day's tasks and commitments |
| `CONFLICT_DETECT` | `src/actions/conflict-detect.ts` | Detect scheduling conflicts |
| `RESOLVE_REQUEST` | `src/actions/resolve-request.ts` | Resolve owner approval requests |
| `VOICE_CALL` | `src/actions/voice-call.ts` | Initiate/manage voice calls via Twilio |
| `REMOTE_DESKTOP` | `src/actions/remote-desktop.ts` | Remote desktop session control |
| `WORK_THREAD` | `src/actions/work-thread.ts` | Long-running work thread lifecycle |
| `SCHEDULED_TASKS` | `src/actions/scheduled-task.ts` | Scheduled-task CRUD for owner |

### Providers

| Provider name | File | What it injects |
|---|---|---|
| `lifeops_browser` | `src/provider.ts` | Browser companion projection; browser bridge implementation lives in `@elizaos/plugin-browser` |
| `websiteBlocker` | `src/providers/website-blocker.ts` | Current website-blocker status |
| `appBlocker` | `src/providers/app-blocker.ts` | Current app-blocker status |
| `firstRun` | `src/providers/first-run.ts` | First-run completion state and affordances |
| `ftuGoal` | `src/providers/ftu-goal.ts` | Post-first-run goal-discovery affordance; silent once the owner's primary goal is known |
| `roomPolicy` | `src/providers/room-policy.ts` | Per-room handoff/policy state |
| `lifeops` | `src/providers/lifeops.ts` | Aggregated owner context for assistant planning |
| `delegationContracts` | `src/providers/delegation-contracts.ts` | Active delegation contracts for thread ownership, tripwires, and sender-class SLAs |
| `pendingPrompts` | `src/providers/pending-prompts.ts` | Pending questions waiting for owner input |
| `workThreads` | `src/providers/work-threads.ts` | Active work-thread state |
| `recentTaskStates` | `src/providers/recent-task-states.ts` | Recent scheduled-task execution results |
| `lifeops-health` | `src/providers/health.ts` | Thin provider wrapper created by `@elizaos/plugin-health` |
| `inboxTriage` | `src/providers/inbox-triage.ts` | Unresolved inbox items for triage |
| `crossChannelContext` | `src/providers/cross-channel-context.ts` | Cross-channel conversation context |
| `activity-profile` | `src/providers/activity-profile.ts` | Owner activity/presence profile |

### Services

| Service type | Class | File | Role |
|---|---|---|---|
| `lifeops_browser_plugin` | `BrowserBridgePluginService` | `src/service.ts` | Legacy LifeOps facade for browser companion state; implementation should continue moving to `@elizaos/plugin-browser` |
| `website_blocker` | `WebsiteBlockerService` | `src/website-blocker/service.ts` | Hosts-file blocking (SelfControl) lifecycle |
| `activity_tracker` | `ActivityTrackerService` | `src/activity-profile/activity-tracker-service.ts` | Legacy activity projection for assistant context; health/screen-time domain logic belongs in `@elizaos/plugin-health` |
| `presence_signal_bridge` | `PresenceSignalBridgeService` | `src/activity-profile/presence-signal-bridge-service.ts` | Device presence signal forwarding |

The `lifeops_scheduled_task_runner` service (`ScheduledTaskRunnerService`) is now **registered by the always-loaded `@elizaos/plugin-scheduling`**, not PA. PA is a consumer: `init()` injects its production deps (DB-backed store, production dispatcher, owner-facts / channel-keys / host-capability probes, anchor registry) via `registerLifeOpsScheduledTaskRunnerDeps(runtime)` (see `src/lifeops/scheduled-task/runtime-wiring.ts`). `src/lifeops/scheduled-task/service.ts` is a back-compat re-export of the moved service.

### Evaluators

| Evaluator name | File | Role |
|---|---|---|
| `owner.profile_extraction` (response handler) | `src/lifeops/owner/profile-extraction-evaluator.ts` | Extracts owner facts from agent responses |
| `threadOps` (response handler field) | `src/lifeops/work-threads/field-evaluator-thread-ops.ts` | Propagates work-thread field ops from responses |
| `ftu_goal_discovery` (post-turn, merged call) | `src/lifeops/ftu-goal/evaluator.ts` | Extracts the owner's primary goal after first-run; persists the `primaryGoal` owner fact and closes discovery once confident |
| `anticipation_feedback` (post-turn, merged call) | `src/lifeops/anticipation/evaluator.ts` | Classifies the owner's reaction to proactive dispatches (accepted / rejected / ignored) into durable rolling stats |

### Views

No views — the LifeOps overview surface was removed (owner: "no need for an overview"). The personal assistant is the chat itself (the `PERSONAL_ASSISTANT` action); the `GET /api/lifeops/overview` route + `getOverview()` service stay (reused by the todos projection + reminder delivery). The *domain* views live in the per-domain plugins (plugin-todos, plugin-inbox, plugin-goals, plugin-health, plugin-calendar, plugin-documents, plugin-blocker, plugin-finances, plugin-relationships). PA also exports the Blocker settings cards via `src/ui.ts`.

## Layout

```
src/
  plugin.ts                     Plugin definition (actions, providers, services, init, dispose, views)
  index.ts                      Public exports (re-exports from plugin.ts + all submodules)
  service.ts                    BrowserBridgePluginService
  provider.ts                   browserBridgeProvider
  public.ts                     Additional public re-exports

  actions/
    block.ts                    BLOCK (website/app blocking umbrella)
    calendar.ts                 CALENDAR
    connector.ts                CONNECTOR facade over plugin-owned connector surfaces
    credentials.ts              CREDENTIALS
    document.ts                 OWNER_DOCUMENTS
    inbox.ts                    INBOX
    owner-surfaces.ts           OWNER_REMINDERS / OWNER_ALARMS / OWNER_GOALS / OWNER_TODOS
                                / OWNER_ROUTINES / health wrappers / screen-time wrappers
                                / OWNER_FINANCES / PERSONAL_ASSISTANT
    entity.ts                   ENTITY
    brief.ts                    BRIEF
    prioritize.ts               PRIORITIZE
    conflict-detect.ts          CONFLICT_DETECT
    resolve-request.ts          RESOLVE_REQUEST
    scheduled-task.ts           SCHEDULED_TASKS
    voice-call.ts               VOICE_CALL
    remote-desktop.ts           REMOTE_DESKTOP
    work-thread.ts              WORK_THREAD
    lib/                        Shared action helpers (calendly-handler, etc.)

  providers/                    All provider implementations (see table above)

  lifeops/
    scheduled-task/             Scheduled-task runner, state log, gates, escalation, runtime wiring
    entities/                   EntityStore + merge engine; voice-observer-bridge.ts
                                handles core VOICE_TURN_OBSERVED → VoiceObserver (merge
                                engine) → emits VOICE_ENTITY_BOUND back to the voice plugin
    relationships/              RelationshipStore
    registries/                 AnchorRegistry, EventKindRegistry, FamilyRegistry, BlockerRegistry
    channels/                   ChannelRegistry + priority-posture map
    connectors/                 ConnectorRegistry + owner policy projections.
                                Connector clients/adapters belong in their plugins.
    send-policy/                Per-connector send-policy contract + registry
    owner/                      OwnerFactStore, profile-extraction-evaluator
    first-run/                  FirstRunService, first-run state store
    pending-prompts/            PendingPromptsStore
    global-pause/               GlobalPauseStore
    handoff/                    Per-room HandoffStore
    i18n/                       MultilingualPromptRegistry, localized examples provider
    messaging/                  Assistant messaging projections and policies.
                                Transport adapters belong in connector plugins.
    checkin/                    CheckinService + schedule resolver
    work-threads/               WorkThreadStore + threadOps field evaluator
    service.ts                  LifeOpsService (large service composed from service-mixin-*.ts)
    repository.ts               LifeOpsRepository (DB access layer)
    runtime.ts                  Scheduler task worker + registration helpers
    schema.ts                   Drizzle schema for plugin tables
    approval-queue.ts           PgApprovalQueue (owner approval workflow)

  website-blocker/
    engine.ts                   SelfControl / hosts-file blocking engine
    service.ts                  WebsiteBlockerService + SelfControlBlockerService
    public.ts                   Public exports for website-blocker subsystem
    chat-integration/           Block-rule reconciler worker

  app-blocker/
    engine.ts                   OS-level app blocking engine (macOS)

  activity-profile/
    activity-tracker-service.ts ActivityTrackerService
    presence-signal-bridge-service.ts PresenceSignalBridgeService
    proactive-worker.ts         Proactive agent task (GM/GN/nudges)

  followup/                     Follow-up tracker task worker + overdue digest

  default-packs/                Default ScheduledTask packs
                                (daily-rhythm, morning-brief, quiet-user-watcher,
                                 habit-starters, inbox-triage-starter, followup-starter, ...)
  ../test/scenarios/            Executable LifeOps scenario-runner specs.
                                Executive-assistant scenarios should cover
                                chief-of-staff workflows beyond reminders:
                                schedule, follow-up, briefing, approvals,
                                messaging handoff, documents, money, and priority triage.

  platform/                     Platform detection helpers (isDarwin, etc.)
  routes/                       HTTP route handlers (lifeops, website-blocker, cloud-features, travel-relay)
  types/                        Shared TypeScript types
  widgets/                      Embeddable widgets (side-effectful entry)
  api/                          Client-side API helpers (client-lifeops.ts)
  components/                   React components
  ui.ts                         UI entry (side-effectful)
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-personal-assistant clean                         # remove build output
bun run --cwd plugins/plugin-personal-assistant build                         # build package artifacts
bun run --cwd plugins/plugin-personal-assistant build:js                      # js build lane
bun run --cwd plugins/plugin-personal-assistant build:types                   # types build lane
bun run --cwd plugins/plugin-personal-assistant typecheck                     # TypeScript typecheck
bun run --cwd plugins/plugin-personal-assistant verify                        # package verification lane
bun run --cwd plugins/plugin-personal-assistant lint                          # mutating Biome check
bun run --cwd plugins/plugin-personal-assistant lint:check                    # read-only Biome check
bun run --cwd plugins/plugin-personal-assistant lint:default-packs            # node scripts/lint-default-packs.mjs
bun run --cwd plugins/plugin-personal-assistant format                        # write formatting
bun run --cwd plugins/plugin-personal-assistant format:check                  # read-only formatting check
bun run --cwd plugins/plugin-personal-assistant test                          # run package tests
bun run --cwd plugins/plugin-personal-assistant pretest                       # pre-test generated checks
bun run --cwd plugins/plugin-personal-assistant test:integration              # integration test lane
bun run --cwd plugins/plugin-personal-assistant test:scenarios                # scenarios test lane
bun run --cwd plugins/plugin-personal-assistant test:scenarios:list           # scenarios:list test lane
bun run --cwd plugins/plugin-personal-assistant test:scenarios:lifeops-spine  # scenarios:lifeops-spine test lane
bun run --cwd plugins/plugin-personal-assistant test:app-state                # app-state test lane
bun run --cwd plugins/plugin-personal-assistant test:background-real          # background-real test lane
bun run --cwd plugins/plugin-personal-assistant bench:work-threads            # work-threads benchmark lane
bun run --cwd plugins/plugin-personal-assistant verify:live-schedule          # bun run ./scripts/verify-live-schedule-data.ts
```

## Config / env vars

| Variable | Required | Description |
|---|---|---|
| `ELIZA_DISABLE_PROACTIVE_AGENT` | No | Set to `1` to skip the proactive GM/GN/nudge task |
| `ELIZA_DISABLE_LIFEOPS_SCHEDULER` | No | Set to `1` to skip the LifeOps scheduler task |
| `LIFEOPS_USE_MOCKOON` | No | Set to `1` to redirect all connector base URLs to local Mockoon mock servers |
| `LIFEOPS_DUFFEL_API_BASE` | No | Override Duffel travel-booking API base URL |
| `SELFCONTROL_HOSTS_FILE_PATH` | No | Override hosts-file path for website blocking (default: `/etc/hosts`) |
| `WEBSITE_BLOCKER_HOSTS_FILE_PATH` | No | Alternative hosts-file path override |
| `ELIZA_DISABLE_ACTIVITY_TRACKER` | No | Set to `1` to skip native activity tracker |
| `ELIZA_NATIVE_PERMISSIONS_DYLIB` | No | Path to native permissions dylib (macOS screen-time) |
| `ELIZA_HEALTHKIT_CLI_PATH` | No | HealthKit CLI path consumed by plugin-health; LifeOps may only observe its projections |
| `ELIZA_IMESSAGE_BACKEND` | No | iMessage backend selector |
| `ELIZA_REMOTE_ACCESS_TOKEN` | No | Token for remote desktop access |
| `ELIZA_REMOTE_LOCAL_MODE` | No | Set to `1` for local-only remote desktop mode |
| `ELIZA_BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS` | No | TTL for browser-bridge companion tokens |
| `ELIZA_WHATSAPP_ACCESS_TOKEN` | No | WhatsApp API access token |
| `ELIZA_WHATSAPP_PHONE_NUMBER_ID` | No | WhatsApp phone number ID |
| `ELIZA_GOOGLE_FIT_ACCESS_TOKEN` | No | Google Fit token consumed by plugin-health |
| `GOOGLE_MAPS_API_KEY` | No | Google Maps API key (travel-time calculations) |
| `TWILIO_SMS_COST_PER_SEGMENT_USD` | No | Override Twilio SMS cost estimate |
| `ELIZAOS_CLOUD_API_KEY` | No | Eliza Cloud API key (cloud features route) |
| `ELIZAOS_CLOUD_BASE_URL` | No | Eliza Cloud base URL override |
| `ELIZA_LIFEOPS_CONTEXT_WINDOW` | No | Override provider context window size (tokens) |

`ELIZA_DEVICE_KIND` (`desktop` / `mobile`) is read for device-specific gating. `ELIZA_DEVICE_ID` is the stable device identifier.

## How to extend

### Add a new action

1. Create `src/actions/<name>.ts`. Export a const implementing `Action` from `@elizaos/core`. Use `promoteSubactionsToActions` if the action has named sub-operations.
2. Import and spread it into the `actions` array in `src/plugin.ts`.
3. Re-export from `src/index.ts` if it needs to be publicly importable.

### Add a new provider

1. Create `src/providers/<name>.ts`. Export a `Provider` object.
2. Add it to the `providers` array in `src/plugin.ts`.
3. Re-export from `src/index.ts` if needed.

### Add a new default pack

1. Add `src/default-packs/<name>.ts` exporting a `DefaultPack` (use `compileTaskDefinition` / `compileTaskDefinitions` — never construct raw `ScheduledTaskSeed`).
2. Import and register it in `src/default-packs/index.ts` inside `getAllDefaultPacks()`.
3. List in `getDefaultEnabledPacks()` to auto-seed, or `getOfferedDefaultPacks()` for first-run opt-in.
4. Run `bun run --cwd plugins/plugin-personal-assistant lint:default-packs` to validate.

### Add a new connector

1. Add `src/lifeops/connectors/<name>.ts` implementing the connector contract from `src/lifeops/connectors/contract.ts`.
2. Register it in `src/lifeops/connectors/index.ts` inside `registerDefaultConnectorPack`.

## Conventions / gotchas

- **OWNER_SCREENTIME is macOS-only.** It is platform-gated via `isDarwin()` in `src/plugin.ts` (`platformGatedActionUmbrellas`). Do not add it unconditionally.
- **Scheduler task init is deferred.** Task workers are registered inside `init()`, but `ensureTask` calls are scheduled via `runtime.initPromise` so they run after the runtime finishes initializing. Failures are non-fatal to plugin load; check `LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY` in the runtime cache for diagnostics.
- **The runner never inspects `promptInstructions`.** Routing is done purely on structural `ScheduledTask` fields. The runner lives in `plugins/plugin-scheduling/src/scheduled-task/runner.ts`; the personal-assistant side wires it in via `src/lifeops/scheduled-task/{service,scheduler,runtime-wiring}.ts`.
- **Approval flows require an approval queue.** Outbound message sends and document signatures go through `PgApprovalQueue` before any external dispatch. Never dispatch directly from action handlers.
- **`LifeOpsService` is composed from mixins.** Core logic lives in `src/lifeops/service-mixin-*.ts` files. `src/lifeops/service.ts` composes them. Add a new domain capability as a mixin.
- **Default packs must pass lint.** `bun run lint:default-packs` (also `pretest`) enforces the rules embedded in `scripts/lint-default-packs.mjs`. CI blocks packs that fail.
- **plugin-google is auto-registered.** If `@elizaos/plugin-google` is not already in the runtime's plugin list, `init()` dynamically imports and registers it. Ensure it is installed in the workspace.
- See root `AGENTS.md` for repo-wide architecture commandments, logger conventions, ESM rules, and naming.

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

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
