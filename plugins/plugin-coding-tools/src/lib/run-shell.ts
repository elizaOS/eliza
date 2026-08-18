/**
 * Plugin-local shell-execution chokepoint.
 *
 * Mirrors the contract of `runShell` in `@elizaos/agent` but is owned by this
 * plugin so the plugin → agent dependency direction stays clean. Whoever holds
 * an `IAgentRuntime` calls this from the SHELL action handler; the body
 * dispatches against the runtime mode.
 */

import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  accessSync,
  createWriteStream,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as importPath from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import {
  CapabilityError,
  getCapabilityRouter,
  type IAgentRuntime,
  sanitizeSpawnEnv,
} from "@elizaos/core";
import { resolveRuntimeExecutionMode } from "@elizaos/shared";
import {
  applyHostExecutionBaseline,
  resolveHostExecutable,
} from "@elizaos/shared/host-execution-env";
import {
  discoverGitAdminMetadata,
  type GitAdminMetadata,
} from "./git-admin-path.js";
import {
  detectTerminalSupport,
  missingToolForCommand,
  missingToolMessage,
  resolveHostShell,
} from "./terminal-capabilities.js";

export type ShellSandboxBackend =
  | "host"
  | "capability-router"
  | "docker"
  | "apple-container"
  | "bubblewrap"
  | "wsl2"
  | "appcontainer"
  | "none";

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  sandbox: ShellSandboxBackend;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
}

export interface BackgroundShellStartResult {
  process: HostShellProcess;
  pid: number | undefined;
  sandbox: ShellSandboxBackend;
  startedAt: number;
}

export interface HostShellProcess {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  stdin: HostShellWritable | null;
  kill(signal?: NodeJS.Signals): void;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface HostShellWritable {
  write(chunk: string): unknown;
  end(): unknown;
  destroyed?: boolean;
  writableEnded?: boolean;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

interface RuntimeSandboxManager {
  exec: (options: {
    command: string;
    workdir?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
    abortSignal?: AbortSignal;
  }) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    executedInSandbox: boolean;
  }>;
}

function getRuntimeSandboxManager(
  runtime: IAgentRuntime,
): RuntimeSandboxManager | null {
  const candidate = (
    runtime as {
      getSandboxManager?: () => RuntimeSandboxManager | null;
    }
  ).getSandboxManager?.();
  return candidate ?? null;
}

function backendForManager(
  manager: RuntimeSandboxManager,
): ShellSandboxBackend {
  const internal = manager as RuntimeSandboxManager & {
    engine?: { engineType?: string };
  };
  const engineType = internal.engine?.engineType;
  if (engineType === "docker") return "docker";
  if (engineType === "apple-container") return "apple-container";
  return "none";
}

function toSandboxWorkdir(cwd: string): string | undefined {
  const root = process.cwd();
  const relative = importPath.relative(
    importPath.resolve(root),
    importPath.resolve(cwd),
  );
  if (relative === "") return "/workspace";
  if (!relative.startsWith("..") && !importPath.isAbsolute(relative)) {
    return `/workspace/${relative}`;
  }
  return undefined;
}

const STREAM_CAP_CHARS = 30_000;

const TRUSTED_BUBBLEWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;

const BUBBLEWRAP_READ_ONLY_SYSTEM_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
] as const;

// Public runtime trust material only. Never bind all of /etc: model-authored
// commands do not need host identities, service configs, or machine-local
// credentials merely to run a compiler and tests.
const BUBBLEWRAP_READ_ONLY_ETC_PATHS = [
  "/etc/ld.so.cache",
  "/etc/ssl/certs",
  "/etc/ssl/openssl.cnf",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/crypto-policies/back-ends/opensslcnf.config",
] as const;

// Model-authored shell commands must not inherit provider credentials or the
// agent's operational configuration. Keep this list intentionally narrow: the
// sandbox gets executable discovery plus terminal/locale presentation only.
const BUBBLEWRAP_PASSTHROUGH_ENV_KEYS = new Set([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "NO_COLOR",
  "TERM",
  "TZ",
]);

const BUBBLEWRAP_TOOLCHAIN_COMMANDS = [
  "bun",
  "git",
  "node",
  "python",
  "python3",
  "rg",
] as const;

interface NpmToolchainMount {
  entrypoint: string;
  launcher: string;
  packageRoot: string;
}

interface AcpGitToolchainMount {
  hostRoot: string;
  sandboxRoot: string;
  wrapperDir: string;
  env: Record<string, string>;
}

interface ProtectedGitMetadata extends GitAdminMetadata {
  mounts: Array<{ source: string; destination: string }>;
  objectDirectories: string[];
}

const MAX_PROTECTED_GIT_SESSION_SNAPSHOTS = 256;
const protectedGitSessionSnapshots = new Map<string, ProtectedGitMetadata>();

function invalidAcpGitConfiguration(reason: string): never {
  throw new Error(`local-safe ACP git configuration is invalid: ${reason}`);
}

const ACP_GIT_IDENTITY_ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

const UNSAFE_MUTABLE_WORKSPACE_ROOTS = [
  "/",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
] as const;

function hostSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return applyHostExecutionBaseline(sanitizeSpawnEnv(env));
}

function bubblewrapSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const presentationEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && BUBBLEWRAP_PASSTHROUGH_ENV_KEYS.has(key)) {
      presentationEnv[key] = value;
    }
  }
  return applyHostExecutionBaseline(sanitizeSpawnEnv(presentationEnv));
}

function isPathInside(path: string, root: string): boolean {
  const relative = importPath.relative(root, path);
  return (
    relative === "" ||
    (!relative.startsWith(`..${importPath.sep}`) &&
      relative !== ".." &&
      !importPath.isAbsolute(relative))
  );
}

function expandWorkspaceRoot(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return importPath.join(homedir(), value.slice(2));
  if (value.startsWith("$HOME/")) {
    return importPath.join(homedir(), value.slice(6));
  }
  return value;
}

function readRuntimeStringSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const fromRuntime = runtime.getSetting?.(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime;
  }
  const fromEnvironment = process.env[key];
  return typeof fromEnvironment === "string" &&
    fromEnvironment.trim().length > 0
    ? fromEnvironment
    : undefined;
}

function canonicalDirectory(value: string, label: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(importPath.resolve(expandWorkspaceRoot(value)));
  } catch (error) {
    // error-policy:J2 local-safe configuration is a hard security boundary;
    // retain the path label and cause while refusing to execute anything.
    throw new Error(`${label} is unavailable: ${value}`, { cause: error });
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`${label} is not a directory: ${value}`);
  }
  return resolved;
}

function resolveBubblewrapWorkspace(
  runtime: IAgentRuntime,
  cwd: string,
): { cwd: string; roots: string[] } {
  const configuredRoots = readRuntimeStringSetting(
    runtime,
    "CODING_TOOLS_WORKSPACE_ROOTS",
  );
  if (!configuredRoots) {
    throw new Error(
      "local-safe mode requires SandboxManager or an explicit CODING_TOOLS_WORKSPACE_ROOTS workspace root for the Linux bubblewrap backend.",
    );
  }

  const rawRoots = configuredRoots
    .split(",")
    .map((root) => root.trim())
    .filter(Boolean);
  if (rawRoots.length === 0) {
    throw new Error(
      "local-safe mode requires SandboxManager or a non-empty CODING_TOOLS_WORKSPACE_ROOTS workspace root for the Linux bubblewrap backend.",
    );
  }

  const roots = Array.from(
    new Set(
      rawRoots.map((root) =>
        canonicalDirectory(root, "Configured coding workspace root"),
      ),
    ),
  ).sort((a, b) => a.length - b.length);
  for (const root of roots) {
    const unsafeRoot = [homedir(), ...UNSAFE_MUTABLE_WORKSPACE_ROOTS].find(
      (blocked) => root === importPath.resolve(blocked),
    );
    if (unsafeRoot) {
      throw new Error(
        `local-safe bubblewrap refuses an over-broad mutable workspace root: ${root}`,
      );
    }
  }

  // A nested root adds no authority beyond an already-mounted parent and can
  // produce surprising mount shadowing, so keep only the minimal root set.
  const minimalRoots = roots.filter(
    (root, index) =>
      !roots.slice(0, index).some((parent) => isPathInside(root, parent)),
  );
  const resolvedCwd = canonicalDirectory(cwd, "Shell cwd");
  if (!minimalRoots.some((root) => isPathInside(resolvedCwd, root))) {
    throw new Error(
      `local-safe bubblewrap cwd is outside CODING_TOOLS_WORKSPACE_ROOTS: ${cwd}`,
    );
  }
  return { cwd: resolvedCwd, roots: minimalRoots };
}

