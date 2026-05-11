# AI QA Master Plan — Comprehensive Page/Connection/App Review

Status: 2026-05-11 (initial draft; living doc)
Author: AI QA orchestrator (Claude Opus 4.7 + parallel sub-agents)
Scope: Web + Mobile + Desktop. Every page, every button, every LifeOps connection, every utility app.

Companion docs (read first):
- `01-onboarding-setup-qa.md` — onboarding W1–W11 audit (existing)
- `05-settings-qa.md` — settings audit (existing)
- `06-ios-qa.md`, `07-android-qa.md`, `09-desktop-qa.md` — platform audits (existing)
- `14-lifeops-qa.md` — existing LifeOps QA notes
- `15-utility-apps-qa.md` — existing utility app QA notes
- `16-all-app-pages-qa.md` — existing page-by-page coverage map

This plan extends those docs with an **AI-driven, screenshot-and-analyze loop** that runs the full surface area, files issues automatically, and feeds remediation back into the same pipeline.

---

## Part 1 — Research: What we have, what we are missing

### 1.1 What we have

**Test infrastructure (strong):**
- `bun run test`, `test:server`, `test:client`, `test:e2e`, `test:launch-qa` — established lanes
- 16 Playwright UI smoke specs under `packages/app/test/ui-smoke/`, including the broad-coverage `all-pages-clicksafe.spec.ts`
- `DIRECT_ROUTE_CASES` (13 utility apps) + `CORE_ROUTE_PROBES` (8 core pages) drive ready-check probes at desktop (1440×1000) and mobile (390×844) viewports
- Mock layer (`installSupplementalSafeRoutes`) for safe smoke runs
- Page-issue guards capture `console.error` and `pageerror`
- Live stack runner at `packages/app-core/scripts/playwright-ui-live-stack.ts`
- Vitest lanes via `TEST_LANE=pr` (mocked) vs `post-merge` (live APIs)

**Dev observability (strong):**
- `GET /api/dev/stack` — port/URL discovery
- `GET /api/dev/cursor-screenshot` — full-screen OS capture (Electrobun)
- `GET /api/dev/console-log` — aggregated tail of vite + api + electrobun logs
- `bun run desktop:stack-status -- --json` — one-shot probe

**Audit scripts (strong):**
- `audit:duplicate-components`, `audit:action-availability`, `audit:action-keyword-i18n`, `audit:package-barrels`, `audit:prompt-compliance`
- `lint:descriptions`

**LifeOps coverage (medium):**
- 89 test files under `plugins/app-lifeops/test/`
- Gmail / Signal / iMessage / Calendar have live e2e tests
- Discord / Twilio / X / Health connectors have lighter coverage
- Bluesky / Slack / GitHub / Notion / Obsidian / Spotify / Apple Notes / Apple Reminders: not registered as LifeOps connectors

**Utility apps coverage (medium):**
- 11 visible utility apps (lifeops, plugin-viewer, skills-viewer, trajectory-viewer, relationship-viewer, memory-viewer, runtime-debugger, database-viewer, log-viewer, training [hidden], documents [hidden])
- All scaffolded via the modern `registry/schema.ts` AppEntry shape
- All have ready-check selectors and pass the clicksafe smoke
- Hero images present (file or `/api/apps/hero/{slug}`)

**Existing launchdocs (strong):**
- 22 numbered launchdocs covering onboarding, settings, iOS, Android, cloud, desktop, browser wallet, computer-use, LifeOps, utility apps, all-app-pages, automation, production-readiness, store-review

### 1.2 What we are missing (the gaps the user is asking us to close)

**Gap A — No screenshot/visual capture loop.**
Playwright captures screenshots **only on failure**. There is no system that takes a screenshot of every page in every viewport in every theme, indexes them, and feeds them to a vision model for design critique.

**Gap B — No AI design critique pass.**
No automated "press every button, look at the result, identify design flaws" loop. Existing tests confirm pages *render*; they do not confirm pages *look right*, *make sense*, or are *easy to use*.

**Gap C — No interactive coverage per page.**
`all-pages-clicksafe.spec.ts` clicks only `SETTING_SECTIONS_TO_CLICK` (Capabilities, Permissions) and `SAFE_APP_TILES` (3 utility app cards). Most buttons across most pages are never exercised.

