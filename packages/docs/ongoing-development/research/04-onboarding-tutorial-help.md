# Onboarding, tutorial & help (chat-first, cloud login)

## Summary

Workstream research for the LifeOps Personal Assistant MVP (GitHub project 15).
Product decision, paraphrased from the owner: onboarding happens **in chat**, and
for the MVP it is exactly one step — **log in with Eliza Cloud**. A flagged
variant for local agent + local models exists and stays flagged. All status
widgets, thinking indicators, and reactions appear in the chat; views assist in
the background but everything happens in chat. The guiding constraint is
minimal additional scope: turn what exists into an MVP by fixing, testing,
verifying and validating — prefer deleting/simplifying over adding.

The good news: the cloud-only in-chat onboarding, the chat-native tutorial, and
help-as-agent-knowledge all **already shipped** (#13377, PRs #13393/#13521/#13394).
The bad news: the only tests that prove a REAL cloud account + REAL LLM work
after onboarding live in a nightly lane that has not produced a green run since
at least 2026-06-25, the device lanes cover the deep-link *remote-connect* path
but not the production-default *cloud sign-in* path, and there is no live-LLM
scenario proving the agent can actually answer help questions from its seeded
knowledge. This doc's core deliverable is the test/verification plan that closes
those gaps.

## Current state

All references verified on `origin/develop` (`c1362eaf72d`, 2026-07-05) unless
noted. Note for readers on older branches: PR #13394 (chat-native tutorial +
Help→knowledge) merged to develop on 2026-07-05; branches cut before it still
carry the deleted spotlight tutorial and `HelpView`.

### Onboarding paths that exist today

