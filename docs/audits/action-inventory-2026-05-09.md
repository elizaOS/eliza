# Project-Wide Action Inventory — 2026-05-09

Repo: `/Users/shawwalters/milaidy/eliza`. Branch: `shaw/more-cache-toolcalling`.
Scope: every elizaOS `Action` defined under `plugins/`, `packages/agent/src/`,
`packages/core/src/`, and `packages/skills/`.

This is a discovery-and-recommendation audit. No source files were modified.

---

## 1. Discovery method + scope

Discovery passes (run from repo root):

```
grep -rln -E '(^export const \w+:\s*Action\b|satisfies\s+Action\b)' \
  plugins/ packages/agent/src/ packages/core/src/ packages/skills/ \
  --include='*.ts'
```

Filters applied to that file list:

- Excluded: `node_modules/`, `dist/`, `*.test.ts`, `*.spec.ts`, `__tests__/`,
  `packages/examples/**`, `packages/benchmarks/**`.
- Excluded niche / example apps and stubs per task spec:
  `app-2004scape`, `app-companion`, `app-phone`, `app-polymarket`,
  `app-scape`, `plugin-roblox`, `plugin-minecraft`.
- Other `app-*` packages (`app-hyperliquid`, `app-shopify`, `app-elizamaker`,
  `app-documents`, `app-defense-of-the-agents`, `app-screenshare`,
  `app-task-coordinator`, `app-trajectory-logger`, `app-vincent`, `app-wallet`,
  `app-wifi`, `app-hyperscape`, `app-form`, `app-knowledge`, `app-browser`,
  `app-workflow-builder`, `app-contacts`, `app-babylon`, `app-clawville`)
  contributed **zero** Action exports under `src/actions/` or anywhere matching
  the discovery pass and so do not appear below.

Per-action metadata was extracted with a custom AST-light parser
(`/tmp/extract-actions.mjs` during this run) that:

1. Parses `export const X: Action(\s*&[\s\S]*?)?\s*=\s*\{ ... \}` and
   `export const X = { ... } satisfies Action`.
2. Reads `name`, `description`, `descriptionCompressed`, `similes`, `examples`,
   `tags`, `keywords`, `category`, `domain`, `validate`, `handler`,
   `parameters`, and `subActions`.
3. Resolves spread enums (`enum: [...IDENT]`) by searching the same file.
4. Follows `parameters: IDENT,` references when the parameters array is
   declared as a top-level const.
5. Resolves `name: spec.name,` / `name: SOMECONST,` and `description:
   spec.description,` to their underlying string by inspecting
   `requireActionSpec("...")` calls and constant declarations.
6. Cross-references the generated spec catalogue
   (`packages/core/src/generated/action-docs.ts` and any plugin
   `generated/specs/specs.ts`) so that actions sourcing their description /
   similes / examples from `requireActionSpec(...)` get real lengths.
7. Tags each Action as `R` (registered in a `Plugin = { actions: [...] }`
   literal) or `H` (helper-only — exported but never registered into a
   Plugin's `actions` array).

Eight additional actions are factory-built with `createPageActionGroupAction`
in `packages/agent/src/actions/page-action-groups.ts` and were added by hand
to the inventory (the regex above will not catch a factory return value).

### Headline numbers

| Bucket | Count |
|---|---|
| Action declarations (`Action` exports + factory-built page groups) | **159** |
| Of those: registered into a `Plugin` `actions: [...]` literal | **100** |
| Helper-only exports (used as inner handlers by an umbrella) | **59** |
| Distinct registered action `name` values | **99** |
| Plugins / packages contributing actions (after exclusions) | **27** |

The 59 "helper-only" exports are not bugs — they are subaction-level Actions
held in import scope and dispatched to from an umbrella's handler (e.g. the
nine MESSAGE triage handlers in `packages/core/.../messaging/triage/actions/*`,
the per-op Linear actions, the per-skill agent-skills actions). They are
counted in the inventory because they ARE `Action` objects; they just are not
the surface the planner sees on its own.

---

## 2. Per-plugin Action table

Sorted by total action count descending. `Subactions` counts the size of the
primary discriminator enum (`op` / `subaction` / `verb` / `kind` / etc.) on the
umbrella action(s); for actions that use a `subActions: [...]` array instead
(see §4), that count is used. Plain handler actions show 0.

| Plugin | Total | Registered | Helper | Subactions |
|---|---|---|---|---|
| `app-lifeops` | 37 | 26 | 11 | 51 |
| `packages/core` | 33 | 14 | 19 | 59 |
| `packages/agent` | 24 | 20 | 4 | 51 |
| `plugin-coding-tools` | 12 | 9 | 3 | 6 |
| `plugin-linear` | 11 | 1 | 10 | 11 |
| `plugin-agent-skills` | 8 | 2 | 6 | 9 |
| `plugin-music` | 4 | 1 | 3 | 23 |
| `plugin-wallet` | 4 | 2 | 2 | 16 |
| `plugin-ngrok` | 3 | 3 | 0 | 0 |
| `plugin-github` | 3 | 3 | 0 | 7 |
| `plugin-computeruse` | 2 | 2 | 0 | 16 |
| `plugin-browser` | 2 | 2 | 0 | 28 |
| `plugin-mysticism` | 2 | 2 | 0 | 5 |
| `plugin-vision` | 1 | 1 | 0 | 6 |
| `plugin-suno` | 1 | 1 | 0 | 0 |
| `plugin-tailscale` | 1 | 1 | 0 | 2 |
| `plugin-nostr` | 1 | 1 | 0 | 0 |
| `plugin-todos` | 1 | 1 | 0 | 0 |
| `plugin-discord` | 1 | 1 | 0 | 0 |
| `plugin-calendly` | 1 | 1 | 0 | 2 |
| `plugin-mcp` | 1 | 0 | 1 | 4 |
| `plugin-shopify` | 1 | 1 | 0 | 5 |
| `plugin-workflow` | 1 | 1 | 0 | 0 |
| `plugin-tunnel` | 1 | 1 | 0 | 0 |
| `plugin-form` | 1 | 1 | 0 | 0 |
| `plugin-agent-orchestrator` | 1 | 1 | 0 | 14 |
| `plugin-shell` | 1 | 1 | 0 | 0 |

### Notes on this table

- `packages/core` has the lowest registered ratio (14 / 33 = 42%). That is
  expected — most of its 33 Actions are MESSAGE / TODO triage handlers
  imported and dispatched from the MESSAGE / TODO umbrellas
  (`packages/core/src/features/advanced-capabilities/actions/message.ts`
  and `.../todos/actions/todo.ts`).
- `plugin-agent-skills` registers only 2 of 8: SKILL umbrella (`skill.ts`)
  and USE_SKILL (`use-skill.ts`). The other 6 files
  (`toggle-skill.ts`, `search-skills.ts`, `install-skill.ts`,
  `sync-catalog.ts`, `get-skill-details.ts`, `uninstall-skill.ts`) all
  declare `name: "SKILL"` but are dispatched to via the umbrella — see §5.4.
- `plugin-linear`'s 10 helper actions (`createIssueAction`, `getIssueAction`,
  ...) all declare distinct names (`CREATE_LINEAR_ISSUE`, `GET_LINEAR_ISSUE`,
  ...) but are dispatched to from the registered LINEAR umbrella's `op` enum.
  This is the "named subaction handler" pattern; LINEAR is the only thing the
  planner sees.

---

## 3. Per-action detail table

One row per action; sorted by primary subaction count descending, then by
name. `R` = registered into a `Plugin` `actions: [...]` literal, `H` = helper
(exported but never registered as a top-level action).

