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
- **Extractor strategies (applied in order on the `examples:` initializer).**
  1. **Inline array literal.** `examples: [[user, agent], ...]`. Fast
     path — no resolution needed.
  2. **`as ActionExample[][]` cast.** Same shape wrapped in an
     `AsExpression` (or parenthesized variant); unwrapped and
     re-classified.
  3. **Identifier reference.** `examples: SOMETHING_EXAMPLES` — resolved
     via `getDefinitionNodes()`. Cross-file resolution works through
     `import { ... } from "./Y"` re-exports; ts-morph's project lazily
     adds the imported source files. The same path resolves
     `name: ACTION_NAME` Identifier-typed action names.
  4. **Spread + concatenation.** `examples: [...A, ...someAction.examples
     ?? [], inlinePair]` — each child is resolved independently via the
     same strategies and the resulting pair-array nodes are concatenated.
     `??` short-circuits: the resolver recurses on the left-hand side
     first, then the right side as fallback.
  5. **Property access.** `someAction.examples` (and `(someAction as
     Partial<Action>).examples`) — resolves the base to its declaration,
     walks to the named property's initializer, then recurses.
- **Action-name resolution.** `name: "FOO"` (string literal) and
  `name: ACTION_NAME` (Identifier resolving to a `const ACTION_NAME = "FOO"`)
  are both supported. The Identifier path uses the same cross-file resolver
  as the example extractor.
- **Fail-loud guarantee.** Every step throws a diagnostic with a
  `<path>:<line>:<col>` source location when it can't reduce to a concrete
  array literal. No silent fallback (CLAUDE.md no-fallback-shim rule).
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
has Spanish + French + **Japanese** translation packs registered, and the
top external plugins under `plugins/plugin-*/` ship es + fr + ja packs as
well. The current bulk-pass total (cumulative, not just the latest round):

- W2-G original es/fr proof-of-concept: ~110 Cerebras calls.
- Japanese expansion for app-lifeops: 29 actions × 1 locale × 2 pairs =
  **58 Cerebras calls**.
- External plugin sweep (es + fr + ja): 35 distinct actions × 3 locales ×
  2 pairs ≈ **210 Cerebras calls** + 12 retry calls for actions that
  needed an explicit `--action-name=` (the harness's auto-name detector
  silently fails when an action's `name:` is an identifier reference like
  `WORKFLOW_ACTION` or `ACTION_NAME` rather than a string literal — Agent
  45 is upgrading the extractor to resolve those).

**Net:** every example-bearing app-lifeops action has all three target
locales (`es`/`fr`/`ja`); the external sweep covers the most-used plugins
(coding-tools, linear, agent-skills, music, computeruse, todos, workflow,
browser) with all three locales each.

### Where the packs live (Option B)

All generated `<action>.<locale>.ts` packs land in a single global
location: `plugins/app-lifeops/src/lifeops/i18n/generated/`. The
`prompt-registry.ts` next to it imports + arrays each one into
`GENERATED_TRANSLATION_PACKS`. External-plugin packs use a
`<plugin-prefix>-<action>.<locale>.ts` filename to disambiguate (e.g.
`ct-bash.ja.ts` for `plugin-coding-tools/actions/bash.ts`,
`linear-create-issue.fr.ts` for `plugin-linear/actions/createIssue.ts`).

The original brief proposed Option A (per-plugin `i18n/` directories with
their own `prompt-registry.ts` files). We chose Option B because:

- Packs are pure declarative data — the runtime needs the entries on a
  single registry instance, not split across plugin boundaries.
- Option A would require adding `@elizaos/app-lifeops` (or a shared
  `@elizaos/i18n-types` package) as a workspace dependency to nine
  plugins purely so they could re-import the `PromptExampleEntry` type.
- Option A also requires each plugin's `index.ts` to wire a per-plugin
  registration hook into runtime init. With nine plugins that's nine
  small but easy-to-forget call sites.
- Option B keeps the registry as the single canonical surface (matches
  the W2-E pattern) and makes it trivial to verify coverage with a
  `bun test translation-harness` smoke run.

**Trade-off:** the `app-lifeops` package's `i18n/generated/` directory is
no longer scoped to lifeops actions. The `<plugin-prefix>-<action>`
naming convention keeps it readable, but if a downstream plugin really
needs to ship its own translations independently of app-lifeops it would
need to either (a) add a per-plugin registry along the lines of Option A
or (b) duplicate its packs into this directory.