**Gap D — Thin desktop QA loop.**
Electrobun packaged regressions exist (`packages/app/test/electrobun-packaged/`) but the AI does not exercise the desktop shell: tray menu, command palette, detached settings windows, surface windows, native shortcuts, share target.

**Gap E — Thin mobile QA loop.**
Mobile chat smoke (`test:sim:local-chat`, `test:sim:auth`) exists, but the broader mobile surfaces (bottom nav, drawer sheets, keyboard handling, safe-area, Android phone/messages/contacts) are not systematically covered.

**Gap F — LifeOps connection verification not always live-credentialed.**
`.live.test.ts` and `.real.test.ts` files exist for Gmail/Signal/iMessage but require credentials. We have no rolling matrix of which connections are *currently* known to work for *this user* with *current tokens*. Bluesky/Slack/GitHub/Notion/etc are not registered yet — the gap is partly product, partly QA.

**Gap G — No "fix-the-finding" loop.**
Even when an issue is identified (e.g. the P1 RuntimeGate styling drift in `01-onboarding-setup-qa.md`), there is no automated path from "AI saw this is broken" → "AI patches it" → "AI re-runs QA to confirm".

**Gap H — Mobile/Desktop platforms not in CI matrix.**
No nightly Playwright run against the packaged Electrobun app. No Android emulator / iOS simulator nightly. Mobile-only routes (`/phone`, `/messages`, `/contacts`) are exercised only via simulator smoke commands.

### 1.3 What needs manual review (cannot be automated)

The following items always require a human in the loop and must be flagged as such in the QA report rather than left for the AI alone:

- **Native iOS device runs** — Xcode signing, physical device deploy, App Store review prerequisites
- **Native macOS app sandbox / hardened runtime** — Gatekeeper, notarization, entitlements
- **OAuth provider consent screens** that require an interactive Google/Discord/Twitter account
- **Anything billed/charged** — Cloud monetization flows, paid Cerebras tokens, Twilio voice/SMS that costs real money
- **Hardware integrations** — physical iPhone bridge, Bluetooth, USB, camera, microphone, accessibility prompts
- **Subjective design judgement on brand voice / illustrations / VRM avatars** — model can flag misalignment, human signs off on art direction
- **Legal / store-review** — App Store / Play Store / Microsoft Store review notes (see `22-store-review-notes.md`)

The plan below treats these as **review checklists** the AI prepares for the user, not as automation targets.

---

## Part 2 — Implementation: Workstreams

### Workstream 0 — Foundation (shared infrastructure)

Owner: orchestrator (this session). All other workstreams depend on this.

Deliverables:
1. **AI QA harness** at `scripts/ai-qa/run-page-review.mjs` — Playwright runner that:
   - Boots the live UI stack via `playwright-ui-live-stack.ts`
   - Navigates to every route in a unified route catalog (CORE_ROUTE_PROBES + DIRECT_ROUTE_CASES + a new MOBILE_ONLY_ROUTES + SETTINGS_SUB_ROUTES set)
   - Takes screenshots at 3 viewports × 2 themes = 6 captures per route
   - Captures console errors, network failures, pageerror events
   - Records button inventory per page (every `button`, `[role=button]`, `a[href]`, `[data-testid]`)
   - Optionally clicks each button in a "smoke" pass with rollback (route back, re-snapshot, ensure no crash)
   - Writes `reports/ai-qa/<timestamp>/page-<id>/{screenshot,issues,buttons}.{png,json}`
2. **AI analysis pass** at `scripts/ai-qa/analyze-screenshots.mjs` — for each captured page:
   - Sends screenshot + console log + button inventory to Claude (vision)
   - Asks for: design issues, UX complexity, accessibility concerns, layout breakage, copy issues, suggested fixes
   - Writes findings JSON keyed by severity (P0/P1/P2/P3)
3. **Triage report** at `scripts/ai-qa/build-report.mjs` — rolls per-page findings into a top-level markdown report grouped by severity, with screenshot embeds and links to source files.
4. **Route catalog generator** at `scripts/ai-qa/route-catalog.ts` — single source of truth for which routes to exercise, derived from `DIRECT_ROUTE_CASES` and `CORE_ROUTE_PROBES` so we never drift.

Exit criteria: harness runs end-to-end against the dev stack on this Mac and produces a report with at least one finding per page (even if "no issues detected" is the finding).

### Workstream 1 — Page review (every page, every button)

Owner: parallel agent A (general-purpose)

Inputs: harness output from Workstream 0

