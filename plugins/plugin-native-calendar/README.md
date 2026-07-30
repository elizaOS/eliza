# @elizaos/capacitor-calendar

Reads and writes Apple Calendar events through EventKit, for elizaOS iOS apps and macOS desktop runtimes.

## What it does

This package provides a Capacitor native-bridge plugin (`AppleCalendar`) for elizaOS apps running on iOS (or macOS via the Electrobun desktop shell with the EventKit dylib). Full EventKit authorization supports calendar/event CRUD. iOS 17+ write-only authorization is represented separately and supports only adding a new event to the system default calendar. On web/browser targets every method returns a graceful `not_supported` error.

## Capabilities

| Operation | Method |
|-----------|--------|
| Check EventKit permission state | `AppleCalendar.checkPermissions()` |
| Request full calendar access from the user | `AppleCalendar.requestPermissions()` |
| Request write-only calendar access on iOS 17+ | `AppleCalendar.requestPermissions({ access: "write_only" })` |
| List all calendars | `AppleCalendar.listCalendars()` |
| Fetch events in a time window | `AppleCalendar.listEvents({ timeMin, timeMax, calendarId? })` |
| Create a new event | `AppleCalendar.createEvent(input)` |
| Update an existing event | `AppleCalendar.updateEvent({ eventId, ...input })` |
| Delete an event | `AppleCalendar.deleteEvent({ eventId })` |

All methods return a Promise. Results include an `ok: boolean` field; failures include `error` and `message` string fields.

## Limitations

- **Attendees are not supported.** EventKit does not permit third-party apps to set event invitees. Passing `attendees` to `createEvent` or `updateEvent` returns `error: "unsupported_feature"`.
- **macOS desktop** uses the Electrobun EventKit dylib, not this Capacitor plugin.
- **Browser/web** targets receive `{ ok: false, error: "not_supported" }` from every method.
- **Write-only is add-only.** It cannot list calendars, read events, update events, or delete events, including events this app previously added. Creation is restricted to `defaultCalendarForNewEvents`; selecting another calendar returns `error: "write_only_default_calendar_only"`.
- **Write-only creation does not imply readback.** Its success result contains a receipt with `readBackAvailable: false` and `eventId: null`, not an event object.
- `AppleCalendarEventInput` requires `title`, `startAt`, and `endAt`; EventKit also requires a writable calendar, which the bridge resolves to the system default under write-only access.
- iOS versions before 17 use the legacy `requestAccess(to:)` API. An approved request grants the legacy full-access state even when a caller requested write-only.

## Required platform setup

### iOS

Add the plugin to your Capacitor iOS project:

```bash
npm install @elizaos/capacitor-calendar
npx cap sync ios
```

Add the usage-description keys for every mode the host requests:

- `NSCalendarsFullAccessUsageDescription` for full read/write access on iOS 17+.
- `NSCalendarsWriteOnlyAccessUsageDescription` for add-only access on iOS 17+.
- `NSCalendarsUsageDescription` for the legacy request on earlier iOS releases.

Missing a required usage description can terminate the app when it requests that permission.

The native pod (`ElizaosCapacitorCalendar`) requires iOS 15.0+ and Swift 5.9+.

## Usage

```typescript
import { AppleCalendar } from "@elizaos/capacitor-calendar";

// Check and request permission
const status = await AppleCalendar.checkPermissions();
if (status.calendar !== "granted") {
  await AppleCalendar.requestPermissions();
}

// List events for the next 7 days
const now = new Date();
const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
const result = await AppleCalendar.listEvents({
  timeMin: now.toISOString(),
  timeMax: nextWeek.toISOString(),
});
if (result.ok) {
  console.log(result.events);
}

// Create an event
const created = await AppleCalendar.createEvent({
  title: "Team sync",
  startAt: "2026-06-01T10:00:00.000Z",
  endAt: "2026-06-01T11:00:00.000Z",
});

// A privacy-minimizing add-only flow can request write-only access instead.
const addOnly = await AppleCalendar.requestPermissions({
  access: "write_only",
});
if (addOnly.calendar === "write_only") {
  const receipt = await AppleCalendar.createEvent({
    title: "School pickup",
    startAt: "2026-06-01T22:00:00.000Z",
    endAt: "2026-06-01T22:30:00.000Z",
  });
  // receipt.receipt?.readBackAvailable is false: EventKit does not allow
  // reading back an event created with write-only authorization.
}
```

## Config / Env Vars

None. This package reads no environment variables. Authorization is granted at the OS level by the user.
