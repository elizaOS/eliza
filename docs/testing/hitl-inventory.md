# Human-in-the-Loop (HITL) test inventory

> Part of #14381 (HITL inventory / developer-facing runner), split from the
> device-review rollup #14317 / #14395. Companion: #14382 (resettable
> onboarding). Plugs into the existing evidence loop
> (`scripts/e2e-recordings/*` → contact sheets → viewer) and nubs'
> `launch-qa` board — this does **not** replace the device passes, it tells a
> developer *which* things a human/device still has to eyeball and pre-stages
> the frames so the review is a contact-sheet skim, not a manual drive.

## What "HITL" means here

A flow is HITL when an automated assertion **cannot** decide pass/fail — the
signal lives in a human's eye, thumb, ear, or a real device capability the
headless runner can't fake:

- **Visual polish** — clipping, overflow, contrast, spacing, safe-area,
  leaked error strings. A DOM node can *exist* and still look broken.
- **Gesture / motion feel** — scroll momentum, sheet detents, drag, long-press,
  frame glitches. "It renders" ≠ "it feels right."
- **Keyboard behavior** — soft-keyboard push/resize, focus retention, IME,
  input obscuring on real mobile.
- **Onboarding** — first impression, copy, pacing; historically untestable
  because you can't reset a real, memory-laden agent (→ #14382).
