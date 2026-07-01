# Issue #10471 - shortcut allow-list boundary

This inventory documents the current shortcut exception for #10471. The rule is:
behavior in prompt/message/action/provider/evaluator paths should come from
structured planner params or focused model extraction, not ad hoc English string
matching. The exception is a narrow, declared shortcut that exists to avoid a
known latency or weak-model failure mode and is tested as a shortcut.

## Allow-listed shortcut surface

### Runtime policy

- `packages/agent/src/actions/extract-params.ts`
  - Policy anchor for action handlers.
  - Planner-supplied params win.
  - Missing required params may be filled with `extractActionParamsViaLlm`.
  - Handlers must not fall back to regex/string matching for intent inference.
  - Shortcut exception: only declared `ShortcutDefinition` entries or
    package-local deterministic shortcuts with stable ids, narrow scope, tests,
    and documented routing targets.

### App-control view navigation shortcut

- `plugins/plugin-app-control/src/shortcuts.ts`
  - Declares `VIEW_NAVIGATION_SHORTCUT_ID =
    "app-control:nl:view-navigation"`.
  - Registers a `ShortcutDefinition` targeting `VIEWS` with
    `{ action: "show" }`.
  - Narrow purpose: explicit view navigation commands such as opening settings
    or showing calendar.
  - Test guard: `plugins/plugin-app-control/src/shortcuts.test.ts`.

- `plugins/plugin-app-control/src/actions/view-command-matcher.ts`
  - Deterministic multilingual matcher for explicit view-navigation commands.
  - It is intentionally the zero-model fast path for shell navigation, not a
    general action-param extractor.
  - Test/coverage guards:
    - `plugins/plugin-app-control/src/actions/view-matrix.test.ts`
    - `plugins/plugin-app-control/src/actions/view-routing-benchmark.test.ts`
    - `plugins/plugin-app-control/src/actions/views-switching.test.ts`

- `plugins/plugin-app-control/src/evaluators/view-command-shortcut.ts`
  - Early response-handler evaluator that forces `VIEWS` for explicit
    navigation commands.
  - It exists so view switching does not depend on weak/local model action
    selection when the user gave a direct shell command.
  - Test guard:
    `plugins/plugin-app-control/src/evaluators/view-command-shortcut.test.ts`.

- `plugins/plugin-app-control/src/actions/views-show.ts`
  - `resolveIntentView(...)` consumes the same deterministic matcher and a
    legacy passive-domain mapping as a fallback once normal target resolution
    fails.
  - This is the one known boundary case that remains intentionally
    deterministic: view navigation is a shell command surface, not arbitrary
    business intent extraction.
  - It should not be copied into other handlers. New behavior-deciding
    natural-language matching belongs in structured planner params or
    `extractActionParamsViaLlm`.

## Keep/remove boundary

Keep:

- Declared `ShortcutDefinition` entries with stable ids, explicit action target,
  confidence/priority, tests, and narrow command surfaces.
- Deterministic routing of IDs, URLs, enum names, file names, or catalog labels
  after a structured parameter exists.
- Security/permission allow-lists, protocol checks, URL checks, and exact
  machine-value parsing.
- Display formatting, logging, and search/filter behavior that does not decide
  agent intent.

Remove or convert:

- English keyword banks that choose an action, subaction, provider mode, or
  evaluator outcome.
- Regex/string replacement that extracts action params from
  `message.content.text` when planner params are missing.
- Confirmation/cancellation/affirmation based on raw English replies inside
  handlers.
- Provider visibility gates that return different context because the raw user
  text contained English phrases.
- Reply-shape or honesty detectors that blank or rewrite model output by
  English-only regex.

## Related #10471 conversion evidence

- `10471-planner-enum-op-inference.md`
- `10471-honesty-detectors-english-only.md`
- `10471-documents-structured-values/`
- `10471-search-youtube-structured/`
- `10471-download-music-structured/`
- `10471-playback-op-structured/`
- `10471-playlist-op-structured/`
- `10471-music-routing-zones/`
- `10471-wikipedia-provider-context/`
- `10471-play-music-query-structured/`
- `10471-music-library-provider/`
- `10471-views-delete-structured-confirm/`

## Validation

- `agent-typecheck.log` - `packages/agent` typecheck passed.
- `agent-lint.log` - `packages/agent` lint passed.
- `git-diff-check.log` - `git diff --check` passed.

## Evidence gaps / N/A

- Live model trajectory: N/A for this documentation/policy inventory. It does
  not change runtime behavior; individual conversion PRs carry runtime evidence
  or note model-key blockers.
- Screenshots / screen recording / audio: N/A. No UI, renderer, or audio path
  changed.
