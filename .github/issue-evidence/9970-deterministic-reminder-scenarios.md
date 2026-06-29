# #9970 — Deterministic reminder/scheduling outcome scenarios (keyless, every-PR)

Extends the outcome-asserting suite (criterion #3) past the inbox/calendar/email
batch (#10170) with **deterministic, api-turn reminder edge cases** that assert
real scheduler effects and run keyless on every PR.

## What changed

1. **`packages/scenario-runner/src/runtime-factory.ts`** — register the
   routes-only `personalAssistantRoutesPlugin` in the scenario runtime. The
   `/api/lifeops/*` HTTP routes live on that separate plugin, not the main
   lifeops plugin, and the executor's api server is built from `runtime.routes`.
   Without this, every lifeops api-turn scenario 404s on the keyless lane — which
   is why the entire existing lifeops/reminder outcome suite is `live-only`. The
   plugin is routes-only (no services/actions/providers/init), its sole
   dependency (`@elizaos/plugin-google`) is already registered, and **no existing
   deterministic scenario hits these routes**, so this only *adds* the capability.

2. **Three `pr-deterministic` reminder outcome scenarios** (api turns only, no
   LLM-dependent assertions), modeled on the `reminder-dispatch-capability` gold
   standard:
   - `reminder-idempotent-retry-outcome` — re-processing a delivered reminder at
     the same instant does **not** double-send (second pass → `"attempts":[]`).
   - `reminder-not-yet-due-outcome` — a reminder is **not** delivered before its
     window opens; processing early yields no attempts, processing at due delivers.
   - `reminder-multistep-plan-outcome` — a lead step (`offsetMinutes: 60`) and an
     at-due step each deliver at their own scheduled time
     (`scheduledFor = dueAt − offsetMinutes`).

## Validation (run locally, keyless deterministic proxy)

```
SCENARIO_USE_LLM_PROXY=1 eliza-scenarios run \
  plugins/plugin-personal-assistant/test/scenarios \
  --scenario reminder-idempotent-retry-outcome,reminder-not-yet-due-outcome,reminder-multistep-plan-outcome \
  --lane pr-deterministic
→ Totals: 3 passed, 0 failed, 0 skipped of 3
```

- The proven `reminder-dispatch-capability` gold standard **passes** with the
  routes registration (confirming the harness change is correct).
- Regression: existing deterministic `convo` scenarios (`echo-self-test`,
  `greeting-dynamic`) still pass → the routes-only registration does not affect
  non-lifeops scenarios.
- `not-yet-due` initially **failed** (the reminder fired early because
  `visibilityLeadMinutes: 240` opens the window at `dueAt − 240m`); fixed by
  setting `visibilityLeadMinutes: 0` — a real diagnostic that local validation
  caught, exactly the kind of timing bug routing-only scenarios miss.

## Evidence types (per PR_EVIDENCE.md)

- **Real-LLM trajectory:** N/A — these assert deterministic scheduler effects
  (delivery / attempt counts / timing), not LLM-authored content. They run on the
  keyless `pr-deterministic` lane and were validated under the deterministic proxy.
- **Backend logs:** the runner emits `[lifeops] Reminder delivery …` and the
  `/api/lifeops/reminders/process` response bodies the assertions read.
- **Frontend / screenshots / video / audio:** N/A — no UI or voice surface.