- **Login / auth** — real OAuth round-trip, tenant, token, redirect. Injected
  state proves nothing (FLEET.md ban; qa-agent's staging-401 lesson).
- **Wallet** — real signing, balances, "not found" / error copy (#14426).
- **Notifications** — permission prompt, delivery, tap-through.
- **Camera / mic** — real permission grant + capture feel.

## Coverage legend

| Mark | Meaning |
|---|---|
| ✅ auto | Fully machine-decidable; e2e asserts it, no human needed |
| 🟡 frame | Headless can **stage + screenshot** the state; a human judges the frame |
| 🔴 device | Needs a **real device** capability (soft keyboard, wallet, camera, push) |
| ⛔ none | No current coverage; manual-only today |

## Inventory

### Onboarding

| Flow / decision point | Why HITL | Current coverage | What a harness can pre-stage |
|---|---|---|---|
| First-run welcome + name/style pick | first impression, copy, pacing | 🟡 frame — `packages/ui` first-run e2e + `test:ftu-home-e2e`; `capture-android-emu` / `capture-ios-sim` drive the real Capacitor onboarding | contact-sheet of each step (welcome → name → style → provider → complete) via the replay entry (#14382) so a fully-onboarded dev can re-walk it without a wipe |
| Provider / model selection | catalog correctness + visual density | 🟡 frame — first-run options e2e | screenshot of the provider grid at each viewport |
| Boot-trouble-speaks-in-chat (no banners) | tone / does the copy read right | 🟡 frame — `App.chat-overlay-first-run.test.tsx`, #14168 detent work | staged error card frame |
| Onboarding **persists** across restart | correctness (not visual) | ✅ auto — `first-run-persistence.restart.test.ts` (real `saveElizaConfig`/`loadElizaConfig`) | n/a (already machine-decided) |
| Onboarding **re-runnable** on a real agent | can't reset without nuking memories | ⛔ none → **#14382 slice in this PR** | dev-gated `?onboarding-replay=1` client overlay (no server wipe) |

### First chat

| Flow / decision point | Why HITL | Current coverage | What a harness can pre-stage |
|---|---|---|---|
| First message send → streamed reply | live inference + feel | 🟡 frame — app `test:e2e` chat suite (stubbed); real inference needs credits (see #14424 credit path) | staged send + streamed-token frames; a human confirms cadence |
| Suggestions / FTU home widgets | visual + relevance | 🟡 frame — `test:suggestions-e2e`, `test:ftu-home-e2e` | rest + populated frames |
| Chat scroll / infinite scroll / momentum | gesture feel | 🟡 frame — `test:chat-scroll-web-e2e`, `test:chat-infinite-scroll-e2e`, `test:chat-perf-gate`; scroll **cert** superset #14380 | scroll-position + perf-gate frames |
| Chat sheet detents / frame glitch | motion feel | 🟡 frame — `test:chat-sheet-e2e`, `test:chat-sheet-frame-glitch-e2e`, `test:chatux-gesture-e2e` | detent-state frames |

### Login / auth

| Flow / decision point | Why HITL | Current coverage | What a harness can pre-stage |
|---|---|---|---|
| Cloud sign-in (OAuth round-trip) | real token/tenant/redirect | 🟡 frame — `cloud-e2e` mock login; **real** sign-in is device-only (#13609, #13611, #13610) | mock-login contact sheet; real login stays 🔴 device |
| Stale-token / no-credits resume (spam guard) | correctness + no visual spam | ✅ auto — `use-first-run-conductor.test.ts` (#14387 / PR #14423) | n/a |
| Staging tenant correctness | env-bake correctness | ✅ auto (process) — FLEET.md rule + qa-agent SW fix #14409 | n/a |

### Wallet

| Flow / decision point | Why HITL | Current coverage | What a harness can pre-stage |
|---|---|---|---|
| Wallet view render | leaked "Not found" red string (#14426, P1) | 🟡 frame | staged wallet-empty + wallet-populated frames so the leak is obvious on the sheet |
| Real signing / balances | real key material | 🔴 device — `platform/e2e-wallet.ts` stub only | n/a headless |

### Notifications / camera / mic

| Flow / decision point | Why HITL | Current coverage | What a harness can pre-stage |
|---|---|---|---|
| Permission priming prompt | copy + timing | 🟡 frame — `test:permission-priming-e2e` | priming-prompt frame |
| Mic permission (first-run) | real grant + capture | 🔴 device — `use-microphone-permission.ts` | n/a headless |
| Push delivery + tap-through | real device push | 🔴 device — Seeker pass (qa-agent) | n/a headless |

### Visual polish (cross-cutting launch-qa)

| Issue | Why HITL | Coverage | Pre-stage |
|---|---|---|---|
| #14427 launcher 'Relationships' label clips | pixel clipping | 🟡 frame | launcher tile frame at each width |
| #14426 wallet red 'Not found' leak (P1) | error-string leak | 🟡 frame | wallet frame |
| #14425 'when this Mac is asleep' on non-Mac | platform copy | 🟡 frame | CloudOverview frame on non-mac env |
| #14380 scroll + tap-target cert | gesture + hit-area | 🟡 frame — superset harness (sibling sol lane) | per-widget scroll/tap frames |
| #14379 mobile chat/search keyboard states | soft-keyboard | 🔴 device | n/a headless — real-device cert |

## How the runner surfaces this (design)

The runner does **not** invent a new capture stack. It:

1. Selects the **HITL subset** of `UI_E2E_SUITES` relevant to a decision point
   (onboarding / first-chat / login) via a tag manifest
   (`scripts/hitl/hitl-manifest.mjs`).
2. Runs them through the existing `e2e-recordings` pipeline (record → extract
   frames → `generate-contact-sheets` → `generate-viewer`).
3. Emits a **HITL contact sheet** where each staged frame is labelled with its
   decision point + a `pass / fail / blocked` slot, so a developer reviews a
   sheet *during* development instead of driving the app by hand or waiting for
   a post-merge device pass.

Pass/fail/blocked is recorded by the human in the viewer; 🔴 device rows are
marked `blocked (device)` automatically and routed to the Seeker pass
(qa-agent) rather than pretending headless covered them. **Auth/wallet/real
inference use real flows only** (FLEET.md) — the harness stages the *mockable*
frames and explicitly defers the rest to device, never fabricates state as
evidence.

## Non-goals / honesty

- The `packages/ui` e2e env is known-flaky; this inventory marks what *can*
  run headless (🟡) vs what genuinely needs a device (🔴). It does not claim
  headless coverage where only a device suffices.
- This is the inventory + the onboarding-replay slice + a harness skeleton.
  Wiring every 🟡 row into the tagged sheet and the full launch-qa board
  labelling is follow-up (tracked on #14381).

— [sol-orch]
