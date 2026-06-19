# @elizaos/macosalarm

macOS native alarm scheduling via `UNUserNotificationCenter`, driven by a self-contained Swift CLI helper invoked from the Eliza runtime.

## Purpose / role

Adds the `ALARM` action to an Eliza agent so it can schedule, cancel, and list macOS calendar-trigger notifications without any third-party dependencies. The plugin is **auto-enabled on darwin** (`"autoEnable": "darwin"` in `package.json`); on non-darwin platforms the action's `validate` hook returns `false` and nothing runs. Load it by name `"macosalarm"` or import `macosAlarmPlugin` from `@elizaos/macosalarm`.

## Plugin surface

| Kind | Name | Description |
|------|------|-------------|
| Action | `ALARM` | Schedule (`set`), remove (`cancel`), or enumerate (`list`) macOS alarms. Subaction is inferred from message text when not explicitly passed as a parameter. Role-gated to `ADMIN`. |

No providers, services, evaluators, routes, or events are registered.

## Layout

```
plugins/plugin-native-macosalarm/
  src/
    index.ts        Re-exports everything; default export = macosAlarmPlugin
    plugin.ts       createMacosAlarmPlugin(deps?) → Plugin; macosAlarmPlugin singleton
    actions.ts      createAlarmAction(deps?) → Action; runSet/runCancel/runList helpers
    helper.ts       runHelper(request, options?) — spawns the Swift binary via stdin/stdout JSON IPC
    types.ts        All request/response/param types for the IPC protocol
  swift-helper/
    main.swift      Self-contained Swift CLI; reads JSON from stdin, writes JSON to stdout
  scripts/
    build-helper.mjs  Compiles main.swift → bin/macosalarm-helper via swiftc (skips on non-darwin)
  bin/
    macosalarm-helper  Compiled Swift binary (darwin only, produced by build:helper)
  __tests__/
    helper.test.ts               Unit tests for runHelper IPC layer (mock spawn, no binary needed)
    integration.macos.test.ts    Integration tests (darwin only)
```

## Commands

```bash
bun run --cwd plugins/plugin-native-macosalarm build          # tsc + swiftc
bun run --cwd plugins/plugin-native-macosalarm build:ts       # TypeScript only
bun run --cwd plugins/plugin-native-macosalarm build:helper   # Swift binary only
bun run --cwd plugins/plugin-native-macosalarm typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-native-macosalarm test           # vitest run
bun run --cwd plugins/plugin-native-macosalarm clean          # rm -rf dist bin
```

## Config / env vars

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ELIZA_MACOSALARM_HELPER_BIN` | No | `bin/macosalarm-helper` relative to package root | Override path to the compiled Swift binary |
| `ELIZA_VERBOSE_PLUGIN_BUILD` | No | unset | Set to `1` to log the binary output path during `build:helper` |

No runtime config keys are read from the agent runtime settings object. The only env var consumed at runtime is `ELIZA_MACOSALARM_HELPER_BIN`.

## ALARM action parameters

| Parameter | Required for | Description |
|-----------|-------------|-------------|
| `action` / `subaction` / `op` | — | `set`, `cancel`, or `list` (inferred from text if absent) |
| `timeIso` | `set` | ISO-8601 timestamp for the alarm |
| `title` | `set` | Notification title |
| `body` | `set` (optional) | Notification body |
| `sound` | `set` (optional) | Sound name (`"default"` = critical sound; any named system sound) |
| `id` | `cancel` (required), `set` (optional) | Alarm identifier; auto-generated as `alarm-<UUID>` if omitted on `set` |

## How to extend

**Add a new Swift action** (e.g., `permission` check exposed to the agent):

1. The Swift binary already handles `"permission"` — add a corresponding TS subaction in `src/actions.ts` alongside `runSet`/`runCancel`/`runList`.
2. Extend `ALARM_SUBACTIONS` and the `switch` in the handler.
3. Add a matching typed response interface in `src/types.ts` and include it in the `MacosAlarmHelperResponse` union.

**Add a new action** (e.g., a separate `ALARM_SNOOZE` action):

1. Create a new function in `src/actions.ts` returning an `Action` object.
2. Export it and add it to the `actions` array in `src/plugin.ts`.
3. Use `runHelper` from `src/helper.ts` for all IPC with the binary.

## Conventions / gotchas

- **darwin-only at runtime.** `helper.ts` throws `MacosAlarmHelperUnavailableError` (reason `"macos-only"`) on non-darwin unless a custom `spawnImpl` is provided (used in tests to mock the binary).
- **Binary must be compiled before use.** `build:helper` runs `swiftc` and writes to `bin/macosalarm-helper`. If the binary is missing at runtime, `runHelper` throws `MacosAlarmHelperUnavailableError` with reason `"helper-binary-missing"`.
- **IPC protocol is line-delimited JSON.** The Swift process reads one JSON object from stdin and writes exactly one JSON object to stdout. The TS layer takes the last non-empty line of stdout as the response.
- **Notification permission.** `schedule` calls `ensureAuthorization()` in Swift, which requests the `UNUserNotificationCenter` permission prompt on first use. If the user has denied notifications, the binary exits with code `3` and returns `{ "success": false, "error": "permission-denied: ..." }`.
- **Role gate.** The `ALARM` action has `roleGate: { minRole: "ADMIN" }`, so only admin-role users can trigger it.
- **Context gate.** The action matches the `tasks`, `calendar`, and `automation` contexts; `hasAlarmSignal` also fires on keyword matching (supports several languages including Spanish, French, German, Chinese, Japanese, Korean, Vietnamese).
- **Testing the Swift layer.** Use the `spawnImpl` and `binPathOverride` options in `HelperRunOptions` to inject a mock process in tests without needing a compiled binary.
