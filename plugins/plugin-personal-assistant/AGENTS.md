# @elizaos/plugin-personal-assistant

Chat-first owner operations and cross-domain LifeOps orchestration for an Eliza agent.

## Role

This package is the composition root for personal-assistant workflows: briefs, prioritization, approvals, scheduled work, household coordination, owner context, and the policy that joins domain plugins into one assistant. Domain implementations remain with their owning plugins. Calendar, inbox, goals, reminders, finances, health, blocker, browser, phone, and messaging connectors are collaborators, not duplicate subsystems to rebuild here.

The plugin declares Google Workspace and scheduling dependencies and initializes the calendar, finances, reminders, goals, inbox, and health plugins when needed. `@elizaos/plugin-scheduling` owns the single scheduled-task runner; this package supplies LifeOps dependencies, workers, registries, policies, and default packs.

All registered actions and providers are wrapped with owner-access guards. The personal assistant is primarily a chat surface, while domain views live with their domain plugins. Its focused `/lifeops/connections` view owns only cross-domain Gmail, Google Calendar, and Apple Calendar onboarding, sync health, recovery, and local imported-data lifecycle; it does not duplicate inbox or calendar product views.

## Runtime surface

### Actions

Most umbrella actions use `promoteSubactionsToActions`, so both the umbrella and discoverable flat subactions are registered.

| Area | Registered umbrellas and direct actions |
|---|---|
| Planning and execution | `PERSONAL_ASSISTANT`, `BRIEF`, `PRIORITIZE`, `CONFLICT_DETECT`, `RESOLVE_REQUEST`, `SCHEDULED_TASKS`, `WORK_THREAD` |
| Owner records | `OWNER_REMINDERS`, `OWNER_ALARMS`, `OWNER_GOALS`, `OWNER_TODOS`, `OWNER_ROUTINES`, `OWNER_HEALTH`, `OWNER_FINANCES` |
| Documents and identity | `OWNER_DOCUMENTS`, `CREATIVE_DRAFT`, `CREDENTIALS`, `ENTITY`, `RESOLVE_REFERENT` |
| Calendar and communications | `CALENDAR`, `CONNECTOR`, `VOICE_CALL`, plus core messaging-triage actions |
| Household | `HOUSEHOLD_COORDINATION`, `HOUSEHOLD_OPERATIONS`, `RESOURCE_CAPACITY`, `FAMILY_COMMUNICATIONS`, `PARENTING_GUIDANCE`, `HOUSEHOLD_FOOD`, `LOCAL_CONDITIONS`, `SCHOOL_SOURCE_FACT` |
| Blocking and platform features | `BLOCK`; `OWNER_SCREENTIME` is registered only on macOS |

`INBOX` and its promoted subactions are registered by `@elizaos/plugin-inbox`, which this plugin ensures is loaded. Do not duplicate them here.

### Providers

The plugin registers these owner-private providers:

- `lifeops_browser` from `src/provider.ts`
- `firstRun`, `ftuGoal`, `roomPolicy`, and `lifeops`
- `pendingApprovals`, `delegationContracts`, and `pendingPrompts`
- `workThreads` and `recentTaskStates`
- `lifeops-health`, `crossChannelContext`, and `activity-profile`

Inbox triage context is owned and registered by `@elizaos/plugin-inbox`.

### Services

`src/plugin.ts` registers:

- `BrowserBridgePluginService`
- `ActivityTrackerService` and `PresenceSignalBridgeService`
- `HouseholdCoordinationRuntimeService`
- `AuthenticatedRuntimeSpeakerVerifierService` and `FamilyCommunicationsRuntimeService`
- `ParentingGuidanceRuntimeService`
- `HouseholdOperationsRuntimeService`
- `OwnerCalendarMutationGatewayService`
- `ResourceCapacityRuntimeService`
- `SchoolSourceFactRuntimeService`
- `FoodDomainRuntimeService`

The scheduled-task runner service is registered by `@elizaos/plugin-scheduling`. Website and app blocking services are registered by `@elizaos/plugin-blocker`; this package composes their action and permission seams.

### Evaluators and events

- Response handler: `ownerProfileExtractionEvaluator`
- Response field handler: `threadOpsFieldEvaluator`
- Post-turn evaluators: `ftuGoalDiscoveryEvaluator` and `anticipationFeedbackEvaluator`
- Event handlers cover inbound scheduled-task completion, unanswered-question follow-up, delegation and household approvals, meeting transcripts, outbound-message follow-up, and voice/entity binding.

Keep side effects that do not affect first-token latency detached from the awaited `MESSAGE_RECEIVED` edge, and surface detached failures with `runtime.reportError`.

