# @elizaos/plugin-native-filesystem

Mobile-safe filesystem bridge for the elizaOS runtime.

## Purpose / role

Adds a single `DeviceFilesystemBridge` service that routes read, write, and directory-list operations to the correct backend depending on the runtime environment: `@capacitor/filesystem` (iOS/Android) or `node:fs/promises` (desktop/AOSP). The plugin is opt-in — it must be explicitly added to an agent's plugin list. It does **not** register any planner-facing actions itself; `@elizaos/plugin-coding-tools` discovers it via the `device_filesystem` service type and delegates `FILE target=device` operations to it.

## Plugin surface

**Services**

| Name | Service type | Purpose |
|---|---|---|
| `DeviceFilesystemBridge` | `"device_filesystem"` | Unified read/write/list API with platform-specific backend |

**Actions / providers / evaluators / routes / events:** none.

## Layout

```
src/
  index.ts                         Plugin export; wires service + dispose
  types.ts                         DEVICE_FILESYSTEM_SERVICE_TYPE, DEVICE_FILESYSTEM_LOG_PREFIX, DirectoryEntry, FileEncoding
  path.ts                          normalizeDevicePath() — path sanitisation (rejects absolute, .., NUL)
  services/
    device-filesystem-bridge.ts    DeviceFilesystemBridge service + getDeviceFilesystemBridge() helper
  __tests__/
    path-validation.test.ts        Unit tests for normalizeDevicePath
    plugin-registration.test.ts    Plugin wiring smoke test
    round-trip.test.ts             read/write/list round-trip against a temp Node root
```

## Service API

`DeviceFilesystemBridge` (resolved via `getDeviceFilesystemBridge(runtime)`) exposes:

```ts
read(relativePath: string, encoding?: FileEncoding): Promise<string>
write(relativePath: string, content: string, encoding?: FileEncoding): Promise<void>
list(relativePath: string): Promise<DirectoryEntry[]>
```

`FileEncoding` is `"utf8" | "base64"`. `DirectoryEntry` is `{ name: string; type: "file" | "directory" }`.

Backend selection happens once at `start()`:
- **Capacitor** — `window.Capacitor.isNativePlatform()` returns true (iOS/Android). Root is `Directory.Documents`.
- **Node** — all other environments. Root is `resolveStateDir() + "/workspace"` (default `~/.local/state/eliza/workspace`).

`DeviceFilesystemBridge.forNodeRoot(root)` constructs a bridge bound to an arbitrary directory; used in tests only.

## Commands

Only scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-native-filesystem build         # bun build (build.ts) → dist/
bun run --cwd plugins/plugin-native-filesystem dev           # hot-rebuild
bun run --cwd plugins/plugin-native-filesystem test          # vitest run
bun run --cwd plugins/plugin-native-filesystem typecheck     # tsgo --noEmit
bun run --cwd plugins/plugin-native-filesystem lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-native-filesystem lint:check    # biome check (no write)
bun run --cwd plugins/plugin-native-filesystem format        # biome format --write
bun run --cwd plugins/plugin-native-filesystem format:check  # biome format (no write)
bun run --cwd plugins/plugin-native-filesystem clean         # rm dist .turbo
bun run --cwd plugins/plugin-native-filesystem check         # typecheck + test
```

## Config / env vars

No plugin-specific env vars. The Node backend root is determined by `resolveStateDir()` from `@elizaos/core`, which reads:

| Env var | Default |
|---|---|
| `ELIZA_STATE_DIR` | `~/.local/state/eliza` (XDG-aware) |

No runtime configuration keys or agent settings are read by this plugin.

## How to extend

**Add a new service method** (e.g. `delete`, `stat`):
1. Add the method signature to `DeviceFilesystemBridge` in `src/services/device-filesystem-bridge.ts`.
2. Implement the Capacitor branch (`mod.Filesystem.*`) and the Node branch (`node:fs/promises`).
3. Call `normalizeDevicePath(relativePath)` as the first step to sanitise input.
4. Add a test case to `src/__tests__/round-trip.test.ts` using `DeviceFilesystemBridge.forNodeRoot(tmpDir)`.

**Add a new action** (e.g. a planner-visible `DELETE_DEVICE_FILE`):
1. Create `src/actions/delete-device-file.ts` implementing the `Action` interface from `@elizaos/core`.
2. Resolve the service inside the handler: `getDeviceFilesystemBridge(runtime).delete(...)`.
3. Add the action to the `actions` array in `src/index.ts`.

**Use this service from another plugin:**
```ts
import { getDeviceFilesystemBridge } from "@elizaos/plugin-native-filesystem";
const bridge = getDeviceFilesystemBridge(runtime);
const content = await bridge.read("notes/checklist.md");
```

## Conventions / gotchas

- All relative paths flow through `normalizeDevicePath()` before reaching either backend. It rejects empty strings, absolute POSIX/Windows paths, `..` segments, and NUL bytes. Pass `{ allowRoot: true }` only for directory listing at the root.
- The Node backend performs a secondary path-escape check (`resolveNodePath`): after `path.resolve(nodeRoot, relative)` it verifies the absolute result still starts with `nodeRoot + sep`, so a relative path that normalizes back out of the root is rejected. This is a string-prefix check on the resolved path; it does not dereference symlinks.
- `@capacitor/filesystem` is an `optionalDependency`. The Capacitor branch is only entered when `isCapacitorNative()` returns true, so the package need not be present on desktop builds.
- iOS users need `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` in the host app's `Info.plist` for files to be visible in Files.app. That change belongs in the host app repo, not here.
- Android requires no manifest changes for `Directory.Documents` — Capacitor Filesystem handles scoped storage (Android 10+) internally.
- Log prefix for all messages: `[device-filesystem]` (`DEVICE_FILESYSTEM_LOG_PREFIX`).
- See root [AGENTS.md](../../AGENTS.md) for repo-wide conventions (logger-only, ESM, naming, architecture rules).

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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
