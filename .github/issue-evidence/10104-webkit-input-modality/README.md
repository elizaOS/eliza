# #10104 / #10722 — Real WebKit Playwright lane + input-modality coverage

Workstream C evidence. Everything below was run locally against the real
ui-smoke live stack (stub-backend profile, ports 34200/34201) with real browser
engines — Playwright 1.61.1, chromium-1228, **webkit-2311** (installed for this
work; the cached webkit-2287 was stale for this Playwright version).

## What shipped

1. **`desktop-webkit` project** in `packages/app/playwright.ui-smoke.config.ts`
   (Desktop Safari device profile) running the assertion-grade dashboard specs
   (`browser-workspace`, `character-editor`, `wallet-inventory`,
   `workflow-editor`), the shell smoke (`ui-smoke.spec.ts`), and the new
   `input-modality.spec.ts`. Before this there was **no webkit project in any
   packages/app Playwright config** — the engine that ships in every Capacitor
   iOS WebView / macOS WKWebView never executed a single spec.
2. **`input-modality.spec.ts`** (new): the same critical shell flows driven by
   keyboard-only (Tab/Shift+Tab traversal, Enter-to-send, Escape-to-collapse),
   mouse (hover rest→hover→rest affordance contract, wheel scroll), and real
   touch (touchscreen tap + genuine CDP `Input.dispatchTouchEvent` swipe) with
   semantic outcome assertions per modality.
3. **`app-browser-webkit` job** in `.github/workflows/scenario-pr.yml`
   mirroring the existing zero-key browser job shape, with its own
   `bunx playwright install --with-deps webkit` step (`--with-deps` is correct
   for the ubuntu-24.04 runner; a macOS runner must omit it — noted inline in
   the workflow).

## Per-project pass/fail table (final local runs)

### desktop-webkit lane — `webkit-lane-run.log` (8 passed, 2 skipped, 0 failed)

