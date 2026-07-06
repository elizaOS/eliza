# @elizaos/native-activity-tracker

macOS-only Swift helper that streams window/app focus and HID idle events to a typed TypeScript driver.

## Purpose / role

This package is a native helper library, not an elizaOS `Plugin` object. It provides a TypeScript API for spawning the compiled Swift `activity-collector` binary and receiving a real-time stream of macOS application-focus transitions and periodic HID idle samples. Consumers (services, plugins) call `startActivityCollector()` directly to get the event stream. It is **Darwin-only** (`elizaos.platforms: ["darwin"]`); callers must check `isSupportedPlatform()` before starting the collector.

## Plugin surface

This package exports a **library API**, not a registered elizaOS plugin. There are no actions, providers, evaluators, routes, or services registered in a plugin manifest. The public surface is:

| Export | Description |
|---|---|
| `isSupportedPlatform()` | Returns `true` on Darwin; callers must gate on this before calling `startActivityCollector`. |
| `startActivityCollector(options)` | Spawns the Swift binary, line-parses stdout, calls `onEvent` per focus transition and `onIdleSample` per HID idle reading. Returns an `ActivityCollectorHandle` with `.stop()` and `.pid`. |
| `ActivityCollectorEvent` | Focus event: `{ ts, event: "activate"|"deactivate", bundleId, appName, windowTitle? }` |
| `ActivityCollectorIdleSample` | HID idle sample: `{ ts, event: "hid_idle", idleSeconds }` — emitted every 30 s by the Swift timer. |
| `ActivityCollectorHandle` | Handle returned by `startActivityCollector`: `stop(): Promise<void>`, `pid: number | null`. |
| `ActivityCollectorOptions` | Options bag for `startActivityCollector`: `onEvent` (required), `onIdleSample`, `onExit`, `onFatal`, `binaryPath`. |
| `ActivityCollectorExit` | Exit descriptor: `{ code, signal, clean, reason }`. |
| `ActivityEventKind` | `"activate" | "deactivate"` |
| `__internal` | `{ parseEventLine, parseCollectorLine, describeCollectorExit }` — exposed for unit tests only, not stable API. |

## Layout

```
plugins/plugin-native-activity-tracker/
  src/
    index.ts                 Entire TypeScript driver: types, parseCollectorLine, startActivityCollector
    index.test.ts            Vitest unit tests for the TypeScript driver
  native/
    macos/
      activity-collector.swift   Swift source — NSWorkspace notifications + HID idle timer
      activity-collector         Compiled binary (Darwin arm64/x86_64; must be built via build:swift)
  dist/                      Compiled TypeScript output (built via build script)
  tsconfig.json
  package.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-activity-tracker build         # build package artifacts
bun run --cwd plugins/plugin-native-activity-tracker build:swift   # build Swift helper (Darwin only)
bun run --cwd plugins/plugin-native-activity-tracker typecheck     # TypeScript typecheck
bun run --cwd plugins/plugin-native-activity-tracker lint          # mutating Biome check
bun run --cwd plugins/plugin-native-activity-tracker lint:check    # read-only Biome check
bun run --cwd plugins/plugin-native-activity-tracker format        # write formatting
bun run --cwd plugins/plugin-native-activity-tracker format:check  # read-only formatting check
bun run --cwd plugins/plugin-native-activity-tracker test          # run package tests
```

## Config / env vars

No environment variables are read by this package. The `binaryPath` option to `startActivityCollector` defaults to `../native/macos/activity-collector` relative to `dist/index.js`. Override it if the binary is at a non-standard location.

macOS Accessibility permission is required at runtime for `windowTitle` to be populated (AX API). Without it, `windowTitle` is omitted from events; focus events still fire.

## How to extend

**Add a new event kind from the Swift side:**

1. Add the new event emission to `native/macos/activity-collector.swift` — emit a JSON object with a new `event` string value.
2. Add a corresponding TypeScript interface in `src/index.ts`.
3. Extend `ParsedCollectorLine` union and `parseCollectorLine()` to handle the new `event` value.
4. Add the new callback to `ActivityCollectorOptions` and call it in the `rl.on("line", ...)` handler in `startActivityCollector`.
5. Recompile both: `bun run build:swift` then `bun run build`.

**Add a new TypeScript-only option:**

Add the field to `ActivityCollectorOptions`, use it inside `startActivityCollector`, and rerun `bun run build`.

## Conventions / gotchas

- **Darwin only.** `startActivityCollector` throws immediately on non-Darwin. Always call `isSupportedPlatform()` before calling it.
- **Binary must be pre-compiled.** The compiled `activity-collector` binary is included in `files[]` but must be built with `build:swift` before first use in a fresh checkout. The `build:swift` step requires macOS with Xcode command-line tools (`swiftc`).
- **stdout line protocol.** The Swift binary writes one complete JSON object per line to stdout, unbuffered. Any line that fails to parse is silently dropped by the TypeScript driver (logged at `debug`). Stderr from the binary is logged at `warn`.
- **Fatal threshold.** The driver calls `onFatal` on any non-zero exit or spawn error. There is no auto-restart — the caller is responsible for restart logic.
- **HID idle cadence.** The Swift timer fires after 5 s initial delay then every 30 s. `onIdleSample` is optional and safe to ignore.
- **System sleep / lock.** The Swift collector emits a synthetic `deactivate` on `willSleep`, `screensDidSleep`, `sessionDidResignActive`, and `com.apple.screenIsLocked`, and a synthetic `activate` on wake/unlock. This prevents a stale frontmost app from appearing active across sleep boundaries.
- **Accessibility permission.** `windowTitle` requires macOS Accessibility permission granted to the host process. The collector proceeds without it; `windowTitle` is simply absent.
- **No plugin manifest.** This package does not export an elizaOS `Plugin` object and is not auto-loaded by the elizaOS plugin registry. It is a library dependency that other plugins or services import directly.
- See the root [AGENTS.md](../../AGENTS.md) for repo-wide architecture, logging, and naming rules.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
