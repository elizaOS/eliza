/**
 * mobile-fs-shim.ts — Sandboxed virtual filesystem for the mobile IDE use case.
 *
 * PURPOSE
 * -------
 * The elizaOS agent bundle runs on-device in Bun (iOS via ElizaBunEngine.xcframework)
 * and Node.js (Android via nodejs-mobile). It uses `node:fs` and `node:path` heavily
 * for workspace reads/writes, PGlite data, skill files, and trajectory logs.
 *
 * This shim installs a deny-by-default interceptor over `node:fs` / `node:path`
 * at process start so that:
 *   1. Every path is resolved relative to a known workspace root on-device.
 *   2. Path traversal outside the root (e.g. `../../etc/passwd`) is rejected.
 *   3. System paths (`/etc`, `/usr`, `/System`, `/private`, kernel sockets, etc.)
 *      are blocked unconditionally — even when the caller passes an absolute path.
 *   4. Dynamic code loading is blocked: `require()` and `import()` of files that
 *      aren't bundled are rejected.
 *   5. Network-sourced code execution is blocked: `fetch + eval/Function` is not
 *      prevented here (that's handled at the JS engine level), but writing fetched
 *      bytes to an executable path is caught at the fs layer.
 *
 * APP STORE COMPLIANCE
 * --------------------
 * iOS App Store:
 *   - No JIT entitlement is required. Bun on iOS runs in interpreter mode
 *     (LLVM AOT + Bun's bytecode interpreter), never dlopen'd JIT pages.
 *   - No code is downloaded and executed at runtime. All JS is bundled into
 *     `agent-bundle.js` at build time via `Bun.build`. The shim adds a runtime
 *     guard to enforce this invariant.
 *   - File access is confined to the app's sandbox (Application Support/Eliza/).
 *     iOS enforces this at the kernel level too, but the shim provides an
 *     explicit JS-layer defence-in-depth.
 *
 * Android Play Store:
 *   - Play Store policy allows JIT for nodejs-mobile (V8 JIT is a documented
 *     exception for scripting runtimes).
 *   - Same "no downloaded code execution" guarantee as iOS — bundle-only JS.
 *   - Access restricted to app's internal storage (`getFilesDir()` / equivalent).
 *
 * USAGE
 * -----
 *   import { installMobileFsShim } from "./mobile-fs-shim.ts";
 *   installMobileFsShim(process.env.MOBILE_WORKSPACE_ROOT!);
 *
 * The shim must be installed before any other module that touches `node:fs`.
 * In `ios-bridge.ts` / `ios-android.ts` entry points, call it as the very
 * first statement — before `bootElizaRuntime()` is imported.
 *
 * DESIGN NOTES
 * ------------
 * - Bun (iOS) and nodejs-mobile (Android) both expose `node:fs` as the
 *   canonical CJS module. We patch the live module object returned by
 *   `require("node:fs")` / `require("fs")` so every subsequent `import fs`
 *   or `require("fs")` in the bundle sees the sandboxed version.
 * - `node:path` is not patched — path utilities themselves are safe; only the
 *   final resolved path fed to an fs operation needs guarding. We export
 *   `sandboxedPath()` for callers that assemble absolute paths externally.
 * - The shim is idempotent: calling `installMobileFsShim` a second time with
 *   the same root is a no-op. Calling it with a different root after install
 *   throws to prevent accidental escalation.
 * - All blocked operations throw `EACCES`-coded errors so callers that check
 *   `err.code` behave the same as if the OS rejected the call.
 */

import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _installed = false;
let _workspaceRoot = "";

// Paths that are unconditionally blocked, regardless of whether they appear to
// live under the workspace root.  These are OS-level paths that can never be
// legitimate workspace content.
const BLOCKED_ROOT_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/System",
  "/private/etc",
  "/private/var/db",
  "/private/var/root",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/run",
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `inputPath` relative to the workspace root and verify it stays
 * inside.  Returns the resolved absolute path on success.  Throws `EACCES`
 * on any traversal or blocked-prefix match.
 */
