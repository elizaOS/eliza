# Plan: Unified Scenario Matrix + Full-Feature Implementation

Status: **Plan for review** — no code yet.
Owner: (pending)
Last updated: 2026-04-16

This plan turns Shaw's two audio recordings into an executable program of work. The goal is to:

1. **Unify** the two existing scenario frameworks (LifeOps JSON + Convo TypeScript) into one schema-driven runner.
2. **Author** scripted scenarios covering every capability described in the recordings, including edge cases.
3. **Implement** every MISSING or PARTIAL feature so the scenarios actually pass.
4. **Run the full matrix on every PR** against real (sandboxed) external services via dedicated test accounts.

The decisions encoded in this plan were chosen explicitly by the user:

| Decision | Choice |
|---|---|
| Scenario framework | **Unify — TypeScript-first (more flexible than JSON)** |
| Implementation scope | **Everything — tests + full implementation of all missing features** |
| CI gating | **Full matrix on `develop` branch post-merge** (not every PR — too expensive). PRs run a small fast subset. |
| Side-effect policy | **Real services with dedicated test accounts** |

---

## 1. Goals, constraints, risks

### 1.1 What exactly needs to be built

Three deliverables, in this order:

1. **Unified Scenario Schema + Runner (USR).** A single scenario file format (JSON with optional TS extension files) that supersedes both `eliza/apps/app-lifeops/scenarios/*.json` and `eliza/packages/app-core/test/convo-testing/scenarios/*.convo.test.ts`. One runner executes all scenarios, surfaces action invocations, trajectories, LLM-judge results, and final-state DB checks uniformly. Both existing runners are adapter-wrapped around the USR (or replaced).

2. **Scenario Library.** At least one scripted scenario per capability the user described, plus edge-case variants (cancel, retry, multi-device, cross-source, wrong-action negatives, parameter ambiguity, multi-turn chains). Target: **~180 scenarios** across domains.

3. **Feature Completion.** For every scenario that fails because the underlying feature is MISSING or PARTIAL, implement the missing action/plugin/service until the scenario passes. Priority-ordered list of ~50 concrete implementation units (see §6).

### 1.2 Why

- Today we ship action-dependent features with **no verification that the agent actually selects and invokes the right action** given a natural-language user request. Text-only assertions mask silent regressions.
- Two fragmented scenario frameworks means: duplicated effort, inconsistent semantics, no way to run "everything" in one command, no shared assertion library.
- The recordings describe a comprehensive personal-assistant product. Most of it has partial scaffolding in the repo (messaging, todos, reminders, SelfControl, triage) and some of it is entirely absent (VNC, Tailscale pairing, WakaTime, 1Password/ProtonPass autofill, meeting dossiers, travel-time, macOS alarms, iOS companion app, Calendly). We cannot call the product "done" until scenarios for every recorded capability pass end-to-end.

### 1.3 Constraints

**Hard constraints:**

- **No stubbing.** Per AGENTS.md in the repo root, fallback/stub/"just enough" code is explicitly disallowed. Every scenario must run against real code or be marked `skip` with an explicit reason.
- **No SQL mocks** (per user memory `feedback_no_sql_mocks.md`). Tests use PGLite for real local databases.
- **Real LLM** for scenarios. Use `selectLiveProvider()` fallback chain (Groq → OpenAI → Anthropic → …).
- **Architecture rules** (CLAUDE.md §10) apply: dependencies point inward, use cases own computation, client displays only, CQRS, DTOs required by default, no `any`, logger only, every endpoint has a client trigger.
- **Real test accounts** for external services. No mocks for Twilio/Gmail/Calendar/iMessage/Discord/Telegram/Signal/WhatsApp.

**Soft constraints:**

- Scenarios must run in < 2 minutes each on average so a full matrix (~180 scenarios) finishes in reasonable CI wall time with parallelism.
- Side-effect cleanup must be automatic. A failed run must not leave stale blocks, reminders, calendar events, or emails.
- Credential management must not block local dev. Devs without credentials should see the scenario "skipped: missing <provider> credentials" not a hard error.

### 1.4 Risks

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Full matrix on every PR blows through LLM quotas | High | High | Provider fallback chain + parallel shards + cached preflight + Groq as default (cheap). §7 details. |
| Real external services (Twilio, Gmail, Apple) rate-limit/ban test accounts | High | Medium | Per-service rate-limiter in runner; dedicated test-only accounts; exponential backoff; nightly rotation plan. |
| LLM non-determinism makes scenarios flaky | High | High | Retry budget + LLM-judge with rubric ≥ 0.7 + fuzzy text matchers already in `lifeops-live-scenario-runner.ts`. Judge is authoritative, not exact string match. |
| Side effects leak across scenarios (orphaned reminders, calendar events, SelfControl blocks) | Medium | High | Per-scenario isolation mode (already in runner) + test-account namespacing + end-of-run cleanup sweep. |
| Unifying two frameworks breaks existing suites before new one stabilizes | High | Medium | Migration ships with both runners live; old command names aliased; cut over per-domain; final removal only after green matrix for N days. |
| "Implement everything" scope is huge (~50 implementation units) | High | Certain | Milestone-gated: each milestone lands USR + a subset of scenarios + only the implementations those scenarios need. Don't build speculative features. |
| Apple ecosystem (iMessage, Reminders, Calendar) requires signed permissions & a real Mac in CI | High | High | Dedicated macOS GitHub Actions runner + permissions pre-granted in image OR scenario tier that runs only on `macos-latest` self-hosted. iMessage via BlueBubbles server is the viable path already in code. |
| 1Password/ProtonPass autofill is architecturally hard (browser extension + secure credential store) | High | Medium | Scoped to Chrome extension message-passing API; out of scope for CI automation; covered by Playwright smoke test with seeded fake vault + a separate `live:local` suite behind a gate. |
| VNC/Tailscale remote-control scenarios can't be fully automated | High | Medium | Test the control-plane API (pair, revoke, session start/stop) in CI; the data-plane (actual remote viewing) gets a manual smoke checklist + Playwright UI test of the overlay. |

### 1.5 Unknowns (require clarification before build)

Listed in §12. Non-blocking for writing the plan but must resolve before certain milestones.

---

## 2. Current state

### 2.1 Scenario frameworks that already exist

