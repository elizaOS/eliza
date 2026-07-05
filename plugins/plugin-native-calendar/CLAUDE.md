# @elizaos/capacitor-calendar

A Capacitor plugin that reads and writes Apple Calendar events through EventKit, for use in elizaOS iOS apps and macOS desktop runtimes.

## Purpose / Role

This package exposes a `AppleCalendar` Capacitor plugin object that Eliza agents embedded in an iOS or macOS Electrobun application can call to interact with the device's native calendar store via EventKit. On web/browser targets every method returns a graceful `not_supported` result — no calendar access is possible outside the native runtime. The package is **not** an elizaOS `Plugin` object (no actions/providers/services); it is a Capacitor native-bridge library imported by whichever elizaOS plugin or service layer needs calendar access.

## Plugin Surface

This is a **Capacitor bridge library**, not an elizaOS runtime plugin. It registers one Capacitor plugin object:

| Export | Description |
|--------|-------------|
| `AppleCalendar` | Capacitor plugin instance. Call its methods to access EventKit. |
| `appleCalendarMacosBridgeCandidates` | Shared macOS EventKit dylib candidate policy consumed by LifeOps and other host plugins. |
| `APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME` | Expected macOS EventKit dylib basename. |

### `AppleCalendar` methods (all return Promises)

| Method | Input | Description |
|--------|-------|-------------|
| `checkPermissions()` | — | Returns current EventKit authorization state (granted/denied/prompt/restricted). |
| `requestPermissions()` | — | Prompts the user for calendar access. iOS 17+ uses full-access API. |
| `listCalendars()` | — | Returns all calendars visible in EventKit. |
| `listEvents(options)` | `{ calendarId?, timeMin, timeMax }` | Fetches events within the ISO 8601 time window. Pass `calendarId = "all"` or omit for every calendar. |
| `createEvent(input)` | `AppleCalendarEventInput` | Creates and saves a new event. Attendees are not supported by EventKit for third-party apps. |
| `updateEvent(input)` | `AppleCalendarUpdateEventInput` | Patches fields on an existing event by `eventId`. |
| `deleteEvent(input)` | `{ eventId }` | Removes an event by EventKit identifier. |

### Exported types (from `src/definitions.ts`)

`AppleCalendarPlugin`, `AppleCalendarPermissionStatus`, `AppleCalendarPermissionState`, `AppleCalendarSummary`, `AppleCalendarEvent`, `AppleCalendarAttendee`, `AppleCalendarEventInput`, `AppleCalendarUpdateEventInput`, `AppleCalendarDeleteEventInput`, `AppleCalendarListEventsOptions`, `AppleCalendarListResult`, `AppleCalendarEventsResult`, `AppleCalendarEventResult`, `AppleCalendarBaseResult`.

## Layout

```
plugins/plugin-native-calendar/
  src/
    index.ts          Entry: registers "AppleCalendar" Capacitor plugin, lazy-loads web fallback.
    definitions.ts    All TypeScript interfaces and types for the plugin API.
    macos-bridge-policy.ts  Shared macOS EventKit dylib candidate policy.
    web.ts            Browser/web fallback. checkPermissions/requestPermissions return { calendar: "restricted", canRequest: false }; all other methods return { ok: false, error: "not_supported" }.
  ios/Sources/CalendarPlugin/
    CalendarPlugin.swift  Swift implementation: EventKit CRUD, permission handling, JSON mapping.
  ElizaosCapacitorCalendar.podspec  CocoaPods spec (pod name: ElizaosCapacitorCalendar; iOS 15+; EventKit + UIKit).
  rollup.config.mjs   Rollup bundle config for CJS + ESM dist artifacts.
  tsconfig.json       TypeScript config.
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-calendar clean           # remove build output
bun run --cwd plugins/plugin-native-calendar build           # build package artifacts
bun run --cwd plugins/plugin-native-calendar typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-calendar lint            # mutating Biome check
bun run --cwd plugins/plugin-native-calendar lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-calendar format          # write formatting
bun run --cwd plugins/plugin-native-calendar format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-calendar test            # run package tests
bun run --cwd plugins/plugin-native-calendar prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-calendar build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / Env Vars

None. This package reads no environment variables and has no runtime configuration. All behavior is governed by iOS/macOS system permissions granted by the user.

## How to Extend

### Add a new method to the Capacitor bridge

1. Define the method signature in `src/definitions.ts` on `AppleCalendarPlugin` and add any input/output interfaces.
2. Add a web fallback returning `{ ...unsupported }` in `src/web.ts` so browser targets keep compiling.
3. Add the native implementation in `ios/Sources/CalendarPlugin/CalendarPlugin.swift`:
   - Register it in `pluginMethods` with `CAPPluginMethod(name: "myMethod", returnType: CAPPluginReturnPromise)`.
   - Implement `@objc func myMethod(_ call: CAPPluginCall)`.
4. Re-export any new types from `src/index.ts` if they need to be public (re-exported automatically via `export * from "./definitions"`).
5. Build: `bun run --cwd plugins/plugin-native-calendar build`.

## Conventions / Gotchas

- **Not an elizaOS Plugin object.** There is no `Plugin` export with actions/providers/services. This is a Capacitor bridge; import `AppleCalendar` and call it directly from service code.
- **Attendees are blocked by EventKit.** `createEvent`/`updateEvent` reject any `attendees` payload with `error: "unsupported_feature"`. EventKit does not permit third-party apps to set invitees.
- **macOS uses the Electrobun EventKit dylib**, not this Capacitor plugin, for the desktop runtime. This Capacitor path is for the iOS/Capacitor app shell only.
- **macOS bridge policy lives here.** Host plugins may resolve and call the Electrobun EventKit dylib, but the candidate list and expected basename belong to this package.
- **iOS 17+ permission model.** `requestFullAccessToEvents` is used on iOS 17+; older devices fall back to `requestAccess(to:)`. `writeOnly` authorization maps to `restricted`, not `granted`.
- **Dates must be ISO 8601.** The Swift layer accepts both fractional-seconds and whole-seconds variants; always pass UTC ISO strings from TypeScript.
- **`calendarId = "primary"` or `""` resolves to `defaultCalendarForNewEvents`** in the Swift layer.
- **Build output:** `dist/plugin.cjs.js` (CJS), `dist/esm/index.js` (ESM), `dist/plugin.js` (IIFE for unpkg). The `bun`/`development` export condition resolves directly to `src/index.ts` for source-mode development.
- See the root `AGENTS.md` for repo-wide architecture rules, naming conventions, and logger requirements.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