Action × locale matrix shipped (each row × {`es`, `fr`, `ja`}):

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

External-plugin coverage (each row × {`es`, `fr`, `ja`}):

| Pack file (in `i18n/generated/`) | Source plugin / file | Action name |
|---|---|---|
| `ct-ask-user-question.<locale>.ts` | `plugin-coding-tools/actions/ask-user-question.ts` | `ASK_USER_QUESTION` |
| `ct-bash.<locale>.ts` | `plugin-coding-tools/actions/bash.ts` | `BASH` |
| `ct-edit.<locale>.ts` | `plugin-coding-tools/actions/edit.ts` | `EDIT` |
| `ct-enter-worktree.<locale>.ts` | `plugin-coding-tools/actions/enter-worktree.ts` | `ENTER_WORKTREE` |
| `ct-exit-worktree.<locale>.ts` | `plugin-coding-tools/actions/exit-worktree.ts` | `EXIT_WORKTREE` |
| `ct-glob.<locale>.ts` | `plugin-coding-tools/actions/glob.ts` | `GLOB` |
| `ct-grep.<locale>.ts` | `plugin-coding-tools/actions/grep.ts` | `GREP` |
| `ct-ls.<locale>.ts` | `plugin-coding-tools/actions/ls.ts` | `LS` |
| `ct-read.<locale>.ts` | `plugin-coding-tools/actions/read.ts` | `READ` |
| `ct-web-fetch.<locale>.ts` | `plugin-coding-tools/actions/web-fetch.ts` | `WEB_FETCH` |
| `ct-write.<locale>.ts` | `plugin-coding-tools/actions/write.ts` | `WRITE` |
| `linear-clear-activity.<locale>.ts` | `plugin-linear/actions/clearActivity.ts` | `CLEAR_LINEAR_ACTIVITY` |
| `linear-create-comment.<locale>.ts` | `plugin-linear/actions/createComment.ts` | `CREATE_LINEAR_COMMENT` |
| `linear-create-issue.<locale>.ts` | `plugin-linear/actions/createIssue.ts` | `CREATE_LINEAR_ISSUE` |
| `linear-delete-comment.<locale>.ts` | `plugin-linear/actions/deleteComment.ts` | `DELETE_LINEAR_COMMENT` |
| `linear-delete-issue.<locale>.ts` | `plugin-linear/actions/deleteIssue.ts` | `DELETE_LINEAR_ISSUE` |
| `linear-get-activity.<locale>.ts` | `plugin-linear/actions/getActivity.ts` | `GET_LINEAR_ACTIVITY` |
| `linear-get-issue.<locale>.ts` | `plugin-linear/actions/getIssue.ts` | `GET_LINEAR_ISSUE` |
| `linear-linear.<locale>.ts` | `plugin-linear/actions/linear.ts` | `LINEAR` |
| `linear-list-comments.<locale>.ts` | `plugin-linear/actions/listComments.ts` | `LIST_LINEAR_COMMENTS` |
| `linear-search-issues.<locale>.ts` | `plugin-linear/actions/searchIssues.ts` | `SEARCH_LINEAR_ISSUES` |
| `linear-update-issue.<locale>.ts` | `plugin-linear/actions/updateIssue.ts` | `UPDATE_LINEAR_ISSUE` |
| `as-skill.<locale>.ts` | `plugin-agent-skills/actions/skill.ts` | `SKILL` |
| `as-use-skill.<locale>.ts` | `plugin-agent-skills/actions/use-skill.ts` | `USE_SKILL` |
| `workflow-workflow.<locale>.ts` | `plugin-workflow/actions/workflow.ts` | `WORKFLOW` |
| `todos-todo.<locale>.ts` | `plugin-todos/actions/todo.ts` | `TODO` |
| `music-manage-routing.<locale>.ts` | `plugin-music/actions/manageRouting.ts` | `MANAGE_ROUTING` |
| `music-manage-zones.<locale>.ts` | `plugin-music/actions/manageZones.ts` | `MANAGE_ZONES` |
| `music-music.<locale>.ts` | `plugin-music/actions/music.ts` | `MUSIC` |
| `music-music-library.<locale>.ts` | `plugin-music/actions/musicLibrary.ts` | `MUSIC_LIBRARY` |
| `music-play-audio.<locale>.ts` | `plugin-music/actions/playAudio.ts` | `PLAY_AUDIO` |
| `music-playback-op.<locale>.ts` | `plugin-music/actions/playbackOp.ts` | `PLAYBACK` |
| `browser-manage-bridge.<locale>.ts` | `plugin-browser/actions/manage-browser-bridge.ts` | `MANAGE_BROWSER_BRIDGE` |
| `cu-desktop.<locale>.ts` | `plugin-computeruse/actions/desktop.ts` | `DESKTOP` |
| `cu-use-computer.<locale>.ts` | `plugin-computeruse/actions/use-computer.ts` | `COMPUTER_USE` |