**Framework A — LifeOps JSON.**
- 23 JSON scenario files in `eliza/apps/app-lifeops/scenarios/` (brush teeth, shower, shave, vitamins, water, stretch, invisalign, workout blocker, goal-sleep, calendar-vague-followup, gmail-retry-followup, gmail-suran-routing, reminder-lifecycle ×2, daily-left-today-variants, one-off-mountain-time, etc.).
- Runner: `eliza/apps/app-lifeops/test/helpers/lifeops-live-scenario-runner.ts` (1,358 lines).
- Entry test: `eliza/apps/app-lifeops/test/lifeops-scenarios.live.e2e.test.ts`.
- Capabilities:
  - Multi-room (Telegram, Discord sources).
  - Template variables (`{{now}}`, `{{now+1d}}`, `{{now-30m}}`, `{{definitionId:title}}`, `{{occurrenceId:title}}`).
  - Per-turn: `responseIncludesAll/Any/Excludes`, `plannerIncludesAll/Any/Excludes`, `responseJudge`/`plannerJudge` (LLM-as-judge with rubric + min score), `attempts`, `trajectoryTimeoutMs`, `waitForDefinitionTitle`/`waitForGoalTitle`.
  - API-call turns (`apiRequest` with method/path/body) as first-class turns alongside user messages.
  - Final checks: `definitionCountDelta`, `reminderIntensity`, `goalCountDelta` (all DB-state assertions including cadence, windows, weekdays, website-access unlock mode, timezone).
  - Isolated or shared runtime modes.
  - Progress events emitted during run.

**Framework B — Convo TypeScript.**
- 2 scenario test files in `eliza/packages/app-core/test/convo-testing/scenarios/` (`echo-self-test.convo.test.ts`, `greeting-dynamic.convo.test.ts`).
- Runner: `eliza/packages/app-core/test/convo-testing/` (scripted-runner, dynamic-runner, action-interceptor, assertions, reporter, conversation-runner, types, index — ~1,100 lines total).
- Command: `bun run test:convo`.
- Capabilities:
  - **Action interception** — patches `action.handler` on the live runtime to record every invocation with `{actionName, parameters, result, error, durationMs, timestamp}`.
  - Scripted mode: fixed turns with `expectedActions`, `forbiddenActions`, `responseContains/Excludes`, `assertResponse(text)`, `assertTurn(TurnResult)`.
  - Dynamic mode: evaluator LLM drives user messages toward a goal, expected actions must fire within `maxTurns`.
  - Per-scenario plugins override, `runtimeOptions` passthrough.

**Other scenario-adjacent frameworks** (out of scope for this plan but noted):
- `packages/benchmarks/configbench/` — plugin/secrets/security.
- `packages/benchmarks/gauntlet/` — Solana trading YAML.
- `packages/core/test/live/coordinator-*` — coordinator readiness.

### 2.2 Capability registry

**152+ actions** registered across core + plugins. Full inventory exists. Highlights:

| Domain | Action count | Examples |
|---|---|---|
| Core basic | 4 | REPLY, CHOOSE_OPTION, IGNORE, NONE |
| Core advanced | 15 | SEND_MESSAGE, ADD_CONTACT, SCHEDULE_FOLLOW_UP, UPDATE_SETTINGS |
| Clipboard | 6 | CLIPBOARD_WRITE, READ, SEARCH, LIST, DELETE, APPEND |
| Plugin-orchestrator | 11 | Agent management, workspace |
| Plugin-music-* | 16 | Playlists, playback |
| Plugin-evm | 7 | Blockchain ops |
| Plugin-discord | 6 | |
| Plugin-shopify | 5 | |
| Plugin-cron | 5 | |
| Plugin-computeruse | 5 | |
| Plugin-commands | 5 | |

~130 of these have **no dedicated unit/integration tests**.

### 2.3 Feature-by-feature gap table

(Condensed from the full audit. 22 EXISTS, 9 PARTIAL, 5 MISSING.)

**EXISTS:** Gmail, Discord, Telegram, Twitter/X, Signal, WhatsApp, iMessage (via BlueBubbles), Twilio, macOS Reminders, macOS Calendar, To-do mgmt, Reminders engine, Morning/night routines, Message triage (Gmail-only), Draft messages, Website/app blocking (SelfControl), Priority management, Goal evaluator, Cloud gateway (Discord/Telegram/WhatsApp adapters), Phone gateway (Twilio adapter), Pairing token endpoint.

**PARTIAL:** GitHub, Screen/app activity tracking (framework only, no collector), Browser extension (references only), Relationship tracking/Rolodex (profile fields only), Follow-up tracking, Calendar *scheduling with others* (CRUD exists, no preferences/defending), Calendly, iOS/multi-device sync, VNC/Tailscale data plane.

**MISSING:** macOS Alarm, 1Password/ProtonPass autofill, Meeting dossiers, Travel time awareness, Billing markup (20%).

### 2.4 CI today

- `.github/workflows/test.yml` has 7 jobs: regression-matrix, unit-tests, db-check, desktop-contract, cloud-live-e2e, validation-e2e, ui-playwright-smoke.
- LifeOps scenarios run via `test:live:lifeops:scenarios` but are **not wired into PR CI** — only nightly/ad-hoc.
- Convo tests run via `test:convo` — not wired into PR CI either.

---

## 3. Target architecture

### 3.1 Unified Scenario Schema (USS) — TypeScript-first

Scenarios are authored in TypeScript. Each scenario is an object that conforms to a `Scenario` type exported from `@elizaos/scenario-schema`. Custom predicates (`assertResponse`, `assertTurn`, `finalChecks[].predicate`) are inline functions — this is the flexibility we picked over JSON.

JSON files ARE supported via a loader (`loadJsonScenario()`) so that the 23 existing LifeOps JSON scenarios can be imported without rewriting them — but the canonical authoring format is TS.

**File layout:**

```
test/scenarios/
  <domain>/
    <scenario-id>.scenario.ts             # TS-authored scenario (primary format)
  _lib/                                   # shared fixtures, test-account factories, helpers
  _catalog.ts                             # discovery, tags, filtering
  imported-from-json/                     # generated TS wrappers around legacy JSON
    <scenario-id>.scenario.ts             # just: export default loadJsonScenario("./<id>.json")
```

**Schema sketch** (`@elizaos/scenario-schema`):

