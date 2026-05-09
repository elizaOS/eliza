# Health platform fallback (W1-B)

## Summary

`plugin-health` is the single place that decides **which health backend is
used to satisfy a `health_signal_observed` completion check**. Two cases:

1. **Native HealthKit available** (`process.platform === "darwin"` and the
   HealthKit CLI helper at `${HEALTH_KIT_HELPER_PATH}` is present and
   executable). The runtime uses the helper as a primary signal source.
2. **HealthKit unavailable** (every non-darwin host, plus darwin hosts where
   the helper binary is not installed). The runtime degrades the
   completion check to `user_acknowledged` — the task fires its prompt
   and waits for the user to acknowledge in chat or via the in-app card.

Per `IMPLEMENTATION_PLAN.md` §3.2 (the W1-B deliverables) and
`GAP_ASSESSMENT.md` §4.4 / §10.2 (cross-platform travel + smoke).

## Resolution rule (canonical)

```ts
import { detectHealthBackend } from "@elizaos/plugin-health";

const backend = await detectHealthBackend({ ... });

// Pseudocode — concrete enforcement lives in the W1-A scheduler runner
// once that ships.
if (backend === "healthkit_helper" || backend === "google_fit") {
  // health_signal_observed evaluates against the actual sample stream.
} else {
  // Degrade: completionCheck.kind = "user_acknowledged"
  // The runner logs a structured `health_signal_observed_degraded`
  // entry on the task state log so this is traceable per fire.
}
```

The actual `detectHealthBackend` implementation lives in `health-bridge.ts`
and inspects `process.platform`, the helper-binary path, and the optional
Google Fit OAuth grant. The detection is per-tick — operators who install
the helper after first run see an automatic upgrade on the next scheduler
tick.

## Why a separate doc, not just a comment

Three callers need to agree on this fallback:

  1. The W1-A `ScheduledTask` runner — when evaluating
     `completionCheck.kind === "health_signal_observed"`, the runner asks
     `plugin-health` for the current backend and substitutes
     `user_acknowledged` evaluation if no backend is available.
  2. The W1-D default-pack lint pass — packs that ship a
     `health_signal_observed` completion check must declare a fallback path
     so non-darwin users don't see eternally-pending tasks. The lint pass
     reads this file's rule.
  3. The W1-B sleep-recap default pack itself — the recap relies on baseline
     sleep data; on hosts without a backend the pack downgrades to a
     manually-acknowledged "did you sleep okay?" message.

A code comment co-located with `detectHealthBackend` would have to be
duplicated in three call sites; this document is the single source of
truth.

## Logged degradation envelope

Every fallback emit logs a one-line structured entry:

```jsonc
{
  "src": "plugin:health",
  "event": "health_signal_observed_degraded",
  "taskId": "<taskId>",
  "fallbackTo": "user_acknowledged",
  "reason": "no_health_backend",
  "platform": "<process.platform>",
  "helperPathChecked": "<HEALTH_KIT_HELPER_PATH>",
  "googleFitConnected": false
}
```

The `event` field is stable; consumers (telemetry, observability, the
auto-training cohort) treat the line as the canonical signal that a task
fired its degraded path.

## Not in scope here

- Per-connector OAuth status. That belongs in
  `health-connectors.ts` (Strava / Fitbit / Withings / Oura). The fallback
  rule above only governs HealthKit + Google Fit, the two backends used
  for sleep / wake completion-check evaluation.
- The `wake.observed` vs `wake.confirmed` hysteresis. That is a separate
  decision in `circadian-rules.ts`; both anchors fire regardless of
  HealthKit availability because the underlying signal stream comes from
  the activity-signal bus, not the health backend.