1. **Cloud-only onboarding — the production default (#13377).**
   `isRuntimeChooserEnabled()` (`packages/ui/src/first-run/first-run-runtime-flag.ts:51`)
   returns false on every build by default; the Play-Store cloud-locked Android
   variant can never re-enable it (`first-run-runtime-flag.ts:52-53`, covered by
   `first-run-runtime-flag.test.ts:54`). With the chooser off, the in-chat
   conductor (`packages/ui/src/first-run/use-first-run-conductor.ts:90-96`)
   seeds a single greeting — "Sign in to Eliza Cloud and I'll get you set up" —
   with one CHOICE button. A usable stored steward session at mount skips the
   ask entirely ("Welcome back", zero interactions). Provisioning success calls
   `completeFirstRun("chat")` immediately (`use-first-run-conductor.ts:467-473`
   on develop); existing cloud agents are auto-adopted (no picker). Exactly one
   `POST /api/first-run` fires per onboarding (idempotency funnel,
   `packages/ui/src/first-run/first-run-finish.ts:100`; server routes in
   `packages/agent/src/api/first-run-routes.ts`).
2. **Flagged local/remote chooser (dev only).** `VITE_ELIZA_ENABLE_RUNTIME_CHOOSER=1`
   build flag or localStorage `eliza:enable-runtime-chooser` re-enables the
   three-way runtime choice (cloud / on this device / remote) plus provider and
   tutorial steps. The flag contract is unit-tested
   (`first-run-runtime-flag.test.ts`) and every chooser-mode e2e lane opts in
   explicitly (`packages/app/test/ui-smoke/onboarding-to-home.shared.ts:327`).
3. **Mobile remote-connect deep link.** `elizaos://first-run/runtime/remote?api=<url>`
   connects a fresh device to an existing agent
   (`packages/ui/src/first-run/deep-link-handler.ts`; driven on-device by
   `packages/app/test/android/onboarding-to-home.android.spec.ts` and
   `packages/app/scripts/ios-onboarding-smoke.mjs`).
4. **Headless real-cloud login for tests.** `packages/ui/src/platform/e2e-wallet.ts`
   installs a harness-seeded EIP-1193 wallet (never on store builds, never on
   deployed origins, never over a real wallet) and
   `packages/ui/src/state/cloud-siwe-login.ts` performs a genuine EIP-4361
   nonce→sign→verify handshake against the real cloud API. With
   `eliza:e2e-wallet:autologin=1` the session lands before onboarding mounts —
   proven zero-touch on the iOS simulator against real Eliza Cloud in <35s
   (#13377 evidence). This is the key that makes automated real-account device
   e2e possible; today it is wired into **no** recurring lane.

### After login

- Cloud handoff: shared→dedicated agent migration with phase events and a
  one-shot retry (`packages/ui/src/cloud/handoff/run-cloud-agent-handoff.ts`).
- The onboarding sheet auto-collapses on completion and the user lands in chat;
  a one-time post-onboarding character-select landing can still occur
  (#13396 product decision, `packages/ui/src/state/startup-phase-hydrate.ts:264-292`).
- Getting-started notifications are seeded once per agent — "Take the tour"
  (`/tutorial`), "Get help any time" (`/chat`), "Connect your calendar"
  (`/connectors`) — `packages/agent/src/runtime/onboarding-notifications.ts:44-73`.
- Post-login permission priming soft-ask modal
  (`packages/ui/src/components/permissions/permission-priming.ts`).

### Tutorial (post-#13394)

Chat-native, no overlay engine: `packages/ui/src/tutorial/tutorial-service.ts`
(guarded state machine, persisted to `eliza:tutorial-state`),
`tutorial-script.ts` (six conversational steps: welcome, send-message, voice,
navigate, new-chat, done; each auto-advances on the real action with a "Next"
fallback), `TutorialConductor.tsx` seeds turns into the live transcript, and the
`__tutorial__:` action channel carries choices. Entry points: the launcher tile
(`packages/ui/src/components/pages/LauncherSurface.tsx:101`), the `/tutorial`
builtin view (`packages/agent/src/api/builtin-views.ts:14-23`), typed
"start/stop/restart tutorial" composer commands, and the seeded notification.
The tour never auto-launches.

### Help (post-#13394)

There is **no Help view**. `HelpView.tsx` and `help-content.ts` were deleted;
the FAQ now ships as help-tagged default knowledge documents
(`packages/agent/src/runtime/default-help-documents.ts`, seeded idempotently by
`seedBundledDocuments` in `default-documents.ts`). The chat is the help surface:
the agent answers "how do I…" from retrieval.

### Test coverage today — what is real and what is mocked

| Lane | What it covers | Real or mocked | Status |
| --- | --- | --- | --- |
| `onboarding-cloud-only.spec.ts` (3 tests) | Production-default flow: sign-in-only greeting, session-injection zero-tap, auto-adopt no-picker | Cloud login + provisioning **mocked** at network boundary | Green in keyless CI |
| `onboarding-to-home.spec.ts` / `-mobile` / `onboarding-confused-user.spec.ts` / `first-run-startup.spec.ts` / `reset-returns-to-onboarding.spec.ts` | Chooser-mode local path, spam-tap/error recovery, factory reset → onboarding | All APIs **mocked** (`installDefaultAppRoutes`) | Green in keyless CI |
| `use-first-run-conductor.test.ts` + `.fuzz.test.ts` | Conductor state machine incl. cloud-only describe block | Unit (jsdom) | Green |
| `tutorial-chat.spec.ts` | Chat-native tour end to end, typed commands, narration via SpeechSynthesis spy | Routes **mocked** | Green |
| `cloud-live.spec.ts` | REAL login (ELIZAOS_CLOUD_API_KEY), REAL provisioning, REAL cloud chat turn asserting a non-stub reply | **Nothing mocked** | Only runs in nightly `app-live-e2e.yml` — see below |
| `live-agent-chat.spec.ts` | Real local runtime + live provider chat turn from the UI | Live | Same lane |
| `.github/workflows/app-live-e2e.yml` | The only home for real-cloud/real-LLM onboarding proof | Live, secret-gated, nightly | **No green run since ≤2026-06-25** — every scheduled run 06-25→07-05 is failure/cancelled (`gh run list`); known causes: desktop-packaged runtime-copy break + live-chat spec timeout |
| `test/dev-smoke/bun-dev-onboarding-chat.spec.ts` | Real local-runtime first-run with a live provider against `bun run dev` | Live, self-skips keyless | Runs only with keys |
| Android device: `onboarding-to-home.android.spec.ts` | **Remote-connect deep link only** — not the cloud sign-in default | Real WebView, real deep link | On-demand |
| iOS: `scripts/ios-onboarding-smoke.mjs` | **Remote-connect only** (Preferences-driven verifier) | Real simulator | On-demand |
| iOS cloud: `test:e2e:ios:cloud` → `scripts/cloud-provisioning-e2e.mjs` | Real Hetzner-backed cloud agent provisioning + runtime answer | Real, but **programmatic — no UI, no onboarding DOM** | On-demand |
| scenario-runner (`packages/scenario-runner/test/scenarios/`) | **No onboarding, tutorial, or help scenario exists** | — | Gap |

### What is weak, broken, or untested

1. **The verification of record is dead.** Every claim that "a real Eliza Cloud
   account works and a real LLM answers after onboarding" rests on
   `app-live-e2e.yml`, which has been red/cancelled for 10+ consecutive days.
   Until it is green, the production-default onboarding is functionally
   unverified end to end.
2. **No automated device coverage of the default path.** Both device onboarding
   lanes exercise the remote-connect deep link — a secondary, flagged-adjacent
   path — while the single path every real user takes (cloud sign-in) is only
   covered by desktop-Chromium mocks and one manual evidence capture. The
   zero-touch SIWE wallet exists precisely to automate this and is unused.
3. **Help has no proof it helps.** The FAQ moved from a searchable view into
   agent knowledge, which means its efficacy now depends on retrieval + a live
   model. `default-documents.test.ts` covers seeding mechanics only; nothing
   asserts a real model answers "how do I start the tutorial?" correctly.
4. **"Everything happens in chat" is not fully landed.** PR #14168 (boot
   trouble speaks in chat: deletes floating boot/handoff banners, in-chat
   recovery cards, full→half onboarding detent) is OPEN, DRAFT, and
   CONFLICTING. Develop still has the floating-banner surfaces it removes.
5. **Evidence mechanics drift.** Several specs still write evidence into
   `.github/issue-evidence/` under `E2E_RECORD=1`
   (e.g. `first-run-startup.spec.ts:33-52`); the MVP convention is inline MP4 +
   JPG posted in issues/PRs.
6. **Post-onboarding character-select detour.** Cloud-only completion says
   "You're all set — ask me anything" then may land the user on character
   select once (#13396). Two messages fighting for the first impression.

## Design considerations

- **Two-tier testing, deliberately.** The mocked keyless lanes are the
  regression net (fast, deterministic, fork-safe) and are genuinely good — the
  cloud-only specs assert the exactly-once POST at the network boundary and the
  confused-user storms are fuzzed. Keep them. The live lane is the *verification
  of record*; fixing it beats adding anything new.
- **Real accounts are already reachable.** Two independent mechanisms exist:
  API-key sessions (`ELIZAOS_CLOUD_API_KEY`, used by `cloud-live.spec.ts`) and
  the genuine SIWE handshake via the e2e wallet (covers the login UX itself,
  works headless on devices). The MVP test plan is wiring, not building.
- **Device evidence tooling exists.** `startAndroidScreenRecord` (MP4 via adb),
  `simctl io recordVideo`, and the screenshot helpers are already in the lanes;
  posting inline (MP4 + JPG) is a convention change, not new machinery.
- **A "liveness contract" is the cheapest strong guarantee.** Every onboarding
  path, on every surface, should end the same way: send one real chat message,
  assert a real (non-stub-marker) reply. `cloud-live.spec.ts` already encodes
  this pattern (`STUB_FIXTURE_MARKER` negative assertion) — generalize it.
- **No new onboarding scope.** No name pickers, provider marketplaces, or
  wizard steps. The one-tap flow is right for children, elderly users, and
  everyone in between — fewer steps is the accessibility strategy, with no
  special rails and no therapy language (the current copy already complies).

## Open questions → answers

**Q1. Is the flagged local path in MVP test scope?**
A: Keep it verified at the flag boundary only: the existing unit tests, the
existing mocked chooser-mode lanes, and one assertion that store/cloud-locked
builds can never enable it. Do not build live lanes for local onboarding — the
MVP default is cloud, and the dev-smoke live lane already covers local
first-run for developers with keys. (Owner-confirmable, but the default is
clear from "minimize scope".)

**Q2. Should the tutorial auto-launch after onboarding?**
A: No. Today it never auto-launches (tile, notification, typed command,
`/tutorial` view) and the wrap-up copy points at it. That matches the views
doctrine (no suggestion chips, agent-proactive is for view switches) and the
no-special-rails constraint. Keep as-is; test discoverability instead.

**Q3. Keep the one-time character-select landing after cloud-only completion?**
A: Default answer: remove it for MVP — cloud-only completion already lands in
chat with "ask me anything", and a full-screen detour immediately after
contradicts one-obvious-path. Because #13396 made this a deliberate product
decision, this needs a one-line owner confirmation before deleting; the issue
below is written to ask first, then act.

**Q4. Where should real-cloud onboarding verification run?**
A: Keep `app-live-e2e.yml` nightly as the home (it exists, is secret-gated,
and never runs on fork PRs), fix its two red jobs independently, and add
`workflow_dispatch` usage to the Definition of Done for onboarding-touching
PRs: run the lane, link the green run in the PR. Do not move live tests into
keyless PR lanes — they cannot have secrets.

**Q5. Does help need any UI surface beyond chat?**
A: No. #13394 deleted the view deliberately; the launcher keeps the tutorial
tile and the notification inbox points "Get help any time" at `/chat`. What is
missing is *proof* the agent answers help questions — a scenario, not a view.

**Q6. How should evidence be attached now?**
A: Inline in the GitHub issue/PR: MP4 (renders inline) for walkthroughs and
device recordings, JPG for screenshots (size), plus logs/trajectory excerpts in
collapsed `<details>` blocks. Specs should stop writing to
`.github/issue-evidence/`; CI lanes upload artifacts and the PR author posts
the reviewed files inline. Issue drafts below encode this.

## Recommendation (minimal-scope MVP plan, ordered)

1. **P0 — Make the live lane green** (`app-live-e2e.yml`): triage the
   desktop-packaged runtime-copy failure and the `live-agent-chat.spec.ts`
   timeout; a green scheduled run with reviewed artifacts is the acceptance.
   Everything else in this workstream depends on this lane meaning something.
2. **P0 — Automate the production-default path on devices**: wire the e2e
   wallet (`eliza:e2e-wallet:pk` + `:autologin`) into an iOS-simulator and
   Android-emulator lane that performs the REAL SIWE handshake, onboards
   through the real UI, and records MP4 + JPG. The manual #13377 recipe is the
   spec; turn it into a command.
3. **P1 — Liveness contract everywhere**: every onboarding e2e (desktop
   packaged, web, iOS, Android, cloud-live) ends with one real chat turn and a
   non-stub reply assertion.
4. **P1 — Help scenario**: a scenario-runner scenario that asks realistic help
   questions ("what do I do first?", "how do I talk to it?", "how do I restart
   the tour?") against a live model with the seeded help knowledge, trajectory
   reviewed by hand.
5. **P1 — Land or explicitly descope PR #14168** (boot trouble speaks in
   chat). It is the remaining piece of "all status happens in chat".
6. **P2 — Post-onboarding landing cleanup**: owner decision on the
   character-select detour; delete if confirmed.
7. **P2 — Spec/evidence hygiene**: move spec evidence output to CI artifacts +
   inline posting; keep the chooser-lock regression assertions.

## Out of scope (MVP non-goals)

- Any new onboarding step, wizard, or personalization flow.
- Live/e2e investment in the flagged local-model onboarding path beyond the
  flag-boundary tests that exist.
- Re-adding a Help view or a searchable FAQ surface.
- Redesigning the tutorial script or adding tour steps.
- The cloud login web page polish (#13519 sign-in flash) — cloud-frontend
  workstream, not this one.
- Therapy-flavored or audience-segmented onboarding copy — explicitly banned;
  current copy is universal and stays that way.

## Proposed issues

1. `[onboarding] P0 — Resurrect App Live E2E: real cloud login + real-LLM chat must produce a green nightly run`
2. `[onboarding] P0 — Device e2e for the default cloud sign-in onboarding via the SIWE e2e wallet (iOS sim + Android emu)`
3. `[onboarding] P1 — Liveness contract: every onboarding e2e ends with a real chat turn and a non-stub reply`
4. `[onboarding] P1 — Scenario: agent answers help questions from seeded help knowledge (live LLM, trajectory reviewed)`
5. `[onboarding] P1 — Land in-chat boot recovery (PR #14168): rebase, resolve, verify no floating banners remain`
6. `[onboarding] P2 — Remove the one-time character-select landing after cloud-only onboarding (owner confirm, then delete)`
7. `[onboarding] P2 — Onboarding test hygiene: inline MP4/JPG evidence, drop .github/issue-evidence writes, chooser-lock assertions`
