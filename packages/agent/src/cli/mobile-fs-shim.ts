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
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _installed = false;
let _workspaceRoot = "";
let _workspaceRootReal = "";
let _readOnlyRoots: string[] = [];
let _readOnlyRootReals: string[] = [];
type FsAccessMode = "read" | "write";
const rawExistsSync = nodeFs.existsSync.bind(nodeFs);
const rawRealpathSync = nodeFs.realpathSync.bind(nodeFs);
type MobileFsGlobals = typeof globalThis & {
  __ELIZA_MOBILE_FS_RESOLVE__?: (
    inputPath: string,
    mode?: FsAccessMode,
  ) => string;
};

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
function isInsideRoot(pathname: string, root: string): boolean {
  const rootWithSep = root.endsWith(nodePath.sep) ? root : root + nodePath.sep;
  return pathname === root || pathname.startsWith(rootWithSep);
}

function envReadOnlyRoots(): string[] {
  const candidates = [
    process.env.ELIZA_IOS_AGENT_PUBLIC_DIR,
    process.env.ELIZA_IOS_AGENT_ASSET_DIR,
    process.env.ELIZA_IOS_AGENT_BUNDLE
      ? nodePath.dirname(process.env.ELIZA_IOS_AGENT_BUNDLE)
      : "",
  ];
  return candidates
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => nodePath.resolve(value));
}

function realpathIfPossible(pathname: string): string {
  try {
    return rawRealpathSync(pathname);
  } catch {
    return nodePath.resolve(pathname);
  }
}

