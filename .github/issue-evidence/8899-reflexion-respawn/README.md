# #8899 — Reflexion-style per-task failure memory (test + evidence)

The production code for #8899 already shipped (#8954): on a failed automatic
verification the orchestrator records a verbal post-mortem on the task
(`metadata.attemptReflections`, capped at `MAX_ATTEMPT_REFLECTIONS`), and the
next `spawnAgentForTask` reads those post-mortems back and injects them into the
re-spawn goal prompt under a `--- Past Attempt Failures ---` section.

Before this change only the **pure render leaf** (`buildGoalPrompt`) was tested
(`goal-prompt.test.ts`). The **stateful loop** — append → cap → coerce → read at
spawn → render into the retry prompt — had **zero** automated coverage. This
bundle closes that gap with tests that drive the real service path (no
hand-injected reflection array) plus a scenario-runner scenario, and captures
the before/after retry prompt for human review.

## Acceptance criteria → artifact

| AC / close-criterion | How it is proven | Artifact |
| --- | --- | --- |
| **AC1** — capture a verbal post-mortem on a failed verification, persisted to `metadata.attemptReflections`; buffer caps at `MAX_ATTEMPT_REFLECTIONS` dropping the oldest; malformed persisted entries are coerced | `auto-goal-verify.test.ts` → `describe("attempt reflection persistence (#8899)")`: drives the **real** `autoVerifyCompletion` append path via the fake-ACP harness — first-failure persist, second-failure accumulate-in-order, cap drops oldest, malformed entries sanitized, no write on pass, no append past the attempt cap | `001-service-integration-test.log` |
| **AC2 / AC3** — a re-spawn reads the reflections (incl. malformed coercion at the read-at-spawn path) and the prior reflection appears in the **second** spawn's goal-prompt envelope, at the **service** level | `reflexion-respawn.test.ts`: drives the real `spawnAgentForTask` (~L2242) — asserts the captured spawn `initialTask` **and** the persisted `session.goalPrompt` carry `Attempt 1: …` / `Missing: …`, plus a malformed-metadata coercion variant | `001-service-integration-test.log` |
| **AC3 (scenario)** — a deterministic scenario-runner fail→retry asserting the second prompt contains the first attempt's reflection | `test/scenarios/orchestrator-reflexion-respawn.scenario.ts` (runner artifact, `ORCHESTRATOR_REFLEXION_RESPAWN` harness action) + keyless assertion-logic coverage in `orchestrator-scenario-logic.test.ts` (`runReflexionRespawnCheck`) | `002-scenario-logic-test.log` + `orchestrator-reflexion-respawn.scenario.ts` |
| **Human-reviewable proof** — the reflection is visibly carried into the retry | Before/after goal-prompt pair captured from a **real** test run (`reflexion-respawn.test.ts` with `ORCH_8899_EVIDENCE_DIR`): BEFORE (first spawn) has no `Past Attempt Failures`; AFTER (re-spawn) replays `Attempt 1: tests were never run` | `004-prompt-before-after.md` |

## How to regenerate

```bash
cd plugins/plugin-agent-orchestrator
# Service-integration tests + before/after prompt capture:
ORCH_8899_EVIDENCE_DIR=$PWD/../../.github/issue-evidence/8899-reflexion-respawn \
  bunx vitest run --config vitest.config.ts \
  src/__tests__/auto-goal-verify.test.ts src/__tests__/reflexion-respawn.test.ts
# Scenario assertion-logic (keyless):
bunx vitest run --config vitest.config.ts src/__tests__/orchestrator-scenario-logic.test.ts
# Scenario-runner artifact (deterministic lane):
bun run test:scenarios   # runs test/scenarios/*.scenario.ts incl. orchestrator-reflexion-respawn
```

## N/A with reason

- **Screenshots / UI / video** — N/A. This is a server-side orchestrator loop
  (task metadata + the goal-prompt string sent to a coding sub-agent). There is
  no UI surface; the reviewable artifact is the before/after prompt pair
  (`004-prompt-before-after.md`).
- **Live-LLM + live-ACP scenario trajectory** — deferred to the live lane.
  A fully live fail→retry needs a real coding-agent subprocess and a real judge
  model, which is not deterministically reachable in CI. The real append→read→
  inject pipeline is proven by the service-integration tests above; the
  `.scenario.ts` runs deterministically via `registerVerifierFixtures`, and the
  live variant is the `bun run test:scenarios:live` lane.
