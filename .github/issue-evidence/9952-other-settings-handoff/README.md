# #9952 follow-up — "Other / configure in Settings" actually opens Settings (C1) + cloud error hardening (C2)

PR #10302 moved first-run onboarding fully in-chat (closing #9952), but left one
acceptance criterion unmet and one robustness gap. Both fixed here.

## C1 — "Other / configure in Settings" never routed to Settings (the AC miss)

#9952's AC: _an "other" option (Anthropic sub / Codex / z.ai / Moonshot-Kimi)
that routes to Settings via the existing handoff._

On `develop` the in-chat conductor's `provider:other` choice set
`localInference: "all-local"` — **identical to `on-device`**. Two consequences:

1. `buildFirstRunSubmitPlan` set `omitRuntimeProvider = !cloudInference` → `true`
   for any local draft, so `buildFirstRunRuntimeConfig` computed
   `needsProviderSetup = !llmText && !omitRuntimeProvider` → **always `false`**.
   The finish path's "Open Settings" banner (`first-run-finish.ts:143`) therefore
   **never fired** for "Other".
2. `firstRunDownloadsLocalModel("all-local") === true` → picking "Other" silently
   kicked off an on-device **model download**.

So "Other / configure in Settings" behaved exactly like "On this device" and the
conductor's own comment ("'other' surfaces the needs-provider-setup banner")
was false.

### Fix

- New `FirstRunLocalInference` member **`configure-later`** (bring-your-own-keys):
  runs the local backend, **no model wired, no download**, and leaves
  `needsProviderSetup` **true** so the "Open Settings" handoff fires.
- `omitRuntimeProvider` now keys off `localInference === "all-local"` only —
  behavior-preserving for cloud / cloud-inference / on-device.
- Conductor routes `provider:other → configure-later`.
- Regression test (`first-run.test.ts`): `configure-later` ⇒ `needsProviderSetup
  true`, no `provider` in payload, `firstRunDownloadsLocalModel === false`.

## C2 — cloud provisioning was fire-and-forget

`listOrAutoProvisionCloudAgent` / `bindCloudAgent` were called
`void fn().then(…)` with **no `.catch`**. A reject (OAuth/network) became an
unhandled rejection and stranded the "Connecting…" turn with no recovery (the
local path already funnels throws to `seedError`). Both now `.catch → seedError`,
re-seeding the runtime choice so the user can retry.

## Visual + color verification (`onboarding-rendered.png`)

The real `ContinuousChatOverlay` was rendered with the conductor's onboarding
turns seeded (greeting + runtime CHOICE + provider CHOICE). Critically assessed
description-vs-actual:

- **Renders as designed:** greeting "Hi — I'm Eliza. Let's get you set up. First,
  where should your agent run?"; runtime buttons _Eliza Cloud (managed) / On this
  device / Bring your own keys_; provider buttons _On this device (recommended) /
  Eliza Cloud / **Other / configure in Settings**_; "Ask Eliza" composer. The
  #9142 drag-handle bar is visibly painted at the top.
- **Hard color test (all 6 choice buttons):** computed `background = rgba(0,0,0,0)`,
  `border = rgb(229,231,235)` (neutral gray), `text = rgb(255,255,255)`. **No blue
  anywhere** (brand rule satisfied); the orange backdrop is the e2e fixture's glass
  test background, not the real app surface. 0 error-level console logs.

(The `?onboarding` fixture seed + runner used to capture this were temporary and
are not committed; the screenshot is the artifact.)
