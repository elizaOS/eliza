# @elizaos/plugin-form

Conversational forms as guardrails for guided user journeys in Eliza agents.

## Purpose / role

Adds a form-session lifecycle to any Eliza agent: define structured forms, collect values through natural conversation, track completion progress, and receive a typed `FormSubmission` when all required fields are filled. Loaded as an opt-in plugin — auto-enabled when `config.features.form` is truthy or not explicitly disabled (see `auto-enable.ts`). No env vars gate the plugin itself; it activates purely through character config.

## Plugin surface

### Services
- **`FORM`** (`FormService`) — singleton that owns all form state. Registers form definitions, manages sessions (start / update / stash / restore / submit / cancel), maintains the control-type registry (simple, composite, external types), executes lifecycle hooks, and computes effort-based TTL.

### Providers
- **`FORM_CONTEXT`** (`formContextProvider`) — injected into every agent turn when a form session is active or stashed. Outputs a `form_context_json` block (required/optional × filled/missing fields, uncertain fields, pending external fields, and a single `instruction` directive). Also exposes `data.nextField`, `hasActiveForm`, `formProgress`, `formStatus`, `stashedCount` for action and template use.

### Actions
- **`FORM`** (`formAction`) — noun-shaped router exported from the package but NOT registered in the plugin's `actions: []` by default. Implements subaction `restore`: rehydrates the most recent stashed form before the agent generates its reply so the resumed form is already in provider scope. Add it to a consuming plugin's action list to activate it. Start, submit, cancel, stash, and field updates are owned by `FormService` plus `formEvaluator`.

### Evaluators
- **`formEvaluator`** (`evaluators/extractor.ts`) — post-turn evaluator (`EvaluatorPriority.FORM` = 50). Detects form intent (`submit`, `stash`, `cancel`, `undo`, `skip`, `autofill`, `fill_form`, `explain`, `example`, `progress`, `other`) via LLM extraction, updates field states in the active session, and — for **external** control types whose subcontrols have all filled — emits `FORM_SUBCONTROLS_FILLED` then activates the field and emits `FORM_EXTERNAL_ACTIVATED`. The `restore` intent is intentionally NOT handled here — it lives in the FORM action so context is ready before response generation.

### Events emitted
`FORM_FIELD_EXTRACTED`, `FORM_SUBFIELD_UPDATED`, `FORM_SUBCONTROLS_FILLED`, `FORM_EXTERNAL_ACTIVATED`, `FORM_FIELD_CONFIRMED`, `FORM_FIELD_CANCELLED`

## Layout

```
plugins/plugin-form/
  package.json              npm metadata; scripts; agentConfig.pluginParameters: {}
  auto-enable.ts            shouldEnable() — reads config.features.form
  src/
    index.ts                Plugin export (formPlugin); re-exports all public API
    types.ts                All interfaces: FormDefinition, FormControl, FormSession,
                            FormSubmission, ControlType, FormContextState, events, etc.
    service.ts              FormService — registration, sessions, subfields, external
                            activation, TTL, hooks, context helpers
    storage.ts              Component-based persistence (sessions, submissions, autofill)
    builtins.ts             Built-in ControlType registrations: text, number, email,
                            boolean, select, date, file
    validation.ts           validateField(), registerTypeHandler(), formatValue()
    extraction.ts           LLM extraction helpers: buildFormExtractorPromptSection(),
                            buildFormExtractorSchema(), parseFormExtractorOutput(),
                            coerceExtractionsAgainstControls()
    builder.ts              FormBuilder / ControlBuilder / C fluent DSL
    defaults.ts             applyFormDefaults(), applyControlDefaults(), prettify()
    ttl.ts                  calculateTTL(), shouldNudge(), isExpired(), formatEffort()
    template.ts             buildTemplateValues(), renderTemplate() — {{placeholder}} resolution
    actions/
      form.ts               FORM action (restore subaction)
    evaluators/
      extractor.ts          formEvaluator — intent detection + field extraction
    providers/
      context.ts            FORM_CONTEXT provider
```

## Commands

```bash
bun run --cwd plugins/plugin-form build          # tsup JS + tsc type declarations
bun run --cwd plugins/plugin-form build:js       # JS only (tsup)
bun run --cwd plugins/plugin-form build:types    # .d.ts only (tsc --noCheck)
bun run --cwd plugins/plugin-form clean          # rm -rf dist
bun run --cwd plugins/plugin-form test           # vitest run
bun run --cwd plugins/plugin-form typecheck      # tsgo --noEmit
```

## Config / env vars

No environment variables. The plugin is gated entirely by character config:

| Config path | Effect |
|---|---|
| `config.features.form` | `true` or `{ enabled: true }` → auto-enable. Absent or `false` → skip. |

Consuming plugins pass `context` and `initialValues` when calling `formService.startSession()`. Hook worker names are set in `FormDefinition.hooks` (strings that resolve to registered `taskWorker` names).

## How to extend

### Add a new action
1. Create `src/actions/<name>.ts` exporting an `Action` object.
2. Import and add it to the `actions: []` array in `src/index.ts`.

### Add a new evaluator
1. Create `src/evaluators/<name>.ts` exporting an `Evaluator` object.
2. Import and add it to the `evaluators: [formEvaluator]` array in `src/index.ts`.

### Register a custom control type (from a consuming plugin)
```typescript
const formService = runtime.getService('FORM') as FormService;
// Simple type
formService.registerControlType({ id: 'phone', validate: ..., extractionPrompt: '...' });
// Composite (subcontrols must all fill before parent is filled)
formService.registerControlType({ id: 'address', getSubControls: (ctrl, rt) => [...] });
// External (async confirmation via confirmExternalField)
formService.registerControlType({ id: 'payment', getSubControls: ..., activate: async (ctx) => ({ instructions, reference, address }) });
```
Built-in types (`text`, `number`, `email`, `boolean`, `select`, `date`, `file`) are protected; pass `{ allowOverride: true }` to replace one intentionally.

### Register a form and start a session
```typescript
formService.registerForm({ id: 'onboard', name: 'Onboarding', controls: [...], hooks: { onSubmit: 'handle_onboard_submission' } });
await formService.startSession('onboard', entityId, roomId, { context: { tier: 'pro' } });
```

## Conventions / gotchas

- **Storage uses elizaOS Components** (no custom DB tables). Sessions are keyed `form_session:{roomId}`, submissions as `form_submission:{formId}:{submissionId}`. All CRUD is in `storage.ts`.
- **One active session per user per room.** Calling `startSession` when one already exists throws. Stash or cancel the existing one first.
- **`restore` intent must go through the FORM action**, not the evaluator, so the provider has fresh context before the agent reply.
- **Effort-based TTL.** Sessions don't expire at a fixed time; more user interaction extends retention (min 14 days, max 90 days, configurable per form via `FormDefinition.ttl`).
- **Sensitive fields** (`sensitive: true`) are never echoed back in provider context — only a masked placeholder is shown.
- **Hook workers** are resolved via `runtime.getTaskWorker(name)`. If the worker is missing the hook silently no-ops with a warning log — it does not throw.
- **External types** require three steps: subfields fill → `FORM_SUBCONTROLS_FILLED` emitted → evaluator calls `activateExternalField()` → consuming plugin calls `confirmExternalField()` on success or `cancelExternalField()` on failure.
- See [AGENTS.md](../../AGENTS.md) at repo root for architecture rules, naming, logger conventions, and ESM requirements.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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