## Package map

```
src/
  plugin.ts                     composition root and lifecycle
  index.ts                      public exports
  register.ts                   app registration entry
  service.ts                    browser bridge facade
  provider.ts                   browser context provider
  actions/                      owner-facing action umbrellas and direct actions
  providers/                    owner context providers
  activity-profile/             presence, activity, and proactive-task wiring
  default-packs/                compiled scheduled-task packs
  followup/                     follow-up worker
  lifeops/
    service.ts                  LifeOpsService composition
    service-mixin-*.ts          domain capabilities mixed into LifeOpsService
    repository.ts               database access
    schema.ts                   package-owned Drizzle schema
    scheduled-task/             scheduling integration and dispatch policy
    registries/                 extensible anchors, families, event kinds, and steps
    entities/                   entity store and merge engine
    relationships/              relationship store
    owner/                      owner facts and profile extraction
    work-threads/               durable work-thread state
    household*/                 household coordination and operations
    family-communications/      authenticated family messaging
    parenting/ food/ school/    household domain modules
    oracles/                    external facts and local conditions
    messaging/ send-policy/     owner send and approval policy
  routes/                       HTTP handlers and route plugin
  components/ widgets/ ui.ts    app-facing UI exports, including the focused connection manager
test/                           integration, scenario, and real-background lanes
```

Use `src/plugin.ts` as the source of truth for what is actually registered. Some modules are intentionally exported for composition without being registered on this plugin object.

## Commands

```bash
bun run --cwd plugins/plugin-personal-assistant build
bun run --cwd plugins/plugin-personal-assistant typecheck
bun run --cwd plugins/plugin-personal-assistant lint:check
bun run --cwd plugins/plugin-personal-assistant format:check
bun run --cwd plugins/plugin-personal-assistant test
bun run --cwd plugins/plugin-personal-assistant verify
bun run --cwd plugins/plugin-personal-assistant test:integration
bun run --cwd plugins/plugin-personal-assistant test:background-real
bun run --cwd plugins/plugin-personal-assistant test:scenarios
bun run --cwd plugins/plugin-personal-assistant lint:default-packs
```

The package manifest contains narrower scenario, app-state, benchmark, and live-schedule lanes.

## Configuration

Frequently used controls include:

| Variable | Purpose |
|---|---|
| `ELIZA_DISABLE_PROACTIVE_AGENT` | Disable proactive greeting and nudge work |
| `ELIZA_DISABLE_LIFEOPS_SCHEDULER` | Disable the LifeOps scheduler task |
| `ELIZA_DISABLE_ACTIVITY_TRACKER` | Disable native activity collection |
| `LIFEOPS_USE_MOCKOON` | Point supported connectors at local Mockoon services |
| `SELFCONTROL_HOSTS_FILE_PATH` / `WEBSITE_BLOCKER_HOSTS_FILE_PATH` | Override the blocker hosts file |
| `ELIZA_BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS` | Configure browser companion token lifetime |
| `ELIZAOS_CLOUD_API_KEY` / `ELIZAOS_CLOUD_BASE_URL` | Configure cloud-backed assistant features |

Connector credentials and domain-specific settings belong to their owning plugin. `ELIZA_DEVICE_KIND` and `ELIZA_DEVICE_ID` control device-specific behavior.

## Architectural constraints

- Scheduled behavior is structural. Never branch on `promptInstructions`; use `kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline`, and related fields.
- There is one scheduler and one entity/relationship graph. Extend their registries rather than creating parallel stores or runners.
- Connector dispatch returns typed `DispatchResult` values. Do not reduce transport outcomes to booleans.
- External sends, signatures, and other consequential operations pass through owner policy and approval boundaries.
- Add domain logic to the owning plugin. Keep this package focused on orchestration, normalized owner projections, and cross-domain policy.
- Owner-private planner providers and ranking inputs must expose every matching record. Do not hide approvals, delegation contracts, work threads, todos, or commitments behind fixed-count slices; use explicit caller pagination only on surfaces that return a truthful continuation contract.
- Build default packs with `compileTaskDefinition` or `compileTaskDefinitions`, register them through the pack catalog, and run `lint:default-packs`.
- Deferred task initialization occurs after `runtime.initPromise`; failures must remain observable in logs, runtime error reporting, or the initialization-failure cache.
- Use `src/lifeops/service-mixin-*.ts` for new LifeOps service capabilities and keep `src/lifeops/service.ts` as composition.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run the relevant package lanes above, then exercise the real connector, scheduler, database, approval, or UI boundary changed. Inspect scheduled-task records, database rows, logs, trajectories, and rendered behavior; mocked success is not evidence for a real integration.