function resolveTrustedBubblewrapBinary(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const seen = new Set<string>();
  for (const candidate of TRUSTED_BUBBLEWRAP_CANDIDATES) {
    try {
      const resolved = realpathSync(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const stat = statSync(resolved);
      if (!stat.isFile() || !isRootOwnedAndNotGroupOrWorldWritable(resolved)) {
        continue;
      }
      accessSync(resolved, fsConstants.X_OK);
      return resolved;
    } catch {
      // error-policy:J4 an absent/untrusted candidate advances to the next
      // fixed system location; exhausting all candidates fails closed below.
    }
  }
  return undefined;
}

function isRootOwnedAndNotGroupOrWorldWritable(path: string): boolean {
  let current = path;
  while (true) {
    const stat = statSync(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
    const parent = importPath.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function appendDestinationParents(
  args: string[],
  destination: string,
  createdDirectories: Set<string>,
): void {
  const parents: string[] = [];
  let current = importPath.dirname(destination);
  while (current !== importPath.dirname(current)) {
    parents.push(current);
    current = importPath.dirname(current);
  }
  for (const parent of parents.reverse()) {
    if (createdDirectories.has(parent)) continue;
    args.push("--dir", parent);
    createdDirectories.add(parent);
  }
}

function appendReadOnlyFileIfOutsideSystemMounts(
  args: string[],
  file: string,
  createdDirectories: Set<string>,
): void {
  let resolved: string;
  try {
    resolved = realpathSync(file);
  } catch {
    return;
  }
  if (
    BUBBLEWRAP_READ_ONLY_SYSTEM_PATHS.some((root) =>
      isPathInside(resolved, root),
    )
  ) {
    return;
  }
  appendDestinationParents(args, resolved, createdDirectories);
  args.push("--ro-bind", resolved, resolved);
}

function npmBinEntrypoint(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const record = manifest as Record<string, unknown>;
  if (record.name !== "npm") return undefined;
  const bin = record.bin;
  if (!bin || typeof bin !== "object") return undefined;
  const npm = (bin as Record<string, unknown>).npm;
  return typeof npm === "string" && npm.length > 0 ? npm : undefined;
}

function resolveNpmToolchainMount(): NpmToolchainMount | undefined {
  const launcher = resolveHostExecutable("npm");
  if (!launcher) return undefined;

  try {
    const entrypoint = realpathSync(launcher);
    let candidate = importPath.dirname(entrypoint);
    while (candidate !== importPath.dirname(candidate)) {
      const manifestPath = importPath.join(candidate, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as unknown;
        const declaredEntrypoint = npmBinEntrypoint(manifest);
        if (declaredEntrypoint) {
          const expectedEntrypoint = realpathSync(
            importPath.resolve(candidate, declaredEntrypoint),
          );
          if (expectedEntrypoint !== entrypoint) return undefined;
          return { entrypoint, launcher, packageRoot: candidate };
        }
      }
      candidate = importPath.dirname(candidate);
    }
  } catch {
    // error-policy:J4 npm is an optional local toolchain. An absent, malformed,
    // or mismatched package is not exposed to model-authored commands.
  }
  return undefined;
}

function appendNpmToolchainMount(
  args: string[],
  createdDirectories: Set<string>,
): void {
  const mount = resolveNpmToolchainMount();
  if (!mount) return;
  if (
    BUBBLEWRAP_READ_ONLY_SYSTEM_PATHS.some(
      (root) =>
        isPathInside(mount.launcher, root) &&
        isPathInside(mount.entrypoint, root),
    )
  ) {
    return;
  }

  appendDestinationParents(args, mount.packageRoot, createdDirectories);
  args.push("--ro-bind", mount.packageRoot, mount.packageRoot);
  if (mount.launcher !== mount.entrypoint) {
    appendDestinationParents(args, mount.launcher, createdDirectories);
    const target = importPath.relative(
      importPath.dirname(mount.launcher),
      mount.entrypoint,
    );
    args.push("--symlink", target, mount.launcher);
  }
}

/**
 * Preserve the orchestrator's per-session Git index inside local-safe.
 *
 * The ACP parent prepends a generated `git` wrapper to PATH and supplies a
 * private index plus the absolute real Git binary. Stripping those non-secret
 * control variables while retaining the wrapper makes the wrapper recursively
 * invoke itself. Passing PATH through without the private index instead lets
 * model-authored `git add` mutate the operator's shared repository index.
 *
 * Treat the complete, correlated tuple as one narrow mount authority. Partial
 * or malformed tuples fail closed; no generic ACP_* environment is forwarded.
 */
function resolveAcpGitToolchainMount(): AcpGitToolchainMount | undefined {
  const indexFile = process.env.ACP_GIT_INDEX_FILE;
  const activeIndexFile = process.env.GIT_INDEX_FILE;
  const realGitValue = process.env.ACP_REAL_GIT;
  const baseline = process.env.ACP_GIT_BASELINE_SHA;
  const firstPathEntry = process.env.PATH?.split(importPath.delimiter)[0];
  const hasAnyAcpGitState = [
    indexFile,
    activeIndexFile,
    realGitValue,
    baseline,
  ].some((value) => value !== undefined);
  if (!hasAnyAcpGitState) return undefined;

  if (!indexFile || !importPath.isAbsolute(indexFile)) {
    invalidAcpGitConfiguration("ACP_GIT_INDEX_FILE must be an absolute path");
  }
  if (activeIndexFile !== indexFile) {
    invalidAcpGitConfiguration("GIT_INDEX_FILE must match ACP_GIT_INDEX_FILE");
  }
  if (!realGitValue || !importPath.isAbsolute(realGitValue)) {
    invalidAcpGitConfiguration("ACP_REAL_GIT must be an absolute path");
  }
  if (
    baseline !== undefined &&
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(baseline)
  ) {
    invalidAcpGitConfiguration(
      "ACP_GIT_BASELINE_SHA must be a full Git object id",
    );
  }
  if (!firstPathEntry || !importPath.isAbsolute(firstPathEntry)) {
    invalidAcpGitConfiguration("the ACP git wrapper directory must lead PATH");
  }

  try {
    const root = realpathSync(importPath.dirname(indexFile));
    const canonicalIndex = realpathSync(indexFile);
    const wrapperDir = realpathSync(firstPathEntry);
    const wrapper = realpathSync(importPath.join(wrapperDir, "git"));
    const realGit = realpathSync(realGitValue);
    if (canonicalIndex !== importPath.join(root, "index")) {
      invalidAcpGitConfiguration(
        "the private index must be named index at the session root",
      );
    }
    if (wrapperDir !== importPath.join(root, "bin")) {
      invalidAcpGitConfiguration(
        "the git wrapper must be the session root's bin directory",
      );
    }
    if (wrapper !== importPath.join(wrapperDir, "git")) {
      invalidAcpGitConfiguration("the git wrapper must not traverse a symlink");
    }
    const rootStat = statSync(root);
    const indexStat = statSync(canonicalIndex);
    const wrapperStat = statSync(wrapper);
    if (
      !rootStat.isDirectory() ||
      !indexStat.isFile() ||
      !wrapperStat.isFile()
    ) {
      invalidAcpGitConfiguration(
        "the session root, index, or wrapper has the wrong file type",
      );
    }
    accessSync(wrapper, fsConstants.X_OK);
    accessSync(realGit, fsConstants.X_OK);
    if (
      !BUBBLEWRAP_READ_ONLY_SYSTEM_PATHS.some((systemRoot) =>
        isPathInside(realGit, systemRoot),
      ) ||
      !isRootOwnedAndNotGroupOrWorldWritable(realGit)
    ) {
      invalidAcpGitConfiguration(
        "ACP_REAL_GIT is not a trusted system executable",
      );
    }

    const objects = importPath.join(root, "objects");
    mkdirSync(objects, { recursive: true, mode: 0o700 });
    if (realpathSync(objects) !== objects || !statSync(objects).isDirectory()) {
      invalidAcpGitConfiguration(
        "the private object database must be a real session-root directory",
      );
    }

    const sandboxRoot = "/run/eliza-acp-git";
    const identityEnv: Record<string, string> = {};
    for (const key of ACP_GIT_IDENTITY_ENV_KEYS) {
      const value = process.env[key];
      if (value === undefined) continue;
      if (!value.trim() || /[\0\r\n]/u.test(value)) {
        invalidAcpGitConfiguration(`${key} contains an unsafe identity value`);
      }
      identityEnv[key] = value;
    }
    return {
      hostRoot: root,
      sandboxRoot,
      wrapperDir: importPath.join(sandboxRoot, "bin"),
      env: {
        ACP_GIT_INDEX_FILE: importPath.join(sandboxRoot, "index"),
        ACP_REAL_GIT: realGit,
        GIT_INDEX_FILE: importPath.join(sandboxRoot, "index"),
        GIT_OBJECT_DIRECTORY: importPath.join(sandboxRoot, "objects"),
        ...identityEnv,
        ...(baseline ? { ACP_GIT_BASELINE_SHA: baseline } : {}),
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("local-safe ACP git configuration is invalid:")
    ) {
      throw error;
    }
    invalidAcpGitConfiguration(
      "the session wrapper, index, or real Git binary is unavailable",
    );
  }
}

/**
 * Find every pre-existing repository below the writable workspace binds.
 *
 * A private GIT_INDEX_FILE is only a cooperative guard: model-authored shell
 * can unset it, invoke an absolute Git binary, or write .git directly. Shadow
 * every real Git administration path with a read-only bind after mounting the
 * workspace writable. New blobs go to the ACP session's private object store;
 * the immutable real object stores are configured as read-only alternates.
 */
function discoverProtectedGitMetadata(roots: string[]): ProtectedGitMetadata {
  const metadata = discoverGitAdminMetadata(roots);
  const mountMap = new Map(
    metadata.adminPaths.map((adminPath) => [adminPath, adminPath]),
  );

  // If a common Git directory contains a per-worktree Git directory, the
  // common parent read-only mount already covers it. Keep file markers and the
  // smallest set of directory mounts to avoid redundant nested mountpoints.
  const mounts = Array.from(mountMap, ([source, destination]) => ({
    source,
    destination,
  })).filter((candidate, _index, candidates) => {
    if (!statSync(candidate.destination).isDirectory()) return true;
    return !candidates.some(
      (parent) =>
        parent.destination !== candidate.destination &&
        statSync(parent.destination).isDirectory() &&
        isPathInside(candidate.destination, parent.destination),
    );
  });

  return {
    ...metadata,
    mounts,
    objectDirectories: Array.from(
      new Set(metadata.repositories.map((repo) => repo.objectDirectory)),
    ).sort(),
  };
}

function resolveProtectedGitMetadata(
  acpGit: AcpGitToolchainMount,
  roots: string[],
): ProtectedGitMetadata {
  // The ACP session root is unique per coding session. Snapshot the operator's
  // repositories on its first shell turn: repeated commands avoid a full-tree
  // scan, while a repository intentionally created later by the isolated
  // session remains writable and usable by that session. This defines the
  // concurrency boundary: operators must not add repository metadata to the
  // same workspace while an ACP session is active; such a repository is not
  // part of that session's protected baseline and requires a new ACP session.
  const key = [acpGit.hostRoot, ...roots].join("\0");
  const cached = protectedGitSessionSnapshots.get(key);
  if (cached) return cached;

  const discovered = discoverProtectedGitMetadata(roots);
  if (
    protectedGitSessionSnapshots.size >= MAX_PROTECTED_GIT_SESSION_SNAPSHOTS
  ) {
    const oldest = protectedGitSessionSnapshots.keys().next().value;
    if (oldest !== undefined) protectedGitSessionSnapshots.delete(oldest);
  }
  protectedGitSessionSnapshots.set(key, discovered);
  return discovered;
}

function configureProtectedSessionGit(
  acpGit: AcpGitToolchainMount,
  metadata: ProtectedGitMetadata,
  cwd: string,
): void {
  const repository = metadata.repositories
    .filter((candidate) => isPathInside(cwd, candidate.worktree))
    .sort((a, b) => b.worktree.length - a.worktree.length)[0];
  if (!repository) return;

  const realGit = acpGit.env.ACP_REAL_GIT;
  const baseline = acpGit.env.ACP_GIT_BASELINE_SHA;
  try {
    if (!baseline) return;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(baseline)) {
      invalidAcpGitConfiguration(
        "the repository baseline is not a full object id",
      );
    }
    execFileSync(
      realGit,
      ["-C", repository.worktree, "cat-file", "-e", `${baseline}^{commit}`],
      { stdio: "ignore" },
    );
  } catch (error) {
    throw new Error(
      "local-safe ACP git configuration is invalid: the repository baseline commit is unavailable",
      { cause: error },
    );
  }

  // Keep the operator's real Git directory mounted read-only. The session can
  // stage and inspect changes through its private index/object store, but a
  // history-changing command must fail rather than create a temporary commit
  // below the session root that teardown later deletes. A durable commit needs
  // an explicit, separately-authorized landing protocol; local-safe never
  // reports an ephemeral private ref as delivered work.
  acpGit.env.GIT_CONFIG_NOSYSTEM = "1";
}

function appendProtectedGitMetadataMounts(
  args: string[],
  createdDirectories: Set<string>,
  metadata: ProtectedGitMetadata,
): void {
  for (const mount of metadata.mounts) {
    appendDestinationParents(args, mount.destination, createdDirectories);
    args.push("--ro-bind", mount.source, mount.destination);
  }
}

function appendAcpGitToolchainMount(
  args: string[],
  createdDirectories: Set<string>,
  mount: AcpGitToolchainMount,
): void {
  appendDestinationParents(args, mount.sandboxRoot, createdDirectories);
  args.push("--dir", mount.sandboxRoot);
  args.push("--bind", mount.hostRoot, mount.sandboxRoot);
  // The private index and its lock file remain writable, but the generated
  // wrapper itself is immutable to model-authored commands.
  args.push(
    "--ro-bind",
    importPath.join(mount.hostRoot, "bin"),
    mount.wrapperDir,
  );
}

function appendTrustedReadOnlyPath(
  args: string[],
  source: string,
  createdDirectories: Set<string>,
): void {
  try {
    if (!existsSync(source) || !isRootOwnedAndNotGroupOrWorldWritable(source)) {
      return;
    }
    appendDestinationParents(args, source, createdDirectories);
    args.push("--ro-bind", source, source);
  } catch {
    // error-policy:J4 optional public trust material is absent or untrusted;
    // skip it rather than broadening host read authority.
  }
}

async function runInBubblewrap(
  runtime: IAgentRuntime,
  opts: RunShellOptions,
): Promise<ShellResult> {
  const bubblewrap = resolveTrustedBubblewrapBinary();
  if (!bubblewrap) {
    throw new Error(
      "local-safe mode requires SandboxManager or a trusted Linux bubblewrap backend; no root-owned, non-writable system bwrap executable is available.",
    );
  }
  const workspace = resolveBubblewrapWorkspace(runtime, opts.cwd);
  const shell = resolveHostShell();
  if (!shell.available) {
    throw new Error(shell.warning ?? "No executable shell was detected.");
  }

  const args = [
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--cap-drop",
    "ALL",
    "--hostname",
    "eliza-sandbox",
  ];
  const createdDirectories = new Set<string>();
  const acpGit = resolveAcpGitToolchainMount();
  const protectedGit = acpGit
    ? resolveProtectedGitMetadata(acpGit, workspace.roots)
    : undefined;
  if (acpGit && protectedGit) {
    configureProtectedSessionGit(acpGit, protectedGit, workspace.cwd);
  }
  for (const source of BUBBLEWRAP_READ_ONLY_SYSTEM_PATHS) {
    if (existsSync(source)) args.push("--ro-bind", source, source);
  }
  for (const source of BUBBLEWRAP_READ_ONLY_ETC_PATHS) {
    appendTrustedReadOnlyPath(args, source, createdDirectories);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  args.push("--dir", "/tmp/home");
  args.push("--tmpfs", "/run");

  appendReadOnlyFileIfOutsideSystemMounts(
    args,
    process.execPath,
    createdDirectories,
  );
  appendReadOnlyFileIfOutsideSystemMounts(
    args,
    shell.command,
    createdDirectories,
  );
  if (acpGit) {
    appendAcpGitToolchainMount(args, createdDirectories, acpGit);
  }
  for (const command of BUBBLEWRAP_TOOLCHAIN_COMMANDS) {
    const executable = resolveHostExecutable(command);
    if (executable) {
      appendReadOnlyFileIfOutsideSystemMounts(
        args,
        executable,
        createdDirectories,
      );
    }
  }
  appendNpmToolchainMount(args, createdDirectories);
  for (const root of workspace.roots) {
    appendDestinationParents(args, root, createdDirectories);
    args.push("--bind", root, root);
  }
  if (protectedGit) {
    appendProtectedGitMetadataMounts(args, createdDirectories, protectedGit);
  }
  // Bubblewrap starts with an empty writable root, and `--dir` creates the
  // absolute ancestors needed by the selected workspace binds. Without this
  // non-recursive remount, a command can create an ephemeral file in one of
  // those synthetic ancestors and receive exit 0 even though no host mutation
  // occurred. Make that root read-only so out-of-workspace writes fail
  // explicitly. The workspace bind and the intentional per-command /tmp and
  // /run scratch mounts are separate child mounts, so they remain writable.
  args.push("--remount-ro", "/");
  const childEnv = bubblewrapSpawnEnv(process.env);
  if (acpGit) {
    Object.assign(childEnv, acpGit.env);
    if (protectedGit && protectedGit.objectDirectories.length > 0) {
      childEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES =
        protectedGit.objectDirectories.join(importPath.delimiter);
    }
    const baselinePath = childEnv.PATH;
    childEnv.PATH = [
      acpGit.wrapperDir,
      ...(baselinePath ?? "")
        .split(importPath.delimiter)
        .filter((entry) => entry && entry !== acpGit.wrapperDir),
    ].join(importPath.delimiter);
  }
  for (const [key, value] of Object.entries(childEnv)) {
    if (value !== undefined) args.push("--setenv", key, value);
  }
  args.push(
    "--setenv",
    "HOME",
    "/tmp/home",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--unsetenv",
    "DBUS_SESSION_BUS_ADDRESS",
    "--unsetenv",
    "SSH_AUTH_SOCK",
    "--chdir",
    workspace.cwd,
    shell.command,
    ...shellArgsForCommand(shell),
  );

  const result = await runOnHostWithShell(
    {
      command: opts.command,
      cwd: "/",
      timeoutMs: opts.timeoutMs,
      env: childEnv,
      abortSignal: opts.abortSignal,
    },
    {
      command: bubblewrap,
      args,
      available: true,
      source: "candidate",
    },
  );
  return { ...result, sandbox: "bubblewrap" };
}

function shellArgsForCommand(shell: {
  command: string;
  args: string[];
}): string[] {
  const basename = importPath.basename(shell.command).toLowerCase();
  if (basename === "bash") {
    const commandFlagIndex = shell.args.lastIndexOf("-c");
    const startupFlags = ["--noprofile", "--norc", "-o", "pipefail"];
    if (commandFlagIndex >= 0) {
      return [
        ...startupFlags,
        ...shell.args.slice(0, commandFlagIndex),
        ...shell.args.slice(commandFlagIndex),
      ];
    }
    return [...startupFlags, ...shell.args];
  }
  if (basename === "zsh") {
    const commandFlagIndex = shell.args.lastIndexOf("-c");
    const startupFlags = ["-f", "-o", "pipefail"];
    if (commandFlagIndex >= 0) {
      return [
        ...startupFlags,
        ...shell.args.slice(0, commandFlagIndex),
        ...shell.args.slice(commandFlagIndex),
      ];
    }
    return [...startupFlags, ...shell.args];
  }
  return shell.args;
}

function killHostProcess(
  pid: number | undefined,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
  proc: HostShellProcess,
): void {
  try {
    if (pid && useProcessGroup) {
      process.kill(-pid, signal);
      return;
    }
    proc.kill(signal);
  } catch {
    // error-policy:J6 best-effort teardown; the process may have exited between
    // the timeout firing and kill delivery, so a failed signal is a no-op.
  }
}

interface BunHostSubprocess {
  pid: number;
  stdout: unknown;
  stderr: unknown;
  stdin?: {
    write(chunk: string): unknown;
    end(): unknown;
  };
  exited: Promise<number>;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): void;
}

interface BunHostRuntime {
  spawn(options: {
    cmd: string[];
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: "ignore" | "pipe";
    stdout: "pipe";
    stderr: "pipe";
    detached: boolean;
    onExit: (
      proc: BunHostSubprocess,
      code: number,
      signal: NodeJS.Signals | null,
      error?: Error,
    ) => void;
  }): BunHostSubprocess;
}

function getBunRuntime(): BunHostRuntime | null {
  return (globalThis as { Bun?: BunHostRuntime }).Bun ?? null;
}

function isBunRuntime(): boolean {
  return typeof getBunRuntime()?.spawn === "function";
}

function startHostProcess(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
  detached: boolean;
  onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ) => void;
}): HostShellProcess {
  if (isBunRuntime()) {
    return startBunHostProcess(opts);
  }
  return spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdin, "pipe", "pipe"],
    detached: opts.detached,
  }) as HostShellProcess;
}