```ts
export interface Scenario {
  id: string;
  title: string;
  domain: string;
  tags: string[];
  description?: string;

  requires?: {
    credentials?: string[];  // e.g. "gmail:test-agent"
    plugins?: string[];
    os?: "any" | "macos" | "linux" | "windows";
    env?: string[];          // required env var names
  };

  isolation: "per-scenario" | "shared" | "domain-shared";

  rooms?: Array<{
    id: string;
    source?: string;                 // "telegram" | "discord" | "dashboard" | ...
    channelType?: "DM" | "GROUP";
    title?: string;
  }>;

  /** Preconditions applied before turns run. */
  seed?: SeedStep[];

  turns: Turn[];

  finalChecks?: FinalCheck[];

  /** Always runs in `finally` — even on failure. */
  cleanup?: CleanupStep[];
}

export type Turn =
  | MessageTurn
  | ApiTurn
  | WaitTurn;

export interface MessageTurn {
  kind: "message";
  name: string;
  room?: string;
  text: string;

  // Action assertions
  expectedActions?: string[];
  forbiddenActions?: string[];
  /** Per-action parameter predicate (MongoDB-style operators). */
  expectedActionParams?: Record<string, ParamPredicate>;

  // Text assertions
  responseIncludesAll?: (string | RegExp)[];
  responseIncludesAny?: (string | RegExp)[];
  responseExcludes?: (string | RegExp)[];

  // LLM-as-judge
  responseJudge?: { rubric: string; minimumScore?: number };

  // Trajectory / planner
  plannerIncludesAll?: (string | RegExp)[];
  plannerIncludesAny?: (string | RegExp)[];
  plannerExcludes?: (string | RegExp)[];
  plannerJudge?: { rubric: string; minimumScore?: number };
  trajectoryTimeoutMs?: number;

  // Wait conditions after send
  waitForDefinitionTitle?: string;
  waitForGoalTitle?: string;

  // Custom predicates (TS-only — the reason we picked TS)
  assertResponse?: (text: string) => string | void;
  assertTurn?: (turn: TurnResult) => string | void;

  attempts?: number;
  timeoutMs?: number;
}

export interface ApiTurn {
  kind: "api";
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  expectedStatus?: number;
  responseIncludesAll?: (string | RegExp)[];
  assertResponse?: (status: number, body: unknown) => string | void;
}

export interface WaitTurn {
  kind: "wait";
  name: string;
  durationMs?: number;
  untilMemoryExists?: MemoryPredicate;
  untilTrajectoryEvent?: TrajectoryEventPredicate;
  timeoutMs?: number;
}

export type ParamPredicate =
  | { $eq: unknown }
  | { $ne: unknown }
  | { $gt: number } | { $gte: number } | { $lt: number } | { $lte: number }
  | { $in: unknown[] } | { $nin: unknown[] }
  | { $regex: string | RegExp }
  | { $exists: boolean }
  | { $contains: string }
  | Record<string, unknown>; // nested object = recursive match

export type FinalCheck =
  // Built-in structural checks (registered in final-check registry)
  | { type: "definitionCountDelta"; title: string; delta: number; /* ... LifeOps-compat fields */ }
  | { type: "reminderIntensity"; title: string; expected: string }
  | { type: "goalCountDelta"; title: string; delta: number }
  | { type: "memoryExists"; roomId?: string; content: Partial<MemoryContent> }
  | { type: "actionCalled"; actionName: string; status?: "success" | "failed"; minCount?: number }
  | { type: "draftCount"; account: string; delta: number; toMatches?: string | RegExp }
  | { type: "calendarEventCount"; account: string; delta: number; titleMatches?: string | RegExp }
  | { type: "reminderScheduled"; title: string; cadence?: string }
  | { type: "selfControlBlockActive"; profile: string; expected: boolean }
  | { type: "twilioMessageSent"; to: string; bodyMatches?: string | RegExp }
  // Custom predicate (TS)
  | { type: "custom"; name: string; predicate: (ctx: FinalCheckContext) => Promise<string | void> };
```

**Example scenario file (`test/scenarios/messaging.gmail/triage-high-priority-client.scenario.ts`):**

```ts
import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "gmail.triage.high-priority-client",
  title: "High-priority client DM triggers immediate response draft",
  domain: "messaging.gmail",
  tags: ["critical", "gmail", "triage", "draft"],

  requires: {
    credentials: ["gmail:test-agent"],
    plugins: ["@elizaos/plugin-gmail"],
  },
  isolation: "per-scenario",

  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],

  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "high-priority-client.eml",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "triage-request",
      room: "main",
      text: "Triage my inbox — anything I need to respond to right now?",

      expectedActions: ["TRIAGE_INBOX"],
      forbiddenActions: ["SEND_MESSAGE"],
      expectedActionParams: {
        TRIAGE_INBOX: { source: { $eq: "gmail" }, limit: { $gte: 1 } },
      },

      responseIncludesAny: ["urgent", "high priority"],
      responseJudge: {
        rubric:
          "Response names the high-priority client and explains why they're flagged urgent.",
        minimumScore: 0.7,
      },
      trajectoryTimeoutMs: 30_000,

      // Custom TS predicate — flexibility from TS-first
      assertTurn: (turn) => {
        const triage = turn.actionsCalled.find(
          (a) => a.actionName === "TRIAGE_INBOX",
        );
        if (!triage?.result?.data) return "TRIAGE_INBOX returned no data";
        const data = triage.result.data as { flagged: Array<{ priority: string }> };
        if (!data.flagged.some((f) => f.priority === "high")) {
          return "No high-priority item was flagged";
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "TRIAGE_INBOX",
      status: "success",
      minCount: 1,
    },
    {
      type: "draftCount",
      account: "test-owner",
      delta: 1,
      toMatches: /client@example\.com/,
    },
  ],

  cleanup: [
    { type: "gmailDeleteDrafts", account: "test-owner", tag: "eliza-e2e" },
  ],
});
```

**Schema additions beyond what either framework has today:**

- `requires.credentials` — declares which test accounts the scenario consumes. Runner skips scenario with clear reason if missing.
- `requires.plugins` / `requires.os` — ditto.
- `seed[]` — preconditions (email fixtures, calendar state, contact presence, to-do rows).
- `expectedActionParams` — per-action parameter predicates (uses `$gte/$lte/$eq/$regex/$in` MongoDB-style operators).
- `finalChecks[]` — extended with `memoryExists`, `draftCount`, `calendarEventCount`, `reminderScheduled`, `selfControlBlockActive`, `twilioMessageSent`, etc. Every integration gets its own check kind.
- `cleanup[]` — explicit teardown steps run even on failure.
- `tags[]` — for subset selection (`--tag critical`, `--tag gmail`).
- `isolation: per-scenario | shared | domain-shared` — domain-shared reuses runtime across scenarios in the same domain folder for speed.

### 3.2 Runner architecture

```
┌──────────────────────────┐
│  scenario.json / .ts     │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  ScenarioLoader           │  validates via Zod, resolves TS sidecar, expands templates
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  CredentialBroker         │  resolves "gmail:test-agent@…" → real creds from 1Password-backed secrets store
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  RuntimeFactory           │  creates AgentRuntime with PGLite + real LLM (selectLiveProvider) + required plugins
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  ActionInterceptor        │  (reused from convo-testing, promoted to shared lib)
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  SeedApplier              │  runs seed[] steps (insert emails, create calendar events, seed to-dos…)
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  TurnExecutor             │  per turn: send message or API call, collect response, wait for trajectories
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  Assertions (declarative) │  responseIncludes, expectedActions, expectedActionParams, judge
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  CustomPredicates (TS)    │  invoked if scenario.ts sidecar present
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  FinalChecks              │  DB state, integration state, memory state
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  CleanupRunner            │  runs cleanup[] even on failure via finally
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│  ScenarioReport (JSON)    │  written to reports/ + streamed to console + (optionally) GitHub Summary
└──────────────────────────┘
```

