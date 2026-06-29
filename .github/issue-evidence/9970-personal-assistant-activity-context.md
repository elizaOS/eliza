# Personal Assistant Activity Context Evidence

Issue: #9970
Date: 2026-06-29
Machine: Windows, PowerShell, Bun 1.4.0-canary.1, Node 24

## Slice

This PR wires the existing macOS activity-event reporting path into the
owner-only `activity-profile` provider. It does not add a scheduler or a second
activity store.

Implemented:

- `getLatestForegroundActivity()` derives the latest current foreground app
  from `life_activity_events`, returning `null` when the latest event is a
  deactivation or OS inactivity surface.
- `activityProfileProvider` now reads today's existing dwell report via
  `getActivityReportBetween()` and injects a compact ambient context line:
  `current app <app> for <duration> | today apps <top apps>`.
- Provider values/data now include current app and today's top app usage for
  downstream PRIORITIZE/proactive consumers.
- The provider keeps its existing OWNER role gate and `screen_time` / `tasks` /
  `health` context gate.

## Validation

Passed:

```text
$ bun run biome check plugins\plugin-personal-assistant\src\providers\activity-profile.ts plugins\plugin-personal-assistant\src\activity-profile\activity-tracker-reporting.ts plugins\plugin-personal-assistant\test\activity-profile-provider.test.ts plugins\plugin-personal-assistant\test\activity-tracker-reporting.test.ts
Checked 4 files in 615ms. No fixes applied.

$ bun run --cwd plugins\plugin-personal-assistant test activity-profile-provider.test.ts activity-tracker-reporting.test.ts
[lint-default-packs] clean — 0 findings across default packs.
Test Files  2 passed (2)
Tests  7 passed (7)

$ bun run --cwd plugins\plugin-personal-assistant build:types
$ tsc --noCheck -p tsconfig.build.json
```

Inconclusive / blocked locally:

```text
$ bun run --cwd plugins\plugin-personal-assistant test
Timed out after 304s without a completion signal.
```

## Evidence Matrix

- Real-LLM trajectory: N/A for this provider-only slice; required for the next
  outcome-scenario work in #9970.
- Backend logs: code path emits structured `[activity-profile] Injected ambient
  app-usage context.` debug metadata; unit test asserts the log call.
- Frontend screenshots/video: N/A, no UI surface changed.
- Audio: N/A, no voice/TTS/STT surface changed.