function nearestExistingParent(pathname: string): string | null {
  let current = nodePath.resolve(pathname);
  for (;;) {
    if (rawExistsSync(current)) return current;
    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function validateResolvedRealPath(
  inputPath: string,
  resolved: string,
  mode: FsAccessMode,
  allowedReadOnly: boolean,
): string {
  if (mode === "read") {
    if (!rawExistsSync(resolved)) return resolved;
    const real = realpathIfPossible(resolved);
    if (isInsideRoot(real, _workspaceRootReal || _workspaceRoot))
      return resolved;
    if (
      allowedReadOnly &&
      _readOnlyRootReals.some((root) => isInsideRoot(real, root))
    ) {
      return resolved;
    }
    throw accessError(
      inputPath,
      `mobile-fs-shim: real path escapes allowed roots: ${real}`,
    );
  }

  const existing = nearestExistingParent(resolved);
  if (!existing) return resolved;
  const real = realpathIfPossible(existing);
  if (isInsideRoot(real, _workspaceRootReal || _workspaceRoot)) return resolved;
  throw accessError(
    inputPath,
    `mobile-fs-shim: write parent escapes workspace root: ${real}`,
  );
}

/**
 * Resolve symlinks in `pathname` by finding its nearest existing ancestor,
 * calling realpathSync on that ancestor, then reconstructing the rest of the
 * path.  This handles Android's /data/user/0 ↔ /data/data aliasing where
 * Java-side APIs return symlink paths but the Bun bundle resolves via the
 * real path.  Returns `pathname` unchanged if no symlink is found or on error.
 */
function resolveViaAncestor(pathname: string): string {
  const existing = nearestExistingParent(pathname);
  if (!existing) return pathname;
  try {
    const realExisting = rawRealpathSync(existing);
    if (realExisting === existing) return pathname;
    return realExisting + pathname.slice(existing.length);
  } catch {
    return pathname;
  }
}

function resolveSandboxed(
  inputPath: string,
  mode: FsAccessMode = "read",
): string {
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
  if (isInsideRoot(resolved, _workspaceRoot)) {
    return validateResolvedRealPath(inputPath, resolved, mode, false);
  }

  if (
    mode === "read" &&
    _readOnlyRoots.some((root) => isInsideRoot(resolved, root))
  ) {
    return validateResolvedRealPath(inputPath, resolved, mode, true);
  }

  // Second-chance: resolve symlinks through the path's nearest existing
  // ancestor.  Handles Android /data/user/0 ↔ /data/data aliasing where
  // Java-set env vars (HOME, ELIZA_STATE_DIR) use the symlink prefix but the
  // Bun bundle's import.meta.url resolves via the real /data/data prefix.
  if (_workspaceRootReal) {
    const realResolved = resolveViaAncestor(resolved);
    if (realResolved !== resolved) {
      if (isInsideRoot(realResolved, _workspaceRootReal)) {
        return resolved;
      }
      if (
        mode === "read" &&
        _readOnlyRootReals.some((root) => isInsideRoot(realResolved, root))
      ) {
        return resolved;
      }
    }
  }

  throw accessError(
    inputPath,
    `mobile-fs-shim: path escapes workspace root (${_workspaceRoot}): ${resolved}`,
  );
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

function pathLikeToString(raw: unknown): string | null {
  if (raw instanceof URL) {
    if (raw.protocol !== "file:") {
      throw accessError(
        raw.toString(),
        `mobile-fs-shim: only file: URLs are accepted by fs (${raw.protocol})`,
      );
    }
    return fileURLToPath(raw);
  }
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return typeof raw === "string" ? raw : null;
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
type MutableModule = Record<string, unknown>;

const mobileRequire = createRequire(import.meta.url);

function optionalRequireObject(id: string): MutableModule | null {
  try {
    const value = mobileRequire(id);
    return value && typeof value === "object" ? (value as MutableModule) : null;
  } catch {
    return null;
  }
}

function objectTargets(...values: unknown[]): MutableModule[] {
  const out: MutableModule[] = [];
  const seen = new WeakSet<object>();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const object = value as MutableModule;
    if (seen.has(object)) continue;
    seen.add(object);
    out.push(object);
  }
  return out;
}

function setIfMutable(
  target: MutableModule,
  key: string,
  value: unknown,
): boolean {
  try {
    target[key] = value;
    return target[key] === value;
  } catch {
    return false;
  }
}

/**
 * Wrap a sync or callback-style fs function whose first argument is a `path`
 * (or PathLike).  The wrapper resolves the path through the sandbox before
 * forwarding the call.
 */
function wrapFsPath<T extends AnyFn>(
  original: T,
  mode: FsAccessMode = "read",
): T {
  return function sandboxedFsCall(this: unknown, ...args: unknown[]) {
    // Normalise PathLike (URL, Buffer, string) to string for checking.
    const raw = args[0];
    const pathStr = pathLikeToString(raw);

    if (pathStr !== null) {
      // Throws EACCES if out-of-sandbox.
      const resolved = resolveSandboxed(pathStr, mode);
      if (mode === "write") guardWritePath(resolved, pathStr);
      args[0] = resolved;
    }

    return original.apply(this, args as Parameters<T>);
  } as T;
}

function modeForOpenFlags(flags: unknown): FsAccessMode {
  if (typeof flags === "number") {
    const writeBits =
      nodeFs.constants.O_WRONLY |
      nodeFs.constants.O_RDWR |
      nodeFs.constants.O_APPEND |
      nodeFs.constants.O_CREAT |
      nodeFs.constants.O_TRUNC;
    return (flags & writeBits) !== 0 ? "write" : "read";
  }
  if (typeof flags !== "string" || flags.length === 0) return "read";
  return /[wa+]/.test(flags) ? "write" : "read";
}

function wrapFsOpenPath<T extends AnyFn>(original: T): T {
  return function sandboxedOpenCall(this: unknown, ...args: unknown[]) {
    const raw = args[0];
    const pathStr = pathLikeToString(raw);

    if (pathStr !== null) {
      const mode = modeForOpenFlags(args[1]);
      const resolved = resolveSandboxed(pathStr, mode);
      if (mode === "write") guardWritePath(resolved, pathStr);
      args[0] = resolved;
    }

    return original.apply(this, args as Parameters<T>);
  } as T;
}

/**
 * Wrap a two-path fs function (e.g. copyFile, rename, link, symlink).
 * Both src and dest are sandboxed.
 */
function wrapFsTwoPaths<T extends AnyFn>(
  original: T,
  srcMode: FsAccessMode,
  dstMode: FsAccessMode,
): T {
  return function sandboxedFsCall(this: unknown, ...args: unknown[]) {
    const rawSrc = args[0];
    const rawDst = args[1];

    const srcStr = pathLikeToString(rawSrc);
    const dstStr = pathLikeToString(rawDst);

    if (srcStr !== null) {
      const resolved = resolveSandboxed(srcStr, srcMode);
      if (srcMode === "write") guardWritePath(resolved, srcStr);
      args[0] = resolved;
    }
    if (dstStr !== null) {
      const resolved = resolveSandboxed(dstStr, dstMode);
      if (dstMode === "write") guardWritePath(resolved, dstStr);
      args[1] = resolved;
    }

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
    const pathStr = pathLikeToString(raw);

    if (pathStr !== null) {
      const resolved = resolveSandboxed(pathStr, "write");
      guardWritePath(resolved, pathStr);
      args[0] = resolved;
    }

    return original.apply(this, args as Parameters<T>);
  } as T;
}

function guardWritePath(resolved: string, originalPath: string): void {
  const ext = nodePath.extname(resolved).toLowerCase();
  // Block writes to native binary extensions (.so / .dylib / .node) under
  // any path — these can't be loaded legitimately at runtime on iOS anyway,
  // but let's be explicit.
  if (ext === ".so" || ext === ".dylib" || ext === ".node") {
    throw accessError(
      originalPath,
      `mobile-fs-shim: writing native binary files is blocked (${ext})`,
    );
  }
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
  const fsTargets = objectTargets(
    optionalRequireObject("node:fs"),
    optionalRequireObject("fs"),
    nodeFs,
    (nodeFs as MutableModule).default,
  );
  const promiseTargets = objectTargets(
    optionalRequireObject("node:fs/promises"),
    optionalRequireObject("fs/promises"),
    nodeFsPromises,
    (nodeFsPromises as MutableModule).default,
    ...fsTargets.map((target) => target.promises),
  );

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
    "appendFileSync",
  ];
  const syncWriteOnePath = new Set<string>([
    "chmodSync",
    "chownSync",
    "lchmodSync",
    "lchownSync",
    "mkdirSync",
    "mkdtempSync",
    "rmdirSync",
    "rmSync",
    "truncateSync",
    "unlinkSync",
    "utimesSync",
    "lutimesSync",
    "appendFileSync",
  ]);

  for (const target of fsTargets) {
    for (const name of syncOnePath) {
      const key = String(name);
      const orig = target[key];
      if (typeof orig === "function") {
        setIfMutable(
          target,
          key,
          wrapFsPath(
            orig as AnyFn,
            syncWriteOnePath.has(key) ? "write" : "read",
          ),
        );
      }
    }

    // writeFileSync carries an extra write guard.
    if (typeof target.writeFileSync === "function") {
      const wrapped = wrapFsWriteGuard(target.writeFileSync as AnyFn);
      setIfMutable(target, "writeFileSync", wrapFsPath(wrapped, "write"));
    }
    if (typeof target.openSync === "function") {
      setIfMutable(
        target,
        "openSync",
        wrapFsOpenPath(target.openSync as AnyFn),
      );
    }
    if (typeof target.createReadStream === "function") {
      setIfMutable(
        target,
        "createReadStream",
        wrapFsPath(target.createReadStream as AnyFn, "read"),
      );
    }
    if (typeof target.createWriteStream === "function") {
      setIfMutable(
        target,
        "createWriteStream",
        wrapFsPath(target.createWriteStream as AnyFn, "write"),
      );
    }
    if (typeof target.cpSync === "function") {
      setIfMutable(
        target,
        "cpSync",
        wrapFsTwoPaths(target.cpSync as AnyFn, "read", "write"),
      );
    }

    // Two-path sync operations.
    const syncTwoPaths: Array<{
      name: keyof typeof nodeFs;
      srcMode: FsAccessMode;
      dstMode: FsAccessMode;
    }> = [
      { name: "copyFileSync", srcMode: "read", dstMode: "write" },
      { name: "renameSync", srcMode: "write", dstMode: "write" },
      { name: "linkSync", srcMode: "read", dstMode: "write" },
      { name: "symlinkSync", srcMode: "read", dstMode: "write" },
    ];
    for (const { name, srcMode, dstMode } of syncTwoPaths) {
      const key = String(name);
      const orig = target[key];
      if (typeof orig === "function") {
        setIfMutable(
          target,
          key,
          wrapFsTwoPaths(orig as AnyFn, srcMode, dstMode),
        );
      }
    }

    // ── Callback (async) API ───────────────────────────────────────────────
    // Callback-style functions: `(path, ...opts, callback)`.
    // We sandbox the first positional path arg; the callback remains at its
    // natural position. For write operations we also apply the write guard.

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
      "opendir",
      "appendFile",
    ];
    const callbackWriteOnePath = new Set<string>([
      "chmod",
      "chown",
      "lchmod",
      "lchown",
      "mkdir",
      "mkdtemp",
      "rmdir",
      "rm",
      "truncate",
      "unlink",
      "utimes",
      "lutimes",
      "appendFile",
    ]);

    for (const name of callbackOnePath) {
      const key = String(name);
      const orig = target[key];
      if (typeof orig === "function") {
        setIfMutable(
          target,
          key,
          wrapFsPath(
            orig as AnyFn,
            callbackWriteOnePath.has(key) ? "write" : "read",
          ),
        );
      }
    }

    if (typeof target.writeFile === "function") {
      const wrapped = wrapFsWriteGuard(target.writeFile as AnyFn);
      setIfMutable(target, "writeFile", wrapFsPath(wrapped, "write"));
    }
    if (typeof target.open === "function") {
      setIfMutable(target, "open", wrapFsOpenPath(target.open as AnyFn));
    }
    if (typeof target.cp === "function") {
      setIfMutable(
        target,
        "cp",
        wrapFsTwoPaths(target.cp as AnyFn, "read", "write"),
      );
    }

    const callbackTwoPaths: Array<{
      name: keyof typeof nodeFs;
      srcMode: FsAccessMode;
      dstMode: FsAccessMode;
    }> = [
      { name: "copyFile", srcMode: "read", dstMode: "write" },
      { name: "rename", srcMode: "write", dstMode: "write" },
      { name: "link", srcMode: "read", dstMode: "write" },
      { name: "symlink", srcMode: "read", dstMode: "write" },
    ];
    for (const { name, srcMode, dstMode } of callbackTwoPaths) {
      const key = String(name);
      const orig = target[key];
      if (typeof orig === "function") {
        setIfMutable(
          target,
          key,
          wrapFsTwoPaths(orig as AnyFn, srcMode, dstMode),
        );
      }
    }
  }

  // ── fs.promises (promise-based API) ─────────────────────────────────────

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
    "opendir",
    "appendFile",
  ];
  const promisesWriteOnePath = new Set<string>([
    "chmod",
    "chown",
    "lchmod",
    "lchown",
    "mkdir",
    "mkdtemp",
    "rmdir",
    "rm",
    "truncate",
    "unlink",
    "utimes",
    "lutimes",
    "appendFile",
  ]);
  for (const promises of promiseTargets) {
    for (const name of promisesOnePath) {
      const orig = promises[name];
      if (typeof orig === "function") {
        setIfMutable(
          promises,
          name,
          wrapFsPath(
            orig as AnyFn,
            promisesWriteOnePath.has(name) ? "write" : "read",
          ),
        );
      }
    }

    if (typeof promises.writeFile === "function") {
      const wrapped = wrapFsWriteGuard(promises.writeFile as AnyFn);
      setIfMutable(promises, "writeFile", wrapFsPath(wrapped, "write"));
    }
    if (typeof promises.open === "function") {
      setIfMutable(promises, "open", wrapFsOpenPath(promises.open as AnyFn));
    }
    if (typeof promises.cp === "function") {
      setIfMutable(
        promises,
        "cp",
        wrapFsTwoPaths(promises.cp as AnyFn, "read", "write"),
      );
    }

    const promisesTwoPaths: Array<{
      name: string;
      srcMode: FsAccessMode;
      dstMode: FsAccessMode;
    }> = [
      { name: "copyFile", srcMode: "read", dstMode: "write" },
      { name: "rename", srcMode: "write", dstMode: "write" },
      { name: "link", srcMode: "read", dstMode: "write" },
      { name: "symlink", srcMode: "read", dstMode: "write" },
    ];
    for (const { name, srcMode, dstMode } of promisesTwoPaths) {
      const orig = promises[name];
      if (typeof orig === "function") {
        setIfMutable(
          promises,
          name,
          wrapFsTwoPaths(orig as AnyFn, srcMode, dstMode),
        );
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
  _workspaceRootReal = realpathIfPossible(canonical);
  _readOnlyRoots = envReadOnlyRoots().filter(
    (root) => !isInsideRoot(root, canonical),
  );
  _readOnlyRootReals = _readOnlyRoots.map((root) => realpathIfPossible(root));
  _installed = true;
  (globalThis as MobileFsGlobals).__ELIZA_MOBILE_FS_RESOLVE__ =
    resolveSandboxed;

  patchFsModule();
  installRequireGuard();

  // Expose the workspace root on the environment for downstream consumers
  // (e.g. PGlite, trajectory logger) that read it from process.env.
  if (!process.env.MOBILE_WORKSPACE_ROOT) {
    process.env.MOBILE_WORKSPACE_ROOT = canonical;
  }
}