### 3.3 Package layout

New package: `eliza/packages/scenario-schema/`
- `src/schema.ts` — Zod schemas
- `src/types.ts` — inferred TS types
- `src/expand.ts` — template expansion
- `src/__tests__/schema.test.ts` — unit tests

New package: `eliza/packages/scenario-runner/`
- `src/loader.ts`
- `src/credentials.ts`
- `src/runtime-factory.ts`
- `src/interceptor.ts` (moved from convo-testing, now shared)
- `src/seed.ts`
- `src/turn-executor.ts`
- `src/assertions.ts` (moved from convo-testing, unified with lifeops)
- `src/final-checks/` (one file per check type)
- `src/cleanup.ts`
- `src/reporter.ts`
- `src/cli.ts` — `eliza scenarios run`

New top-level directory: `test/scenarios/` (workspace root).

Migration map:
- `eliza/apps/app-lifeops/scenarios/*.json` → `test/scenarios/lifeops.*/`
- `eliza/packages/app-core/test/convo-testing/scenarios/*.convo.test.ts` → `test/scenarios/convo.*/`
- Old runners deleted once cutover complete.

### 3.4 Data flow for a single scenario

1. Load JSON → validate → expand `{{now+1d}}` etc.
2. Resolve credentials: `gmail:test-agent@…` → real OAuth refresh token from secrets broker.
3. Create runtime with PGLite + required plugins + LLM provider. Install action interceptor.
4. Set up room(s) per `rooms[]`. Apply `seed[]`.
5. For each `turn`:
   a. Post user message OR execute API call.
   b. Wait for `handleMessage` to complete OR trajectory event matching expected action.
   c. Assert declaratively.
   d. If TS sidecar, invoke custom predicates.
6. Run `finalChecks[]`.
7. `finally`: run `cleanup[]`, tear down runtime, close DB.
8. Emit `ScenarioReport`.

---

## 4. Scenario library — scope

Target ~180 scenarios. Outlined here by domain; the authoritative catalog lives in `test/scenarios/_catalog.ts` and grows per-milestone.

### 4.1 Domain: `messaging.*` (~30 scenarios)

- `gmail.triage.*` — triage unread, rank by priority, skip promotions, group by thread. (6)
- `gmail.draft.*` — draft reply from context, draft follow-up, draft with attachment, draft in specific tone. (5)
- `gmail.send-with-confirmation.*` — send draft after user confirms, refuse to send without confirmation, cancel mid-flow. (3)
- `discord.local.*` — read recent DMs, reply to DM, ignore channel, set priority. (3)
- `telegram.local.*` — read recent, reply, mute a chat. (3)
- `twitter.dm.*` — read unread DMs, reply in-character, schedule reply. (3)
- `imessage.*` — read incoming, reply with confirmation, cross-reference contact, do-not-send guardrails. (3)
- `signal.*` — read recent, reply. (2)
- `whatsapp.*` — read, reply. (2)

### 4.2 Domain: `todos.*` (~20 scenarios)

- `todo.create.one-off`, `todo.create.recurring-daily`, `todo.create.weekly-weekday`, `todo.create.every-10-days` (Invisalign). (4)
- `todo.update.priority`, `todo.update.due`, `todo.complete`, `todo.delete`. (4)
- `todo.list.today`, `todo.list.upcoming`, `todo.list.overdue`. (3)
- `todo.routine.morning-checkin`, `todo.routine.night-checkin`. (2)
- `todo.forceful-reminder.*` — negative-case: agent should persist reminder if undone at scheduled time. (3)
- `todo.cross-device.*` — create on phone, see on Mac (simulated multi-device). (2)
- `todo.prioritize-deprioritize.*`. (2)

### 4.3 Domain: `reminders.*` (~15 scenarios)

- `reminder.vitamins.daily-morning`. (1)
- `reminder.invisalign-tray.every-10-days`. (1)
- `reminder.water.hourly-weekdays`. (1)
- `reminder.stretch.every-2-hours`. (1)
- `reminder.lifecycle.ack-complete`, `reminder.lifecycle.snooze`, `reminder.lifecycle.dismiss`. (3)
- `reminder.escalation.*` — escalate intensity if user doesn't respond. (3)
- `reminder.alarm.sets-ios-alarm` — sets actual iOS alarm on connected device. (1)
- `reminder.alarm.sets-macos-alarm` — *new* macOS alarm plugin. (1)
- `reminder.cross-platform.*` — reminder fires on Mac AND phone. (3)

### 4.4 Domain: `calendar.*` (~15 scenarios)

- `calendar.create.simple`, `calendar.create.with-prep-buffer`, `calendar.create.travel-time`. (3)
- `calendar.reschedule.*`, `calendar.cancel.*`. (3)
- `calendar.scheduling-with-others.ask-preferences` — *new feature*. (1)
- `calendar.scheduling-with-others.propose-times`. (1)
- `calendar.calendly.navigate` — *new feature*, uses browser plugin. (1)
- `calendar.dossier.prep-briefing` — *new feature*: dossier generated 24h before meeting. (1)
- `calendar.reminder.1hr-before`, `calendar.reminder.10min-before`, `calendar.reminder.on-the-dot`. (3)
- `calendar.defend-time.*` — refuses overlap, offers alternatives. (2)

### 4.5 Domain: `relationships.*` (~12 scenarios)

- `rolodex.add-contact`, `rolodex.search`, `rolodex.update-notes`. (3)
- `followup.track-overdue` — find contacts not messaged in N days. (2)
- `followup.daily-digest` — morning list of people to follow up with. (1)
- `followup.draft-cross-platform` — draft reply for same person on Gmail, Discord, Telegram. (3)
- `relationships.status-goals` — track relationship status + goals per person. (2)
- `relationships.import-from-platform` — pull contacts from Gmail/Twitter/Discord. (1)

### 4.6 Domain: `lifeops.habits.*` (~15 scenarios)

Already ~10 exist in JSON (brush teeth ×7, shower, shave, stretch, workout-blocker, invisalign, vitamins, water). Add:
- `habit.sit-ups-push-ups.daily-counts`. (1)
- `habit.morning-routine.full-stack`. (1)
- `habit.night-routine.full-stack`. (1)
- `habit.missed-streak.escalation`. (1)
- `habit.pause-while-traveling`. (1)

### 4.7 Domain: `goals.*` (~8 scenarios)

- `goal.sleep-basic` (exists). 
- `goal.relationship.*` — set relationship goals, track progress. (2)
- `goal.career.*`. (2)
- `goal.health.*`. (2)
- `goal.experience-loop` — evaluator reviews goal progress weekly. (1)