| Spec | Result | Notes |
|---|---|---|
| browser-workspace.spec.ts | PASS | tab create/navigate/switch/close + history on real WebKit |
| character-editor.spec.ts | SKIP (pre-existing, engine-neutral) | in-spec `LIVE_STACK` gate — needs the real character pipeline; skips identically on the chromium keyless lanes |
| input-modality.spec.ts keyboard ×2 | PASS | Alt+Tab traversal (Safari's documented full-traversal chord — see below) |
| input-modality.spec.ts mouse hover / wheel | PASS | hover affordance + wheel scroll on WebKit |
| input-modality.spec.ts real touch | SKIP (capability) | Desktop Safari profile has no touch digitizer, matching real Mac Safari; the touch cells run on mobile-chromium |
| ui-smoke.spec.ts | PASS | after the stale-/apps repair (see below) |
| wallet-inventory.spec.ts | PASS | now runs FULLY on WebKit (was a whole-test chromium-only skip) |
| workflow-editor.spec.ts | PASS | after the service-worker parity fix (see below) |

### input-modality matrix — `input-modality-matrix-run.log` (12 passed, 3 skipped, 0 failed)

| Test | chromium | mobile-chromium (Pixel 7) | desktop-webkit |
|---|---|---|---|
| keyboard: Tab→composer, type opens, Enter sends, Escape collapses | PASS | PASS | PASS |
| keyboard: bidirectional traversal, ≥3 stops, all `:focus-visible` | PASS | PASS | PASS |
| mouse: hover affordance rest→hover→rest | PASS | SKIP¹ | PASS |
| mouse: wheel scrolls transcript | PASS | PASS | PASS |
| touch: tap + real CDP swipe + backdrop-tap collapse | SKIP² | **PASS** | SKIP² |

¹ Documented capability gate: the design system compiles every hover utility
behind `@media (hover: hover)` (verified in the built CSS — grep the dist
bundle), so on a touch-primary profile (Pixel 7 reports `hover: none`) the
affordance deliberately does not exist. Product behavior, not a test gap.
² Documented capability gate: no touch digitizer on the desktop profiles
(`hasTouch` false); CDP touch events additionally require Chromium. Non-Chromium
real touch is covered by the on-device lanes (capture:ios-sim / android-emu).

Also re-ran the touched `wallet-inventory.spec.ts` across all four
`dashboard-*` viewport projects: 4/4 PASS (no regression from the repair).

## Real engine differences found (and how each was fixed the right way)

1. **WebKit does not bypass the app service worker under route interception —
   Chromium does.** With the SW active, a `page.route`-fulfilled
   `/api/conversations` list came back with the stub server's conversations
   instead of the fixture (verified with a minimal reproduction: SW allow →
   `stub-conversation-1`; SW block → the fixture id). Every helpers.ts fixture
   stub was silently void on WebKit; this is what broke `workflow-editor` (its
   save POST bypassed `installWorkflowApi`) and the transcript fixtures. Fix:
   `serviceWorkers: "block"` on the `desktop-webkit` project — engine parity
   with what the Chromium lanes actually test, documented in the config.
2. **WebKit exposes no Playwright-grantable `clipboard-read` permission and
   gates `navigator.clipboard.readText()` behind a transient user gesture.**
   `wallet-inventory.spec.ts` used this as a whole-test `browserName !==
   "chromium"` skip, making the spec vacuous on WebKit. Repair: the clipboard
   READ-BACK assertions are chromium-gated per-assertion with a written
   justification; badges, rows, tabs, copy-control clicks, hide state, and
   persistence now run on every engine.
3. **Keyboard traversal chord.** WebKit keeps Safari's default keyboard model
   (Tab traverses form controls; Option+Tab is the full-traversal chord that
   also reaches buttons/links). The input-modality spec uses each engine's real
   chord (`Tab` on Chromium, `Alt+Tab` on WebKit) — WebKit runs the entire
   keyboard flow, nothing is skipped.
4. **Focus-visibility policy.** The design system intentionally bans decorative
   focus rings globally (`packages/ui/src/styles/styles.css`, "Product policy:
   focus rings are intentionally disabled globally"), so the spec asserts the
   enforceable cross-engine contract instead: the keyboard-focused element is
   the expected control, the engine reports it `:focus-visible`, and it is
   visible on screen — plus caret visibility on the text control.

## Cross-engine (NOT WebKit) rot found while standing the lane up

- `ui-smoke.spec.ts` asserted the old standalone Views catalog on `/apps`
  (heading "Views" + chat-search hint + `view-card-*` tiles). On this branch
  `/apps` routes to the launcher surface (`App.tsx renderAppsSurface` →
  `HomeScreenMount initialPage="launcher"`); the old assertions fail
  **identically on chromium**, including against a freshly booted stack —
  verified before touching the spec. Minimal repair: assert the launcher
  surface's real anchors (`launcher` testid + first `launcher-tile-*`), which
  match the shipped UI (see `apps-launcher-{chromium,webkit}.png`).

## Input-modality audit (what existed before this spec)

- Mouse click/fill: everywhere.
- Real CDP touch: only `chat-clear-swipe` (drag), `chat-send-voice-newchat-fuzz`
  (tap), `apps-personal-assistant-decomposed-interactions` (pinch) — gesture
  specific, single-engine, no tap-open/scroll coverage of the core chat flow.
- Keyboard: `Escape`/`Enter` pressed on an already-mouse-focused composer in a
  few specs; **zero** Tab-traversal / keyboard-only-reachability coverage.
- Hover: hover used only as a scroll aid (`thread.hover()` before `wheel`);
  **zero** hover-affordance assertions.
- Pen: not exercised anywhere (unchanged — Playwright has no pen pointer API;
  documented here as N/A rather than larped).

## Screenshots (reviewed by hand)

- `chat-home-chromium.png` / `chat-home-webkit.png` — primary shell surface,
  rendering is equivalent across engines.
- `chat-open-chromium.png` / `chat-open-webkit.png` — sheet open after a real
  send round-trip through the stub on each engine (fixture echo visible).
- `apps-launcher-chromium.png` / `apps-launcher-webkit.png` — the `/apps`
  launcher surface backing the ui-smoke.spec repair; equivalent grid/dock.
- Observation: WebKit shots show a ~8px white square artifact at the far left
  edge (not present on Chromium). Cosmetic, engine-level, does not affect any
  assertion; flagged for an eyeball if it ever shows on real WKWebView.

## Verdicts

| Page/flow | Verdict |
|---|---|
| chat home (both engines) | good |
| chat sheet open + send (both engines) | good |
| /apps launcher (both engines) | good |
| wallet inventory on WebKit | good |
| workflow editor on WebKit | good |
| browser workspace on WebKit | good |
| WebKit left-edge white artifact | needs-eyeball (cosmetic, engine-level, no functional impact) |

## Reproduce locally

```bash
bunx playwright install webkit
cd packages/app
ELIZA_UI_SMOKE_API_PORT=34201 ELIZA_UI_SMOKE_PORT=34200 \
  node scripts/run-ui-playwright.mjs --config playwright.ui-smoke.config.ts \
  --project=desktop-webkit
ELIZA_UI_SMOKE_API_PORT=34201 ELIZA_UI_SMOKE_PORT=34200 \
  node scripts/run-ui-playwright.mjs --config playwright.ui-smoke.config.ts \
  test/ui-smoke/input-modality.spec.ts \
  --project=chromium --project=mobile-chromium --project=desktop-webkit
```

Gates run green: `node packages/app/scripts/ui-smoke-pr-specs.mjs --check`
(input-modality lands on the PR path via auto-discovery), the
route/ui-smoke/view-interaction coverage vitest gates (20/20), `bun run --cwd
packages/app typecheck`, and biome on every touched file. scenario-pr.yml
parses (16 jobs, `app-browser-webkit` present).