| Name | Plugin | R/H | Subs | Desc | Sim | Ex | Locales |
|---|---|---|---|---|---|---|---|
| `BROWSER` | `plugin-browser` | R | 24 | 634 | 17 | 2 | en |
| `MESSAGE` | `packages/core` | R | 22 | 233 | 5 | 1 | en |
| `TASKS` | `plugin-agent-orchestrator` | R | 14 | 90 | 93 | 0 | — |
| `COMPUTER_USE` | `plugin-computeruse` | R | 13 | 571 | 17 | 0 | — |
| `MUSIC` | `plugin-music` | R | 12 | 191 | 0 | 0 | en |
| `CALENDAR` | `app-lifeops` | R | 11 | 92 | 3 | 9 | en |
| `LINEAR` | `plugin-linear` | R | 11 | 289 | 22 | 4 | en |
| `PLUGIN` | `packages/agent` | R | 11 | 64 | 19 | 8 | en |
| `SCHEDULED_TASK` | `app-lifeops` | R | 11 | 340 | 14 | 0 | — |
| `CONTACT` | `packages/agent` | R | 9 | 94 | 49 | 4 | en |
| `LIFE` | `app-lifeops` | R | 9 | 650 | 21 | 10 | en |
| `LIQUIDITY` | `plugin-wallet` | R | 8 | 256 | 15 | 0 | en |
| `GOOGLE_CALENDAR` | `app-lifeops` | R | 7 | 47 | 22 | 7 | en |
| `MUSIC_LIBRARY` | `plugin-music` | H | 6 | 344 | 0 | 0 | en |
| `SKILL` | `plugin-agent-skills` | R | 6 | 310 | 0 | 4 | en |
| `VISION` | `plugin-vision` | R | 6 | 258 | 14 | 6 | en |
| `CONNECTOR` | `app-lifeops` | R | 5 | 67 | 6 | 4 | en |
| `MANAGE_SECRET` | `packages/core` | R | 5 | 68 | 7 | 3 | en |
| `PLAYBACK` | `plugin-music` | H | 5 | 68 | 11 | 5 | en |
| `RUNTIME` | `packages/agent` | R | 5 | 433 | 30 | 5 | en |
| `SET_SECRET` | `packages/core` | R | 5 | 72 | 8 | 3 | en |
| `SHOPIFY` | `plugin-shopify` | R | 5 | 298 | 19 | 4 | en |
| `TODO` | `packages/core` | R | 5 | 108 | 3 | 0 | — |
| `TRIGGER` | `packages/agent` | R | 5 | 166 | 0 | 2 | en |

…full 159-row table, grouped by plugin, is in §3a immediately below; the
machine-readable copy is in §7.

### 3a. Per-plugin per-action detail (grouped)

The complete grouped table is appended at the bottom of this document
(§Appendix A) so the executive summary above stays scannable.

---

## 4. Aggregate stats

Across all 159 Action declarations:

| Metric | min | p25 | median | mean | p75 | max | sum |
|---|---|---|---|---|---|---|---|
| primary subactions, nonzero only (54 actions) | 1 | 3 | 4 | 5.67 | 6 | 24 | 306 |
| primary subactions, all 159 (incl 0) | 0 | 0 | 0 | 1.92 | 3 | 24 | 306 |
| description length (chars) | 28 | 74 | 127 | 173.55 | 233 | 650 | 27 594 |
| similes count | 0 | 3 | 4 | 7.14 | 8 | 93 | 1 136 |
| examples count | 0 | 0 | 2 | 1.87 | 3 | 10 | 297 |

### Subaction histogram

| Bucket | Actions |
|---|---|
| 0 (no enum-discriminator parameter) | 105 |
| 1–2 | 9 |
| 3–5 | 29 |
| 6–10 | 7 |
| 11–15 | 7 |
| 16+ | 2 |

### Locale coverage

- 113 of 159 actions ship at least one example.
- **0 of 113 ship a non-English example.** Every `examples: [...]` array in
  the project is English-only (literal Latin / ASCII content). No CJK,
  Cyrillic, Arabic, Hebrew, or even accented-Latin example was found.

### Discriminator parameter naming (umbrellas only)

| Param name | Used as primary discriminator by N actions |
|---|---|
| `op` | 26 |
| `subaction` | 13 |
| `action` | 10 |
| `operation` | 2 |
| `mode` | 1 |
| (no canonical discriminator — picker fell back to a secondary enum) | 12 |

This is the single biggest naming-consistency finding of the audit. There is
no single canonical name for "select the umbrella op". `op` is the most
common, but `subaction`, `action`, and `operation` are all in active use.

---

## 5. Gap findings + recommendations

The recommendations below are conservative. Each lists the concrete actions
involved and a one-line action: **keep / extend / fold / split / translate**.
Nothing is implemented — this is a report.

### 5.1 Missing or weak descriptions

Four actions have a `description` shorter than 30 characters or synthesized
from `JSON.stringify(...)`:

| Action | File | Length | Notes |
|---|---|---|---|
| `CLEAR_LINEAR_ACTIVITY` | `plugins/plugin-linear/src/actions/clearActivity.ts:1` | 29 | Helper. Bare label-style description. |
| `CREATE_LINEAR_ISSUE` | `plugins/plugin-linear/src/actions/createIssue.ts:1` | 28 | Helper. |
| `DELETE_LINEAR_COMMENT` | `plugins/plugin-linear/src/actions/deleteComment.ts:1` | 29 | Helper. |
| `MANAGE_BROWSER_BRIDGE` | `plugins/plugin-browser/src/actions/manage-browser-bridge.ts:564` | 28 (proxy via `descriptionCompressed`) | `description: JSON.stringify({...})` — a structured-blob description, not a sentence. The compressed form is human; the raw description is JSON. |

**Recommendation:** `extend` for the three Linear helpers — they are dispatched
to from LINEAR's `op` enum, but the planner can still call them directly via
the per-op spec name and a 28-char description is too thin to disambiguate
from the umbrella. For `MANAGE_BROWSER_BRIDGE`, **keep** but document the
JSON-blob convention, or **fold** the JSON-blob description into a normal
prose description with the structured part moved to a `subActions` field —
the JSON.stringify trick is used nowhere else in the codebase so it is an
outlier.

### 5.2 Zero similes

Thirteen actions ship zero similes:

| Action | File | Notes |
|---|---|---|
| `MUSIC` | `plugins/plugin-music/src/actions/music.ts:224` | Spreads similes from sub-actions at module scope. The literal field is `similes: [...musicLibraryAction.similes ?? [], ...]`. The extractor sees zero literals; the runtime value is non-empty. **Mark this as a parser limitation, not a real gap.** |
| `MUSIC_LIBRARY` | `plugins/plugin-music/src/actions/musicLibrary.ts:1` | Helper — same spread pattern. |
| `SKILL` (×6 files) | `plugins/plugin-agent-skills/src/actions/{toggle,install,sync-catalog,uninstall,skill,get-skill-details}.ts` | These are real zero-simile actions. Six handler files, each declaring `name: "SKILL"`, `similes: []`. The umbrella `skillAction` in `skill.ts` also has empty similes. |
| `USE_SKILL` | `plugins/plugin-agent-skills/src/actions/use-skill.ts:170` | Real zero. `similes: []` literal. The canonical entry-point for invoking a skill has no aliases. |
| `TAILSCALE` | `plugins/plugin-tailscale/src/actions/tailscale.ts` | Real zero. |
| `TRIGGER` | `packages/agent/src/actions/trigger.ts` | Real zero. Uses `descriptionCompressed` and a strong `op` enum but no similes. |
| `STREAM` | `packages/agent/src/actions/stream-control.ts` | Helper (not registered). Real zero. |
| `SEND_TO_ADMIN` | `packages/core/src/features/autonomy/action.ts` | Helper. Real zero. |
| `ROLE` | `packages/core/src/features/advanced-capabilities/actions/role.ts` | Helper. Real zero (the registered `updateRoleAction` is a different export and was wrapped via `withCanonicalActionDocs`). |

**Recommendation:** `extend` `USE_SKILL` and the SKILL umbrella with at least
3–5 similes (`INVOKE_SKILL`, `RUN_SKILL`, `EXECUTE_SKILL`, `CALL_SKILL`,
`USE_AGENT_SKILL`). These are advertised in the project README as the
canonical entry points and zero similes hurts planner recall. `extend`
TAILSCALE and TRIGGER similarly. The MUSIC / MUSIC_LIBRARY entries are
parser artifacts and can be ignored for this gap.

### 5.3 Zero or one example

77 of 159 actions (48%) ship 0 or 1 examples:

- **46 actions ship zero examples.** Highlights: `COMPUTER_USE` (umbrella with
  13 subactions, 0 examples), `SCHEDULED_TASK` (11 subactions, 0 examples),
  `MUSIC` (12 subactions, 0 examples), `MUSIC_LIBRARY` (6 subactions, 0
  examples), `LIQUIDITY` (8 subactions, 0 examples), `WORKFLOW` (registered,
  0 examples), `TODO` in `plugin-todos` (registered, 0 examples). Top-9 by
  subaction count includes SCHEDULED_TASK and MUSIC with literally zero
  worked examples — the planner has to learn dispatch from descriptions
  alone.
