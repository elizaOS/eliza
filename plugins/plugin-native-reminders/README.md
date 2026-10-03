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

An additive [Android reminder engine](android/README.md) provides host-configured storage, scheduling, notification actions and a Capacitor base bridge. Its source ships in the package; generated Gradle outputs and the consumer fixture do not. The existing macOS entrypoint remains unchanged. See the [independent consumer](test/android-consumer/README.md) for build and qualification instructions. This candidate has no typed JavaScript Android entrypoint yet and is not release-qualified.
