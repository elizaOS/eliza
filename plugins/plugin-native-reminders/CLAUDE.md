# @elizaos/macosreminders

macOS Apple Reminders native bridge policy helpers for elizaOS host runtimes.

## Purpose / role

This package owns reusable native Apple Reminders bridge policy. It is not an
elizaOS runtime `Plugin` object and does not register actions, providers,
services, routes, or views. Higher-level packages such as
`@elizaos/plugin-lifeops` import its helpers when they need to resolve the
macOS EventKit dylib used to create, update, or delete Apple Reminders.

LifeOps may own the personal-assistant reminder workflow, DTO projection,
approval policy, and scheduled-task integration. It should not own reusable
native bridge policy.

## Plugin surface

| Export | Description |
|---|---|
| `appleRemindersMacosBridgeCandidates` | Shared macOS EventKit dylib candidate policy. |
| `APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME` | Expected macOS EventKit dylib basename. |
| `AppleRemindersMacosBridgeCandidate` | Candidate record type. |

## Layout

```
plugins/plugin-native-reminders/
  src/
    index.ts                 Public exports.
    macos-bridge-policy.ts   Shared macOS EventKit dylib candidate policy.
```

## Commands

```bash
bun run --cwd plugins/plugin-native-reminders test
bun run --cwd plugins/plugin-native-reminders build
bun run --cwd plugins/plugin-native-reminders clean
```

## Config / env vars

The candidate policy accepts the caller-resolved env path. Current LifeOps
callers pass `ELIZA_NATIVE_PERMISSIONS_DYLIB` explicitly so this package stays
pure and testable.

## Conventions / gotchas

- Keep reusable native bridge policy here, not in LifeOps.
- Do not add LifeOps DTOs, scheduled-task behavior, or owner-assistant prompt
  text to this package.
- The current macOS dylib is shared with the desktop permissions/EventKit
  bridge. If the dylib is renamed or split, update the basename here and keep
  host packages importing it.
- See the root `AGENTS.md` for repo-wide architecture rules.