- **31 actions ship exactly one example.** Almost all of `packages/core`'s
  MESSAGE handlers (`triageMessagesAction`, `draftReplyAction`,
  `draftFollowupAction`, `sendDraftAction`, `manageMessageAction`,
  `respondToMessageAction`, `listInboxAction`, `scheduleDraftSendAction`,
  `searchMessagesAction`) ship exactly one example each, plus the LINEAR
  helpers (`UPDATE_LINEAR_ISSUE`, `LIST_LINEAR_COMMENTS`,
  `DELETE_LINEAR_COMMENT`).

**Recommendation:** `extend` the high-subaction umbrellas first
(`COMPUTER_USE`, `SCHEDULED_TASK`, `MUSIC`, `LIQUIDITY`, `MUSIC_LIBRARY`).
For each, target one worked example per top-3 subactions — that is at most
~35 new examples to take the worst offenders out of the zero-example bucket.
The MESSAGE handlers in core are dispatched from the MESSAGE umbrella so
their per-op example is mostly informational; the umbrella itself only ships
1 example for 22 ops, which IS a planner-learning hazard — extend
`messageAction.examples` (currently 1) to at least one example per op group
(send / read / list / triage / draft / search → 6 examples).

### 5.4 English-only examples (translation candidates)

**113 of 113 example-bearing actions ship English-only content.** No action
has a single non-Latin example. Given the project documents iMessage,
WeChat, Feishu, Telegram, and Line connectors and ships a `plugin-feishu`,
this is a meaningful gap — none of the underlying action examples teach the
planner what a Chinese / Japanese / Korean / Arabic message looks like.

**Recommendation:** `translate` — for the umbrella actions that the planner
sees most often, add at least one CJK and one Cyrillic example. Highest
priority by traffic shape:

1. `MESSAGE` (`packages/core/.../message.ts`) — universal messaging surface.
2. `CONTACT` (`packages/agent/src/actions/contact.ts`) — name lookups have
   to handle non-Latin display names.
3. `REPLY` (`packages/core` — name comes from `requireActionSpec("REPLY")`,
   description 388 chars, 4 examples, all English).
4. `IGNORE`, `NONE` (basic-capabilities — very high call rate, ship 5 / 4
   examples respectively, all English).
5. `LIFE`, `LIFEOPS` (`app-lifeops`) — owner-only commands, but the owner
   may write in their native language.

This is conservative: just the umbrellas, just one CJK + one Cyrillic per.

### 5.5 Inconsistent subaction naming

The discriminator parameter itself is inconsistent across the project:

```
op:         26 actions   ← canonical-ish
subaction:  13 actions
action:     10 actions   ← BROWSER uses both `subaction` and a legacy
                           `action` alias; COMPUTER_USE uses `action`;
                           GITHUB_PR_OP uses `action`.
operation:   2 actions   ← MESSAGE, MANAGE_SECRET
mode:        1 action    ← USE_SKILL (`mode: guidance|script|auto` —
                           this is genuinely a mode, not a subaction)
```

Within an action's subaction enum, only ONE action mixes naming styles:

| Action | Mix | Values |
|---|---|---|
| `MUSIC_LIBRARY` (helper, `plugins/plugin-music/src/actions/musicLibrary.ts`) | snake_case + kebab-case | `playlist, play-query, play_query, search-youtube, search_youtube, download` |

This is a **legacy-alias bug**: both `play-query` and `play_query`,
`search-youtube` and `search_youtube` are accepted. The kebab forms appear
to be legacy.

**Recommendation:** `fold` — pick one naming convention (snake_case to match
the rest of the project — `BROWSER`, `MUSIC`, `LINEAR`, `CONTACT`, `MESSAGE`
all use snake_case for subaction values) and remove the kebab aliases from
`MUSIC_LIBRARY`. The umbrella `MUSIC` already only exposes the snake_case
forms, so this is purely a helper-side cleanup.

For the discriminator parameter name itself: `keep` `op` as canonical and
treat `subaction` / `action` / `operation` as legacy. There is no
high-confidence migration path here — moving 13 + 10 + 2 = 25 actions to a
new param name would break their existing call sites and the spec catalogue.

### 5.6 Subactions not surfaced in similes

Eleven actions have a primary subaction enum that is larger than the simile
list, meaning the planner has fewer aliases than dispatch paths:

| Action | Similes | Subactions |
|---|---|---|
| `MESSAGE` (umbrella) | 5 | 22 |
| `BROWSER` | 17 | 24 |
| `MUSIC` | 0 | 12 |
| `CALENDAR` (lifeops umbrella) | 3 | 11 |
| `LINEAR` | 22 | 11 — OK (under, similes >= subs) |
| `MUSIC_LIBRARY` | 0 | 6 |
| `SKILL` umbrella | 0 | 6 |
| `TRIGGER` | 0 | 5 |
| `USE_SKILL` | 0 | 3 |
| `ROLE` | 0 | 3 |
| `TAILSCALE` | 0 | 2 |
| `STREAM` | 0 | 2 |

**Recommendation:** `extend` MUSIC (give it the synthesized similes that the
sub-actions provide — but at the literal-source level, not as a runtime
spread, so the spec catalogue picks them up). Likewise for MUSIC_LIBRARY.
Extend MESSAGE's 5 similes to at least 8–10 (it has 22 ops and the spec
ones are mostly `MESSAGE`-as-noun aliases). Extend CALENDAR (3 similes
covering 11 ops). The five zero-simile umbrellas in this list (MUSIC,
MUSIC_LIBRARY, SKILL, TRIGGER, ROLE) overlap with §5.2.

### 5.7 Cross-plugin near-duplicates (fold candidates)

**Same action `name` registered by multiple plugins:**

| Name | Plugins | Notes |
|---|---|---|
| `TODO` | `plugin-todos` (`plugins/plugin-todos/src/actions/todo.ts`), `packages/core` (`packages/core/src/features/advanced-capabilities/todos/actions/todo.ts`) | Both register an Action named `TODO`. The plugin-todos one is a thin no-similes umbrella; the core one is a 5-op umbrella with `subActions: [CREATE_TODO, COMPLETE_TODO, LIST_TODOS, EDIT_TODO, DELETE_TODO]`. Whichever loads later wins by name. |

**Same `name` declared by helper exports across files:** `MESSAGE` (10
files in `packages/core`), `SKILL` (8 files in `plugin-agent-skills`),
`CALENDAR` / `GOOGLE_CALENDAR` (lifeops). These are the documented umbrella
+ handlers pattern and are NOT a duplication bug.

**Same verb across multiple umbrellas (fold-or-keep judgement calls):**

- `delete` appears as a subaction value in 7 umbrellas across `app-lifeops`,
  `packages/agent`, and `packages/core`.
- `create` in 6 umbrellas (`app-lifeops`, `plugin-agent-orchestrator`,
  `packages/agent`).
- `update` in 6 umbrellas (`app-lifeops`, `packages/agent`).
- `list` in 5 umbrellas across 3 packages.
- `status` in 3 umbrellas (`app-lifeops`, `packages/agent`).
- `disconnect` in 2 (`app-lifeops`, `packages/agent`).

**Recommendation:**

1. `fold` `TODO` — pick the canonical owner. `packages/core`'s TODO has the
   richer `subActions` array; `plugin-todos`'s TODO appears to be a
   different surface (different validation path). Verify which is loaded
   first at runtime; **deprecate** the loser. **Do not** silently let
   "whichever loads later wins" be the resolution rule.
2. `keep` the verb-reuse pattern (`delete`, `create`, `update`, `list`).
   These are genuinely separate domain operations (delete a calendar event
   vs delete a todo vs delete a Linear issue) and folding them into a single
   umbrella would lose information. The `connect/disconnect/status` triple
   that the spec asked about IS spread across two domains
   (`app-lifeops/CONNECTOR` for app-side connectors and
   `packages/agent/PLUGIN`'s `connect|disconnect|status` for runtime
   plugins) — `keep` separate; they touch different services.

### 5.8 Sort/reorganization opportunities

1. **`MESSAGE.handoff` should be a subaction of MESSAGE, not a top-level
   action.** `app-lifeops/src/actions/message-handoff.ts` registers an
   action named `MESSAGE.handoff` (note the literal dot in the action name).
   The dot is a unique convention — no other action in the project uses
   dot-suffixed names. The MESSAGE umbrella in `packages/core` has 22 ops
   already; either fold `handoff` into MESSAGE's `op` enum, or rename to
   `MESSAGE_HANDOFF` for naming consistency.
