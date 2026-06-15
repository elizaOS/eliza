# Slice 1 critical assessment — chat task widget + OAuth secrets widget

Companion to
[`orchestrator-dashboard-task-widget-secrets-design.md`](./orchestrator-dashboard-task-widget-secrets-design.md).
Recorded after the first implementation pass, before any UI screenshot.

## What landed

| Area | Files | Net change |
|---|---|---|
| `[TASK:id]title[/TASK]` parser | `packages/ui/src/components/chat/message-task-parser.ts` (new) + test (new) | Pure parser, strict UUID-shaped threadId, truncates titles, ignores unterminated tags. 9/9 tests green. |
| `TaskWidget` component | `packages/ui/src/components/chat/widgets/task-widget.tsx` (new) + test (new) | One-line title + one-line status (status · agents · relative · tokens). Polls `getCodingAgentTaskThread` every 5s, stops on terminal status, silent on 404 ("Task removed."), click dispatches `eliza:navigate:view` → `/orchestrator?taskId=…`. 6/6 tests green. |
| Wire-up in chat | `packages/ui/src/components/chat/MessageContent.tsx` (edit) + integration test (new) | New `kind: "task-widget"` segment + dispatch. Prose around the block continues to render. 4/4 integration tests green. |
| Sensitive-request OAuth | `packages/ui/src/components/chat/MessageContent.tsx` (edit) + extended test | New `OAuthRequestPanel` rendered when `form.kind === "oauth"`. Opens authorization URL in a popup; on popup block, surfaces "Pop-up blocked" without falling back to the chat stream. Scopes are visible; the URL itself is never substituted into chat text. The secret form keeps its current behavior. |
| Type widening | `packages/ui/src/api/client-types-chat.ts` (edit) | `SensitiveRequestForm.kind` widened to `"secret" \| "oauth"` with three optional fields: `provider`, `scopes`, `authorizationUrl`. |
| Tests added | 4 vitest files | Parser (9), Widget (6), MessageContent integration (4), OAuth in SensitiveRequestBlock (3 new). Whole `src/components/chat` suite: 49/49 green. |
| Lint / typecheck | — | `bun run --cwd packages/ui lint` clean. `bun run --cwd packages/ui typecheck` clean. |

## Honest gaps

These are not "in the design doc but I forgot" — they were called out as
follow-ups in the doc itself. Listing here so the next pass knows the
priority order:

1. **No emission point in `TASKS_CREATE`.** The widget RENDERS, but no
   production action yet emits `[TASK:<id>]<title>[/TASK]` after a successful
   durable-task creation. `runCreate` in
   [`tasks.ts`](../src/actions/tasks.ts) spawns ACP sessions, not durable
   task threads — the link between an action callback and a durable
   `taskId` is not in place. Without that, the widget only renders if
   the agent text already contains the block, which is the e2e seam used
   in tests. The natural next step is wiring `OrchestratorTaskService`'s
   `createTask` (or a separate `TASKS_CREATE_THREAD` sub-action) so that
   on success it returns a `taskId` and the callback text concatenates the
   block. That is a one-line emission change + a unit test in the plugin,
   but it touches the create flow's wiring and was scoped as a separate
   slice.
2. **No OAuth backend adapter yet.** The UI widget works, but no
   `SensitiveRequest` with `target.kind === "oauth"` is produced by the
   policy classifier today; the inline adapter rejects non-secret. A
   sibling `owner-app-oauth-adapter.ts` (and a `target.kind: "oauth"`) is
   the next backend step. See `orchestrator-buildout-followups.md` section B.
3. **No Playwright spec yet for the chat path.** Component-level tests cover
   the rendering, dispatch, and event contract; an end-to-end "send chat
   → assistant emits block → widget appears → click → workbench task
   detail visible" would need MSW-style routes for the chat backend plus a
   way to inject the assistant turn. The existing
   `orchestrator-gui-workbench.spec.ts` already covers the create-flow and
   the rail → inspector path. The chat-side spec is in slice 4 of the
   design doc; it didn't land in this pass.