function startBunHostProcess(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
  detached: boolean;
  onExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ) => void;
}): HostShellProcess {
  const events = new EventEmitter();
  const stdinFifo =
    opts.stdin === "pipe" && process.platform !== "win32"
      ? createStdinFifo()
      : null;
  const commandArgs = stdinFifo
    ? withShellStdinRedirect(opts.args, stdinFifo.path)
    : opts.args;
  const bun = getBunRuntime();
  if (!bun) {
    throw new Error("Bun runtime is unavailable");
  }
  const proc = bun.spawn({
    cmd: [opts.command, ...commandArgs],
    cwd: opts.cwd,
    env: opts.env as Record<string, string | undefined>,
    stdin: opts.stdin,
    stdout: "pipe",
    stderr: "pipe",
    detached: opts.detached,
    onExit: (_proc, code, signal, error) => {
      opts.onExit?.(code, signal as NodeJS.Signals | null, error);
    },
  });
  const stdout = Readable.fromWeb(proc.stdout as never);
  const stderr = Readable.fromWeb(proc.stderr as never);
  const stdin = stdinFifo?.open(events) ?? null;
  const bunStdin = proc.stdin;
  const stdoutEnded = streamEnded(stdout);
  const stderrEnded = streamEnded(stderr);
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let exitError: Error | undefined;

  proc.exited
    .then((code) => {
      exitCode = code;
      signalCode = proc.signalCode;
    })
    .catch((error: unknown) => {
      exitCode = -1;
      exitError = error instanceof Error ? error : new Error(String(error));
      events.emit("error", exitError);
    })
    .finally(() => {
      Promise.allSettled([stdoutEnded, stderrEnded]).then(() => {
        stdinFifo?.cleanup();
        events.emit("close", exitCode, signalCode);
      });
    });

  return {
    pid: proc.pid,
    stdout,
    stderr,
    stdin:
      stdin ??
      (opts.stdin === "pipe" && bunStdin
        ? {
            write(chunk: string) {
              return bunStdin.write(chunk);
            },
            end() {
              return bunStdin.end();
            },
          }
        : null),
    kill(signal?: NodeJS.Signals) {
      proc.kill(signal);
    },
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
  };
}