### 4.8 Domain: `selfcontrol.*` (~12 scenarios)

- `selfcontrol.block-websites.simple` (exists implicitly).
- `selfcontrol.block-until-task-complete` — block X.com until workout logged. (1)
- `selfcontrol.conditional-unblock.fixed-duration`. (1)
- `selfcontrol.block-apps.mobile` — requires iOS/Android companion. (2)
- `selfcontrol.harsh-mode` — no bypass even by user request until time elapsed. (1)
- `selfcontrol.self-set-enforcement.*` — agent asks, user confirms, agent enforces. (3)
- `selfcontrol.integration-with-todos` — auto-block socials if today's todos incomplete at noon. (1)
- `selfcontrol.nighttime-wind-down` — block apps after 10pm. (1)
- `selfcontrol.override-requires-auth` — bypass requires password/pairing. (1)

### 4.9 Domain: `browser.lifeops.*` (~10 scenarios)

*New browser extension required for most of these.*

- `lifeops-extension.time-tracking.per-site`. (1)
- `lifeops-extension.time-tracking.social-breakdown` — X/Instagram/FB separately. (1)
- `lifeops-extension.daily-report`. (1)
- `lifeops-extension.reports-to-agent-ui`. (1)
- `lifeops-extension.see-what-user-sees` — agent reads page context. (1)
- `1password-autofill.whitelisted-site` — *new*. (2)
- `1password-autofill.non-whitelisted-refused` — *new*. (1)
- `browser.computer-use.click-captcha-via-user`. (1)
- `browser.computer-use.agent-fails-calls-user-for-help`. (1)

### 4.10 Domain: `social.x.*` (~8 scenarios)

- `x.feed-summary.top-interesting`. (1)
- `x.search.topic-deep-dive`. (1)
- `x.never-visit.surface-content-in-chat`. (1)
- `x.dm.read-unread`. (1)
- `x.dm.reply-with-confirmation`. (1)
- `x.dm.group-chat-gateway`. (1)
- `x.post.with-confirmation`. (1)
- `x.refuse-banworthy-action`. (1)

### 4.11 Domain: `activity.*` (~6 scenarios)

*New WakaTime-like collector required.*

- `activity.per-app.today`. (1)
- `activity.per-app.weekly-average`. (1)
- `activity.per-site.social`. (1)
- `activity.context-aware-response` — agent knows what app user is in. (1)
- `activity.browser-extension-feeds-data`. (1)
- `activity.privacy-redaction`. (1)

### 4.12 Domain: `remote.*` (~8 scenarios)

*VNC/Tailscale + pairing code + iOS companion required.*

- `remote.pair.local-no-code`. (1)
- `remote.pair.remote-requires-code`. (1)
- `remote.vnc.start-session`. (1)
- `remote.vnc.revoke-session`. (1)
- `remote.agent-calls-for-help` — agent stuck, user receives call/ping. (1)
- `remote.mobile-controls-mac` — iOS sends input events. (1)
- `remote.sso-cloud.discord-login`. (1)
- `remote.sso-cloud.gmail-login`. (1)

### 4.13 Domain: `gateway.*` (~10 scenarios)

- `twilio.sms.receive-route-to-agent`. (1)
- `twilio.sms.send-from-agent-with-confirmation`. (1)
- `twilio.call.receive`. (1)
- `twilio.call.outbound-with-confirmation`. (1)
- `bluebubbles.imessage.receive`. (1)
- `bluebubbles.imessage.send-blue`. (1)
- `discord-gateway.bot-routes-to-user-agent`. (1)
- `telegram-gateway.bot-routes-to-user-agent`. (1)
- `whatsapp-gateway.bot-routes-to-user-agent`. (1)
- `billing.20-percent-markup-applied`. (1)

### 4.14 Domain: `cross-cutting.*` (~12 scenarios)

These are the action-verification and negative-case tests that span every plugin.

- `cross.negative.greeting-calls-no-action`. (1)
- `cross.negative.question-calls-no-action`. (1)
- `cross.action-selection.wrong-action-fails`. (1)
- `cross.multi-action-chain.create-todo-then-block-sites`. (1)
- `cross.parameter-extraction.complex-natural-language`. (1)
- `cross.ambiguity.agent-asks-clarifying-question`. (1)
- `cross.multi-turn.memory-across-turns`. (1)
- `cross.language.spanish-english-mixed`. (1)
- `cross.long-context.stays-on-task-after-10-turns`. (1)
- `cross.refuses-unsafe-action`. (1)
- `cross.confirms-destructive-action`. (1)
- `cross.failure-recovery.action-fails-agent-retries`. (1)

**Total: ~181 scenarios.**

---

## 5. Edge cases — must be covered

For every domain, these edge-case variants must appear at least once across the scenarios:

1. **Cancel mid-flow.** User says "actually, no" after agent proposes.
2. **Retry after failure.** Action fails (fake the failure), agent retries or asks.
3. **Ambiguous parameter.** User says "remind me about dentist" → agent asks "when?".
4. **Time-of-day edge.** User says "every day at 8" at 9pm (next occurrence tomorrow).
5. **Timezone.** User in Mountain Time says "3pm tomorrow" (scenario validates TZ).
6. **Non-English.** User messages in Spanish (scenario `brush-teeth-spanish` shows pattern).
7. **Missing context.** User says "message John" with 3 Johns in Rolodex.
8. **Long utterance.** User dumps a 500-word request; agent must extract correct intent.
9. **Wrong action requested.** User explicitly asks for action the agent shouldn't do (e.g., "send this to everyone in my contacts"); agent refuses or asks for confirmation.
10. **Cross-platform inconsistency.** Telegram message arrives while Discord scenario is running; both must route correctly.
11. **Concurrency.** Two user messages within 500ms; ordering preserved.
12. **Permission denied.** User lacks permission for a destructive action.
13. **Credentials missing.** Integration not set up; agent explains what to connect.
14. **Plugin disabled.** Action unavailable; agent says so rather than silently failing.
15. **LLM failure.** Model provider 429; runner retries up to `attempts`.

Runner-enforced: every scenario tagged with at least one edge-case tag from the list above, or explicitly marked `happy-path`.

---

## 6. Implementation scope (every MISSING/PARTIAL feature)

Ordered by priority; each unit has explicit deliverables. No stubs.

### P0 — required by ≥ 20 scenarios each

**6.1 Action parameter extraction + verification pipeline**
- *Gap:* Runtime captures actions but params verification isn't part of any test surface.
- *Deliverable:* Extend `HandlerOptions.parameters` tracing; expose `runtime.getActionResults(messageId)` uniformly; implement `expectedActionParams` matcher with MongoDB-style operators in USR.
- *Files:* `eliza/packages/core/src/runtime.ts` (expose plan), `eliza/packages/scenario-runner/src/assertions.ts`.

