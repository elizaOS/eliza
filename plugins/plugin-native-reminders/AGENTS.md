# @elizaos/macosreminders

macOS Apple Reminders native bridge policy helpers for elizaOS host runtimes.

## Purpose / role

This package owns reusable native Apple Reminders bridge policy. It is not an
elizaOS runtime `Plugin` object and does not register actions, providers,
services, routes, or views. Higher-level packages such as
`@elizaos/plugin-personal-assistant` import its helpers when they need to resolve the
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

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-reminders clean           # remove build output
bun run --cwd plugins/plugin-native-reminders build           # build package artifacts
bun run --cwd plugins/plugin-native-reminders typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-reminders lint            # mutating Biome check
bun run --cwd plugins/plugin-native-reminders lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-reminders format          # write formatting
bun run --cwd plugins/plugin-native-reminders format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-reminders test            # run package tests
bun run --cwd plugins/plugin-native-reminders prepublishOnly  # publish-time build hook
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
- See the root `CLAUDE.md` for repo-wide architecture rules.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
