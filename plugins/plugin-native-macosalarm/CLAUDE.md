# @elizaos/macosalarm

macOS native alarm scheduling via `UNUserNotificationCenter`, driven by a self-contained Swift CLI helper invoked from the Eliza runtime.

## Purpose / role

Adds the `ALARM` action to an Eliza agent so it can schedule, cancel, and list macOS calendar-trigger notifications without any third-party dependencies. The plugin is **auto-enabled on darwin** (`"autoEnable": "darwin"` in `package.json`); on non-darwin platforms the action's `validate` hook returns `false` and nothing runs. Load it by name `"macosalarm"` or import `macosAlarmPlugin` from `@elizaos/macosalarm`.

## Plugin surface

| Kind | Name | Description |
|------|------|-------------|
| Action | `ALARM` | Schedule (`set`), remove (`cancel`), or enumerate (`list`) macOS alarms. Subaction comes from structured parameters (`action` / `subaction` / `op`) or from the structured parameter shape. Role-gated to `ADMIN`. |

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

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-macosalarm clean           # remove build output
bun run --cwd plugins/plugin-native-macosalarm build           # build package artifacts
bun run --cwd plugins/plugin-native-macosalarm typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-macosalarm lint            # mutating Biome check
bun run --cwd plugins/plugin-native-macosalarm lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-macosalarm format          # write formatting
bun run --cwd plugins/plugin-native-macosalarm format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-macosalarm test            # run package tests
bun run --cwd plugins/plugin-native-macosalarm prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-macosalarm build:helper    # node scripts/build-helper.mjs
bun run --cwd plugins/plugin-native-macosalarm build:ts        # tsc --noCheck -p tsconfig.json
```

## Config / env vars

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ELIZA_MACOSALARM_HELPER_BIN` | No | `bin/macosalarm-helper` relative to package root | Override path to the compiled Swift binary |
| `ELIZA_MACOSALARM_FORCE_HELPER_BUILD` | No | unset | Set to `1` to force recompiling the tracked Swift helper binary even when it is newer than the source |
| `ELIZA_VERBOSE_PLUGIN_BUILD` | No | unset | Set to `1` to log the binary output path during `build:helper` |

No runtime config keys are read from the agent runtime settings object. The only env var consumed at runtime is `ELIZA_MACOSALARM_HELPER_BIN`.

## ALARM action parameters

| Parameter | Required for | Description |
|-----------|-------------|-------------|
| `action` / `subaction` / `op` | — | `set`, `cancel`, or `list` (if absent, inferred from structured parameter shape: schedule payload → `set`, id → `cancel`, otherwise `list`) |
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
- **Context gate.** The action matches the `tasks`, `calendar`, and `automation` contexts from canonical turn routing plus legacy `activeContexts` / `selectedContexts` signals. It does not validate from alarm keywords in raw message text.
- **Testing the Swift layer.** Use the `spawnImpl` and `binPathOverride` options in `HelperRunOptions` to inject a mock process in tests without needing a compiled binary.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
