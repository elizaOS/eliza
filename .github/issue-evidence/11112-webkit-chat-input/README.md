# #11112 — WebKit chat-input reliability (leg W1, wave 3)

Branch: `feat/ui-mobile-gap-burndown` (worktree `ui-mobile-wave3`, based at develop 5471346e7a6).
Scope at assignment: the 4 WebKit-only `slash-commands.spec.ts` reds + the
`conversation-management.spec.ts` reload-persistence red, flipping the WebKit lane to
blocking, and the #10722 zero-test item (SlashCommandMenu drag-gesture tests, real pointer
input). Explicitly OUT of scope (epic B owns): `ContinuousChatOverlay.tsx` and red 6
("long transcript scrolls").

## Findings inventory (research phase — re-verified against develop tip 2026-07-02)

### F0 — MID-LEG SUPERSEDE: PR #11225 merged 2026-07-02T06:25Z and closed #11112

While this leg was in flight, **PR #11225** (`fix(ui/chat): resolve #11112 — composer
focus-open regression + WebKit slash-menu/reload (lane 3/9 → 9/9)`) merged to develop and
closed the issue. It shipped:

- **Reds 1–4 (slash menu never mounts on WebKit) + red 5 (reload persistence):** one root
  cause — the PROD renderer registers `/sw.js`; WebKit (unlike Chromium) does **not** bypass
  a controlling service worker for `page.route` interception, so `/api/*` went around the
  per-spec fixtures to the real stub (empty catalog → menu never mounts; foreign thread on
  reload). Fixed with `serviceWorkers: "block"` on the opt-in `webkit` project in
  `packages/app/playwright.ui-smoke.config.ts` — parity with the `desktop-webkit` project and
  with Chromium's force-bypass. This matches this leg's pre-supersede diagnosis (F2 in the
  prior revision of this README; repro log kept as `01-webkit-repro-before-fix.log`).
- **Red 6** ("long transcript scrolls", both engines): overlay focus-open fix in
  `ContinuousChatOverlay.tsx` (epic-B surface — merged by them, untouched by this leg).
- **Controller observability:** `useSlashCommandController` no longer swallows catalog-fetch
  failures with `.catch(() => [])` — errors are logged before degrading to `[]`; +5 controller
  tests (`useSlashCommandController.catalog.test.ts`).

**Consequence for this leg:** items 1 and 2 are done on develop; this branch's uncommitted
controller partial (a near-identical error-surfacing hunk) was reconciled to **exactly the
develop-tip bytes** so the merge is clean and no divergent duplicate ships.

### F1 — item 3 (flip the WebKit lane to blocking): ALREADY blocking at develop tip — no yml edit exists to make

Verified at `origin/develop` (post-#11225): `.github/workflows/test.yml` contains **zero**
`continue-on-error` occurrences; the step `Actual app WebKit pointer/focus coverage`
(`PLAYWRIGHT_WEBKIT=1 … --project=webkit`, ~line 691) is blocking. The second WebKit lane
(`scenario-pr.yml` job `app-browser-webkit`, `--project=desktop-webkit`) is blocking and wired
into the gate `needs`/result list (lines 907/931). The #11225 PR body's "flip remains" note is
stale relative to the tree: there is no `continue-on-error` to delete. Verified, not skipped.

### F2 — item 4 (#10722): SlashCommandMenu had ZERO real-pointer gesture tests and a REAL touch-gesture product bug

- `SlashCommandMenu.tsx` (base) picked on **`onPointerDown`** (with `preventDefault()` so the
  composer keeps focus). The list is `overflow-y-auto` with `max-h-[min(46vh,22rem)]`, so a
  long catalog scrolls. Because `pointerdown` fires at touch-contact, a touch
  **drag-to-scroll starting on an option row executed that command instantly** instead of
  scrolling — no tap-vs-scroll discrimination at all. Similarly, a mouse press that dragged
  off a row and released elsewhere still executed the pressed row.
- Coverage was jsdom-only (`fireEvent.pointerDown` in `ContinuousChatOverlay.slash.test.tsx`)
  plus keyboard-path e2e — the #10722 "zero real-input tests" item.
- **Product fix (this leg):** the pick moved from pointer-down to **click**;
  `onPointerDown` now only `preventDefault()`s the focus steal. The engine's native
  tap-vs-scroll discrimination applies: a touch scroll gesture never emits `click`, a
  drag-away mouse release clicks the common ancestor (not the row). Composer focus retention
  is preserved and asserted.
- **New real-input e2e (this leg), in `slash-commands.spec.ts`** (runs on the chromium AND
  webkit projects — the webkit `testMatch` already includes this spec, no config change):
  1. real mouse click picks + composer keeps focus (both engines);
  2. mouse press → drag off the row → release elsewhere never picks (both engines — this is
     the direct regression discriminator for the old pointer-down pick);
  3. real touch tap (CDP `Input.dispatchTouchEvent` via the shared #10766 helper
     `packages/ui/src/testing/real-touch-gestures.ts`) executes the pick — proves a
     `preventDefault`'d pointerdown still yields the tap's click (Chromium; CDP is
     Chromium-only, skip is annotated);
  4. real touch drag starting ON an option row over a 24-command overflowing catalog scrolls
     the listbox (`scrollTop > 0` asserted) and executes NOTHING (agent-kind catalog, so a
     mis-fired pick would be loudly visible as a chat send; menu stays open, draft intact).

  Anti-flake hardening baked into the tests (found during the discriminator runs): a
  **handler-liveness gate** before every gesture (hover must flip `data-active`, proving the
  React listeners are attached — a press into un-hydrated UI would vacuously "not pick"), and
  a **bounded 3-attempt retry** on the touch-drag (scroll-chain arbitration can eat a first
  gesture right after mount) that re-asserts the no-pick invariant after every attempt, so a
  pick-on-pointer-down regression still reds on attempt 1.

### F3 — lane/port facts for the runs in this evidence dir

- Leg port range 36100–36199: `ELIZA_UI_SMOKE_API_PORT=36137`, `ELIZA_UI_SMOKE_PORT=36138`.
- WebKit runs require `bunx playwright install webkit` and `PLAYWRIGHT_WEBKIT=1`.
- The local webkit-lane green run needed #11225's fixes, which are **after** this branch's
  base commit. For the run only, the three #11225 files
  (`playwright.ui-smoke.config.ts`, `ContinuousChatOverlay.tsx`,
  `chat-overlay-controls-interactions.spec.ts`) were temporarily set to develop-tip bytes and
  **restored to base bytes afterward** (they are epic-B / already-merged surfaces this leg
  must not ship changes to; the PR merge ref gets them from develop). The diff state before
  and after is recorded in `07-temporary-materialization-audit.log`.

## Artifacts

| File | What it shows |
|---|---|
| `01-webkit-repro-before-fix.log` | The original reds reproduced locally on WebKit at develop base (pre-#11225), kept as the before-state |
| `03-webkit-after-fix.log` | Full `webkit` project (slash + conversation + chat-overlay specs, incl. the new gesture tests) green on WebKit |
| `04-chromium-slash-after-fix.log` | slash-commands spec (4 original + 4 new gesture tests) green on Chromium — no cross-engine regression |
| `05-gesture-drag-discriminator.log` | Discriminator vs the OLD pointer-down pick: the touch-drag test REDS ("element(s) not found" — the menu unmounted because the old code executed /bulk01 the instant the finger landed). Redded on every old-code run. |
| `05b-gesture-mouse-discriminator.log` | The mouse drag-off test REDDING solo vs the OLD pick (menu closed by the press-pick). Under old code this test's red is run-order-sensitive (it passed when scheduled first in `05`, red solo here) — the PAIR discriminated on every old-code run; under the NEW code both are stable-green. |
| `06-vitest-ui-slash.log` | packages/ui jsdom lane for the touched slash-menu files |
| `07-temporary-materialization-audit.log` | git-diff audit proving the temporarily materialized #11225 files were restored to base bytes |