## Identifier resolution + spread concatenation (now in scope)

The harness's AST extractor now follows Identifier references and spread
elements end-to-end. Before this change, an action whose `examples:` field
referenced an external constant (`examples: musicExamples`) or composed
several sub-action example arrays via spread (`examples: [...playlistOpExamples,
...searchYouTubeExamples, ...(playbackOp.examples ?? [])]`) would fail
extraction with `Could not locate an 'examples' array literal`. With
identifier-resolved + spread-resolved AST extraction:

- `plugin-music/actions/music.ts` (`MUSIC`) is now extractable directly
  from source: 32 example pairs concatenated across 5 sub-actions.
- `plugin-music/actions/musicLibrary.ts` (`MUSIC_LIBRARY`): 16 example
  pairs concatenated across 4 sub-actions, all imported from sibling
  `*.ts` files.
- Action names declared as `name: ACTION_NAME` (Identifier-referencing a
  string const) are resolved automatically — previously these required
  `--action-name=NAME` to be passed manually.

The two music actions above had been pre-translated by the bulk-pass
operator using `--action-name=` overrides on a hand-tweaked harness; the
extractor enhancement makes those workarounds unnecessary so future re-runs
(e.g. when source actions change or new locales are added) work without
manual intervention.

## Still pending — future bulk passes

Out of scope for this round (does not violate the conservative budget cap):

- Translation packs for the long tail of plugins beyond the top external
  set (e.g. `plugin-twitter`, `plugin-discord`, `plugin-bluebubbles`,
  the various `plugin-{telegram,slack,whatsapp,…}` connectors). Their
  example-bearing actions are not yet covered.
- `plugin-shell/actions/clearHistory.ts` is **not** covered: its action
  is constructed dynamically from a `requireActionSpec("CLEAR_SHELL_HISTORY")`
  call (`spec.examples`), and the harness's literal-only AST extractor
  cannot statically reach the example pairs. Fix path: either inline the
  examples literal in the action source, or extend the harness to
  resolve `requireActionSpec` references via the ts-morph type checker.
- The agent-skills plugin ships eight action source files but they all
  declare `name: "SKILL"` (op-fanout pattern) — only `as-skill.{es,fr,ja}.ts`
  + `as-use-skill.{es,fr,ja}.ts` are kept; the other six would have
  collided on the registry's `<actionName>.example.<index>` composite
  key. If the SKILL family is ever split into per-op action names, the
  retired files can be regenerated.
- Inline `action: ACTION_NAME` references INSIDE example content. The
  extractor still drops these from the structured `action` field on each
  pair (the action-name resolver only walks the action's `name:` and
  `examples:` properties, not nested literal content). The inline
  action-token tests guard against translation regressions; resolving
  these would require deeper per-pair AST descent and was not needed for
  the current bulk pass.

## Test coverage

- `test/translation-harness.test.ts` (7 assertions): bulk-pack
  registration, `es`/`fr` action-coverage parity, `<actionName>.example.<index>`
  key shape, both placeholder conventions (`{{name1}}/{{agentName}}` and
  `{{user1}}/{{agent}}`), action-token shape (`UPPER_SNAKE` plus optional
  `.verb` suffix), placeholder preservation in body text, and non-empty
  translated text.
- `test/translation-harness-extractor.test.ts` (5 assertions): exercises
  the AST extractor strategies directly via fixtures under
  `test/fixtures/translate-action-examples/`. Covers the inline-array
  regression, identifier-resolved external refs (`examples: SOMETHING`),
  spread concatenation (`[...A, ...B.examples ?? [], inlinePair]`),
  monotonic index ordering across spreads, and the fail-loud diagnostic
  path (unresolvable initializer → non-zero exit + source location).
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
