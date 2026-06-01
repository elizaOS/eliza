# @elizaos/plugin-lifeops

Owner operations plugin: routines, goals, scheduled tasks, calendar, messaging, connectors, website/app blocking, credentials, voice calls, and browser companion control for an Eliza agent.

## Purpose / role

Adds the full owner-operations surface to an Eliza agent: it registers action umbrellas for every owner-facing domain (reminders, alarms, goals, todos, routines, health, finances, calendar, inbox, documents, screen-time, voice calls, connectors), a persistent scheduled-task runner, website/app blocking via hosts-file manipulation (SelfControl) and OS-level APIs, and a browser-bridge service for companion browser extension pairing. The plugin is opt-in; add `@elizaos/plugin-lifeops` to the agent's plugin list. It depends on `@elizaos/plugin-google` (auto-registered at init if absent).

## Plugin surface

### Actions (registered via `promoteSubactionsToActions`)

| Action name | File | What it does |
|---|---|---|
| `BLOCK` | `src/actions/block.ts` | Website/app block and unblock (SelfControl + OS APIs) |
| `CALENDAR` | `src/actions/calendar.ts` | Calendar read/write, event creation, scheduling |
| `CONNECTOR` | `src/actions/connector.ts` | Connect/disconnect/query external service connectors |
| `CREDENTIALS` | `src/actions/credentials.ts` | Credential lookup and autofill |
| `OWNER_DOCUMENTS` | `src/actions/document.ts` | Document search, review, signature workflows |
| `INBOX` | `src/actions/inbox.ts` | Email/messaging inbox triage |
| `OWNER_REMINDERS` | `src/actions/owner-surfaces.ts` | Reminders (Apple Reminders, Google Tasks) |
| `OWNER_ALARMS` | `src/actions/owner-surfaces.ts` | Alarms |
| `OWNER_GOALS` | `src/actions/owner-surfaces.ts` | Goals CRUD |
| `OWNER_TODOS` | `src/actions/owner-surfaces.ts` | Todos |
| `OWNER_ROUTINES` | `src/actions/owner-surfaces.ts` | Daily routines |
| `OWNER_HEALTH` | `src/actions/owner-surfaces.ts` | Health metrics |
| `OWNER_SCREENTIME` | `src/actions/owner-surfaces.ts` | Screen-time (macOS only; platform-gated) |
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
| `lifeops_browser` | `src/provider.ts` | Browser-bridge companion context |
| `websiteBlocker` | `src/providers/website-blocker.ts` | Current website-blocker status |
| `appBlocker` | `src/providers/app-blocker.ts` | Current app-blocker status |
| `firstRun` | `src/providers/first-run.ts` | First-run completion state and affordances |
| `roomPolicy` | `src/providers/room-policy.ts` | Per-room handoff/policy state |
| `lifeops` | `src/providers/lifeops.ts` | Aggregated owner context (schedule, goals, reminders, health) |
| `pendingPrompts` | `src/providers/pending-prompts.ts` | Pending questions waiting for owner input |
| `workThreads` | `src/providers/work-threads.ts` | Active work-thread state |
| `recentTaskStates` | `src/providers/recent-task-states.ts` | Recent scheduled-task execution results |
| `lifeops-health` | `src/providers/health.ts` | Health metrics from plugin-health |
| `inboxTriage` | `src/providers/inbox-triage.ts` | Unresolved inbox items for triage |
| `crossChannelContext` | `src/providers/cross-channel-context.ts` | Cross-channel conversation context |
| `activity-profile` | `src/providers/activity-profile.ts` | Owner activity/presence profile |

### Services

| Service type | Class | File | Role |
|---|---|---|---|
| `browser_bridge` | `BrowserBridgePluginService` | `src/service.ts` | Browser extension companion pairing and session management |
| `website_blocker` | `WebsiteBlockerService` | `src/website-blocker/service.ts` | Hosts-file blocking (SelfControl) lifecycle |
| `activity_tracker` | `ActivityTrackerService` | `src/activity-profile/activity-tracker-service.ts` | macOS activity/screen-time tracking |
| `presence_signal_bridge` | `PresenceSignalBridgeService` | `src/activity-profile/presence-signal-bridge-service.ts` | Device presence signal forwarding |
| `lifeops_scheduled_task_runner` | `ScheduledTaskRunnerService` | `src/lifeops/scheduled-task/service.ts` | Scheduled-task execution engine |

### Evaluators

| Evaluator name | File | Role |
|---|---|---|
| `owner.profile_extraction` (response handler) | `src/lifeops/owner/profile-extraction-evaluator.ts` | Extracts owner facts from agent responses |
| `threadOps` (response handler field) | `src/lifeops/work-threads/field-evaluator-thread-ops.ts` | Propagates work-thread field ops from responses |

### Views (registered via `views` array)

