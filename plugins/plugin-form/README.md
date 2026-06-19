# @elizaos/plugin-form

Conversational forms for Eliza agents. Define structured data-collection workflows; the agent extracts values from natural conversation, tracks completion, and delivers a typed `FormSubmission` when all required fields are filled.

## What it does

- **Defines forms** — a `FormDefinition` describes the fields to collect (`FormControl[]`), lifecycle hooks, TTL settings, and UX rules (undo, skip, autofill).
- **Tracks sessions** — one `FormSession` per user per room. Sessions survive topic changes and can be stashed and resumed later.
- **Extracts field values via LLM** — the post-turn evaluator detects user intent and pulls values from conversational messages, handling uncertain extractions with a confirm step.
- **Supports composite and external control types** — composite types (e.g. address) have subfields that must all fill before the parent is complete; external types (e.g. payment) await asynchronous confirmation from another service before marking the field filled.
- **Effort-aware retention** — session TTL scales with how long the user has invested (default 14–90 days).

## Capabilities added to an Eliza agent

| Capability | How |
|---|---|
| FORM\_CONTEXT provider | Injects current form progress into every agent turn — filled/missing fields, uncertain extractions, pending external fields, and a single action directive |
| FORM action | `action=restore` rehydrates the most recent stashed form before the agent responds. **Not auto-registered** — import `formAction` from `@elizaos/plugin-form` and add it to your consuming plugin's `actions` array to activate it. |
| Form evaluator | Post-turn: detects submit / stash / cancel / undo / skip / autofill / fill\_form intents and updates session state |
| FormService | Singleton service: register forms and custom control types, start/manage sessions, submit, stash, restore |

## Installation

Add the plugin to your agent character config:

```json
{
  "plugins": ["@elizaos/plugin-form"],
  "features": {
    "form": true
  }
}
```

The plugin auto-enables when `config.features.form` is truthy (`true`, or an object whose `enabled` is not `false`). No environment variables are required.

## Built-in field types

`text`, `number`, `email`, `boolean`, `select`, `date`, `file`

Custom types are registered at runtime via `FormService.registerControlType()`.

## Registering a form (consuming plugin example)

```typescript
import type { FormDefinition } from '@elizaos/plugin-form';

const onboardingForm: FormDefinition = {
  id: 'onboard',
  name: 'Onboarding',
  controls: [
    { key: 'name',  label: 'Full Name',  type: 'text',   required: true },
    { key: 'email', label: 'Email',       type: 'email',  required: true },
    { key: 'role',  label: 'Role',        type: 'select', required: false,
      options: [{ value: 'dev', label: 'Developer' }, { value: 'pm', label: 'Product' }] },
  ],
  hooks: { onSubmit: 'handle_onboarding_submission' },
};

// In your plugin's start() or action handler:
const formService = runtime.getService('FORM');
formService.registerForm(onboardingForm);
await formService.startSession('onboard', entityId, roomId);
```

Register a task worker to handle the submission:

```typescript
runtime.registerTaskWorker({
  name: 'handle_onboarding_submission',
  execute: async (runtime, { submission }) => {
    // submission.values, submission.mappedValues, submission.entityId, etc.
  },
});
```

## Registering a custom control type

```typescript
// Simple type
formService.registerControlType({
  id: 'phone',
  validate: (v) => ({ valid: /^\+?[\d\s-]{10,}$/.test(String(v)) }),
  extractionPrompt: 'a phone number with country code',
});

// External type (async confirmation required)
formService.registerControlType({
  id: 'payment',
  getSubControls: () => [
    { key: 'amount',   type: 'number', label: 'Amount',   required: true },
    { key: 'currency', type: 'select', label: 'Currency', required: true,
      options: [{ value: 'SOL', label: 'SOL' }, { value: 'USDC', label: 'USDC' }] },
  ],
  activate: async (ctx) => {
    // Return instructions and a reference for matching the external event
    return { instructions: 'Send funds to ...', reference: 'memo-xyz', address: '...' };
  },
});
```

When all subfields are filled the evaluator automatically calls `activateExternalField()`. Your service calls `formService.confirmExternalField(sessionId, entityId, field, value, externalData)` when confirmation arrives.

## FormDefinition reference (key fields)

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string | required | Unique form identifier |
| `name` | string | required | Human-readable name |
| `controls` | FormControl[] | required | Fields to collect |
| `status` | `draft\|active\|deprecated` | `active` | Draft forms cannot be started |
| `allowMultiple` | boolean | `false` | Allow multiple submissions per user |
| `hooks.onStart/onSubmit/onCancel/onReady/onFieldChange/onExpire` | string | — | Task worker names |
| `ttl.minDays` / `ttl.maxDays` | number | 14 / 90 | Retention bounds |
| `ttl.effortMultiplier` | number | 0.5 | Extra days per minute of interaction |
| `ux.allowUndo` / `allowSkip` / `allowAutofill` | boolean | all `true` | UX feature flags |
| `nudge.afterInactiveHours` / `maxNudges` | number | 48 / 3 | Stale-session nudge config |

## FormControl reference (key fields)

| Field | Type | Description |
|---|---|---|
| `key` | string | Unique within form; used in `values` map |
| `label` | string | Human-readable name |
| `type` | string | `text`, `number`, `email`, `boolean`, `select`, `date`, `file`, or custom |
| `required` | boolean | Form cannot submit without this field |
| `sensitive` | boolean | Value masked in agent context |
| `hidden` | boolean | Extract silently, never ask directly |
| `askPrompt` | string | Custom agent prompt for this field |
| `extractHints` | string[] | Keywords to improve LLM extraction accuracy |
| `confirmThreshold` | number | Confidence below this triggers confirmation (default 0.8) |
| `dependsOn` | FormControlDependency | Conditional display based on another field's value |
| `dbbind` | string | Column name for `mappedValues` in submission |
| `options` | FormControlOption[] | For `select` type |
