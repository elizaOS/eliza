# @elizaos/capacitor-calendar

A Capacitor plugin that reads and writes Apple Calendar events through EventKit, for use in elizaOS iOS apps and macOS desktop runtimes.

## Purpose / Role

This package exposes a `AppleCalendar` Capacitor plugin object that Eliza agents embedded in an iOS or macOS Electrobun application can call to interact with the device's native calendar store via EventKit. On web/browser targets the plugin stubs every method with a graceful `not_supported` error — no calendar access is possible outside the native runtime. The package is **not** an elizaOS `Plugin` object (no actions/providers/services); it is a Capacitor native-bridge library imported by whichever elizaOS plugin or service layer needs calendar access.

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

```bash
bun run --cwd plugins/plugin-native-calendar build          # tsc + rollup → dist/
bun run --cwd plugins/plugin-native-calendar clean          # remove dist/
bun run --cwd plugins/plugin-native-calendar prepublishOnly # build before npm publish
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
- **Build output:** `dist/plugin.cjs.js` (CJS), `dist/esm/index.js` (ESM), `dist/plugin.js` (IIFE for unpkg). The `bun`/`development` export condition resolves directly to `src/index.ts` to skip the build step in dev.
- See the root `AGENTS.md` for repo-wide architecture rules, naming conventions, and logger requirements.
