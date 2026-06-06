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

## Sub-agent → broker dispatcher (now wired)

`runCloudCommand` (the only emitter of `spend_auto_authorized`) is now reachable
by a live agent. The three gaps the earlier draft of this runbook called out are
closed:

1. **Dispatch.** `SubAgentRouter.handleEvent` accumulates the child's streamed
   `message` text and, when a complete `USE_SKILL parent-agent <json>` directive
   appears, bridges it to `runParentAgentBroker({ runtime, sessionId, session,
   args })` and streams `result.text` back via `acp.sendToSession`
   (`src/services/parent-agent-dispatch.ts`). Detection is marker-guarded (it
   only acts on text containing `USE_SKILL parent-agent`, which ordinary coding
   tasks never emit) and capped by `ACPX_SUB_AGENT_ROUND_TRIP_CAP`.
2. **Advertise.** `spawnAgentForTask` writes a `SKILLS.md` into the workdir for
   `capabilityProfile === "economics"` tasks via `buildSkillsManifest(runtime, {
   recommendedSlugs: ["build-monetized-app", "eliza-cloud"], virtualSkills:
   [PARENT_AGENT_BROKER_MANIFEST_ENTRY] })`, so the child learns the `parent-agent`
   slug and its arg contract.
3. **Estimate.** The broker's unknown-cost stall now returns an *actionable*
   instruction ("fetch a quote with `domains.check` and retry with
   `params.spendEstimateUsd`") instead of a human-only yes/no, and the manifest
   guidance advertises the same pattern — so an autonomous agent self-authorizes
   `domains.buy` within the cap without a human turn.

The directive parser and the broker→`sendToSession` bridge are unit-tested in
`src/__tests__/parent-agent-dispatch.test.ts`; `spend_auto_authorized` itself
stays covered by `parent-agent-broker.test.ts`. End-to-end confirmation still
needs a live ACP backend (`ELIZA_ACP_DEFAULT_AGENT=opencode`, the broker pointed
at `cloud:mock`) — follow the runbook steps above to watch the
`spend_auto_authorized` line on a real `domains.buy` / `containers.create`.

See `default-eliza-skills-and-agent-bridge-plan.md` for the broader bridge design;
this runbook is the economics-specific slice.
