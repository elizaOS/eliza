# #13377 — onboarding UX polish evidence (PR #14168)

Captured 2026-07-05 from the live ui-smoke Playwright stack (Chromium, desktop
viewport) on `feat/13377-onboarding-ux-polish`, all lanes green.

- `cloud-only-sign-in-greeting.png` — fresh boot: the full-screen onboarding
  sheet with the single "Sign in to Eliza Cloud" path. No floating boot pill
  or banner anywhere above the chat.
- `cloud-only-home.png` — the completion edge settled at the HALF detent:
  home + widgets revealed behind the top half, conversation still in hand,
  no suggestion chips on the dashboard.
- `cloud-only-session-injection-home.png` / `cloud-only-auto-adopt-home.png` —
  zero-interaction paths (stored session; existing agent auto-adopted, no
  picker).
- `onboarding-fresh-boot-signin-full-to-half.webm` — full walkthrough of the
  tap flow including the full→half settle animation.
- `session-injection-zero-tap.webm` — stored-session boot straight to the
  onboarded home.
- `handoff-failure-in-chat-retry-setup.webm` — a failed dedicated-agent
  handoff speaking IN the chat ("I couldn't finish setting up your dedicated
  agent…") with the Retry setup control dispatching the handoff supervisor;
  the old floating toast never appears.