Tasks per page (≈56 pages total, see CLAUDE.md page inventory + the launchdocs page list):
- Validate screenshot looks coherent in 6 viewports/themes
- For each interactive element, confirm it does *something* — navigates, opens a modal, mutates state, etc. Buttons that do nothing or only show a console warning are P2 findings.
- Cross-reference against `06-ios-qa.md` / `07-android-qa.md` / `09-desktop-qa.md` for known per-platform quirks
- Update the existing per-page doc (e.g. `16-all-app-pages-qa.md`) with the new findings — do not write new docs; the section already exists

Done = every page has a "AI QA pass 2026-05-11" entry with P0/P1/P2/P3 findings (or "clean").

### Workstream 2 — LifeOps connections (user-facing)

Owner: parallel agent B (general-purpose)

Inputs: LifeOps inventory in Part 1, `14-lifeops-qa.md`

Tasks for each of the 13 user-facing connectors (Gmail, Telegram, Discord, Signal, iMessage, WhatsApp, SMS/Twilio, X DM, Calendly, Duffel, Apple Health, Google Fit, Strava, Fitbit, Withings, Oura — plus the agent-facing list: LLM providers, embeddings, vector store, vault, database):
1. Confirm route handler exists and `status()` endpoint returns a defined shape
2. Confirm UI surfaces the status (connected / disconnected / error) with sensible copy
3. Confirm `/api/lifeops/capabilities` includes the connector in the response
4. If the connector has env-based config (Calendly, Duffel, Twilio): confirm a missing-env state is handled and surfaced as "not configured" rather than crashing
5. If the connector has OAuth: confirm initiation, callback, disconnect, and re-connect paths exist
6. If the connector is iMessage/Signal (local-only): confirm graceful non-macOS behavior
7. Document each connector's verification status in `14-lifeops-qa.md` with a `Last AI QA: 2026-05-11` stamp

Done = every connector has a verified row in the LifeOps QA table with route, status endpoint, UI surface, verification path, and known issues.

### Workstream 3 — Utility apps

Owner: parallel agent C (general-purpose)

Inputs: utility apps inventory in Part 1, `15-utility-apps-qa.md`

Tasks for each of the 11 utility apps:
1. Load `/apps/<id>` and confirm it boots
2. Run the AI design pass — does it match the modern `PageLayout` + `PagePanel` + `SidebarPanel` shell? Does it use the design tokens? Does the app icon render? Does the hero image render?
3. Confirm the app has an entry in the registry, a route plugin (if `launch.type === "internal-tab"`), and a ready-check selector that resolves
4. Confirm the app's data fetch path: does the page work when API returns empty/loading/error? Stub these states via the mock layer.
5. Document the result in `15-utility-apps-qa.md`

Done = every utility app has a "modern shell" pass/fail mark, design issues filed, and the hidden ones (Training, Documents) explicitly noted as deferred or promoted-to-visible.

### Workstream 4 — Desktop-specific surfaces (Electrobun)

Owner: parallel agent D (general-purpose, runs locally)

Inputs: `09-desktop-qa.md`

Tasks:
1. Boot `bun run dev:desktop` and confirm `GET /api/dev/stack` returns sane data
2. Use `GET /api/dev/cursor-screenshot` to capture the actual native window (not the webview pixels)
3. Verify: titlebar drag region, traffic lights padding (macOS), Cmd+K command palette shortcut, tray menu items, detached settings window (`openDesktopSettingsWindow`), detached surface windows
4. Use computer-use MCP to actually click through the tray menu and shortcuts — this is a native-app task
5. Document findings in `09-desktop-qa.md`

Done = every desktop-specific behavior listed has a verified pass or a filed P0/P1/P2 issue.

### Workstream 5 — Mobile-specific surfaces

Owner: parallel agent E (general-purpose; harness-driven for the simulator parts that we can run)

Inputs: `06-ios-qa.md`, `07-android-qa.md`

Tasks:
1. Run the existing `bun run --cwd packages/app test:sim:local-chat` and `test:sim:auth` and capture pass/fail
2. Run the harness in mobile viewport (390×844 + 320×568 for stress) against every web-mobile route
3. Confirm bottom-nav, drawer sheets, keyboard handling, safe-area insets visually pass — screenshot + AI critique
4. For native-only routes (Android phone/messages/contacts): confirm they are correctly gated by `isNative && platform === "android"` and produce a clear "not available on this platform" state on the web build
5. Document findings in `06-ios-qa.md` and `07-android-qa.md` (split by platform)

