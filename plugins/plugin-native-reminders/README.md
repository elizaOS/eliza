# @elizaos/macosreminders

macOS Apple Reminders native bridge policy helpers for elizaOS host runtimes.


Install workspace dependencies with `bun install` at the repository root.

Build from the repository root:

```bash
bun run --cwd plugins/plugin-native-reminders build
```

Test from the repository root:

```bash
bun run --cwd plugins/plugin-native-reminders test
```

## Android candidate

An additive [Android reminder engine](android/README.md) provides host-configured storage, scheduling, notification actions and a Capacitor base bridge. Its source ships in the package; generated Gradle outputs and the consumer fixture do not. The existing macOS entrypoint remains unchanged. See the [independent consumer](test/android-consumer/README.md) for build and qualification instructions. This candidate is not release-qualified.

Import `registerAndroidReminders` from `@elizaos/macosreminders/android` and pass the exact Capacitor name declared by the host subclass. Install `@capacitor/core` 8.3.1 or compatible 8.x for this entrypoint; it is an optional peer so existing macOS consumers do not need it. Importing the entrypoint does not register a plugin, map the Apple API, or supply a simulated web fallback. Resolved `unknown` outcomes require reconciliation; rejected promises and resolved failure statuses must be handled separately.

After building, `bun run --cwd plugins/plugin-native-reminders test:android-package` packs the real package and checks an external NodeNext consumer, explicit alert/null typing, reviewed-target bindings and unsupported-web rejection. This verifies packaging and TypeScript contracts, not native execution.
