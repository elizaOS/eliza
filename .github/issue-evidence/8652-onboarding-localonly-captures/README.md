# #8652 — onboarding / local-only UI captures (#8670 surface), audit:app + walkthrough

Captured 2026-07-02 on branch `feat/ui-mobile-gap-burndown` (develop
`5471346e7a6` + wave commits), as the captures-only leg advancing the
"onboarding tours" / "local-only mode" rows of the #8652 pre-launch tracker
(shipped by #8670). Zero product-code changes rode along with these captures.

## 1. Full-journey walkthrough (`node scripts/walkthrough-e2e.mjs`, mock lane)

Run `2026-07-02_09-13-17_mock`, pinned ports 36550/36551 (leg-assigned range),
**2/2 passed** — 25 steps × {desktop 1440×900, mobile 390×844} against the real
ui-smoke stack (real Vite renderer + real API server; keyless mock model lane).

- `walkthrough-desktop.mp4` / `walkthrough-mobile.mp4` — stitched, step-labeled
  recordings of the entire journey (cold launch → onboarding → chat → settings
  → dashboard).
- `contact-sheet-desktop.png` / `contact-sheet-mobile.png` — all 25 frames.
- `desktop/` + `mobile/` — the four frames this leg is about, hand-reviewed:
  - `01-cold-launch.png` — first paint, no onboarding modal (chat-first
    onboarding, #8670's design).
  - `02-onboarding-runtime.png` — the in-chat runtime chooser: "Hi — I'm
    Eliza. Let's get you set up. First, where should your agent run?" with
    **Eliza Cloud (managed) / On this device / Bring your own keys** chips.
    "On this device" is the local-only entry (#8652 "local-only mode" row).
    Verified present at BOTH viewports.
  - `03-provisioning-ready.png` — post-choice provisioning state.
  - `25-dashboard-rest.png` — journey lands on the dashboard.
- `steps-desktop.json` / `steps-mobile.json` — per-step timing + assertions.

Hand-review verdict: onboarding is chat-first (composer locked to "Choose an
option to continue" until a runtime is picked), the three runtime chips render
on desktop + mobile, no modal, no blue, orange accent only → **good**.

## 2. `bun run --cwd packages/app audit:app` (all-views aesthetic audit)

Full run on pinned ports 36540/36541: **348 passed / 1 failed** (~12.8 min),
auto-stubbed manual-review markdowns for all 348 view×viewport pairs.

- `audit-app/builtin-chat--{desktop-landscape,mobile-portrait}.png` — the chat
  surface (where the #8670 onboarding lives) at rest.
- `audit-app/builtin-settings--{desktop-landscape,mobile-portrait}.png` — the
  settings surface (runtime/mode controls).

The 1 failure is `plugin-smartglasses-tui @ ipad-portrait` — the minimalism
metric budget for a plugin TUI view untouched by this leg (the smartglasses
completion gate is a known-brittle view; nothing in this evidence leg changes
any product file, so the failure is pre-existing on the branch and unrelated
to the #8670 onboarding/local-only surface). Every onboarding/chat/settings
view relevant to this leg passed.

## Reproduce

```bash
ELIZA_UI_SMOKE_API_PORT=36540 ELIZA_UI_SMOKE_PORT=36541 \
  bun run --cwd packages/app audit:app
ELIZA_UI_SMOKE_PORT=36551 ELIZA_UI_SMOKE_API_PORT=36550 \
  node packages/app/scripts/walkthrough-e2e.mjs
```
