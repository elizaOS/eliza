# @elizaos/capacitor-calendar

A Capacitor plugin that reads and writes Apple Calendar events through EventKit, for use
in elizaOS iOS apps and macOS desktop runtimes.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-calendar build  # build
```


## Android CalendarProvider adapter

Android uses a separate, ESM-only `@elizaos/capacitor-calendar/android` entrypoint.
Import `registerAndroidCalendar` and call it with the exact name of your registered
native subclass. The root AppleCalendar API and web fallback remain unchanged.
This entrypoint deliberately has no web simulation and no CommonJS redirect to
the Apple bundle; an absent native implementation rejects calls.

Subclass `ai.eliza.plugins.calendar.CalendarPlugin` with an immutable
`CalendarConfiguration` and both documented permission aliases. Register it in
your BridgeActivity and include the Android Gradle library. See `android/README.md`
for identity, lifecycle and journal compatibility requirements. Account/calendar
names, journal name and creation URI prefix are migration-sensitive host values.

The exported Android types distinguish editor timestamps/body from reviewed-agent
ISO dates/description. Permission-required, conflict, unknown and cancellation are
results callers must handle. Promise rejection remains possible. A saved creation
receipt must be acknowledged explicitly; unknown operations must not be replayed.

Android bridge/provider tests do not establish a host's upgrade or physical-device
acceptance. Preserve existing host storage identities and run migration tests.

Android provider and bridge integration coverage: [independent consumer](test/android-consumer/README.md).

After building, `bun run --cwd plugins/plugin-native-calendar test:android-package`
packs the package and checks an external NodeNext consumer, reviewed-operation
types, the CommonJS Apple export, unsupported-native rejection and exact tracked
Android source bytes. This qualifies packaging, not native execution.