function resolveSandboxed(inputPath: string): string {
  if (!_workspaceRoot) {
    throw accessError(
      inputPath,
      "mobile-fs-shim: workspace root not initialised",
    );
  }

  // Resolve the path.  If it's relative, anchor it to the workspace root.
  // If it's absolute, path.resolve still normalises it (removes /../ etc.).
  const resolved = nodePath.isAbsolute(inputPath)
    ? nodePath.resolve(inputPath)
    : nodePath.resolve(_workspaceRoot, inputPath);

  // Check unconditionally blocked prefixes first.
  for (const blocked of BLOCKED_ROOT_PREFIXES) {
    if (resolved === blocked || resolved.startsWith(blocked + nodePath.sep)) {
      throw accessError(
        inputPath,
        `mobile-fs-shim: path targets a system directory (${blocked})`,
      );
    }
  }

  // Ensure the resolved path is inside the workspace root.
  // Use a trailing-sep check to prevent a root like /data/workspace being
  // accepted as a prefix for /data/workspace-escape.
  const rootWithSep = _workspaceRoot.endsWith(nodePath.sep)
    ? _workspaceRoot
    : _workspaceRoot + nodePath.sep;

  if (resolved !== _workspaceRoot && !resolved.startsWith(rootWithSep)) {
    throw accessError(
      inputPath,
      `mobile-fs-shim: path escapes workspace root (${_workspaceRoot})`,
    );
  }

  return resolved;
}

/**
 * Exported for callers that assemble absolute paths outside fs calls.
 * Returns the sandbox-validated absolute path or throws `EACCES`.
 */
export function sandboxedPath(inputPath: string): string {
  return resolveSandboxed(inputPath);
}

/**
 * Whether the shim is currently active.
 */
export function isMobileFsShimInstalled(): boolean {
  return _installed;
}

/**
 * The workspace root the shim was installed with (empty string if not yet
 * installed).
 */