2. **`SKILL` umbrella is empty-string-similes.** With 6 ops, USE_SKILL
   alongside, and zero similes, the planner cannot route catalog ops by
   alias. Extend (§5.2 / §5.6).
3. **`packages/agent`'s `codeAction`, `agentInboxAction`, `analyzeImageAction`
   are exported but never registered.** None of them appear in any
   `Plugin = { actions: [...] }` literal in the repo (verified by grep
   across `packages/`, `plugins/`, and `apps/`). They are either dead code
   or pending registration. Confirmed at:
   - `packages/agent/src/actions/code-umbrella.ts:1`
   - `packages/agent/src/actions/agent-inbox.ts:1`
   - `packages/agent/src/actions/media.ts` (`mediaActions` array exists but
     is not consumed).
4. **`plugin-mcp/MCP` is a registered action via `withMcpContext(mcpAction)`
   wrapping; my discovery flagged it as helper-only because the
   registration-time wrapper doesn't textually preserve `mcpAction` as a
   bare identifier in the `actions: [...]` literal.** Treat it as
   registered. Same situation with `roleAction`, `searchExperiencesAction`,
   `roomOpAction`, `documentAction` — the core wraps these via
   `withCanonicalActionDocs(...)` in `packages/core/src/features/advanced-
   capabilities/index.ts:95`. Six such actions are flagged H but are
   actually registered. The R/H column should be read with that caveat.
