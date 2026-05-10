# Translation Harness — `translate-action-examples.mjs`

## What this is

A bulk-translation tool that turns English `ActionExample` pairs into
locale-specific entries in the `MultilingualPromptRegistry` (W2-E,
`plugins/app-lifeops/src/lifeops/i18n/prompt-registry.ts`).

The harness is the answer to the locale-coverage gap finding in
`docs/audits/action-inventory-2026-05-09.md` §5.4: actions ship English
example arrays only, the planner has no localized variants to fall back to,
and translating 113 example-bearing actions by hand is not viable.

## Contract

- **Input.** A `*.ts` action file. The harness statically extracts the
  action's `name` literal and its `examples: ActionExample[][]` array via
  `ts-morph` AST walk — no module evaluation.
- **Translation.** Cerebras `gpt-oss-120b` with a strict JSON-only prompt
  that forbids translating speaker placeholders (`{{name1}}`,
  `{{agentName}}`) and action tokens (`LIFE`, `MESSAGE_HANDOFF`,
  `SCHEDULED_TASK`).
- **Output.** A self-contained TypeScript file under
  `plugins/app-lifeops/src/lifeops/i18n/generated/<action>.<locale>.ts`
  exporting `<action>_<locale>_examples: ReadonlyArray<PromptExampleEntry>`.
  The file is then imported by `registerDefaultPromptPack` in
  `prompt-registry.ts` so every runtime sees the new entries.
- **Registry key shape.** `<actionName>.example.<index>` (e.g.
  `"LIFE.example.0"`). The index matches the source pair's position in the
  action's English `examples` array. Action authors who want to inline a
  localized pair into their static `examples` array can call:

  ```ts
  import { getDefaultPromptExamplePair } from "../lifeops/i18n/prompt-registry.js";
  // ...
  examples: [
    [...getDefaultPromptExamplePair("LIFE.example.0", "es")],
    // ...
  ],
  ```

  This mirrors the W2-E `life.brush_teeth.create_definition` pattern.
- **Failure mode.** Any LLM error (HTTP non-2xx, empty content, unparseable
  JSON, missing `userText`/`agentText`) throws and exits non-zero. The
  harness has no silent fallback, in keeping with the CLAUDE.md
  fail-loud / no-fallback-shim rules.

## Run it on one action (sample)

```bash
bun plugins/app-lifeops/scripts/translate-action-examples.mjs \
    plugins/app-lifeops/src/actions/life.ts \
    --target-locale=es \
    --max-examples=3 \
    --output=plugins/app-lifeops/src/lifeops/i18n/generated/life.es.ts
```

Required environment:

- `CEREBRAS_API_KEY` (resolved from `eliza/.env` or
  `plugins/app-lifeops/.env`).
- Optional: `CEREBRAS_BASE_URL` (default `https://api.cerebras.ai/v1`),
  `CEREBRAS_MODEL` (default `gpt-oss-120b`).

Useful flags:

| Flag | Purpose |
|------|---------|
| `--target-locale=es` | comma-separated locale list; supports `es`, `fr`, `ja` |
| `--max-examples=N` | translate only the first N pairs (saves tokens) |
| `--action-name=NAME` | override auto-detected action name |
| `--output=PATH` | write to a file instead of stdout |
| `--dry-run` | skip Cerebras; emit `[dry-run:<locale>]`-prefixed text |

For multi-locale runs, `--output=foo.es.ts --target-locale=es,fr` writes
`foo.es.ts` and `foo.fr.ts` (locale spliced into the filename).

## Run it on all 113 example-bearing actions (bulk)

```bash
# Spanish, French, Japanese for every action under plugins/app-lifeops/src/actions/.
for f in plugins/app-lifeops/src/actions/*.ts; do
  base=$(basename "$f" .ts)
  bun plugins/app-lifeops/scripts/translate-action-examples.mjs \
    "$f" \
    --target-locale=es,fr,ja \
    --max-examples=3 \
    --output="plugins/app-lifeops/src/lifeops/i18n/generated/${base}.ts" \
    || echo "[bulk] FAILED $base — see logs above"
done
```

After the loop finishes, append the new `<action>_<locale>_examples`
imports + entries to the `GENERATED_TRANSLATION_PACKS` array in
`prompt-registry.ts`. (We deliberately do NOT auto-edit `prompt-registry.ts`
from the harness; the registry's default pack is the curated
human-reviewed surface, and bulk-generated content should land via PR.)

## Cost estimate

- 113 example-bearing actions × ~3 pairs each × 3 locales = **~1,017
  Cerebras calls**.
- Per call: ≤ 1k input tokens (system + prompt + JSON pair) + ≤ 256 output
  tokens.
- Total: **≈ 1.3M tokens** through Cerebras `gpt-oss-120b`.
- Wall clock at Cerebras's ~2s/call median: ~30 minutes (sequential).
  Parallelism is straightforward but not implemented — the script is
  intentionally sequential so a transient error halts the run rather than
  producing a partially-translated half-state.

## What this proof ships

W2-? sample (initial PoC):

- 3 actions × Spanish (1 locale) × 3 pairs each = **8 Cerebras calls
  total** (LIFE: 3, MESSAGE_HANDOFF: 2 — only two source pairs exist,
  SCHEDULED_TASK: 3).
