# Economics `/goal` runbook — autonomous monetized-app loop

How to drive (and what currently blocks) a `/goal` sub-agent that autonomously
runs the monetized-app loop: create app → deploy container → enable monetization
→ buy a domain → stay alive on earnings, with paid Cloud commands auto-authorized
within a spend cap.

## What already works (verified)

- **Capped self-spend allowance.** `decideSpendAuthorization`
  (`src/services/spend-allowance.ts`) gates each Cloud command by risk/cap, and
  `runCloudCommand` (`src/services/parent-agent-broker.ts:1067`) emits the
  structured `event: "spend_auto_authorized"` log when a self-spend command
  auto-authorizes within `ELIZA_AGENT_SPEND_CAP_USD`. Confirmed by
  `src/__tests__/parent-agent-broker.test.ts` › _capped self-spend allowance_
  (4 cases pass: within-cap auto-authorizes, over-cap confirms, non-self-spend
  mutating auto-authorizes).
- **Economics capability profile.** `/economics` (or `/monetize`,
  `/monetized-app`) in the composer sets `metadata.capabilityProfile = "economics"`
  (`plugin-task-coordinator` composer directives → `createOrchestratorTask`), and
  `spawnAgentForTask` reads `coerceGoalCapabilityProfile(task.metadata.capabilityProfile)`
  and widens the goal fence via `ECONOMICS_GOAL_CAPABILITIES` (`goal-prompt.ts`).
- **The Cloud loop itself.** `apps.create → monetization.update → domains.buy
  (real credit debit) → earnings → survival economics` is exercised end-to-end
  against the mock stack by
  `packages/test/cloud-e2e/tests/monetized-app-loop.spec.ts`.

## Runbook (once the dispatcher gap below is closed)

1. Boot a stubbed-but-real Cloud so paid commands succeed without real money:

   ```bash
   CLOUD_E2E=1 NODE_ENV=test bun run cloud:mock --reset
   # note the printed "Ready on http://127.0.0.1:<apiPort>"
   ```

2. Point the broker at the mock and arm the spend cap (these resolve through
   `config-env.ts`, so the eliza config `env` section or process env both work):

   ```bash
   ELIZA_CLOUD_BASE_URL=http://127.0.0.1:<apiPort>
   ELIZAOS_CLOUD_API_KEY=<a seeded org API key>      # see cloud-e2e seedTestUser
   ELIZA_AGENT_SPEND_CAP_USD=20
   ELIZA_ACP_DEFAULT_AGENT=opencode                   # or codex/claude with their keys
   ```

3. Create an economics task — `/economics build and monetize a tiny app` in the
   composer, or `POST /api/orchestrator` with
   `metadata: { capabilityProfile: "economics" }`.

4. The sub-agent loads the `build-monetized-app` skill and should drive the loop
   through the parent-agent broker. Watch the logs for
   `event: "spend_auto_authorized"` on `domains.buy` / `containers.create` —
   that line is the proof the agent spent within its cap without a human prompt.

   - **Domains gotcha:** `domains.buy` (and `media.*`/`promote.*`) resolve to
     unknown cost and stall on confirmation unless the agent first calls
     `domains.check` and threads the quote into `params.spendEstimateUsd`.
     `containers.create` has a built-in `$0.67/day` estimate, so it
     auto-authorizes without a hint.

## Blocker: no production path from a sub-agent to the broker

`runCloudCommand` (the only emitter of `spend_auto_authorized`) is **not reachable
by a live agent today** — the mechanism is unit-tested but unwired:

- `runParentAgentBroker` / `PARENT_AGENT_BROKER_MANIFEST_ENTRY` have **no
  production caller** (only the test invokes them).
- `buildSkillsManifest({ virtualSkills })` is never called, so a spawned child
  never receives a `SKILLS.md` advertising the `parent-agent` slug or its arg
  shape.
- There is **no `USE_SKILL parent-agent` dispatcher** — nothing parses a child's
  `USE_SKILL parent-agent {…}` request and calls `runCloudCommand`.

So a `/economics` sub-agent can read the (advisory) capability fence but has no
executable path to run `apps.create` / `containers.create` / `domains.buy`
through the capped broker. **Verifying `spend_auto_authorized` via the Vitest
above is the current proof-of-mechanism.**

### To close it (smallest path to a live demo)

1. **Dispatch.** In the ACP session-event path (or `SubAgentRouter`), detect a
   sub-agent message `USE_SKILL parent-agent <json>`, parse it, call
   `runParentAgentBroker({ runtime, sessionId, session, args })`, and send
   `result.text` back via `acp.sendToSession`.
2. **Advertise.** In `spawnAgentForTask`, when `capabilityProfile === "economics"`,
   call `buildSkillsManifest(runtime, { recommendedSlugs: ["build-monetized-app",
   "eliza-cloud"], virtualSkills: [PARENT_AGENT_BROKER_MANIFEST_ENTRY] })` and write
   it as `SKILLS.md` in the workdir so the child learns the slug + arg contract.
3. **Estimate.** Encourage (skill prose) calling `domains.check` first and passing
   the price as `spendEstimateUsd` on `domains.buy`, or seed a small built-in
   estimate so the demo's first paid step auto-authorizes.

See `default-eliza-skills-and-agent-bridge-plan.md` for the broader bridge design;
this runbook is the economics-specific slice.