**6.2 Unified Scenario Schema + Runner package**
- Two new packages (`@elizaos/scenario-schema`, `@elizaos/scenario-runner`) per §3.3.
- Adapters: `lifeops-live-scenario-runner.ts` + `convo-testing/` delegate to new runner or are replaced.

**6.3 Rolodex / contacts core service**
- *Gap:* Only profile fields exist (`partnerName`, `relationshipStatus`). No contact CRUD with history, cross-platform ID merge, or follow-up tracking.
- *Deliverable:* `eliza/packages/core/src/features/relationships/` — full Contact entity with platform handles (`gmail`, `discord`, `telegram`, `twitter`, `signal`, `phone`, `imessage-id`). Actions: `ADD_CONTACT`, `UPDATE_CONTACT`, `SEARCH_CONTACTS`, `MERGE_CONTACTS`, `LIST_OVERDUE_FOLLOWUPS`. Provider: `relationshipsProvider` exposes context to agent.
- *Schema:* new PGLite tables `contacts`, `contact_handles`, `contact_interactions`, `followup_rules`.

**6.4 Follow-up tracker service**
- Depends on Rolodex. Service runs hourly, finds contacts where `now - last_interaction_at > followup_rule.threshold`, writes digest memory for morning check-in.
- Actions: `RECORD_INTERACTION`, `LIST_OVERDUE_FOLLOWUPS`, `DRAFT_FOLLOWUP`.

**6.5 Message triage v2 — cross-platform**
- *Gap:* `inbox-triage.ts` exists but Gmail-only.
- *Deliverable:* Promote to `eliza/packages/core/src/features/messaging/triage/`. Unified `MessageRef = { source, externalId, contact, channel, text, receivedAt }`. Triage scoring operates over all connected sources. Action: `TRIAGE_MESSAGES`.

**6.6 Calendar: scheduling-with-others**
- *Gap:* CRUD exists; no proposal, availability, preferences.
- *Deliverable:* Actions `PROPOSE_MEETING_TIMES`, `CHECK_AVAILABILITY`, `UPDATE_MEETING_PREFERENCES`. Service stores user's preferred times / blackout windows.

**6.7 Meeting dossier generator**
- *Gap:* Missing entirely.
- *Deliverable:* Service runs 24h, 1h before every calendar event. Gathers: attendee Rolodex data, recent messages with attendees, linked docs, prior meeting notes. Writes memory + UI widget. Action: `GENERATE_DOSSIER`.

**6.8 Website blocker chat integration**
- *Gap:* SelfControl exists; need action-level integration with todo completion.
- *Deliverable:* Action `BLOCK_UNTIL_TASK_COMPLETE` (existing SelfControl + todo observer). Service: `block-rules` table, reconciler cron.

### P1 — required by 5–20 scenarios each

**6.9 Travel-time awareness**
- *Deliverable:* New service `travel-time-service.ts`. Integrates Apple/Google Maps via browser plugin. Action: `COMPUTE_TRAVEL_BUFFER`. Calendar action `CREATE_MEETING_WITH_TRAVEL` wraps event creation + blocks travel time.

**6.10 macOS native alarm**
- *Gap:* No alarm integration.
- *Deliverable:* `eliza/packages/native-plugins/macosalarm/` — Swift helper app (similar to SelfControl helper) that schedules NSUserNotifications with sound. Action `SET_ALARM_MACOS`.

**6.11 iOS native alarm + companion app skeleton**
- *Deliverable:* Capacitor-wrapped iOS app with push notification support and an intent-receiver for alarm, reminder, block. Minimum viable companion: accepts deep links from agent and shows a chat mirror.

**6.12 Activity tracker (WakaTime-like)**
- *Deliverable:* macOS agent service (existing activity-profile package) + new collector: `AppFocusCollector` (uses `NSWorkspace` notifications), writes to `app_activity_events` table. Provider `activityProvider` exposes summary. Actions: `GET_ACTIVITY_REPORT`, `GET_TIME_ON_SITE`.

**6.13 Browser extension: LifeOps**
- *Deliverable:* Chrome + Safari extension. Responsibilities: (a) per-tab time tracking, (b) agent context feed (current URL, title, selection), (c) field autofill injection via 1Password/ProtonPass. Bidirectional channel to desktop agent via native messaging or local WebSocket.

**6.14 1Password / ProtonPass autofill**
- *Deliverable:* Integration within the browser extension. Whitelist stored in `autofill_whitelist` table + a default `popular-sites.json`. Action: `AUTOFILL_FIELD` (extension-side). Agent-side: `REQUEST_FIELD_FILL`.

**6.15 Twitter/X feed summarization**
- *Gap:* `service-mixin-x.ts` is post-oriented.
- *Deliverable:* Actions `FETCH_FEED_TOP`, `SEARCH_X`, `SUMMARIZE_FEED`. Via API where possible; browser plugin fallback.

**6.16 Calendly navigation**
- *Deliverable:* `eliza/plugins/plugin-calendly/` — browser-plugin-backed flow. Action: `BOOK_CALENDLY_SLOT`.

**6.17 GitHub full integration**
- *Gap:* Only cloud route reference.
- *Deliverable:* `@elizaos/plugin-github` actions: `LIST_PRS`, `REVIEW_PR`, `CREATE_ISSUE`, `ASSIGN_ISSUE`, `GITHUB_NOTIFICATION_TRIAGE`.

### P2 — required by < 5 scenarios each

**6.18 VNC / remote-control data plane**
- *Deliverable:* macOS-side: tunnel through Eliza Cloud (Tailscale alternative). Pairing code flow exists; add session lifecycle. Electrobun webview on iOS side for viewer.

**6.19 Tailscale routing option**
- *Deliverable:* Optional alternative path to Eliza Cloud tunnel. `connectors/tailscale` config.

**6.20 iOS remote companion — full UX**
- *Deliverable:* Beyond P1 skeleton: VNC viewer, input relay, push-triggered session start, pairing QR.

**6.21 Eliza Cloud phone gateway billing markup**
- *Deliverable:* `cloud/packages/services/billing/src/markup.ts` — 20% markup on Twilio/BlueBubbles passthrough. Admin route to see per-user cost + markup.

**6.22 Twilio calling (inbound + outbound with confirmation guardrails)**
- *Gap:* SMS exists; calling unclear.
- *Deliverable:* Action `CALL_USER`, `CALL_EXTERNAL` (gated on confirmation). Inbound webhook routes call audio to agent voice-mode (future work: voice plugin).

**6.23 Morning/night check-in routine engine**
- *Gap:* Routine time-windows defined; no forceful check-in logic.
- *Deliverable:* Service `checkin-service.ts`. Cron fires at user-configured morning/night. Pulls overdue todos, overdue followups, today's meetings, yesterday's wins. Action: `RUN_MORNING_CHECKIN`, `RUN_NIGHT_CHECKIN`. Persistence: escalates tone if user ignores.