4. **`OrchestratorGlanceStrip` was descoped.** On second read of
   [`WorkbenchHeader`](../../../plugins/plugin-task-coordinator/src/OrchestratorWorkbench.tsx#L597),
   the header already reads "12 tasks · 1 active · 3 done" with the same
   minimal language the design called for, and adds a usage chip on the
   right. A separate strip would have been redundant and added a second
   row that competes with the same information. The right follow-up if a
   user calls this out specifically is making the inline counts
   click-to-filter, NOT introducing a new pinned tile.
5. **Inspector terminal-task cleanup (slice 5) was descoped.** It's a
   handful of `if (TERMINAL_STATUSES.has(status)) return null;` guards in
   `TaskInspector`; not landed because the inspector is 4142 LOC and I
   prioritized the user-visible chat gap. Worth a follow-up.

## Security audit of what landed

- **Secret form (`SensitiveRequestBlock`)** — submission still goes
  through `client.updateSecrets`, never through the chat message stream.
  Existing test asserts the raw secret never appears anywhere in the
  rendered DOM. Added a `data-testid="sensitive-request-submit"` so
  Playwright can target the submit cleanly; behavior unchanged.
- **OAuth widget (`OAuthRequestPanel`)** — three guards:
  1. The authorization URL is only consumed inside `window.open()`. It is
     never substituted into the visible chat text. The new test asserts
     the URL substring is not present anywhere in `container.textContent`.
  2. Popup is opened with `noopener,noreferrer` so the consent page can't
     `window.opener.*` back to chat.
  3. A blocked popup surfaces "Pop-up blocked. Allow pop-ups for this
     site to continue." rather than silently falling back to a chat
     message that would re-render the URL.
- **TaskWidget** — only reads structured status fields (`status`,
  `sessionCount`, `activeSessionCount`, `latestActivityAt`,
  `usage.totalTokens`). It does not render `metadata` or `messages`. A
  regression test asserts secret-shaped strings smuggled through `metadata`
  do not appear in the rendered DOM.

## Test coverage table

| File | Suite | Count | Status |
|---|---|---|---|
| `message-task-parser.test.ts` | parser unit | 9 | green |
| `widgets/task-widget.test.tsx` | component unit | 6 | green |
| `MessageContent.task-widget.test.tsx` | integration | 4 | green |
| `MessageContent.sensitive-request.test.tsx` | sensitive widget (extended) | 7 | green |
| Whole `src/components/chat` suite | — | 49 | green |

`bun run --cwd packages/ui lint` clean. `bun run --cwd packages/ui typecheck` clean.
`bun run --cwd packages/app-core typecheck` shows two pre-existing
`@elizaos/plugin-commands` resolution errors unrelated to this change.

## What a screenshot pass would look for (next session)

Not run in this session because there is no live UI to capture. The
checklist for that pass:

- **Chat surface, message with a task block** —
  - Title line truncates without ellipsis-jitter at 320px width.
  - Status line wraps gracefully; the dot/label/agents/tokens chips
    never wrap mid-chip.
  - Pulse animation is visible on `active` and `validating`, absent
    on terminal states.
  - Click → orchestrator workbench shows the matching task selected.
- **Chat surface, OAuth request** —
  - "Connect <provider>" button reads exactly like the surrounding chat
    accent (no accidental blue).
  - Scopes line truncates at small widths.
  - Pop-up blocked state surfaces inline, not modal.
- **Chat surface, secret request** — unchanged, but confirm the new
  `data-testid` didn't shift any spacing.
- **Orchestrator workbench, `?taskId=…` arrival** — task is selected,
  inspector visible without scrolling.

## Post-review fixes (second pass)

After fanning out independent code-review + aesthetic + verification agents, four
findings were addressed in this same change-set:

1. **`window.open(..., "noopener,noreferrer")` bug** — per the HTML spec
   `noopener` forces `window.open` to return `null`, so the popup-blocked
   detection misfired in every real browser. Removed `noopener` from the
   features string, kept `noreferrer`, and added an explicit
   `popup.opener = null` immediately after open as a belt-and-suspenders
   measure. Test asserts `noreferrer` is present and `noopener` is not, and
   that `opener` is nulled.
2. **`TaskWidget` infinite poll on auth error** — added a
   `MAX_CONSECUTIVE_ERRORS = 3` cap on the silent-error counter; after three
   consecutive 401/403/etc the widget freezes on the last good state and
   stops polling. Counter resets on the next successful fetch.
3. **Slop pass — `ExternalLink` decorative icon removed** from `TaskWidget`.
   The whole card is already a `<button>` with `hover:bg-bg-hover`; the icon
   added zero info at a glance.
4. **Slop pass — "The value will not be sent as a chat message." removed**
   from the secret-form widget. A `type="password"` input is its own
   signal; the trust copy stays on the OAuth panel where the user is
   genuinely navigating to a third-party origin.
5. **OAuth panel testid** — added `data-testid="sensitive-request-oauth"`
   to the panel wrapper for parity with `sensitive-request`.

Reopen-on-terminal was reconsidered and intentionally left as-is: done/failed
tasks have an Archive button that transitions them to `archived`, which
exposes Reopen. The path exists — it just isn't a single-click escape from
done → reopened. Acceptable.

The legacy `SensitiveRequestOauthTarget` (lowercase `a`) coexists with the
new `SensitiveRequestOAuthTarget` (capital `A`) in the
`SensitiveRequestTarget` union. The new OAuth adapter defends with an
`isOAuthTarget` runtime narrower, so downstream consumers that already
relied on the loose shape are unaffected. Consolidating these two into a
single tight type is a follow-up (it widens the blast radius beyond this
change-set).

## What to revisit if a user looks at this and says "still too busy"

- The header's `12 tasks · 1 active · 3 done` line already aims at
  minimal/dense. If that still reads as cluttered, the next reduction
  is dropping `tasks` (just show counts and labels) and making the
  divider thinner.
- The widget's status line is four chips by default. If three of the
  four are zero (e.g. fresh task, no agents, no tokens), only `status`
  + `relative` render — that's already the case via the existing
  conditional renders.
- The OAuth panel intentionally explains *why* it's safe ("token is
  stored securely and never shown in chat"). That sentence is the only
  prose in the panel and it's important for trust; it should not be
  cut.