- `lifeops` — `LifeOpsPageView` (desktop dashboard), `LifeOpsTuiView` (TUI), and an XR variant. Bundle: `dist/views/bundle.js`.

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
    connector.ts                CONNECTOR
    credentials.ts              CREDENTIALS
    document.ts                 OWNER_DOCUMENTS
    inbox.ts                    INBOX
    owner-surfaces.ts           OWNER_REMINDERS / OWNER_ALARMS / OWNER_GOALS / OWNER_TODOS
                                / OWNER_ROUTINES / OWNER_HEALTH / OWNER_SCREENTIME
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
    entities/                   EntityStore + merge engine
    relationships/              RelationshipStore
    registries/                 AnchorRegistry, EventKindRegistry, FamilyRegistry, BlockerRegistry
    channels/                   ChannelRegistry + priority-posture map
    connectors/                 ConnectorRegistry + per-connector adapters
                                (calendly, discord, duffel, google, imessage,
                                 signal, telegram, twilio, whatsapp, x)
    send-policy/                Per-connector send-policy contract + registry
    owner/                      OwnerFactStore, profile-extraction-evaluator
    first-run/                  FirstRunService, first-run state store
    pending-prompts/            PendingPromptsStore
    global-pause/               GlobalPauseStore
    handoff/                    Per-room HandoffStore
    i18n/                       MultilingualPromptRegistry, localized examples provider
    messaging/                  Messaging adapters (Gmail, X DM, Calendly, BrowserBridge)
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

  platform/                     Platform detection helpers (isDarwin, etc.)
  routes/                       HTTP route handlers (lifeops, website-blocker, cloud-features, travel-relay)
  types/                        Shared TypeScript types
  widgets/                      Embeddable widgets (side-effectful entry)
  api/                          Client-side API helpers (client-lifeops.ts)
  components/                   React components
  ui.ts                         UI entry (side-effectful)
```

## Commands

```bash
bun run --cwd plugins/plugin-lifeops build              # Full build (JS + views + types)
bun run --cwd plugins/plugin-lifeops build:js           # tsup bundling only
bun run --cwd plugins/plugin-lifeops build:views        # Vite views bundle
bun run --cwd plugins/plugin-lifeops build:types        # tsc declaration emit
bun run --cwd plugins/plugin-lifeops test               # Unit tests (vitest)
bun run --cwd plugins/plugin-lifeops test:background-real  # Long-running real e2e tests
bun run --cwd plugins/plugin-lifeops lint:default-packs # Validate default-pack definitions
bun run --cwd plugins/plugin-lifeops verify             # lint:default-packs + build:types + test
bun run --cwd plugins/plugin-lifeops clean              # Remove dist/
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
| `ELIZA_HEALTHKIT_CLI_PATH` | No | Path to HealthKit CLI binary |
| `ELIZA_IMESSAGE_BACKEND` | No | iMessage backend selector |
| `ELIZA_REMOTE_ACCESS_TOKEN` | No | Token for remote desktop access |
| `ELIZA_REMOTE_LOCAL_MODE` | No | Set to `1` for local-only remote desktop mode |
| `ELIZA_BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS` | No | TTL for browser-bridge companion tokens |
| `ELIZA_WHATSAPP_ACCESS_TOKEN` | No | WhatsApp API access token |
| `ELIZA_WHATSAPP_PHONE_NUMBER_ID` | No | WhatsApp phone number ID |
| `ELIZA_GOOGLE_FIT_ACCESS_TOKEN` | No | Google Fit access token (health) |
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
4. Run `bun run --cwd plugins/plugin-lifeops lint:default-packs` to validate.

### Add a new connector

1. Add `src/lifeops/connectors/<name>.ts` implementing the connector contract from `src/lifeops/connectors/contract.ts`.
2. Register it in `src/lifeops/connectors/index.ts` inside `registerDefaultConnectorPack`.

## Conventions / gotchas

- **OWNER_SCREENTIME is macOS-only.** It is platform-gated via `isDarwin()` in `src/plugin.ts` (`platformGatedActionUmbrellas`). Do not add it unconditionally.
- **Scheduler task init is deferred.** Task workers are registered inside `init()`, but `ensureTask` calls are scheduled via `runtime.initPromise` so they run after the runtime finishes initializing. Failures are non-fatal to plugin load; check `LIFEOPS_TASK_INIT_FAILURE_CACHE_KEY` in the runtime cache for diagnostics.
- **The runner never inspects `promptInstructions`.** Routing is done purely on structural `ScheduledTask` fields. See `src/lifeops/scheduled-task/runner.ts`.
- **Approval flows require an approval queue.** Outbound message sends and document signatures go through `PgApprovalQueue` before any external dispatch. Never dispatch directly from action handlers.
- **`LifeOpsService` is composed from mixins.** Core logic lives in `src/lifeops/service-mixin-*.ts` files. `src/lifeops/service.ts` composes them. Add a new domain capability as a mixin.
- **Default packs must pass lint.** `bun run lint:default-packs` (also `pretest`) enforces rules from `docs/audit/prompt-content-lint.md`. CI blocks packs that fail.
- **plugin-google is auto-registered.** If `@elizaos/plugin-google` is not already in the runtime's plugin list, `init()` dynamically imports and registers it. Ensure it is installed in the workspace.
- **Views are built separately.** The `build:views` step (Vite) produces `dist/views/bundle.js`. The main `build:js` step (tsup) does not include views. Run `build` to get both.
- See root `AGENTS.md` for repo-wide architecture commandments, logger conventions, ESM rules, and naming.