**6.24 Cross-device intent bus**
- *Deliverable:* `cloud/packages/services/device-bus/` — agent publishes `intent.alarm.set` etc; devices subscribe and realize (set local alarm, push notification, etc). Device registry + online presence.

### Totals

- **P0:** 8 units.
- **P1:** 9 units.
- **P2:** 7 units.
- **Total: 24 implementation units**, each a named subproject with its own deliverable. These are the minimum for all 181 scenarios to pass.

---

## 7. Test-account / credential strategy

Real services + dedicated test accounts per the user's choice. Details:

### 7.1 Accounts to provision

| Service | Account identifier | Purpose | Owner |
|---|---|---|---|
| Gmail | `eliza-e2e-owner@…` and `eliza-e2e-agent@…` | Owner's mailbox + agent mailbox | Eng |
| Google Workspace | Same domain | Calendar, Contacts | Eng |
| GitHub | `eliza-e2e-user` + `eliza-e2e-agent` | Repo ops | Eng |
| Discord | Test user + test bot app | DMs + server ops | Eng |
| Telegram | Test phone number + test bot | DMs + bot | Eng |
| Twitter/X | Test handle + test API app | Feed + DMs | Eng |
| Signal | Test phone number | DMs | Eng |
| WhatsApp Business | Test phone number | DMs | Eng |
| Twilio | Dedicated test phone number(s) | SMS + Voice | Eng |
| BlueBubbles | Dedicated Mac mini + Apple ID | iMessage | Eng |
| 1Password | E2E test vault | Autofill | Eng |
| Calendly | Test host | Scheduling-with-others | Eng |
| Apple Developer | For iOS companion | Push, APNs | Eng |

### 7.2 Credential storage & rotation

- **Source of truth:** 1Password vault `eliza-e2e`. All creds as items with `ELIZA_E2E_<SERVICE>_<FIELD>` tags.
- **CI access:** GitHub Actions secrets `ELIZA_E2E_*`, pushed via 1Password CLI in a monthly rotation workflow.
- **Local dev:** `bun run scenarios:creds:pull` uses `op` to fetch into `.env.scenarios`. `.gitignore`d.
- **Runner:** `CredentialBroker` (§3.2) resolves `"gmail:test-agent"` → env var lookup → real creds.
- **Redaction:** Scenario reports scrub anything matching `ELIZA_E2E_*` values before upload.

### 7.3 Side-effect isolation

- **Gmail:** Labels applied to anything the agent sends (`eliza-e2e`). Cleanup sweep deletes labeled items after each run.
- **Calendar:** Events created with prefix `[e2e]` + unique run ID. Sweep deletes at run end.
- **Twilio:** Rate-limited sandbox number + per-scenario recipient whitelist (only other test numbers).
- **iMessage:** Via BlueBubbles to a dedicated test Apple ID on a dedicated Mac mini. Recipients limited to paired test numbers.
- **SelfControl:** Ephemeral blocks with `e2e-` tag; helper cleans up on scenario end.
- **GitHub:** Dedicated test repo per scenario; deleted post-run.
- **Discord/Telegram/Signal/WhatsApp:** Dedicated test servers/channels.

### 7.4 Cleanup contract

Every scenario MUST:
- Declare `cleanup[]` in JSON.
- Runner runs cleanup in `finally`, even on failure.
- A global "orphan sweeper" runs nightly, checks each integration for `e2e-*` artifacts older than 24h, deletes them. Sweeper reports count to CI summary.

---

## 8. CI plan

Full matrix runs on **`develop` post-merge**, not every PR. PRs run a small fast subset of ~15 critical scenarios to catch major regressions cheaply.

```
PR opened / updated                          develop branch push
     │                                             │
     ▼                                             ▼
┌──────────────────┐                  ┌───────────────────────────┐
│ regression-matrix│                  │ scenario-matrix (FULL)     │
└────────┬─────────┘                  │   8 shards, ~181 scenarios │
         │                            │   macos self-hosted + ubuntu│
         ▼                            └───────────┬────────────────┘
┌──────────────────────┐                          │
│ scenario-matrix      │                          ▼
│   ONLY tag=critical  │               ┌──────────────────┐
│   ~15 scenarios      │               │ nightly-regression│
│   single shard       │               │  5x hardening run │
│   Groq only          │               │  flake tracking   │
└──────────┬───────────┘               └──────────────────┘
           │
           ▼
    post PR summary
```

### 8.1 Execution budget

**On `develop` (full matrix):**
- 181 scenarios × avg 90s = 4.5h single-threaded.
- 8 shards × parallel = ~45 min wall time worst case.
- Per-scenario timeout 300s.
- LLM cost at Groq: ~$0.002 × 181 = **~$0.36 per develop push**. If develop gets ~20 pushes/day, ~$7/day = ~$210/month. Acceptable.

**On PRs (critical subset only):**
- ~15 scenarios × avg 90s = ~22 min single-threaded.
- 2 shards parallel = ~11 min wall time.
- LLM cost: ~$0.03 per PR. Negligible.

- Fallback providers: if Groq rate-limited, fall back to OpenAI/Anthropic; runner tracks per-provider usage.

### 8.2 Flake policy

