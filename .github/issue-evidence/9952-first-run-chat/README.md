# #9952 — first-run in-chat login/runtime/provider flow

Verification date: 2026-06-29
Verified tree: `origin/develop` at `06d475e67f`, plus local verify-cleanup branch
`chore/verify-lint-drift-995x` for formatting drift only.

## What was verified

- The first visible surface is an agent chat greeting, not a full-screen
  onboarding gate.
- Runtime/account choices render as in-chat choice options:
  `Log in with Eliza Cloud`, `Run locally on this device`, and
  `Connect my own agent`.
- Cloud, local, remote, provider, pick-agent, and busy states render on both
  mobile and desktop in the focused E2E.
- The cloud and local paths each POST `/api/first-run` exactly once and persist
  `firstRunComplete`.
- The "other provider" path routes to Settings.
- The app-level first-run smoke boots the actual app startup surface without a
  render loop and lets the runtime be chosen.

## Evidence

Regenerate focused flow:

```bash
bun run --cwd packages/ui test:onboarding-e2e
```

Captured screenshots:

- `01-mobile-greet-runtime.png` — mobile agent greeting + inline runtime choices.
- `08-desktop-greet-runtime.png` — desktop agent greeting + inline runtime choices.
- `05-mobile-cloud-signin.png` — mobile cloud sign-in step.
- `11-desktop-remote.png` — desktop remote-agent path.

Additional app smoke:

```bash
bunx playwright test test/ui-smoke/first-run-startup.spec.ts \
  --config playwright.ui-smoke.config.ts --project=chromium
```

Result: `1 passed`.

## Manual review

I opened `01-mobile-greet-runtime.png` and `08-desktop-greet-runtime.png`.
Both show the greeting as the first surface and the choice options inline in the
chat flow. The screenshots do not show the removed full-screen onboarding gate.
Text is readable on mobile and desktop, with no obvious overlap.

## N/A

- Real-LLM trajectory: N/A. This is a deterministic startup/setup UI flow, not
  agent model behavior.
- Audio/voice: N/A. No voice path changed for this issue.