Done = every mobile breakpoint and native-only behavior has a verified row.

### Workstream 6 — Cross-cutting accessibility + dark mode

Owner: parallel agent F (general-purpose)

Inputs: harness output from Workstream 0, with dark theme captures

Tasks:
1. Run axe-core (or playwright's `@axe-core/playwright`) per route, capture violations
2. AI vision pass focused on: contrast issues in dark mode, text legibility, touch-target size on mobile, focus rings, hover states
3. Document findings in a new `24-accessibility-and-dark-mode-qa.md` (since none exists)

Done = every route has an axe pass + dark-mode visual review.

### Workstream 7 — Fix-and-verify loop

Owner: orchestrator (this session) after all reports come back

Tasks:
1. Triage all P0/P1 findings into a fix queue
2. Spawn fix-agents per finding (or batch related findings) — must touch the source code, then re-run the relevant harness target to confirm the fix
3. Commit per-fix on `develop` branch (per the AGENTS.md git workflow), push proactively
4. Update the launchdocs with `Last fixed: 2026-05-11 — fix commit <sha>` lines

Done = every P0/P1 finding has either a fix commit or an explicit "deferred — reason" justification in the doc.

---

## Part 3 — Execution order and dependencies

```
Workstream 0 (foundation)                  ─┬─ Workstream 1 (pages)
                                            ├─ Workstream 2 (lifeops)        ─┐
                                            ├─ Workstream 3 (utility apps)   ─┤
                                            ├─ Workstream 4 (desktop)        ─┼─ Workstream 7 (fix-and-verify)
                                            ├─ Workstream 5 (mobile)         ─┤
                                            └─ Workstream 6 (a11y + dark)    ─┘
```

Workstreams 1–6 run in parallel after Workstream 0 lands its harness output. Workstream 7 sequences fixes and re-verifies — it cannot start until the parallel reports come in.

---

## Part 4 — Manual review checkpoints (cannot be automated)

The AI must surface these to the user explicitly. Each is a hand-off, not a task the harness completes:

1. **After Workstream 0** — confirm the harness output matches what the user is seeing in their dev stack (anti-hallucination guard)
2. **After Workstream 1 P0/P1 findings** — confirm severity assignment is reasonable before kicking off fixes
3. **After Workstream 2** — manual OAuth check for at least one connector the user is paired with (e.g. Gmail) to confirm real round-trip
4. **After Workstream 4** — manual tray click on the actual desktop app, since computer-use can drive it but final acceptance is the user's eye
5. **After Workstream 5** — manual run on the user's actual iPhone for at least the chat path
6. **Before any user-facing prose/design change lands** — the user reviews the proposed fix; design subjectivity is theirs

---

## Part 5 — Anti-hallucination guards

The user explicitly asked us to "verify that what you are testing is actually real". Concrete guards baked into the plan:

1. **Route catalog comes from code, not from this doc.** The harness imports `DIRECT_ROUTE_CASES` and `CORE_ROUTE_PROBES` from the actual Playwright test source. If a route exists in this doc but not in code, it is omitted from the run — and we surface that gap.
2. **Every "no issues" finding includes the screenshot + console log evidence** so a human can spot-check that the page actually loaded.
3. **Every "issue" finding includes a reproduction step** (URL + viewport + action taken + observed result + expected result).
4. **Every "fix" includes a before+after screenshot pair** from the same harness target. No fix is marked done without it.
5. **AI-generated findings are tagged with severity confidence**: high/medium/low. The orchestrator only auto-applies fixes to high-confidence findings; medium/low get queued for user review.
6. **The harness's own success is verified** by including a known-broken canary route in the catalog (a route that intentionally throws) and asserting the AI flags it. If the canary slips through, the analysis pipeline is broken.

---

## Part 6 — Out of scope for this pass

- Cloud production deploys
- Anything that costs money to execute (paid Cerebras inference, Twilio voice calls, Duffel bookings)
- Hardware-specific runtime QA (Eliza-1 hardware testing — see `ELIZA_1_TESTING_TODO.md`)
- Game apps (`2004scape`, `babylon`, `defense-of-the-agents`, etc.) — separate gameplay QA
- Backend perf / load testing

These remain on the existing launchdocs roadmap and are not blocked by this plan.