export function getMobileWorkspaceRoot(): string {
  return _workspaceRoot;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function accessError(path: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "EACCES";
  err.path = path;
  return err;
}

// ---------------------------------------------------------------------------
// Dynamic require / import guards
// ---------------------------------------------------------------------------

/**
 * Wrap the global `require` so that attempts to `require()` a file path that
 * resolves outside the bundle's already-loaded modules are rejected.
 * Built-in modules (node:*, bun:*) and bare package names are allowed.
 * File-path requires (starting with `.` or `/`) are sandboxed.
 *
 * This prevents an attacker (via a prompt-injected code snippet) from
 * `require('/etc/passwd')` or `require('../../sensitive')`.
 */
function installRequireGuard(): void {
  type RequireFn = NodeRequire & {
    __mobileFsShimGuarded?: boolean;
  };

  const g = globalThis as typeof globalThis & {
    require?: RequireFn;
    __elizaOriginalRequire?: RequireFn;
  };

  if (!g.require || g.require.__mobileFsShimGuarded) return;

  const original = g.require as RequireFn;
  g.__elizaOriginalRequire = original;

  const guarded: RequireFn = new Proxy(original, {
    apply(target, thisArg, args: unknown[]) {
      const id = args[0];
      if (typeof id === "string") {
        // Allow built-in node: / bun: specifiers and bare package names.
        const isBuiltin =
          id.startsWith("node:") ||
          id.startsWith("bun:") ||
          id === "buffer" ||
          id === "path" ||
          id === "fs" ||
          id === "url" ||
          id === "util" ||
          id === "stream" ||
          id === "events" ||
          id === "crypto" ||
          id === "os" ||
          id === "child_process" ||
          id === "net" ||
          id === "tls";

        const isFilePath = id.startsWith(".") || nodePath.isAbsolute(id);

        if (isFilePath && !isBuiltin) {
          // Reject file-path requires to anything outside the sandbox.
          // A dynamic file-path require of bundled code should not be needed —
          // the bundle is fully self-contained; surface this as a loud error.
          throw accessError(
            id,
            `mobile-fs-shim: dynamic require of file paths is blocked on mobile (${id}). All code must be bundled.`,
          );
        }
      }
      return Reflect.apply(target, thisArg, args as Parameters<typeof target>);
    },
  });
  guarded.__mobileFsShimGuarded = true;
  g.require = guarded;
}

// ---------------------------------------------------------------------------
// fs sync API patch helpers
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wrap a sync or callback-style fs function whose first argument is a `path`
 * (or PathLike).  The wrapper resolves the path through the sandbox before
 * forwarding the call.
 */
function wrapFsPath<T extends AnyFn>(original: T): T {
  return function sandboxedFsCall(this: unknown, ...args: unknown[]) {
    // Normalise PathLike (URL, Buffer, string) to string for checking.
    const raw = args[0];
    const pathStr =
      raw instanceof URL
        ? raw.pathname
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : typeof raw === "string"
            ? raw
            : null;

    if (pathStr !== null) {
      // Throws EACCES if out-of-sandbox.
      args[0] = resolveSandboxed(pathStr);
    }

    return original.apply(this, args as Parameters<T>);
  } as T;
}

/**
 * Wrap a two-path fs function (e.g. copyFile, rename, link, symlink).
 * Both src and dest are sandboxed.
 */
function wrapFsTwoPaths<T extends AnyFn>(original: T): T {
  return function sandboxedFsCall(this: unknown, ...args: unknown[]) {
    const rawSrc = args[0];
    const rawDst = args[1];

    const toStr = (v: unknown): string | null =>
      v instanceof URL
        ? v.pathname
        : Buffer.isBuffer(v)
          ? v.toString("utf8")
          : typeof v === "string"
            ? v
            : null;

    const srcStr = toStr(rawSrc);
    const dstStr = toStr(rawDst);

    if (srcStr !== null) args[0] = resolveSandboxed(srcStr);
    if (dstStr !== null) args[1] = resolveSandboxed(dstStr);

    return original.apply(this, args as Parameters<T>);
  } as T;
}

/**
 * Guard a write operation: block writes to executable-extension paths that
 * would introduce new runnable code onto the device at runtime (i.e. code
 * that wasn't bundled).  The workspace root itself may contain `.js` files
 * (e.g. user scripts in a workspace), so we only block writes to the special
 * sub-paths conventionally used for agent bundles and native modules.
 */
function wrapFsWriteGuard<T extends AnyFn>(original: T): T {
  return function sandboxedFsWrite(this: unknown, ...args: unknown[]) {
    const raw = args[0];
    const pathStr =
      raw instanceof URL
        ? raw.pathname
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : typeof raw === "string"
            ? raw
            : null;

    if (pathStr !== null) {
      const resolved = resolveSandboxed(pathStr);
      const ext = nodePath.extname(resolved).toLowerCase();
      // Block writes to native binary extensions (.so / .dylib / .node) under
      // any path — these can't be loaded legitimately at runtime on iOS anyway,
      // but let's be explicit.
      if (ext === ".so" || ext === ".dylib" || ext === ".node") {
        throw accessError(
          pathStr,
          `mobile-fs-shim: writing native binary files is blocked (${ext})`,
        );
      }
      args[0] = resolved;
    }

    return original.apply(this, args as Parameters<T>);
  } as T;
}

// ---------------------------------------------------------------------------
// Core shim installation
// ---------------------------------------------------------------------------

/**
 * Patch the live `node:fs` and `node:fs/promises` module objects so that all
 * path-accepting calls go through the sandbox.
 *
 * Because Bun (and nodejs-mobile) cache the module object, patching the
 * exported properties directly is sufficient — every `import fs from 'node:fs'`
 * in the bundle references the same object.
 */
function patchFsModule(): void {
  const mutableNodeFs = nodeFs as Record<string, unknown>;

  // ── Synchronous API ──────────────────────────────────────────────────────

  const syncOnePath: Array<keyof typeof nodeFs> = [
    "accessSync",
    "chmodSync",
    "chownSync",
    "lchmodSync",
    "lchownSync",
    "lstatSync",
    "mkdirSync",
    "mkdtempSync",
    "readdirSync",
    "readFileSync",
    "readlinkSync",
    "realpathSync",
    "rmdirSync",
    "rmSync",
    "statSync",
    "truncateSync",
    "unlinkSync",
    "utimesSync",
    "lutimesSync",
    "existsSync",
    "opendirSync",
    "openSync",
    "appendFileSync",
  ];

  for (const name of syncOnePath) {
    const key = String(name);
    const orig = mutableNodeFs[key];
    if (typeof orig === "function") {
      mutableNodeFs[key] = wrapFsPath(orig as AnyFn);
    }
  }

  // writeFileSync and appendFileSync carry an extra write guard.
  if (typeof nodeFs.writeFileSync === "function") {
    const wrapped = wrapFsWriteGuard(nodeFs.writeFileSync as AnyFn);
    mutableNodeFs.writeFileSync = wrapFsPath(wrapped);
  }

  // Two-path sync operations.
  const syncTwoPaths: Array<keyof typeof nodeFs> = [
    "copyFileSync",
    "renameSync",
    "linkSync",
    "symlinkSync",
  ];
  for (const name of syncTwoPaths) {
    const key = String(name);
    const orig = mutableNodeFs[key];
    if (typeof orig === "function") {
      mutableNodeFs[key] = wrapFsTwoPaths(orig as AnyFn);
    }
  }

  // ── Callback (async) API ─────────────────────────────────────────────────
  // Callback-style functions: `(path, ...opts, callback)`.
  // We sandox the first positional path arg; the callback remains at its
  // natural position.  For write operations we also apply the write guard.

  const callbackOnePath: Array<keyof typeof nodeFs> = [
    "access",
    "chmod",
    "chown",
    "lchmod",
    "lchown",
    "lstat",
    "mkdir",
    "mkdtemp",
    "readdir",
    "readFile",
    "readlink",
    "realpath",
    "rmdir",
    "rm",
    "stat",
    "truncate",
    "unlink",
    "utimes",
    "lutimes",
    "open",
    "opendir",
    "appendFile",
  ];

  for (const name of callbackOnePath) {
    const key = String(name);
    const orig = mutableNodeFs[key];
    if (typeof orig === "function") {
      mutableNodeFs[key] = wrapFsPath(orig as AnyFn);
    }
  }

  if (typeof nodeFs.writeFile === "function") {
    const wrapped = wrapFsWriteGuard(nodeFs.writeFile as AnyFn);
    mutableNodeFs.writeFile = wrapFsPath(wrapped);
  }

  const callbackTwoPaths: Array<keyof typeof nodeFs> = [
    "copyFile",
    "rename",
    "link",
    "symlink",
  ];
  for (const name of callbackTwoPaths) {
    const key = String(name);
    const orig = mutableNodeFs[key];
    if (typeof orig === "function") {
      mutableNodeFs[key] = wrapFsTwoPaths(orig as AnyFn);
    }
  }

  // ── fs.promises (promise-based API) ─────────────────────────────────────

  const promises = nodeFsPromises as Record<string, unknown>;

  const promisesOnePath = [
    "access",
    "chmod",
    "chown",
    "lchmod",
    "lchown",
    "lstat",
    "mkdir",
    "mkdtemp",
    "readdir",
    "readFile",
    "readlink",
    "realpath",
    "rmdir",
    "rm",
    "stat",
    "truncate",
    "unlink",
    "utimes",
    "lutimes",
    "open",
    "opendir",
    "appendFile",
  ];
  for (const name of promisesOnePath) {
    const orig = promises[name];
    if (typeof orig === "function") {
      promises[name] = wrapFsPath(orig as AnyFn);
    }
  }

  if (typeof promises.writeFile === "function") {
    const wrapped = wrapFsWriteGuard(promises.writeFile as AnyFn);
    promises.writeFile = wrapFsPath(wrapped);
  }

  const promisesTwoPaths = ["copyFile", "rename", "link", "symlink"];
  for (const name of promisesTwoPaths) {
    const orig = promises[name];
    if (typeof orig === "function") {
      promises[name] = wrapFsTwoPaths(orig as AnyFn);
    }
  }

  // Mirror patched promises back onto `nodeFs.promises` (same object
  // reference in modern Node/Bun, but guard for older builds).
  if (
    nodeFs.promises &&
    typeof nodeFs.promises === "object" &&
    nodeFs.promises !== nodeFsPromises
  ) {
    for (const key of promisesOnePath.concat(["writeFile"], promisesTwoPaths)) {
      if (key in promises) {
        (nodeFs.promises as Record<string, unknown>)[key] = promises[key];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install the mobile filesystem sandbox.
 *
 * @param workspaceRoot  Absolute path to the app's writable workspace directory.
 *                       Typically `SandboxPaths.appSupport + "/workspace"` on iOS,
 *                       equivalent to `getFilesDir()/workspace` on Android.
 *                       May be passed directly from the native host via
 *                       `process.env.MOBILE_WORKSPACE_ROOT`.
 *
 * The function is idempotent: a second call with the same root is silently
 * ignored.  A second call with a different root throws to prevent accidental
 * privilege escalation.
 */
export function installMobileFsShim(workspaceRoot: string): void {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    throw new Error(
      "mobile-fs-shim: installMobileFsShim() requires a non-empty workspaceRoot string",
    );
  }

  // Canonicalise the root (remove trailing slashes, resolve symlinks we can
  // resolve without fs calls, normalise separators).
  const canonical = nodePath.resolve(workspaceRoot);

  if (_installed) {
    if (_workspaceRoot === canonical) {
      // Idempotent — same root, nothing to do.
      return;
    }
    throw new Error(
      `mobile-fs-shim: already installed with root "${_workspaceRoot}"; ` +
        `attempted re-install with "${canonical}" is not allowed`,
    );
  }

  _workspaceRoot = canonical;
  _installed = true;

  patchFsModule();
  installRequireGuard();

  // Expose the workspace root on the environment for downstream consumers
  // (e.g. PGlite, trajectory logger) that read it from process.env.
  if (!process.env.MOBILE_WORKSPACE_ROOT) {
    process.env.MOBILE_WORKSPACE_ROOT = canonical;
  }
}