- Auto-retry once on pass; if first attempt fails and second passes, scenario is marked "flaky-passed" (yellow, doesn't block PR).
- ≥ 3 flaky-passed in one PR blocks with actionable error.
- Nightly job hard-runs every scenario 5x and computes flake rate per scenario; scenarios > 10% flake are auto-bugged.

### 8.3 macOS runner

- Mac mini self-hosted runner in dedicated network.
- Pre-configured with: Xcode, SelfControl binary, BlueBubbles, test Apple ID, 1Password CLI, Tailscale.
- Persistent worker pool (3–5 runners) to avoid cold-start per PR.

### 8.4 Skip conditions

- Scenario with `requires.os: macos` on a non-mac runner → skip with reason.
- Scenario with `requires.credentials: ["gmail:test-agent"]` and env missing → skip with reason.
- Skip must be explicit and counted; too many skips (> 5%) on a PR fails the job.

---

## 9. Observability

Every scenario produces a `ScenarioReport`:

```typescript
interface ScenarioReport {
  id: string;
  title: string;
  status: "passed" | "failed" | "skipped" | "flaky-passed";
  durationMs: number;
  providerName: string;
  startedAt: string;
  turns: ScenarioTurnReport[];
  finalChecks: { label: string; status: "passed" | "failed"; detail: string }[];
  actionsCalled: CapturedAction[];
  llmCallCount: number;
  llmTokensIn: number;
  llmTokensOut: number;
  cost: { provider: string; usd: number };
  cleanup: { step: string; status: "succeeded" | "failed"; error?: string }[];
  error?: string;
}
```

Reports aggregate into `ScenarioMatrixReport` per shard, then into a PR-level summary posted as a comment:

```
Eliza Scenario Matrix
  ✅ 176 passed  ⚠️ 3 flaky-passed  ❌ 2 failed  ⏭️ 0 skipped
  Duration: 44m 12s
  LLM cost: $0.38 (Groq 98%, OpenAI 2%)

Failures:
  ❌ calendar.scheduling-with-others.ask-preferences (turn 2)
     judge score 0.61 < 0.7 — agent didn't reference user's preferred times
  ❌ selfcontrol.harsh-mode (final check)
     expected selfControlBlockActive=true, got false

Flaky (passed on retry):
  ⚠️ gmail.triage.high-priority-client
  ⚠️ twitter.dm.read-unread
  ⚠️ reminder.escalation.intensity-up
```

---

## 10. Milestones & sequencing

Chose milestone gating over big-bang. Each milestone is independently shippable and provides measurable value.

### Milestone 0 — Decision & inventory (Week 0)
- This document reviewed & approved.
- Create `eliza-e2e` 1Password vault + all accounts in §7.1.
- Fill out unknowns in §12.

### Milestone 1 — Unified runner (Week 1–3)
- `@elizaos/scenario-schema` package + Zod schema + tests.
- `@elizaos/scenario-runner` package + all assertion kinds + action interceptor promoted + credential broker.
- Port all 23 LifeOps JSON scenarios to new schema → runner passes them.
- Port both convo test scenarios → runner passes them.
- Old runners marked deprecated.
- CI: new `test:scenarios` command; not yet on PR gate.

### Milestone 2 — Cross-cutting action verification (Week 3–4)
- 12 `cross-cutting.*` scenarios authored & passing.
- `expectedActionParams` predicate shipped.
- Negative-case coverage.
- Still not yet on PR gate.

### Milestone 3 — P0 implementation units + scenarios (Week 4–8)
- Ship P0 units 6.1–6.8 in §6.
- Author scenarios in domains that depend on them: messaging, todos, reminders, calendar base, relationships.
- ~80 scenarios live.
- Enable PR gate with these scenarios only.

### Milestone 4 — P1 implementation (Week 8–14)
- Ship P1 units 6.9–6.17.
- Scenarios for meeting dossiers, travel-time, macOS alarm, iOS alarm skeleton, activity tracker, browser extension, 1Password autofill, Twitter summarization, Calendly, GitHub.
- ~150 scenarios live.

### Milestone 5 — P2 implementation + full matrix (Week 14–20)
- Ship P2 units 6.18–6.24.
- VNC/Tailscale, iOS companion UX, cloud markup, Twilio call, check-in engine, device bus.
- All 181 scenarios live.
- PR gate = full matrix.

### Milestone 6 — Harden & remove old code (Week 20–22)
- Old runners deleted.
- Flake rate < 2% across matrix.
- Scenario-authoring docs published.
- Team workshop on authoring new scenarios.

**Total duration: ~22 weeks (~5 months)** assuming 1–2 engineers full-time. Real dates depend on staffing.

---

## 11. Definition of done (per scenario, per milestone, per project)

**Per scenario:**
- Scenario JSON validates against schema.
- Passes on clean local run.
- Passes in CI on three consecutive main-branch runs.
- Has at least one edge-case tag.
- Cleanup runs verified.
- Action invocations asserted where applicable.

**Per implementation unit (§6):**
- Actions defined with full `examples[]`, `description`, `validate`, `handler` meeting architecture rules (CLAUDE.md).
- Providers/services defined where needed.
- At least two scenarios exercise the unit.
- Unit tests on the handler logic (not just the scenario).

**Per milestone:**
- All scenarios in scope pass in CI for 3 consecutive runs.
- No new flakes introduced.
- Runtime API documented.
- Migration path for any breaking changes documented.

**Per project:**
- All 181 scenarios green.
- Old scenario frameworks deleted.
- Full matrix on PR gate as default.
- Flake rate < 2%.
- Authoring docs + examples.
- Orphan-sweeper in production for 7 consecutive days clean.

---

## 12. Open questions / unknowns (resolve before Milestone 3)

1. **macOS self-hosted runners:** where do they live, who owns their maintenance? Apple ID for iMessage is the critical item.
2. **1Password E2E vault access model:** service-account + SSH key vs CI-only token? Who rotates?
3. **Twilio test numbers:** how many, and what compliance/approval is needed for outbound calls?
4. **Apple Developer account:** Which team, and who owns provisioning profiles for the iOS companion?
5. **Calendly test host:** organization account with multiple hosts, or single-host free tier?
6. **GitHub Actions pricing:** self-hosted macOS runners are free, but Ubuntu shards on GitHub-hosted will add up. Acceptable budget?
7. **Cleanup race conditions:** two scenarios running against the same test Gmail mailbox — is per-scenario Gmail labels enough, or do we need per-scenario aliases (`+e2e-<runid>@…`)?
8. **LLM provider neutrality:** does the matrix have to pass on all three providers (Groq/OpenAI/Anthropic) or only the "primary"? Affects quota and flake rate.
9. **Billing markup scope:** is the 20% already in the billing service and we're just missing the test, or is the service itself missing? Audit found no markup code but billing service is rich — needs code-level confirmation.
10. **Scenario authoring tooling:** do we want a `scenario init` CLI that scaffolds a JSON from a live recorded conversation? Nice-to-have but saves time if authored well.

---

## 13. What is NOT in this plan

Explicitly excluded so there's no surprise:

- Voice input/output (no STT/TTS in current plugins). Twilio call scenarios test the routing, not the voice content.
- Multi-user tenancy beyond single-owner (the product today is single-user-per-agent; tests follow).
- Mobile OS lifecycle testing (iOS/Android test automation is a separate project).
- Third-party Calendly programmatic write (only navigational read supported initially).
- Performance/load testing (scenarios validate correctness; perf is separate).
- Security/pen-testing of remote-control data plane (separate hardening track).

---

## 14. Summary

- **Current state:** Two scenario frameworks (LifeOps JSON, Convo TS), ~25 existing scenarios, 152+ actions, 22 features existing / 9 partial / 5 missing vs. the vision in the recordings.
- **Target:** One unified scenario schema, ~181 scenarios across 14 domains, all 24 missing/partial implementation units built, full matrix on every PR against real sandboxed services.
- **Work shape:** 6 milestones, ~22 weeks, 24 implementation units, 181 scenarios, 8-way sharded CI with macOS self-hosted runners, dedicated test accounts in a 1Password vault.
- **Authority:** Everything in this plan is driven by explicit user choices (unify, implement everything, full matrix on PR, real accounts). Deviations need a new decision.

**Ready for review.**
