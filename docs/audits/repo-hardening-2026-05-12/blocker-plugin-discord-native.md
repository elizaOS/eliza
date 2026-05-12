# plugin-discord Native Voice Binding Blocker

## Scope

- Package: `plugins/plugin-discord`
- Blocker: `bun run --cwd plugins/plugin-discord test` failed during import before `actions/messageConnector.test.ts` could run.
- Native package: optional `@snazzah/davey` binding loaded through `@discordjs/voice`.

## Reproduction

`bun` was not on this shell's `PATH`, so the same command was run with the installed Bun binary:

```sh
/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-discord test
```

Initial result:

```text
FAIL actions/messageConnector.test.ts [ actions/messageConnector.test.ts ]
Error: Cannot find native binding.
  ../../node_modules/.bun/@snazzah+davey@0.1.11/node_modules/@snazzah/davey/index.js:500:11
  voice.ts:3:1
```

## Import Path

The failing test does not exercise Discord voice. The native binding was loaded by this eager import path:

```text
plugins/plugin-discord/actions/messageConnector.test.ts
  -> plugins/plugin-discord/service.ts
  -> plugins/plugin-discord/voice.ts
  -> @discordjs/voice
  -> @snazzah/davey native binding
```

`plugins/plugin-discord/tests.ts` also had eager value imports from `@discordjs/voice`, which could make plugin import unsafe when the plugin root imports its live test suite.

## Fix

- Replaced eager `@discordjs/voice` value imports in `voice.ts` with erased type imports.
- Added a cached `loadDiscordVoiceModule()` dynamic import used only by actual voice operations.
- Wrapped dynamic import failures in `DiscordVoiceUnavailableError` so the original native binding failure is preserved in `cause` and surfaced when voice is used.
- Updated voice live-test helpers in `tests.ts` to use the same lazy loader.
- Changed `VoiceManager.getVoiceConnection()` to consult the manager's tracked local connections instead of importing `getVoiceConnections()` at module load.

This keeps text/message connector imports test-safe while still failing real voice operations if the optional native voice stack is unavailable.

## Verification

```text
/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-discord typecheck
PASS

/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-discord build
PASS

/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-discord test
PASS: 7 test files, 34 tests
```

Vitest still reports the existing package export ordering warning for `package.json`, but it is not related to this blocker.
