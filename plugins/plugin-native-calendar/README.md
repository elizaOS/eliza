# @elizaos/capacitor-calendar

Reads and writes Apple Calendar events through EventKit, for elizaOS iOS apps and macOS desktop runtimes.

## What it does

This package provides a Capacitor native-bridge plugin (`AppleCalendar`) that gives elizaOS apps running on iOS (or macOS via the Electrobun desktop shell with the EventKit dylib) full read/write access to the device's calendar store. On web/browser targets every method returns a graceful `not_supported` error.

## Capabilities

| Operation | Method |
|-----------|--------|
| Check EventKit permission state | `AppleCalendar.checkPermissions()` |
| Request calendar access from the user | `AppleCalendar.requestPermissions()` |
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
- iOS 17+ requires full-access authorization (`requestFullAccessToEvents`). `writeOnly` authorization is treated as `restricted`.

## Required platform setup

### iOS

Add the plugin to your Capacitor iOS project:

```bash
npm install @elizaos/capacitor-calendar
npx cap sync ios
```

Add the `NSCalendarsFullAccessUsageDescription` key to `Info.plist` explaining why calendar access is needed. Without this key the system will deny access.

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
```

## Config / Env Vars

None. This package reads no environment variables. Authorization is granted at the OS level by the user.

## License

MIT — elizaOS
