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
  mkdtempSync,
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
  for (const root of workspace.roots) {
    appendDestinationParents(args, root, createdDirectories);
    args.push("--bind", root, root);
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