5. **PLAY_AUDIO's helpers and PLAYBACK / MUSIC_LIBRARY are all registered
   helpers under MUSIC.** The 4 `plugin-music` actions
   (`musicAction`, `musicLibraryAction`, `playbackOp`, `playAudio`) have
   only 1 registered (MUSIC). The other three are exported and dispatched
   to from MUSIC's switch, but they're full Actions with their own examples
   and similes. They could either be inlined into MUSIC's similes/examples
   array (raising MUSIC's surface vocabulary) or split out and registered
   as siblings. Today they're orphaned — the planner sees MUSIC, the
   per-handler examples never reach training.
6. **Eight `*_ACTIONS` page-group umbrellas are registered but ship zero
   examples and only 2 similes each.** `BROWSER_ACTIONS`, `WALLET_ACTIONS`,
   `CHARACTER_ACTIONS`, `SETTINGS_ACTIONS`, `CONNECTOR_ACTIONS`,
   `AUTOMATION_ACTIONS`, `PHONE_ACTIONS`, `LIFEOPS_ACTIONS`. They are
   factory-built in `packages/agent/src/actions/page-action-groups.ts`.
   The factory hard-codes a 2-simile pattern (`X_TOOLS`, `X_PAGE_ACTIONS`)
   and zero examples. **Recommendation:** make the factory accept
   `examples` and pass at least one through for each page group.
7. **`SECURITY_EVALUATOR` lives in the trust evaluators directory but is
   declared as an `Action`.** `packages/core/src/features/trust/evaluators/securityEvaluator.ts`
   exports `securityEvaluator: Action` (not `Evaluator`). Description is 77
   chars, 1 simile, 0 examples. This is either misclassified (should be an
   `Evaluator`) or genuinely an Action that lives in the evaluators folder
   for organizational reasons. Audit and classify.

---

## 6. Top 10 high-impact follow-ups (ranked)

1. **Translate / extend examples on the top umbrella actions.** No action
   in the repo ships a non-English example. The five highest-traffic
   umbrellas (`MESSAGE`, `CONTACT`, `REPLY`, `IGNORE`, `LIFE`) should each
   gain one CJK example and one Cyrillic / accented-Latin example. (~10
   examples total.) — §5.4
2. **Resolve the duplicate `TODO` registration.** `plugin-todos` and
   `packages/core` both register an action named `TODO`. Pick a canonical
   owner; deprecate the other. Today the loser is silently shadowed at
   load time. — §5.7
3. **Add similes to the SKILL family.** `USE_SKILL`, `SKILL`, and the six
   helper SKILL files all ship `similes: []`. These are documented as the
   canonical skill-invocation entry points; zero similes hurts planner
   recall. — §5.2
4. **Confirm or delete `codeAction`, `agentInboxAction`, `analyzeImageAction`
   in `packages/agent/src/actions/`.** Three Actions exported, never
   registered. Either dead code or unfinished migrations — the README
   explicitly calls them out as the new umbrellas (`USE_SKILL`, `CODE`).
   — §5.8 #3
5. **Extend MESSAGE's similes from 5 → 10+.** It has 22 ops; 5 similes
   yields a poor alias-to-op ratio. Same recommendation for `BROWSER`
   (17 sim / 24 ops), `MUSIC` (0 / 12), `CALENDAR` (3 / 11). — §5.6
6. **Pick a canonical discriminator parameter name.** `op` (26), `subaction`
   (13), `action` (10), and `operation` (2) all coexist as the umbrella
   discriminator. Document `op` as the convention and migrate the rest in
   a follow-up. The spec catalogue
   (`packages/core/src/generated/action-docs.ts`) makes this safer because
   it is generated. — §4 / §5.5
7. **Fold the kebab-case aliases out of `MUSIC_LIBRARY`.** It is the only
   action in the project with mixed `play-query` / `play_query` and
   `search-youtube` / `search_youtube` enum values. — §5.5
8. **Bring `MESSAGE.handoff` (`app-lifeops`) into naming-convention
   compliance.** Either rename to `MESSAGE_HANDOFF` or fold into
   `MESSAGE`'s `operation` enum. The literal dot in an action name is a
   one-off. — §5.8 #1
9. **Extend the page-action-group factory to accept `examples`.** Eight
   registered actions (`BROWSER_ACTIONS`, `WALLET_ACTIONS`, ...) ship 0
   examples each and only 2 boilerplate similes from
   `createPageActionGroupAction`. — §5.8 #6
10. **Add 1 example per top-3 op for the zero-example umbrellas.**
    `COMPUTER_USE`, `SCHEDULED_TASK`, `MUSIC`, `LIQUIDITY`, `MUSIC_LIBRARY`,
    `TODO` (`plugin-todos`), and `WORKFLOW` are registered with subactions
    > 0 and ship zero examples. ~21 worked examples removes the worst
    cases. — §5.3

---

## Caveats and known limitations of the discovery

1. **Action exports vs registered actions.** 159 Action declarations are
   counted; only 100 of those are registered into a `Plugin = { actions: [...] }`
   literal. The other 59 are imported by an umbrella's handler and never
   surface independently. The R/H flag in §3 documents this. Some R/H
   classifications are over-conservative because of registration-time
   wrappers like `withCanonicalActionDocs(...)` and `withMcpContext(...)`
   — see §5.8 #4. About 6 actions are flagged H but are actually
   registered after the wrapper.
2. **Spread enums.** Where an action declares `enum: [...SOME_CONST]`, the
   extractor resolves `SOME_CONST` only if it is defined in the same file.
   `TOKEN_INFO`'s `subaction` enum is sourced from
   `plugin-wallet/src/analytics/token-info/types.ts` — the extractor falls
   back to a secondary enum and reports an underestimate. `SET_SECRET`
   has the same issue.
3. **Spread similes / examples.** `MUSIC` and `MUSIC_LIBRARY` build their
   `similes` field with `[...musicLibraryAction.similes ?? [], ...]` at
   module scope. The extractor counts the literal array length (zero) and
   not the runtime value. The §5.2 zero-simile finding flags both, but
   only MUSIC_LIBRARY's helper-side similes are real. The runtime
   `similes` for MUSIC is the union of its handlers' similes. This is also
   why the spec catalogue
   (`packages/core/src/generated/action-docs.ts`) is the right source of
   truth for similes and examples; the audit prefers the spec value when
   the literal is zero.
4. **Page action groups.** Eight Actions in
   `packages/agent/src/actions/page-action-groups.ts` are factory-built
   via `createPageActionGroupAction({...})`. The discovery regex does not
   match factory-returned values; they were added by hand to the
   inventory. If new factories are added later they may be missed by this
   audit method.
5. **`subActions:` field semantics.** Four actions use `subActions: [...]`
   instead of an `op`/`subaction` enum: `FILE`
   (`subActions: [readAction, writeAction, editAction]`),
   `CALENDAR` (lifeops, 4 sub-action references), `CODE`
   (`subActions: [...CODE_SUB_ACTIONS]`), `TODO` (5 string names). The
   audit treats `subActions: [...]` length as the subaction count for these
   actions. This convention is a parallel-but-incompatible mechanism to the
   `op`-enum convention; it is not a finding to flag, but it is a
   documented inconsistency that makes machine analysis harder.
6. **`packages/skills`.** The discovery pass scanned `packages/skills`. No
   Action declarations were found there; the package contains skill-handler
   helpers, not Actions.
7. **The `eliza/` submodule.** Per `git submodule status`, no submodules
   are configured in this checkout. All sources scanned are tracked
   directly in this repository.

---

## 7. Raw inventory JSON appendix

For mechanical iteration, the full inventory is in
`/tmp/inventory-slim.json` during this run. The schema is captured by the
following sample entry:

```json
{
  "name": "BROWSER",
  "varName": "browserAction",
  "plugin": "plugin-browser",
  "file": "plugins/plugin-browser/src/actions/browser.ts",
  "isRegistered": true,
  "factoryBuilt": false,
  "descriptionLength": 634,
  "descriptionFromSpec": false,
  "similesCount": 17,
  "examplesCount": 2,
  "examplesLocales": ["en"],
  "primarySubactionParam": "subaction",
  "primarySubactionCount": 24,
  "primarySubactionValues": ["back","click","close","..."],
  "subActionsCount": 0,
  "subActionsField": null,
  "paramEnumGroups": [
    { "paramName": "subaction", "count": 24 },
    { "paramName": "action", "count": 31 }
  ],
  "blockLineCount": 213
}
```

To regenerate: rerun the extractor pipeline (the scripts live under `/tmp/`
during this audit and are reproducible from the methodology in §1). A future
agent can keep this inventory current by:

1. Re-running the discovery grep.
2. Re-running the extractor on the resulting file list.
3. Re-merging with `packages/core/src/generated/action-docs.ts` and any
   plugin-local `generated/specs/specs.ts`.
4. Re-classifying R/H by walking each `Plugin = {...}` literal.

---

## Appendix A — Per-plugin per-action detail

This is the full §3a grouped table. Columns: `Name` / `var` / `R or H` /
`Subs` / `Desc` chars / `Sim` / `Ex` / `File`.

### `app-lifeops` (37 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `APP_BLOCK` | `appBlockAction` | R | 0 | 101 | 8 | 3 | `app-lifeops/src/actions/app-block.ts` |
| `AUTOFILL` | `autofillAction` | R | 0 | 76 | 4 | 3 | `app-lifeops/src/actions/autofill.ts` |
| `BOOK_TRAVEL` | `bookTravelAction` | R | 0 | 190 | 5 | 3 | `app-lifeops/src/actions/book-travel.ts` |
| `CALENDAR` | `calendarAction` | R | 11 | 92 | 3 | 9 | `app-lifeops/src/actions/calendar.ts` |
| `CALENDLY` | `calendlyAction` | R | 0 | 67 | 7 | 3 | `app-lifeops/src/actions/lib/calendly-handler.ts` |
| `CHECK_AVAILABILITY` | `checkAvailabilityAction` | H | 0 | 67 | 3 | 2 | `app-lifeops/src/actions/lib/scheduling-handler.ts` |
| `CHECKIN` | `checkinAction` | H | 0 | 156 | 10 | 2 | `app-lifeops/src/actions/checkin.ts` |
| `CONNECTOR` | `connectorAction` | R | 5 | 67 | 6 | 4 | `app-lifeops/src/actions/connector.ts` |
| `DEVICE_INTENT` | `deviceIntentAction` | R | 0 | 157 | 5 | 0 | `app-lifeops/src/actions/device-intent.ts` |
| `ENTITY` | `entityAction` | R | 0 | 297 | 10 | 4 | `app-lifeops/src/actions/entity.ts` |
| `FIRST_RUN` | `firstRunAction` | R | 0 | 84 | 7 | 2 | `app-lifeops/src/actions/first-run.ts` |
| `GOOGLE_CALENDAR` | `calendarAction` | R | 7 | 47 | 22 | 7 | `app-lifeops/src/actions/lib/calendar-handler.ts` |
| `HEALTH` | `healthAction` | R | 0 | 105 | 9 | 3 | `app-lifeops/src/actions/health.ts` |
| `LIFE` | `lifeAction` | R | 9 | 650 | 21 | 10 | `app-lifeops/src/actions/life.ts` |
| `LIFEOPS` | `lifeOpsPauseAction` | R | 0 | 98 | 7 | 3 | `app-lifeops/src/actions/lifeops-pause.ts` |
| `LIST_ACTIVE_BLOCKS` | `listActiveBlocksAction` | H | 0 | 517 | 3 | 1 | `app-lifeops/src/website-blocker/chat-integration/actions/listActiveBlocks.ts` |
| `LIST_OVERDUE_FOLLOWUPS` | `listOverdueFollowupsAction` | H | 0 | 83 | 5 | 1 | `app-lifeops/src/followup/actions/listOverdueFollowups.ts` |
| `MARK_FOLLOWUP_DONE` | `markFollowupDoneAction` | H | 0 | 77 | 5 | 1 | `app-lifeops/src/followup/actions/markFollowupDone.ts` |
| `MESSAGE.handoff` | `messageHandoffAction` | R | 0 | 200 | 7 | 2 | `app-lifeops/src/actions/message-handoff.ts` |
| `PASSWORD_MANAGER` | `passwordManagerAction` | R | 0 | 86 | 5 | 0 | `app-lifeops/src/actions/password-manager.ts` |
| `PAYMENTS` | `paymentsAction` | R | 0 | 181 | 6 | 0 | `app-lifeops/src/actions/payments.ts` |
| `PROFILE` | `profileAction` | R | 2 | 289 | 6 | 2 | `app-lifeops/src/actions/profile.ts` |
| `PROPOSE_MEETING_TIMES` | `proposeMeetingTimesAction` | H | 0 | 72 | 7 | 1 | `app-lifeops/src/actions/lib/scheduling-handler.ts` |
| `RELATIONSHIP` | `relationshipAction` | H | 0 | 247 | 8 | 6 | `app-lifeops/src/actions/relationship.ts` |
| `RELEASE_BLOCK` | `releaseBlockAction` | H | 0 | 63 | 3 | 1 | `app-lifeops/src/website-blocker/chat-integration/actions/releaseBlock.ts` |
| `REMOTE_DESKTOP` | `remoteDesktopAction` | R | 0 | 113 | 5 | 3 | `app-lifeops/src/actions/remote-desktop.ts` |
| `RESOLVE_REQUEST` | `resolveRequestAction` | R | 2 | 104 | 12 | 2 | `app-lifeops/src/actions/resolve-request.ts` |
| `SCHEDULE` | `scheduleAction` | R | 0 | 118 | 2 | 2 | `app-lifeops/src/actions/schedule.ts` |
| `SCHEDULED_TASK` | `scheduledTaskAction` | R | 11 | 340 | 14 | 0 | `app-lifeops/src/actions/scheduled-task.ts` |
| `SCHEDULING_NEGOTIATION` | `schedulingAction` | H | 0 | 68 | 6 | 4 | `app-lifeops/src/actions/lib/scheduling-handler.ts` |
| `SCREEN_TIME` | `screenTimeAction` | R | 0 | 393 | 7 | 4 | `app-lifeops/src/actions/screen-time.ts` |
| `SET_FOLLOWUP_THRESHOLD` | `setFollowupThresholdAction` | H | 0 | 78 | 3 | 1 | `app-lifeops/src/followup/actions/setFollowupThreshold.ts` |
| `SUBSCRIPTIONS` | `subscriptionsAction` | R | 3 | 175 | 5 | 0 | `app-lifeops/src/actions/subscriptions.ts` |
| `TOGGLE_FEATURE` | `toggleFeatureAction` | R | 0 | 127 | 6 | 2 | `app-lifeops/src/actions/toggle-feature.ts` |
| `UPDATE_MEETING_PREFERENCES` | `updateMeetingPreferencesAction` | H | 0 | 72 | 7 | 2 | `app-lifeops/src/actions/lib/scheduling-handler.ts` |
| `VOICE_CALL` | `voiceCallAction` | R | 1 | 381 | 6 | 3 | `app-lifeops/src/actions/voice-call.ts` |
| `WEBSITE_BLOCK` | `websiteBlockAction` | R | 0 | 595 | 7 | 4 | `app-lifeops/src/actions/website-block.ts` |

### `packages/core` (33 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `CHARACTER` | `characterAction` | R | 3 | 272 | 11 | 5 | `core/src/features/advanced-capabilities/personality/actions/character.ts` |
| `CHOOSE_OPTION` | `choiceAction` | H | 0 | 62 | 7 | 0 | `core/src/features/basic-capabilities/actions/choice.ts` |
| `COMPLETE_TODO` | `completeTodoAction` | R | 0 | 47 | 3 | 0 | `core/src/features/advanced-capabilities/todos/actions/complete-todo.ts` |
| `CREATE_PLAN` | `createPlanAction` | R | 0 | 67 | 4 | 0 | `core/src/features/advanced-planning/actions/create-plan.ts` |
| `CREATE_TODO` | `createTodoAction` | R | 0 | 95 | 3 | 0 | `core/src/features/advanced-capabilities/todos/actions/create-todo.ts` |
| `DELETE_TODO` | `deleteTodoAction` | R | 0 | 41 | 2 | 0 | `core/src/features/advanced-capabilities/todos/actions/delete-todo.ts` |
| `DOCUMENT` | `documentAction` | H | 3 | 140 | 8 | 2 | `core/src/features/documents/actions.ts` |
| `EDIT_TODO` | `editTodoAction` | R | 3 | 82 | 3 | 0 | `core/src/features/advanced-capabilities/todos/actions/edit-todo.ts` |
| `IGNORE` | `ignoreAction` | H | 0 | 545 | 3 | 5 | `core/src/features/basic-capabilities/actions/ignore.ts` |
| `LIST_TODOS` | `listTodosAction` | R | 3 | 89 | 3 | 0 | `core/src/features/advanced-capabilities/todos/actions/list-todos.ts` |
| `MANAGE_SECRET` | `manageSecretAction` | R | 5 | 68 | 7 | 3 | `core/src/features/secrets/actions/manage-secret.ts` |
| `MESSAGE` | `messageAction` | R | 22 | 233 | 5 | 1 | `core/src/features/advanced-capabilities/actions/message.ts` |
| `MESSAGE` (helper) | `triageMessagesAction` | H | 0 | 217 | 3 | 1 | `core/src/features/messaging/triage/actions/triageMessages.ts` |
| `MESSAGE` (helper) | `draftFollowupAction` | H | 0 | 148 | 3 | 1 | `core/src/features/messaging/triage/actions/draftFollowup.ts` |
| `MESSAGE` (helper) | `sendDraftAction` | H | 0 | 337 | 4 | 1 | `core/src/features/messaging/triage/actions/sendDraft.ts` |
| `MESSAGE` (helper) | `manageMessageAction` | H | 0 | 344 | 5 | 1 | `core/src/features/messaging/triage/actions/manageMessage.ts` |
| `MESSAGE` (helper) | `respondToMessageAction` | H | 0 | 307 | 3 | 1 | `core/src/features/messaging/triage/actions/respondToMessage.ts` |
| `MESSAGE` (helper) | `draftReplyAction` | H | 0 | 289 | 2 | 1 | `core/src/features/messaging/triage/actions/draftReply.ts` |
| `MESSAGE` (helper) | `listInboxAction` | H | 0 | 363 | 2 | 1 | `core/src/features/messaging/triage/actions/listInbox.ts` |
| `MESSAGE` (helper) | `scheduleDraftSendAction` | H | 0 | 154 | 3 | 1 | `core/src/features/messaging/triage/actions/scheduleDraftSend.ts` |
| `MESSAGE` (helper) | `searchMessagesAction` | H | 0 | 369 | 5 | 1 | `core/src/features/messaging/triage/actions/searchMessages.ts` |
| `NONE` | `noneAction` | H | 0 | 121 | 5 | 4 | `core/src/features/basic-capabilities/actions/none.ts` |
| `POST` | `postAction` | R | 3 | 233 | 5 | 1 | `core/src/features/advanced-capabilities/actions/post.ts` |
| `READ_ATTACHMENT` | `readAttachmentAction` | H | 0 | 200 | 5 | 0 | `core/src/features/working-memory/readAttachmentAction.ts` |
| `REQUEST_SECRET` | `requestSecretAction` | R | 0 | 55 | 4 | 2 | `core/src/features/secrets/actions/request-secret.ts` |
| `ROLE` | `roleAction` | H | 3 | 84 | 0 | 0 | `core/src/features/advanced-capabilities/actions/role.ts` |
| `ROOM` | `roomOpAction` | H | 4 | 249 | 18 | 5 | `core/src/features/advanced-capabilities/actions/room.ts` |
| `SEARCH_EXPERIENCES` | `searchExperiencesAction` | H | 0 | 125 | 4 | 1 | `core/src/features/advanced-capabilities/experience/actions/search-experiences.ts` |
| `SECRETS_UPDATE_SETTINGS` | `updateSettingsAction` | R | 0 | 109 | 4 | 2 | `core/src/features/secrets/onboarding/action.ts` |
| `SECURITY_EVALUATOR` | `securityEvaluator` | H | 0 | 77 | 1 | 0 | `core/src/features/trust/evaluators/securityEvaluator.ts` |
| `SEND_TO_ADMIN` | `sendToAdminAction` | H | 0 | 65 | 0 | 2 | `core/src/features/autonomy/action.ts` |
| `SET_SECRET` | `setSecretAction` | R | 5 | 72 | 8 | 3 | `core/src/features/secrets/actions/set-secret.ts` |
| `TODO` | `todoAction` | R | 5 | 108 | 3 | 0 | `core/src/features/advanced-capabilities/todos/actions/todo.ts` |

### `packages/agent` (24 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `AGENT_INBOX` | `agentInboxAction` | H | 0 | 70 | 5 | 2 | `agent/src/actions/agent-inbox.ts` |
| `ANALYZE_IMAGE` | `analyzeImageAction` | H | 0 | 77 | 8 | 2 | `agent/src/actions/media.ts` |
| `AUTOMATION_ACTIONS` | `automationActionsGroupAction` | R | 0 | 228 | 2 | 0 | `agent/src/actions/page-action-groups.ts` |
| `BROWSER_ACTIONS` | `browserActionsGroupAction` | R | 0 | 333 | 2 | 0 | `agent/src/actions/page-action-groups.ts` |
| `CHARACTER_ACTIONS` | `characterActionsGroupAction` | R | 0 | 296 | 2 | 0 | `agent/src/actions/page-action-groups.ts` |
| `CODE` | `codeAction` | H | 1 | 67 | 3 | 2 | `agent/src/actions/code-umbrella.ts` |
| `CONNECTOR_ACTIONS` | `connectorActionsGroupAction` | R | 0 | 228 | 2 | 0 | `agent/src/actions/page-action-groups.ts` |
| `CONTACT` | `contactAction` | R | 9 | 94 | 49 | 4 | `agent/src/actions/contact.ts` |
| `DATABASE` | `databaseAction` | R | 4 | 138 | 16 | 3 | `agent/src/actions/database.ts` |
| `EXTRACT_PAGE` | `extractPageAction` | R | 4 | 142 | 4 | 2 | `agent/src/actions/extract-page.ts` |
| `LIFEOPS_ACTIONS` | `lifeOpsActionsGroupAction` | R | 0 | 226 | 2 | 0 | `agent/src/actions/page-action-groups.ts` |
| `LOGS` | `logsAction` | R | 3 | 218 | 18 | 3 | `agent/src/actions/logs.ts` |
| `MEMORY` | `memoryAction` | R | 4 | 220 | 17 | 2 | `agent/src/actions/memories.ts` |
| `PHONE_ACTIONS` | `phoneActionsGroupAction` | R | 0 | 224 | 2 | 0 | `agent/src/actions/page-action-groups.ts` |
| `PLUGIN` | `pluginAction` | R | 11 | 64 | 19 | 8 | `agent/src/actions/plugin.ts` |
| `QUERY_TRAJECTORIES` | `queryTrajectoriesAction` | R | 3 | 105 | 3 | 1 | `agent/src/actions/trajectories.ts` |
| `RUNTIME` | `runtimeAction` | R | 5 | 433 | 30 | 5 | `agent/src/actions/runtime.ts` |
| `SETTINGS` | `settingsAction` | R | 0 | 71 | 9 | 4 | `agent/src/actions/settings-actions.ts` |
| `SETTINGS_ACTIONS` | `settingsActionsGroupAction` | R | 0 | 226 | 2 | 0 | `agent/src/actions/page-action-groups.ts` |
| `SHELL_COMMAND` | `terminalAction` | R | 0 | 69 | 8 | 2 | `agent/src/actions/terminal.ts` |
| `SKILL_COMMAND` | `skillCommandAction` | R | 0 | 117 | 1 | 2 | `agent/src/actions/skill-command.ts` |
| `STREAM` | `streamAction` | H | 2 | 74 | 0 | 2 | `agent/src/actions/stream-control.ts` |
| `TRIGGER` | `triggerAction` | R | 5 | 166 | 0 | 2 | `agent/src/actions/trigger.ts` |
| `WALLET_ACTIONS` | `walletActionsGroupAction` | R | 0 | 304 | 2 | 0 | `agent/src/actions/page-action-groups.ts` |

### `plugin-coding-tools` (12 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `ASK_USER_QUESTION` | `askUserQuestionAction` | R | 0 | 461 | 2 | 0 | `plugin-coding-tools/src/actions/ask-user-question.ts` |
| `BASH` | `bashAction` | R | 0 | 232 | 3 | 0 | `plugin-coding-tools/src/actions/bash.ts` |
| `EDIT` | `editAction` | H | 0 | 298 | 2 | 0 | `plugin-coding-tools/src/actions/edit.ts` |
| `ENTER_WORKTREE` | `enterWorktreeAction` | R | 0 | 289 | 3 | 0 | `plugin-coding-tools/src/actions/enter-worktree.ts` |
| `EXIT_WORKTREE` | `exitWorktreeAction` | R | 0 | 190 | 3 | 0 | `plugin-coding-tools/src/actions/exit-worktree.ts` |
| `FILE` | `fileAction` | R | 3 | 66 | 5 | 0 | `plugin-coding-tools/src/actions/file.ts` |
| `GLOB` | `globAction` | R | 0 | 207 | 1 | 0 | `plugin-coding-tools/src/actions/glob.ts` |
| `GREP` | `grepAction` | R | 3 | 184 | 3 | 0 | `plugin-coding-tools/src/actions/grep.ts` |
| `LS` | `lsAction` | R | 0 | 215 | 2 | 0 | `plugin-coding-tools/src/actions/ls.ts` |
| `READ` | `readAction` | H | 0 | 237 | 3 | 0 | `plugin-coding-tools/src/actions/read.ts` |
| `WEB_FETCH` | `webFetchAction` | R | 0 | 409 | 3 | 0 | `plugin-coding-tools/src/actions/web-fetch.ts` |
| `WRITE` | `writeAction` | H | 0 | 243 | 2 | 0 | `plugin-coding-tools/src/actions/write.ts` |

### `plugin-linear` (11 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `CLEAR_LINEAR_ACTIVITY` | `clearActivityAction` | H | 0 | 29 | 3 | 2 | `plugin-linear/src/actions/clearActivity.ts` |
| `CREATE_LINEAR_COMMENT` | `createCommentAction` | H | 0 | 31 | 4 | 3 | `plugin-linear/src/actions/createComment.ts` |
| `CREATE_LINEAR_ISSUE` | `createIssueAction` | H | 0 | 28 | 3 | 2 | `plugin-linear/src/actions/createIssue.ts` |
| `DELETE_LINEAR_COMMENT` | `deleteCommentAction` | H | 0 | 29 | 2 | 1 | `plugin-linear/src/actions/deleteComment.ts` |
| `DELETE_LINEAR_ISSUE` | `deleteIssueAction` | H | 0 | 35 | 4 | 3 | `plugin-linear/src/actions/deleteIssue.ts` |
| `GET_LINEAR_ACTIVITY` | `getActivityAction` | H | 0 | 52 | 4 | 3 | `plugin-linear/src/actions/getActivity.ts` |
| `GET_LINEAR_ISSUE` | `getIssueAction` | H | 0 | 38 | 5 | 3 | `plugin-linear/src/actions/getIssue.ts` |
| `LINEAR` | `linearAction` | R | 11 | 289 | 22 | 4 | `plugin-linear/src/actions/linear.ts` |
| `LIST_LINEAR_COMMENTS` | `listCommentsAction` | H | 0 | 31 | 3 | 1 | `plugin-linear/src/actions/listComments.ts` |
| `SEARCH_LINEAR_ISSUES` | `searchIssuesAction` | H | 0 | 48 | 4 | 3 | `plugin-linear/src/actions/searchIssues.ts` |
| `UPDATE_LINEAR_ISSUE` | `updateIssueAction` | H | 0 | 81 | 3 | 1 | `plugin-linear/src/actions/updateIssue.ts` |

### `plugin-agent-skills` (8 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `SKILL` | `getSkillDetailsAction` | H | 0 | 84 | 2 | 1 | `plugin-agent-skills/src/actions/get-skill-details.ts` |
| `SKILL` | `installSkillAction` | H | 0 | 97 | 0 | 1 | `plugin-agent-skills/src/actions/install-skill.ts` |
| `SKILL` | `searchSkillsAction` | H | 0 | 151 | 3 | 1 | `plugin-agent-skills/src/actions/search-skills.ts` |
| `SKILL` | `toggleSkillAction` | H | 0 | 80 | 0 | 2 | `plugin-agent-skills/src/actions/toggle-skill.ts` |
| `SKILL` | `syncCatalogAction` | H | 0 | 64 | 0 | 1 | `plugin-agent-skills/src/actions/sync-catalog.ts` |
| `SKILL` | `uninstallSkillAction` | H | 0 | 65 | 0 | 1 | `plugin-agent-skills/src/actions/uninstall-skill.ts` |
| `SKILL` | `skillAction` | R | 6 | 310 | 0 | 4 | `plugin-agent-skills/src/actions/skill.ts` |
| `USE_SKILL` | `useSkillAction` | R | 3 | 115 | 0 | 3 | `plugin-agent-skills/src/actions/use-skill.ts` |

### `plugin-music` (4 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `MUSIC` | `musicAction` | R | 12 | 191 | 0 | 0 | `plugin-music/src/actions/music.ts` |
| `MUSIC_LIBRARY` | `musicLibraryAction` | H | 6 | 344 | 0 | 0 | `plugin-music/src/actions/musicLibrary.ts` |
| `PLAY_AUDIO` | `playAudio` | H | 0 | 86 | 12 | 5 | `plugin-music/src/actions/playAudio.ts` |
| `PLAYBACK` | `playbackOp` | H | 5 | 68 | 11 | 5 | `plugin-music/src/actions/playbackOp.ts` |

### `plugin-wallet` (4 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `EVM_TRANSFER` | `transferAction` | H | 0 | 62 | 6 | 1 | `plugin-wallet/src/chains/evm/actions/transfer.ts` |
| `LIQUIDITY` | `liquidityAction` | R | 8 | 256 | 15 | 0 | `plugin-wallet/src/lp/actions/liquidity.ts` |
| `TOKEN_INFO` | `tokenInfoAction` | H | 4 | 224 | 13 | 2 | `plugin-wallet/src/analytics/token-info/action.ts` |
| `WALLET` | `walletRouterAction` | R | 4 | 354 | 11 | 2 | `plugin-wallet/src/chains/wallet-action.ts` |

### `plugin-ngrok` (3 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `GET_TUNNEL_STATUS` | `getTunnelStatusAction` | R | 0 | 216 | 4 | 3 | `plugin-ngrok/src/actions/get-tunnel-status.ts` |
| `START_TUNNEL` | `startTunnelAction` | R | 0 | 200 | 4 | 3 | `plugin-ngrok/src/actions/start-tunnel.ts` |
| `STOP_TUNNEL` | `stopTunnelAction` | R | 0 | 194 | 4 | 3 | `plugin-ngrok/src/actions/stop-tunnel.ts` |

### `plugin-github` (3 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `GITHUB_ISSUE_OP` | `issueOpAction` | R | 2 | 107 | 14 | 2 | `plugin-github/src/actions/issue-op.ts` |
| `GITHUB_NOTIFICATION_TRIAGE` | `notificationTriageAction` | R | 2 | 117 | 2 | 1 | `plugin-github/src/actions/notification-triage.ts` |
| `GITHUB_PR_OP` | `prOpAction` | R | 3 | 81 | 8 | 2 | `plugin-github/src/actions/pr-op.ts` |

### `plugin-computeruse` (2 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `COMPUTER_USE` | `useComputerAction` | R | 13 | 571 | 17 | 0 | `plugin-computeruse/src/actions/use-computer.ts` |
| `DESKTOP` | `desktopAction` | R | 3 | 94 | 6 | 0 | `plugin-computeruse/src/actions/desktop.ts` |

### `plugin-browser` (2 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `BROWSER` | `browserAction` | R | 24 | 634 | 17 | 2 | `plugin-browser/src/actions/browser.ts` |
| `MANAGE_BROWSER_BRIDGE` | `manageBrowserBridgeAction` | R | 4 | 28 | 21 | 0 | `plugin-browser/src/actions/manage-browser-bridge.ts` |

### `plugin-mysticism` (2 actions)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `PAYMENT` | `paymentOpAction` | R | 2 | 180 | 7 | 2 | `plugin-mysticism/src/actions/payment-op.ts` |
| `READING` | `readingOpAction` | R | 3 | 208 | 22 | 5 | `plugin-mysticism/src/actions/reading-op.ts` |

### `plugin-vision` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `VISION` | `visionAction` | R | 6 | 258 | 14 | 6 | `plugin-vision/src/action.ts` |

### `plugin-suno` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `MUSIC_GENERATION` | `musicGeneration` | R | 0 | 168 | 6 | 1 | `plugin-suno/src/actions/musicGeneration.ts` |

### `plugin-tailscale` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `TAILSCALE` | `tailscaleAction` | R | 2 | 155 | 0 | 2 | `plugin-tailscale/src/actions/tailscale.ts` |

### `plugin-nostr` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `NOSTR_PUBLISH_PROFILE` | `publishProfile` | R | 0 | 59 | 3 | 1 | `plugin-nostr/src/actions/publishProfile.ts` |

### `plugin-todos` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `TODO` | `todoAction` | R | 0 | 76 | 22 | 0 | `plugin-todos/src/actions/todo.ts` |

### `plugin-discord` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `DISCORD_SETUP_CREDENTIALS` | `setupCredentials` | R | 0 | 193 | 8 | 3 | `plugin-discord/actions/setup-credentials.ts` |

### `plugin-calendly` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `CALENDLY_OP` | `calendlyOpAction` | R | 2 | 189 | 5 | 3 | `plugin-calendly/src/actions/calendly-op.ts` |

### `plugin-mcp` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `MCP` | `mcpAction` | H* | 4 | 175 | 21 | 2 | `plugin-mcp/src/actions/mcp.ts` |

`*` MCP is registered indirectly via `withMcpContext(mcpAction)` in
`plugin-mcp/src/index.ts`. The R/H column reflects the textual
`actions: [...]` literal only; see §5.8 #4.

### `plugin-shopify` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `SHOPIFY` | `shopifyAction` | R | 5 | 298 | 19 | 4 | `plugin-shopify/src/actions/shopify.ts` |

### `plugin-workflow` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `WORKFLOW` | `workflowAction` | R | 0 | 65 | 22 | 0 | `plugin-workflow/src/actions/workflow.ts` |

### `plugin-tunnel` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `TUNNEL` | `tunnelAction` | R | 0 | 260 | 15 | 3 | `plugin-tunnel/src/actions/tunnel.ts` |

### `plugin-form` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `FORM_RESTORE` | `formRestoreAction` | R | 0 | 41 | 2 | 3 | `plugin-form/src/actions/restore.ts` |

### `plugin-agent-orchestrator` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `TASKS` | `tasksAction` | R | 14 | 90 | 93 | 0 | `plugin-agent-orchestrator/src/actions/tasks.ts` |

### `plugin-shell` (1 action)

| Name | var | R/H | Subs | Desc | Sim | Ex | File |
|---|---|---|---|---|---|---|---|
| `CLEAR_SHELL_HISTORY` | `clearHistory` | R | 0 | 74 | 4 | 0 | `plugin-shell/actions/clearHistory.ts` |

---

## Post-2026-05-10 standardization

The 2026-05-10 follow-up landed two project-wide changes on
`shaw/more-cache-toolcalling`:

### Discriminator field name → `subaction` (canonical)

The umbrella discriminator field is now **`subaction`** project-wide. Legacy
names (`op`, `action`, `operation`) are accepted as one-release input
aliases — the canonical key is consulted first, then the aliases. The
helper `readSubaction()` in `packages/core/src/actions/subaction-dispatch.ts`
exports `CANONICAL_SUBACTION_KEY = "subaction"` and
`DEFAULT_SUBACTION_KEYS = ["subaction", "op", "action", "operation"]` so
every umbrella that uses the helper picks up the canonical-first ordering
without further code changes.

The MESSAGE umbrella (the heaviest by op count) was the canonical case: its
`MESSAGE_PARAMETERS` array now lists `subaction` as the documented field with
`enum: [...MESSAGE_OPS]` and lists `operation` / `subAction` / `__subaction`
/ `op` as legacy aliases. The handler's `inferOp` reads `params.subaction`
first. Same pattern applies to `MANAGE_SECRET` (was `operation`) and the
SCHEDULED_TASK alias resolver (`resolveSubaction(params)` accepts all four
keys).

For the 26 umbrellas that previously documented `op`, the parameter-name
rename has not yet landed end-to-end across every file. Callers using `op:`
continue to work via the alias path; the canonical schema name will move to
`subaction` in a follow-up sweep. The `mode` discriminator on `USE_SKILL`
stays as `mode` — it is genuinely a mode, not a subaction (per §5.5).

### Subaction → virtual top-level Action promotion

A new helper `promoteSubactionsToActions(parent: Action)` in
`packages/core/src/actions/promote-subactions.ts` returns
`[parent, ...virtuals]` where each virtual is a top-level Action named
`<UMBRELLA>_<SUBACTION>` (e.g. `SCHEDULED_TASK_LIST`,
`MESSAGE_SEND`, `CONTACT_SEARCH`). Virtual handlers delegate to the parent's
handler with `subaction: <name>` injected into `options.parameters`; the
parent's `validate` is reused so authorization gates compose.

Helper signature:

```ts
export function promoteSubactionsToActions(
  parent: Action,
  options?: PromoteSubactionsOptions,
): readonly Action[];
```

Plugins wired to use the promotion helper as of this write:

- `plugins/app-lifeops/src/plugin.ts` — CALENDAR, RESOLVE_REQUEST, LIFE,
  PROFILE, VOICE_CALL, SCHEDULED_TASK, SUBSCRIPTIONS, CONNECTOR.
- `packages/agent/src/runtime/eliza-plugin.ts` — TRIGGER, EXTRACT_PAGE,
  CONTACT, PLUGIN, LOGS, RUNTIME, DATABASE, MEMORY.
- `packages/core/src/plugins/native-features.ts` — MESSAGE, POST.
- `packages/core/src/features/advanced-capabilities/index.ts` — ROOM,
  MESSAGE, POST, TODO, CHARACTER (via `advancedActions`).
- `packages/core/src/features/secrets/plugin.ts` — SET_SECRET, MANAGE_SECRET.
- `plugins/plugin-agent-orchestrator/src/index.ts` — TASKS.
- `plugins/plugin-linear/src/index.ts` — LINEAR.
- `plugins/plugin-shopify/src/index.ts` — SHOPIFY.
- `plugins/plugin-music/src/index.ts` — MUSIC.
- `plugins/plugin-computeruse/src/index.ts` — COMPUTER_USE, DESKTOP.
- `plugins/plugin-browser/src/plugin.ts` — BROWSER, MANAGE_BROWSER_BRIDGE.
- `plugins/plugin-vision/src/index.ts` — VISION.
- `plugins/plugin-tailscale/src/index.ts` — TAILSCALE.
- `plugins/plugin-mysticism/src/index.ts` — READING, PAYMENT.
- `plugins/plugin-calendly/src/index.ts` — CALENDLY_OP.
- `plugins/plugin-github/src/index.ts` — GITHUB_PR_OP, GITHUB_ISSUE_OP.
- `plugins/plugin-agent-skills/src/plugin.ts` — SKILL.
- `plugins/plugin-mcp/src/index.ts` — MCP.
- `plugins/plugin-wallet/src/chains/evm/index.ts` — WALLET.
- `plugins/plugin-wallet/src/lp/lp-manager-entry.ts` — LIQUIDITY.

The promotion is **idempotent**, **strongly typed** (no `any`), and reuses
the parent's `validate`, `roleGate`, `connectorAccountPolicy`, and other
authorization metadata so the virtuals enforce identical gates as the
parent. Tests live in
`plugins/app-lifeops/test/subaction-promotion.test.ts`
and `packages/core/src/actions/__tests__/subaction-dispatch.test.ts`.

The Cerebras 28-domain re-eval
(`plugins/app-lifeops/test/journey-cerebras-eval.live.e2e.test.ts`) passes
**29/29** after the promotion sweep, confirming the planner can route
through the larger surface (hundreds of virtual actions) without regression.