- 8 `PromptExampleEntry` rows landed under
  `src/lifeops/i18n/generated/{life,message-handoff,scheduled-task}.es.ts`
  and were wired into `registerDefaultPromptPack`.

## Bulk pass coverage (current state)

Every example-bearing action under `plugins/app-lifeops/src/actions/` now
has Spanish + French translation packs registered. **29 actions × 2
locales × up to 2 pairs each = ~110 Cerebras calls total** for the bulk
pass on top of the original 8 from the proof-of-concept.

Action × locale matrix shipped (each row × {`es`, `fr`}):

| Action | Source file | Action name |
|--------|-------------|-------------|
| `app-block` | `actions/app-block.ts` | `APP_BLOCK` |
| `autofill` | `actions/autofill.ts` | `AUTOFILL` |
| `block` | `actions/block.ts` | `BLOCK` |
| `book-travel` | `actions/book-travel.ts` | `BOOK_TRAVEL` |
| `calendar` | `actions/calendar.ts` | `CALENDAR` |
| `checkin` | `actions/checkin.ts` | `CHECKIN` |
| `connector` | `actions/connector.ts` | `CONNECTOR` |
| `credentials` | `actions/credentials.ts` | `CREDENTIALS` |
| `device-intent` | `actions/device-intent.ts` | `DEVICE_INTENT` |
| `entity` | `actions/entity.ts` | `ENTITY` |
| `first-run` | `actions/first-run.ts` | `FIRST_RUN` |
| `health` | `actions/health.ts` | `HEALTH` |
| `life` | `actions/life.ts` | `LIFE` |
| `lifeops-pause` | `actions/lifeops-pause.ts` | `LIFEOPS` |
| `message-handoff` | `actions/message-handoff.ts` | `MESSAGE_HANDOFF` |
| `money` | `actions/money.ts` | `MONEY` |
| `password-manager` | `actions/password-manager.ts` | `PASSWORD_MANAGER` |
| `payments` | `actions/payments.ts` | `PAYMENTS` |
| `profile` | `actions/profile.ts` | `PROFILE` |
| `relationship` | `actions/relationship.ts` | `RELATIONSHIP` |
| `remote-desktop` | `actions/remote-desktop.ts` | `REMOTE_DESKTOP` |
| `resolve-request` | `actions/resolve-request.ts` | `RESOLVE_REQUEST` |
| `schedule` | `actions/schedule.ts` | `SCHEDULE` |
| `scheduled-task` | `actions/scheduled-task.ts` | `SCHEDULED_TASK` |
| `screen-time` | `actions/screen-time.ts` | `SCREEN_TIME` |
| `subscriptions` | `actions/subscriptions.ts` | `SUBSCRIPTIONS` |
| `toggle-feature` | `actions/toggle-feature.ts` | `TOGGLE_FEATURE` |
| `voice-call` | `actions/voice-call.ts` | `VOICE_CALL` |
| `website-block` | `actions/website-block.ts` | `WEBSITE_BLOCK` |

`scheduling-negotiation.ts` is intentionally excluded — it has no
`examples: ActionExample[][]` array (the planner builds its prompt purely
from offer-set state).

## Still pending — future bulk passes

Out of scope for this round (does not violate the conservative budget cap):

- Japanese (`ja`) for any app-lifeops action.
- Translation packs for example-bearing actions in plugins outside
  `plugins/app-lifeops/`. The full project has ~110 example-bearing
  actions; the cross-plugin sweep is a separate, larger budget item.
- Identifier-resolved `action: ACTION_NAME` references. The harness's
  literal-only AST extractor silently drops `action: ACTION_NAME`
  (constant identifier) values, which is why some generated entries lack
  a structured `action` field even when the source had one. Resolving
  identifiers via ts-morph type checker is a follow-up enhancement; the
  inline action-token tests guard against translation regressions in the
  meantime.

## Test coverage

- `test/translation-harness.test.ts` (7 assertions): bulk-pack
  registration, `es`/`fr` action-coverage parity, `<actionName>.example.<index>`
  key shape, both placeholder conventions (`{{name1}}/{{agentName}}` and
  `{{user1}}/{{agent}}`), action-token shape (`UPPER_SNAKE` plus optional
  `.verb` suffix), placeholder preservation in body text, and non-empty
  translated text.
- `test/journey-domain-coverage.test.ts` (40 assertions) continues to
  pass — pack expansion does not break the journey-domain mapping.

## Planner integration point (out of scope for this commit)

`MultilingualPromptRegistry` registers via `registerMultilingualPromptRegistry`
on the runtime. The `OwnerFactStore.locale` (see
`plugins/app-lifeops/src/lifeops/owner/fact-store.ts`) already records the
owner's preferred locale.

The actual planner-side example assembly currently lives in
`packages/core/src/runtime/action-catalog.ts` (the catalog entry copies
`action.examples` verbatim). To make the planner pick up localized
variants, that path needs one of:

1. A pre-render hook that resolves `<actionName>.example.<index>` keys
   against the registry using the active locale, OR
2. A new field on the catalog entry (`examplesByLocale`) populated at
   action-catalog-build time.

Either change touches core. It is **NOT** part of this commit, by design
— the rule was to ship the harness + registered entries and document the
integration as a follow-up. Once the planner consumes the registry, every
action automatically picks up the entries the harness has already
populated.