function streamEnded(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded) {
      resolve();
      return;
    }
    stream.once("end", resolve);
    stream.once("close", resolve);
  });
}

function createStdinFifo(): {
  path: string;
  open(events: EventEmitter): HostShellWritable;
  cleanup(): void;
} {
  const dir = mkdtempSync(importPath.join(tmpdir(), "eliza-bg-stdin-"));
  const fifoPath = importPath.join(dir, "stdin");
  execFileSync("mkfifo", [fifoPath]);
  let stream: WriteStream | null = null;
  return {
    path: fifoPath,
    open(events: EventEmitter) {
      stream = createWriteStream(fifoPath, { encoding: "utf8" });
      stream.on("error", (error) => events.emit("error", error));
      return {
        write(chunk: string) {
          return stream?.write(chunk);
        },
        end() {
          return stream?.end();
        },
      };
    },
    cleanup() {
      stream?.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function withShellStdinRedirect(args: string[], fifoPath: string): string[] {
  const commandFlagIndex = args.lastIndexOf("-c");
  if (commandFlagIndex < 0 || commandFlagIndex + 1 >= args.length) {
    return args;
  }
  const redirected = `exec < ${quoteShellArg(fifoPath)}; ${
    args[commandFlagIndex + 1]
  }`;
  return [
    ...args.slice(0, commandFlagIndex + 1),
    redirected,
    ...args.slice(commandFlagIndex + 2),
  ];
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function runOnHost(opts: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
}): Promise<ShellResult> {
  const shell = resolveHostShell();
  return runOnHostWithShell(opts, shell).then(async (result) => {
    const basename = importPath.basename(shell.command).toLowerCase();
    if (
      basename === "zsh" &&
      result.exitCode !== 0 &&
      !result.timedOut &&
      result.signal === null &&
      result.stdout.length === 0 &&
      result.stderr.length === 0
    ) {
      const bash = resolveExecutableForHost("bash", "/bin/bash");
      if (bash && bash !== shell.command) {
        return runOnHostWithShell(opts, {
          command: bash,
          args: ["-c"],
          available: true,
          source: "candidate",
        });
      }
    }
    return result;
  });
}

function assertHostBackgroundSupported(
  runtime: IAgentRuntime,
  command: string,
  cwd: string,
): void {
  if (getCapabilityRouter(runtime)) {
    throw new Error(
      "Background shell sessions are not supported by the capability-router backend.",
    );
  }

  const mode = resolveRuntimeExecutionMode(runtime);
  if (mode === "cloud") {
    throw new Error("Background shell sessions are disabled in cloud mode.");
  }
  if (mode === "local-safe") {
    throw new Error(
      "Background shell sessions require a managed sandbox backend with session support; this runtime only exposes one-shot sandbox exec.",
    );
  }

  const support = detectTerminalSupport();
  if (!support.supported) {
    throw new Error(
      support.message ?? "Local terminal execution is unavailable.",
    );
  }

  const missingTool = missingToolForCommand(command);
  if (missingTool) {
    throw new Error(missingToolMessage(missingTool));
  }

  const resolvedCwd = importPath.resolve(cwd);
  if (!existsSync(resolvedCwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
}

export function startBackgroundShellOnHost(
  runtime: IAgentRuntime,
  opts: {
    command: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): BackgroundShellStartResult {
  assertHostBackgroundSupported(runtime, opts.command, opts.cwd);
  const shell = resolveHostShell();
  if (!shell.available) {
    throw new Error(shell.warning ?? "No executable shell was detected.");
  }
  const useProcessGroup = process.platform !== "win32";
  const proc = startHostProcess({
    command: shell.command,
    args: [...shellArgsForCommand(shell), opts.command],
    cwd: opts.cwd,
    env: hostSpawnEnv(opts.env ?? process.env),
    stdin: "pipe",
    detached: useProcessGroup,
  });
  return {
    process: proc,
    pid: proc.pid,
    sandbox: "host",
    startedAt: Date.now(),
  };
}

export function signalHostProcessGroup(
  proc: HostShellProcess,
  signal: NodeJS.Signals,
): void {
  killHostProcess(proc.pid, signal, process.platform !== "win32", proc);
}

function resolveExecutableForHost(
  name: string,
  fallback: string,
): string | undefined {
  return resolveHostExecutable(name) ?? resolveHostExecutable(fallback);
}

function runOnHostWithShell(
  opts: {
    command: string;
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
  },
  shell: ReturnType<typeof resolveHostShell>,
): Promise<ShellResult> {
  const start = Date.now();
  return new Promise<ShellResult>((resolve, reject) => {
    try {
      opts.abortSignal?.throwIfAborted();
    } catch (error) {
      reject(error);
      return;
    }
    if (!shell.available) {
      resolve({
        exitCode: -1,
        signal: null,
        stdout: "",
        stderr: shell.warning ?? "No executable shell was detected.",
        timedOut: false,
        durationMs: Date.now() - start,
        sandbox: "host",
      });
      return;
    }
    const useProcessGroup = process.platform !== "win32";
    const proc = startHostProcess({
      command: shell.command,
      args: [...shellArgsForCommand(shell), opts.command],
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      detached: useProcessGroup,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const abortReason = (): unknown =>
      opts.abortSignal?.reason ??
      new DOMException("Shell command cancelled", "AbortError");
    const onAbort = () => {
      aborted = true;
      // Model-authored commands get no post-cancel grace period: a process that
      // ignores TERM could otherwise keep mutating the workspace for 1.5s
      // after the caller believed cancellation had taken effect.
      killHostProcess(proc.pid, "SIGKILL", useProcessGroup, proc);
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (opts.abortSignal?.aborted) onAbort();

    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < STREAM_CAP_CHARS * 2) {
        stdout += chunk.toString("utf8");
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STREAM_CAP_CHARS * 2) {
        stderr += chunk.toString("utf8");
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // A timeout is the same containment boundary as explicit cancellation.
      // Kill the complete process group immediately and avoid a detached grace
      // timer that could later target a reused PID after the shell exits.
      killHostProcess(proc.pid, "SIGKILL", useProcessGroup, proc);
    }, opts.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(abortReason());
        return;
      }
      resolve({
        exitCode: code ?? -1,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
        sandbox: "host",
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(abortReason());
        return;
      }
      resolve({
        exitCode: -1,
        signal: null,
        stdout,
        stderr: stderr.length > 0 ? `${stderr}\n${err.message}` : err.message,
        timedOut,
        durationMs: Date.now() - start,
        sandbox: "host",
      });
    });
  });
}

async function runThroughCapabilityRouter(
  runtime: IAgentRuntime,
  opts: RunShellOptions,
): Promise<ShellResult | null> {
  const router = getCapabilityRouter(runtime);
  if (!router) return null;
  if (opts.abortSignal) {
    throw new Error(
      "Capability-router shell execution cannot guarantee cancellation; refusing to dispatch a cancellable command.",
    );
  }
  const start = Date.now();
  try {
    const result = await router.pty.runCommand({
      command: opts.command,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
    return {
      exitCode: result.exitCode ?? -1,
      signal: null,
      stdout: result.output,
      stderr: "",
      durationMs: Date.now() - start,
      timedOut: result.timedOut,
      sandbox: "capability-router",
    };
  } catch (error) {
    // error-policy:J4 only the expected "no PTY capability" shape
    // (CAPABILITY_UNAVAILABLE) degrades to null below (advancing to the
    // host-shell fallback); any other router error rethrows so a genuine
    // execution failure reaches the SHELL action.
    if (
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE"
    ) {
      return null;
    }
    throw error;
  }
}

export interface RunShellOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

/**
 * Run a shell command, dispatching against the active runtime mode:
 *  - `cloud`      → throws ("Local shell execution disabled in cloud mode.").
 *  - `local-safe` → SandboxManager.exec, or a fail-closed Linux bubblewrap
 *                   fallback constrained to explicit coding workspace roots.
 *  - `local-yolo` → /bin/bash -c host exec.
 */
export async function runShell(
  runtime: IAgentRuntime,
  opts: RunShellOptions,
): Promise<ShellResult> {
  const mode = resolveRuntimeExecutionMode(runtime);

  opts.abortSignal?.throwIfAborted();

  const routed = await runThroughCapabilityRouter(runtime, opts);
  opts.abortSignal?.throwIfAborted();
  if (routed) return routed;

  if (mode === "cloud") {
    throw new Error("Local shell execution disabled in cloud mode.");
  }

  const support = detectTerminalSupport();
  if (!support.supported) {
    throw new Error(
      support.message ?? "Local terminal execution is unavailable.",
    );
  }

  const missingTool = missingToolForCommand(opts.command);
  if (missingTool) {
    throw new Error(missingToolMessage(missingTool));
  }

  if (mode === "local-safe") {
    const manager = getRuntimeSandboxManager(runtime);
    if (!manager) {
      if (process.platform === "linux") {
        return runInBubblewrap(runtime, opts);
      }
      throw new Error(
        "local-safe mode requires SandboxManager; the Linux bubblewrap fallback is unavailable on this platform.",
      );
    }
    const sandboxWorkdir = toSandboxWorkdir(opts.cwd);
    if (!sandboxWorkdir) {
      throw new Error(
        `local-safe mode can only execute inside the sandbox workspace; cwd is outside process workspace: ${opts.cwd}`,
      );
    }
    const result = await manager.exec({
      command: opts.command,
      workdir: sandboxWorkdir,
      timeoutMs: opts.timeoutMs,
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });
    opts.abortSignal?.throwIfAborted();
    return {
      exitCode: result.exitCode,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: false,
      sandbox: backendForManager(manager),
    };
  }

  return runOnHost({
    command: opts.command,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    env: hostSpawnEnv(process.env),
    abortSignal: opts.abortSignal,
  });
}
