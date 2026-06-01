# @elizaos/plugin-device-filesystem

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
bun run --cwd plugins/plugin-device-filesystem build         # bun build (build.ts) → dist/
bun run --cwd plugins/plugin-device-filesystem dev           # hot-rebuild
bun run --cwd plugins/plugin-device-filesystem test          # vitest run
bun run --cwd plugins/plugin-device-filesystem typecheck     # tsgo --noEmit
bun run --cwd plugins/plugin-device-filesystem lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-device-filesystem lint:check    # biome check (no write)
bun run --cwd plugins/plugin-device-filesystem format        # biome format --write
bun run --cwd plugins/plugin-device-filesystem format:check  # biome format (no write)
bun run --cwd plugins/plugin-device-filesystem clean         # rm dist .turbo
bun run --cwd plugins/plugin-device-filesystem check         # typecheck + test
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
import { getDeviceFilesystemBridge } from "@elizaos/plugin-device-filesystem";
const bridge = getDeviceFilesystemBridge(runtime);
const content = await bridge.read("notes/todo.md");
```

## Conventions / gotchas

- All relative paths flow through `normalizeDevicePath()` before reaching either backend. It rejects empty strings, absolute POSIX/Windows paths, `..` segments, and NUL bytes. Pass `{ allowRoot: true }` only for directory listing at the root.
- The Node backend performs a secondary path-escape check after `path.resolve()` — resolving through symlinks could still escape the root, so callers cannot trick it with clever relative paths.
- `@capacitor/filesystem` is an `optionalDependency`. The Capacitor branch is only entered when `isCapacitorNative()` returns true, so the package need not be present on desktop builds.
- iOS users need `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` in the host app's `Info.plist` for files to be visible in Files.app. That change belongs in the host app repo, not here.
- Android requires no manifest changes for `Directory.Documents` — Capacitor Filesystem handles scoped storage (Android 10+) internally.
- Log prefix for all messages: `[device-filesystem]` (`DEVICE_FILESYSTEM_LOG_PREFIX`).
- See root [AGENTS.md](../../AGENTS.md) for repo-wide conventions (logger-only, ESM, naming, architecture rules).
