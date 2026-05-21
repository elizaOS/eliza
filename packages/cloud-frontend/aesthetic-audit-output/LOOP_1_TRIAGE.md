# Loop 1 — baseline triage of existing screenshots

Generated 2026-05-21 from `aesthetic-audit-output/desktop/*.png` (last run
before wave-1 changes). Per-page reviews will land under
`manual-review/<slug>.md` once that directory exists; this file is the
roll-up so loop 2 can act on it.

## Cross-cutting harness bugs (block accurate evaluation)

These must be fixed in `tests/e2e/aesthetic-audit.spec.ts` BEFORE
remaining loops produce trustworthy artifacts. Loop-2 prereqs.

### H1. `landing.png` captures the dashboard, not `/`
The harness runs with `VITE_PLAYWRIGHT_TEST_AUTH=true` which keeps the
mock session active. When visiting `/`, the app redirects authed users
to `/dashboard`. Result: `landing.png` shows the dashboard (Instances
empty state with "No agents yet"), not the marketing landing page.

**Fix:** Split the audit into two passes — a public pass (no test-auth
cookie cleared) and an authed pass. Routes listed `auth: false` should
run with the session cleared via `await context.clearCookies()` and a
fresh storageState.

### H2. `dashboard-api-keys.png`, `dashboard-containers.png` render "Something went wrong / Unauthorized"
Test-auth mode passes the UI gate (JWT decoded), but the API treats the
mock token as unauthorized for these endpoints. Result: the
audit captures the error boundary, not the page content.

**Fix:** Either (a) extend the test-auth backend stub to honour these
endpoints, or (b) intercept API calls inside the audit spec with
`page.route(...)` to return canned fixtures per route. Option (b) is
strictly local and won't require backend changes.

### H3. `dashboard-billing.png`, `dashboard-settings.png` captured during loading skeleton
Empty header (no "Billing" / "Settings" title), four placeholder
rectangles, no real content. The audit fires the screenshot before
content settles.

**Fix:** Add per-route "ready" waits. Easiest: wait for a
`[data-testid="<slug>-ready"]` element on each page; add the testid in
source where the page mounts its real content. Backup: wait until
`networkidle` AND no `[aria-busy="true"]` element in the main region.

### H4. No hover-state screenshots yet
Subagent A is adding `<slug>--hover.png` for the primary button — once
that lands, re-run.

### H5. No mobile screenshots reviewed yet
The mobile screenshots are in `aesthetic-audit-output/mobile/` but
haven't been triaged. Loop-4 task.

---

## Page-level findings (desktop only — first pass)

### `/` (landing) → SEE H1 — currently shows dashboard, not landing
Cannot evaluate until H1 fixed.

### `/login` (`login.png`)
- Looks tight visually. Logo + cloud bg.
- Email field → "Passkey" / "Magic Link" / "Ethereum" / "Solana" buttons.
- ✅ no blue. ✅ orange CTA `Passkey` with neutral siblings.
- **UX**: "Developer Dashboard" button top-right is confusing on a sign-in screen — what does it mean before login? Consider removing or renaming.
- **Test gap**: error case when wallet user rejects sig (see `docs/E2E_COVERAGE_GAPS.md`).

### `/bsc` (`bsc.png`)
- Marketing-style purchase card. Looks clean.
- Cloud bg + white card. Mobile not yet checked.
- ✅ no obvious blue/orange-black hover. Confirm hover state once `--hover` shots exist.

### `/dashboard` (`dashboard-home.png`) — REDESIGN IN PROGRESS (subagent C)
- **VIOLATION**: "API Access" card is solid **blue** (`bg-blue-500` family). Banned. Subagent B should catch this.
- Layout dominated by oversized marketing card "Run your Eliza agent on the hosted runtime" + 5 colored tiles. Feels like onboarding, not a dashboard.
- "My Agent (0)" section is mostly empty → "Launch Instance" CTA. Reasonable empty state but the whole page is empty state.
- Header right side: 🇺🇸 EN dropdown, "Invite" button, "LO" avatar. OK.
- Sidebar shows "Dashboard" highlighted with thin orange left bar. Good.
- **Test gap**: every tile's CTA → assert correct route.

### `/dashboard/agents` (`dashboard-agents.png`)
- Title bar shows "Instances" not "Agents" — naming inconsistency between sidebar ("Instances") and the historical route (`/dashboard/agents`).
- Usage & Rates card: RUNNING/IDLE/YOUR COST/REMAINING tiles. Visually OK; colors fine.
- Empty state: centered "No agents yet" + "New Agent" button. Good.
- **VIOLATION CHECK**: "New Agent" button rests white → confirm hover doesn't go to orange or black-from-orange. Captured `--hover.png` needed.
- **Test gap**: click "New Agent" → navigates to creation flow.

### `/dashboard/api-explorer` (`dashboard-api-explorer.png`)
- **VIOLATION**: blue HTTP-method badges (`POST` is solid blue). Subagent B must replace.
- **VIOLATION**: "Auth" tab uses blue accent on selection. Replace with white/black or orange.
- Endpoints list looks good otherwise.
- Search + category chips work visually.
- **Test gap**: each method badge color asserted in `blue-banned.spec.ts`.

### `/dashboard/api-keys` → SEE H2 — error state captured
### `/dashboard/containers` → SEE H2 — error state captured
### `/dashboard/billing` → SEE H3 — skeleton captured
### `/dashboard/settings` → SEE H3 — skeleton captured

---

## Net findings for loop 2

1. **Fix the harness first** (H1–H3). Without that, screenshots for
   ~half of dashboard routes are meaningless.
2. **Blue eradication is broader than just hover classes** — subagent B
   should also catch the dashboard-home "API Access" card and the
   API-explorer method/auth badges (these are in component source, not
   just Tailwind utility classes).
3. **Sidebar label "Instances" vs route `/dashboard/agents`** — pick
   one. The dashboard tile says "My Agent", the sidebar says
   "Instances", the page heading says "Instances". Customer mental
   model breaks. Decide on the canonical word and rename.
4. **Header `/dashboard` title is just "Dashboard"** — once redesign
   lands, give it a clearer title or remove the title bar entirely.
5. **Per-page testids** required for H3 fix — emit
   `data-testid="<slug>-ready"` on each dashboard page root once
   content loads.

## Loop 2 work derived from this triage

(Tracked in TaskList.)

- Fix H1, H2, H3 in `aesthetic-audit.spec.ts`.
- Add per-page `data-testid` ready markers.
- Add `blue-banned.spec.ts` enforcement.
- Land subagent B's hover/color sweep including the dashboard-home blue card and API-explorer method badges.
- Decide sidebar terminology: Instances vs Agents. Implement once.
