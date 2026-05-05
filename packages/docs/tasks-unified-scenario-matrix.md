# Task Breakdown — Unified Scenario Matrix

Source: `docs/plan-unified-scenario-matrix.md`.
Each task below is ready to be dispatched to a subagent, or executed directly, with a complete prompt.

## Dependency graph

```
T1 (schema package)
  │
  ├─→ T2 (runner package skeleton)    ──→ T3 (runner execution loop)
  │     │                                    │
  │     └─→ T2c (credential broker)           ├─→ T4a (port convo scenarios)
  │                                           ├─→ T4b (port lifeops scenarios)
  │                                           └─→ T5a..T5n (author new scenarios per domain)
  │
  └─→ T6 (action catalog doc)            ──→ T5a..T5n

T7 (P0 impl units) ──→ T5* scenarios dependent on those units
T8 (P1 impl units) ──→ T5* scenarios dependent on those units
T9 (P2 impl units) ──→ T5* scenarios dependent on those units

T10 (CI wiring: develop full + PR subset)
T11 (credential / test-account provisioning playbook)
T12 (orphan sweeper)
T13 (cleanup + delete old runners)
```

## Wave 1 — Foundation (sequential within the wave)

### T1 — scenario-schema package

**Prompt:**

> Create `eliza/packages/scenario-schema/` — a new workspace package that defines the canonical TypeScript-first scenario schema for the Eliza scenario matrix. Read the plan at `docs/plan-unified-scenario-matrix.md` §3.1 for the full schema. Deliverables:
>
> 1. `package.json` with name `@elizaos/scenario-schema`, version `0.0.1`, `"private": true`, workspace-compatible.
> 2. `src/types.ts` — exported TS interfaces: `Scenario`, `Turn` (discriminated union of `MessageTurn`, `ApiTurn`, `WaitTurn`), `SeedStep`, `FinalCheck` (discriminated union, include `custom` variant with async predicate), `CleanupStep`, `ParamPredicate` (MongoDB-style operators), `MemoryPredicate`, `TrajectoryEventPredicate`, `TurnResult`, `CapturedAction` (move from convo-testing), `ScenarioReport`, `FinalCheckContext`. No `any`/`unknown`. Every field must be typed.
> 3. `src/schema.ts` — a Zod schema equivalent that validates declarative parts at runtime. Custom function fields (`assertResponse`, `predicate`, etc.) are marked as runtime-validated. Export `validateScenario(input): Scenario`.
> 4. `src/template.ts` — template expansion: `{{now}}`, `{{now+1d}}`, `{{now-30m}}`, `{{now+Xh}}`, `{{definitionId:title}}`, `{{occurrenceId:title}}`. Extract logic from `eliza/plugins/app-lifeops/test/helpers/lifeops-live-scenario-runner.ts` (it's already implemented — move it). Function signature: `expandTemplates(scenario, context): Scenario`.
> 5. `src/builder.ts` — export a `scenario(def)` helper that accepts a Scenario literal, validates it, and returns it typed. This is the entry point authors use.
> 6. `src/param-matcher.ts` — implement `matchParamPredicate(value, predicate)` supporting `$eq`, `$ne`, `$gt/$gte/$lt/$lte`, `$in`, `$nin`, `$regex`, `$exists`, `$contains`, nested object predicates (recursive). Returns `{ match: boolean, path?: string, reason?: string }`.
> 7. `src/final-check-registry.ts` — registry pattern: `registerFinalCheck(type, handler)`, `getFinalCheckHandler(type)`. The built-in check handlers themselves live in `@elizaos/scenario-runner` (depends on runtime); the registry is here so schema knows the type list.
> 8. `src/index.ts` — re-exports.
> 9. `src/__tests__/schema.test.ts` — unit tests for Zod validation, template expansion, param matcher (every operator). Use vitest config from the repo root — follow the existing pattern (`@elizaos/plugin-sql` PGLite pattern if any DB is touched; no SQL mocks — but schema package should have no DB at all).
> 10. `tsdown.config.ts` if the repo uses tsdown; else match the existing package build setup.
>
> Constraints (from CLAUDE.md and AGENTS.md):
> - No `any`, no `unknown` except at narrow validated boundaries.
> - No stubs or placeholder code. No TODO comments except ones linked to a specific follow-up task ID.
> - No logger usage in this package — it's pure types + functions. (`logger` only gets used in the runner.)
> - All exported types required-by-default (`?:` only when genuinely nullable).
>
> Also add `eliza/packages/scenario-schema` to the workspace config (root `package.json` `workspaces` field or `pnpm-workspace.yaml` / `bun` workspace — inspect the repo).
>
> When done, verify with `bun run build` on the package and `bunx vitest run eliza/packages/scenario-schema/src/__tests__`. Report back the files created and test output.

### T2 — scenario-runner package

**Prompt:**

> Create `eliza/packages/scenario-runner/` — the runtime that executes scenarios produced by `@elizaos/scenario-schema`. Read `docs/plan-unified-scenario-matrix.md` §3.2 and §3.3 for the full architecture.
>
> Structure:
> ```
> eliza/packages/scenario-runner/
>   package.json            # name: @elizaos/scenario-runner, depends on @elizaos/scenario-schema, @elizaos/core
>   src/index.ts
>   src/loader.ts           # loadScenarioFile(path) → Scenario; loadJsonScenario(path) for legacy imports
>   src/credentials.ts      # CredentialBroker: resolves "gmail:test-agent" → real creds from env
>   src/runtime-factory.ts  # createScenarioRuntime(scenario) → AgentRuntime (PGLite + LLM + plugins)
>   src/interceptor.ts      # Action interceptor — migrated from eliza/packages/app-core/test/convo-testing/action-interceptor.ts. Must be byte-compatible behavior; this is the ONLY interceptor going forward.
>   src/seed/               # seed step handlers (gmailInbox, calendarEvents, todos, contacts, ...)
>   src/seed/index.ts       # registerSeedHandler / runSeed
>   src/turn-executor.ts    # executes a single Turn: message | api | wait
>   src/assertions.ts       # responseIncludesAll/Any/Excludes, judge, plannerIncludes...  Use tokenization from lifeops-live-scenario-runner.ts.
>   src/final-checks/       # one file per check type
>   src/final-checks/index.ts  # registers them all with the registry
>   src/cleanup.ts          # runs cleanup[] in finally
>   src/judge.ts            # judgeTextWithLlm — migrate from lifeops-live-judge.ts
>   src/reporter.ts         # ScenarioReport writer; JSON + console + optional GitHub Actions summary
>   src/executor.ts         # runScenario(scenario, opts) — top-level entry point
>   src/cli.ts              # bin: eliza-scenarios run <files…> [--tag …] [--shard N/M]
>   src/__tests__/          # unit tests for every non-trivial file
> ```
>
> Behavior:
> - `runScenario(scenario)` creates a runtime (PGLite + real LLM via `selectLiveProvider`), installs the interceptor, runs seed, iterates turns (respecting `kind`), runs final checks, runs cleanup in finally, returns `ScenarioReport`.
> - Isolation modes: `per-scenario` (new runtime each), `shared` (reuse), `domain-shared` (reuse across same-domain scenarios). Implementation: accept an optional `sharedRuntime` argument; `executor` may pool them.
> - CredentialBroker: static identifier format `service:tag` (e.g. `"gmail:test-agent"`). Looks up env vars following convention `ELIZA_E2E_GMAIL_TESTAGENT_*`. Returns a `Credentials` object or throws `MissingCredentialsError`. Runner catches and marks scenario `skipped` with reason.
> - Reporter: outputs to `reports/scenarios/<runId>/<scenarioId>.json` and a human transcript to stdout. In GitHub Actions, append to `$GITHUB_STEP_SUMMARY`.
> - All built-in final-check handlers implemented in `src/final-checks/` using `registerFinalCheck` from schema. Handlers for: `definitionCountDelta`, `reminderIntensity`, `goalCountDelta` (migrate from lifeops runner), `memoryExists`, `actionCalled`, `draftCount` (no-op for now, expects external gmail adapter), `calendarEventCount`, `reminderScheduled`, `selfControlBlockActive`, `twilioMessageSent`. For integrations whose backend isn't ready yet, the handler lives here but calls into an adapter interface that throws "not yet implemented: waiting on T7-GMAIL" — those get wired up as the integrations land.
> - Tests: every assertion type and final-check type has at least one unit test.
>
> Constraints per CLAUDE.md: logger only (no console), no `any`, required-by-default DTOs, CQRS for any DB touches.
>
> When done, verify with:
> - `bun run build` on the package
> - `bunx vitest run eliza/packages/scenario-runner/src/__tests__`
> - A smoke scenario — write a minimal `echo-smoke.scenario.ts` that sends "hello" and expects a non-empty response. Run it end-to-end with `bun eliza/packages/scenario-runner/src/cli.ts run <path>` and confirm report is written.
>
> Report back: files created, test output, smoke-scenario output.

### T2c — Credential broker (folded into T2 above)

## Wave 2 — Parallel once foundation exists

### T4a — Port convo-testing scenarios to unified runner

**Prompt:**

> Port the two existing scenarios in `eliza/packages/app-core/test/convo-testing/scenarios/` to the new unified scenario format at `test/scenarios/convo/`:
> - `echo-self-test.convo.test.ts` → `test/scenarios/convo/echo-self-test.scenario.ts`
> - `greeting-dynamic.convo.test.ts` → `test/scenarios/convo/greeting-dynamic.scenario.ts`
>
> Use the `scenario()` builder from `@elizaos/scenario-schema`. Preserve exact semantics (same expected actions, same assertions).
>
> The `greeting-dynamic.convo.test.ts` uses the dynamic/LLM-driven mode. For this first port, convert it to a scripted scenario — we'll re-add dynamic mode in a later task (T4c). Capture the original dynamic semantics as a TODO comment with the task ID.
>
> After porting, run the new scenarios via `eliza-scenarios run test/scenarios/convo/` and confirm they pass.
>
> Do NOT delete the original files yet — rename them to `*.ported.ts` and leave them for visual diffing; final removal happens in T13.

### T4b — Port LifeOps JSON scenarios to unified runner

**Prompt:**

> Port all 23 JSON scenarios in `eliza/plugins/app-lifeops/scenarios/*.json` to TypeScript scenarios at `test/scenarios/lifeops/`. Preserve exact semantics — every turn, every final check, every judge rubric.
>
> Read `docs/plan-unified-scenario-matrix.md` §3.1 for the TS schema. Use the `scenario()` builder.
>
> For each JSON file:
> 1. Read it (see the 23 filenames under `eliza/plugins/app-lifeops/scenarios/`).
> 2. Translate each `turn` to a `MessageTurn` or `ApiTurn` based on whether it has `text` or `apiRequest`.
> 3. Translate `finalChecks` to the matching `FinalCheck` variants. The `definitionCountDelta`, `reminderIntensity`, `goalCountDelta` types already exist in the schema.
> 4. Place the resulting `.scenario.ts` under `test/scenarios/lifeops/<original-id>.scenario.ts`.
>
> After porting, run the matrix with `eliza-scenarios run test/scenarios/lifeops/` and confirm every scenario still passes against a live runtime (provider selected via `selectLiveProvider()`). Use `ELIZA_LIVE_TEST=1 ELIZA_LIVE_CHAT_TEST=1 ELIZA_LIVE_SCENARIO_TEST=1`.
>
> Do NOT delete the original JSON files. They become the reference fixture set loaded by `loadJsonScenario()` if anyone still wants to author in JSON. Mark them read-only via a note in `eliza/plugins/app-lifeops/scenarios/README.md`.

### T6 — Action catalog reference doc

**Prompt:**

> Produce `docs/action-catalog.md` — an exhaustive, organized reference of every registered Action in the eliza runtime. Scenario authors will consult this when writing `expectedActions` and `expectedActionParams`.
>
> For each action, include:
> - Name
> - Plugin / file path
> - Description (one line)
> - Parameters declared in the action's `parameters?: ActionParameter[]` field, including name, type, required-or-not, and description
> - Similes
> - Whether it returns `ActionResult.data` and the shape of that data (if observable from the handler's return statements)
>
> Group by domain. At minimum cover: core (basic, advanced, clipboard, trust, plugin-manager, planning, secrets, memory), plugin-agent-orchestrator, plugin-music-*, plugin-wallet, plugin-discord, plugin-shopify, TaskService/triggers (scheduling), plugin-computeruse, plugin-commands, plugin-gmail, plugin-calendar, plugin-telegram, plugin-twitter, plugin-signal, plugin-whatsapp, plugin-imessage, plugin-bluebubbles, plugin-twilio, lifeops-specific actions.
>
> Start with a quick stats header: total count, count by domain, count without tests, count without examples[].
>
> This is a read-only research task — no code changes required.

## Wave 3 — Scenario authoring (parallelizable per domain)

Each of T5a through T5n corresponds to one domain folder. Each is dispatchable in parallel once Waves 1 and 2 are done.

### T5a — `messaging.gmail` scenarios (6 scenarios)

**Prompt:**

> Author 6 scripted TypeScript scenarios at `test/scenarios/messaging.gmail/`:
>
> 1. `triage-unread.scenario.ts` — user: "Triage my unread email". Expected: `TRIAGE_INBOX` action; response mentions count + priority breakdown; `actionCalled` final check.
> 2. `triage-high-priority-client.scenario.ts` — as shown in `plan-unified-scenario-matrix.md` §3.1 example.
> 3. `draft-reply-from-context.scenario.ts` — seed: recent email from "Alice". User: "Draft a reply to Alice's last email". Expected: `DRAFT_REPLY` action; draft body references the seeded email; `draftCount` +1.
> 4. `draft-followup.scenario.ts` — seed: email sent 14 days ago, no response. User: "Draft a follow-up to anyone I haven't heard back from". Expected: `DRAFT_FOLLOWUP` action.
> 5. `send-with-confirmation.scenario.ts` — user draft exists. User: "Send it". Expected: agent asks confirmation, user says yes, agent sends. Two turns. Forbidden action `SEND_MESSAGE` on turn 1.
> 6. `refuse-send-without-confirmation.scenario.ts` — user: "Email everyone in my contacts 'hi'". Expected: agent refuses or asks confirmation. `forbiddenActions: ["SEND_MESSAGE"]`.
>
> Requirements:
> - Every scenario: tags include at least one of the 15 edge-case tags from §5 of the plan.
> - Every scenario: `requires.credentials: ["gmail:test-agent"]`, `requires.plugins: ["@elizaos/plugin-gmail"]`.
> - Every scenario: `cleanup[]` entries delete anything the scenario created (drafts, labels).
> - Every scenario: runnable via `eliza-scenarios run test/scenarios/messaging.gmail/<id>.scenario.ts`.
>
> If the underlying Gmail actions don't yet implement the behavior needed (e.g. triage returns nothing useful), the scenario still authored BUT tagged `waiting-on:T7-gmail-triage-v2` and skipped until that task lands.

### T5b — `messaging.discord-local` (3)
Similar structure; see §4.1 of the plan for the scenario list.

### T5c — `messaging.telegram-local` (3)

### T5d — `messaging.twitter-dm` (3)

### T5e — `messaging.imessage` (3)

### T5f — `messaging.signal` (2)

### T5g — `messaging.whatsapp` (2)

### T5h — `todos.*` (20)

Per §4.2. Subdivide into: create (4), update/complete/delete (4), list (3), routine (2), forceful-reminder (3), cross-device (2), prioritize (2).

### T5i — `reminders.*` (15)

Per §4.3.

### T5j — `calendar.*` (15)

Per §4.4.

### T5k — `relationships.*` (12)

Per §4.5.

### T5l — `lifeops.habits.*` (5 new)

Per §4.6 — 10 already ported in T4b; only 5 new ones.

### T5m — `goals.*` (8)

Per §4.7.

### T5n — `selfcontrol.*` (12)

Per §4.8.

### T5o — `browser.lifeops.*` (10)

Per §4.9.

### T5p — `social.x.*` (8)

Per §4.10.

### T5q — `activity.*` (6)

Per §4.11.

### T5r — `remote.*` (8)

Per §4.12.

### T5s — `gateway.*` (10)

Per §4.13.

### T5t — `cross-cutting.*` (12)

Per §4.14.

## Wave 4 — Implementation units (parallelizable)

Each of these is a substantial subproject. Prompts reference the plan's §6.

### T7a — Action parameter extraction + verification pipeline (§6.1)
### T7b — Rolodex / contacts core service (§6.3)
### T7c — Follow-up tracker service (§6.4)
### T7d — Message triage v2 — cross-platform (§6.5)
### T7e — Calendar scheduling-with-others (§6.6)
### T7f — Meeting dossier generator (§6.7)
### T7g — Website blocker chat integration (§6.8)

(T2 = §6.2 = already in Wave 1.)

### T8a — Travel-time awareness (§6.9)
### T8b — macOS native alarm (§6.10)
### T8c — iOS native alarm + companion skeleton (§6.11)
### T8d — Activity tracker (WakaTime-like) (§6.12)
### T8e — LifeOps browser extension (§6.13)
### T8f — 1Password / ProtonPass autofill (§6.14)
### T8g — Twitter/X feed summarization (§6.15)
### T8h — Calendly navigation plugin (§6.16)
### T8i — GitHub full integration (§6.17)

### T9a — VNC / remote-control data plane (§6.18)
### T9b — Tailscale routing option (§6.19)
### T9c — iOS remote companion full UX (§6.20)
### T9d — Eliza Cloud billing markup (§6.21)
### T9e — Twilio calling (§6.22)
### T9f — Morning/night check-in routine engine (§6.23)
### T9g — Cross-device intent bus (§6.24)

## Wave 5 — Wiring & cleanup

### T10 — CI wiring

**Prompt:**

> Wire the scenario matrix into CI per `docs/plan-unified-scenario-matrix.md` §8. Two workflows:
>
> 1. **PR subset** — new job in `.github/workflows/test.yml` named `scenario-critical-subset`: runs `eliza-scenarios run --tag critical --shards 2`. Requires `GROQ_API_KEY`. Runs on `ubuntu-latest`. Target: ≤ 15 scenarios, ≤ 15min wall time.
>
> 2. **Full matrix on develop** — new workflow `.github/workflows/scenario-matrix.yml`: triggers on push to `develop`. 8 shards by domain folder. macOS shards on self-hosted runner (label `eliza-e2e-macos`); others on `ubuntu-latest`. Post aggregated summary to `$GITHUB_STEP_SUMMARY`.
>
> Update `eliza/packages/app-core/test/regression-matrix.json`: add `scenarios-critical` to PR suites and `scenarios-full` to nightly suites per the existing contract validation format.
>
> Update `validate-regression-matrix.mjs` assertions if needed. Run `bun run test:regression-matrix:pr` to verify.

### T11 — Credential provisioning playbook

**Prompt:**

> Create `docs/scenario-credentials.md` — operator playbook for provisioning all test accounts listed in `plan-unified-scenario-matrix.md` §7.1 (Gmail, Google Workspace, GitHub, Discord, Telegram, Twitter/X, Signal, WhatsApp Business, Twilio, BlueBubbles, 1Password, Calendly, Apple Developer).
>
> For each:
> - Step-by-step setup instructions.
> - Required scopes/permissions.
> - How to obtain OAuth refresh tokens / API keys.
> - Which `ELIZA_E2E_*` env vars the CredentialBroker expects (exact names).
> - Rotation schedule and process.
> - How to add the creds to the `eliza-e2e` 1Password vault.
> - How to push them as GitHub Actions secrets via `op` CLI (+ the monthly rotation workflow file at `.github/workflows/rotate-e2e-secrets.yml`).
>
> Also implement the rotation workflow file.

### T12 — Orphan sweeper

**Prompt:**

> Build the scheduled orphan sweeper per `plan-unified-scenario-matrix.md` §7.4. New workflow `.github/workflows/e2e-orphan-sweeper.yml` runs daily. Calls `eliza-scenarios sweep` (new CLI command) which iterates every integration adapter and deletes items tagged `e2e-*` or labeled `eliza-e2e` older than 24 hours. Reports counts to workflow summary. Fails if sweep fails (so an alert fires).

### T13 — Delete old runners & finalize

**Prompt:**

> Once T4a and T4b have landed and the scenario matrix is passing for 3 consecutive develop runs:
>
> 1. Delete `eliza/plugins/app-lifeops/test/helpers/lifeops-live-scenario-runner.ts` (1,358 lines). Its behavior now lives in `@elizaos/scenario-runner`.
> 2. Delete `eliza/plugins/app-lifeops/test/lifeops-scenarios.live.e2e.test.ts`. Replace with a one-liner that calls the new runner over `test/scenarios/lifeops/`.
> 3. Delete `eliza/packages/app-core/test/convo-testing/` directory in full (scripted-runner, dynamic-runner, action-interceptor, assertions, etc.). All behavior is in `@elizaos/scenario-runner`.
> 4. Remove `test:convo` from root `package.json` (or alias to `eliza-scenarios run test/scenarios/convo/`).
> 5. Update `docs/plan-unified-scenario-matrix.md` §14 to reflect completion.
>
> Verify: all tests pass. No references to the deleted files remain (grep the repo).

## Ownership matrix

(For when we assign these to people / sessions.)

| Task | Can parallelize | Human-days estimate |
|---|---|---|
| T1 | — | 2 |
| T2 | After T1 | 5 |
| T4a | After T2 | 0.5 |
| T4b | After T2 | 2 |
| T6 | After T1 | 1 |
| T5a-t | Yes, per domain | 0.5-2 each, ~30 total |
| T7a-g | Yes, per unit | 3-5 each, ~30 total |
| T8a-i | Yes, per unit | 3-7 each, ~45 total |
| T9a-g | Yes, per unit | 3-10 each, ~40 total |
| T10 | After T2 | 1 |
| T11 | Parallel with anything | 2 |
| T12 | After T2 | 1 |
| T13 | Last | 0.5 |
| **Total** | | **~160 days single-dev; ~25 weeks at team of 3** |
