/**
 * Shared helpers for launching and inspecting packaged Electrobun app builds
 * in tests.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPackagedWindowsAppEnv } from "./windows-test-env";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const electrobunArtifactsDir = path.join(
  repoRoot,
  "packages",
  "app-core",
  "platforms",
  "electrobun",
  "artifacts",
);
const electrobunBuildDir = path.join(
  repoRoot,
  "packages",
  "app-core",
  "platforms",
  "electrobun",
  "build",
);

export interface PackagedProcessLogs {
  stdout: string[];
  stderr: string[];
}

export interface DesktopTestBridgeState {
  mainWindow: {
    present: boolean;
    windowId: number | null;
    webviewId: number | null;
    url: string | null;
    titleBarStyle: string | null;
    transparent: boolean | null;
    vibrancyEnabled: boolean | null;
    shadowEnabled: boolean | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
  };
  shell: {
    trayPresent: boolean;
    mainWindowPresent: boolean;
    windowVisible: boolean;
    windowFocused: boolean;
    shortcuts?: Array<{ id: string; accelerator: string }>;
    trayPopover?: {
      configured: boolean;
      windowPresent: boolean;
      visible: boolean;
      lastAnchorBounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null;
    };
  };
}

export interface DesktopWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PackagedStartOptions {
  bridgeHealthTimeoutMs?: number;
  shellReadyTimeoutMs?: number;
}

const PACKAGED_TEST_DISABLED_FIRST_PARTY_REMOTES = ["eliza.local-model"];
const PACKAGED_GRACEFUL_QUIT_TIMEOUT_MS = 15_000;
const PACKAGED_LINUX_PROCESS_COOLDOWN_MS = 2_500;
const PACKAGED_RELAUNCH_DELAY_MS =
  process.platform === "linux" ? PACKAGED_LINUX_PROCESS_COOLDOWN_MS : 1_000;

function appendLog(target: string[], chunk: Buffer | string): void {
  const text = chunk.toString();
  if (!text) return;
  target.push(text);
  if (target.length > 2000) {
    target.splice(0, target.length - 2000);
  }
}

function collectProcessLogs(child: ChildProcess): PackagedProcessLogs {
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => appendLog(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendLog(stderr, chunk));
  return { stdout, stderr };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveExecutableOnPath(binaryName: string): string | null {
  const pathValue = process.env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function waitAfterPackagedProcessExit(): Promise<void> {
  if (process.platform === "linux") {
    await delay(PACKAGED_LINUX_PROCESS_COOLDOWN_MS);
  }
}

async function findFiles(
  root: string,
  matcher: (fullPath: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  async function walk(currentDir: string): Promise<void> {
    const entries = await fs
      .readdir(currentDir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && matcher(fullPath)) {
        found.push(fullPath);
      }
    }
  }
  if (existsSync(root)) {
    await walk(root);
  }
  return found;
}

async function findMacLauncher(): Promise<string | null> {
  const explicit = process.env.ELIZA_TEST_PACKAGED_LAUNCHER_PATH?.trim();
  if (explicit) {
    await fs.access(explicit);
    return await fs.realpath(explicit);
  }

  const candidates = [
    ...(await findFiles(electrobunBuildDir, (fullPath) =>
      fullPath.endsWith(
        `${path.sep}Contents${path.sep}MacOS${path.sep}launcher`,
      ),
    )),
    ...(await findFiles(electrobunArtifactsDir, (fullPath) =>
      fullPath.endsWith(
        `${path.sep}Contents${path.sep}MacOS${path.sep}launcher`,
      ),
    )),
  ];

  if (candidates.length === 0) {
    return null;
  }

  const withStats = await Promise.all(
    candidates.map(async (candidate) => ({
      path: candidate,
      stat: await fs.stat(candidate),
    })),
  );
  withStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return await fs.realpath(withStats[0].path);
}

async function findLinuxLauncher(): Promise<string | null> {
  const explicit = process.env.ELIZA_TEST_PACKAGED_LAUNCHER_PATH?.trim();
  if (explicit) {
    await fs.access(explicit);
    return await fs.realpath(explicit);
  }

  // The Linux Electrobun bundle places the launcher at `<App>/bin/launcher`.
  const candidates = [
    ...(await findFiles(electrobunBuildDir, (fullPath) =>
      fullPath.endsWith(`${path.sep}bin${path.sep}launcher`),
    )),
    ...(await findFiles(electrobunArtifactsDir, (fullPath) =>
      fullPath.endsWith(`${path.sep}bin${path.sep}launcher`),
    )),
  ];

  if (candidates.length === 0) {
    return null;
  }

  const withStats = await Promise.all(
    candidates.map(async (candidate) => ({
      path: candidate,
      stat: await fs.stat(candidate),
    })),
  );
  withStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return await fs.realpath(withStats[0].path);
}

async function findWindowsLauncherExe(dir: string): Promise<string | null> {
  const matches = await findFiles(
    dir,
    (fullPath) => path.basename(fullPath).toLowerCase() === "launcher.exe",
  );
  if (matches.length === 0) {
    return null;
  }
  const withStats = await Promise.all(
    matches.map(async (candidate) => ({
      path: candidate,
      stat: await fs.stat(candidate),
    })),
  );
  withStats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  return await fs.realpath(withStats[0].path);
}

async function resolveWindowsLauncher(tempExtractDir: string): Promise<string> {
  const explicit =
    process.env.ELIZA_TEST_PACKAGED_LAUNCHER_PATH?.trim() ||
    process.env.ELIZA_TEST_WINDOWS_LAUNCHER_PATH?.trim();
  if (explicit) {
    await fs.access(explicit);
    return await fs.realpath(explicit);
  }

  let launcher = await findWindowsLauncherExe(electrobunBuildDir);
  if (launcher) {
    return launcher;
  }

  launcher = await findWindowsLauncherExe(electrobunArtifactsDir);
  if (launcher) {
    return launcher;
  }

  const artifactEntries = await fs
    .readdir(electrobunArtifactsDir, { withFileTypes: true })
    .catch(() => []);
  const tarballs = artifactEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tar.zst"))
    .map((entry) => path.join(electrobunArtifactsDir, entry.name));
  if (tarballs.length === 0) {
    throw new Error(
      `No Windows packaged artifacts found in ${electrobunArtifactsDir}.`,
    );
  }

  const stats = await Promise.all(
    tarballs.map(async (candidate) => ({
      path: candidate,
      stat: await fs.stat(candidate),
    })),
  );
  stats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  const archivePath = await fs.realpath(stats[0].path);

  await fs.mkdir(tempExtractDir, { recursive: true });
  await execFileAsync("tar", [
    "--force-local",
    "-xf",
    archivePath,
    "-C",
    tempExtractDir,
  ]);

  launcher = await findWindowsLauncherExe(tempExtractDir);
  if (!launcher) {
    throw new Error(
      `Failed to find launcher.exe after extracting ${archivePath}.`,
    );
  }
  return launcher;
}

export async function resolvePackagedLauncher(
  tempExtractDir: string,
): Promise<string | null> {
  if (process.platform === "darwin") {
    return await findMacLauncher();
  }
  if (process.platform === "win32") {
    return await resolveWindowsLauncher(tempExtractDir);
  }
  if (process.platform === "linux") {
    return await findLinuxLauncher();
  }
  return null;
}

function pickTempPort(seed: number): number {
  return seed;
}

function buildMinimalMacEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const user =
    baseEnv.USER || baseEnv.LOGNAME || process.env.USER || process.env.LOGNAME;
  const lang = baseEnv.LANG || process.env.LANG || "en_US.UTF-8";
  const pathValue =
    baseEnv.PATH || process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";

  return {
    HOME: baseEnv.HOME || process.env.HOME,
    PATH: pathValue,
    SHELL: baseEnv.SHELL || process.env.SHELL || "/bin/zsh",
    USER: user,
    LOGNAME: user,
    TMPDIR: baseEnv.TMPDIR || process.env.TMPDIR || os.tmpdir(),
    LANG: lang,
    LC_ALL: baseEnv.LC_ALL || process.env.LC_ALL || lang,
    TERM: baseEnv.TERM || process.env.TERM || "dumb",
  };
}

function createPackagedDesktopEnv(args: {
  baseEnv: NodeJS.ProcessEnv;
  apiBase: string;
  stateDir: string;
  bridgePort: number;
  bridgeToken: string;
  partition?: string;
  appData?: string;
  localAppData?: string;
}): NodeJS.ProcessEnv {
  const partition = args.partition ?? "persist:packaged-regression";
  const commonEnv = {
    ELIZA_DESKTOP_TEST_API_BASE: args.apiBase,
    ELIZA_DESKTOP_TEST_PARTITION: partition,
    ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS: "1",
    ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
    ELIZA_DESKTOP_TEST_BRIDGE_ENABLED: "1",
    ELIZA_DESKTOP_TEST_BRIDGE_PORT: String(args.bridgePort),
    ELIZA_DESKTOP_TEST_BRIDGE_TOKEN: args.bridgeToken,
    ELIZA_STATE_DIR: args.stateDir,
    ELECTROBUN_CONSOLE: "1",
  };

  if (process.platform === "win32") {
    return {
      ...createPackagedWindowsAppEnv({
        baseEnv: args.baseEnv,
        apiBase: args.apiBase,
        appData: args.appData ?? args.stateDir,
        localAppData: args.localAppData ?? args.stateDir,
      }),
      ...commonEnv,
      APPDATA: args.appData ?? args.stateDir,
      LOCALAPPDATA: args.localAppData ?? args.stateDir,
    };
  }

  if (process.platform === "linux") {
    // Forward the X auth cookie (xvfb-run / a locked-down X server sets
    // XAUTHORITY) so the spawned WebKitGTK webview can authenticate to the
    // display. buildMinimalMacEnv is an allowlist that drops it; without it the
    // child dies with "Authorization required ... cannot open display" under
    // any headless X server (e.g. CI behind xvfb).
    const xauthority = args.baseEnv.XAUTHORITY || process.env.XAUTHORITY;
    return {
      ...buildMinimalMacEnv(args.baseEnv),
      ...commonEnv,
      // Linux Electrobun uses WebKitGTK; it needs a display and software GL so
      // the webview renders under a headless / GPU-less display (the bare GPU
      // path raises GLXBadWindow).
      DISPLAY: args.baseEnv.DISPLAY || process.env.DISPLAY || ":0",
      ...(xauthority ? { XAUTHORITY: xauthority } : {}),
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      // WebKitGTK's bubblewrap web/network-process sandbox aborts (SIGTRAP)
      // under restricted/headless environments (containers, CI behind xvfb)
      // where it cannot set up its namespaces — disable it so the webview's
      // child processes start. Honor an explicit opt-out from the caller.
      WEBKIT_DISABLE_SANDBOX:
        args.baseEnv.WEBKIT_DISABLE_SANDBOX ??
        process.env.WEBKIT_DISABLE_SANDBOX ??
        "1",
      LIBGL_ALWAYS_SOFTWARE: "1",
      GALLIUM_DRIVER: "llvmpipe",
    };
  }

  return {
    ...buildMinimalMacEnv(args.baseEnv),
    ...commonEnv,
  };
}

interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
}

const BRIDGE_REQUEST_TIMEOUT_MS = 5_000;

async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const {
    timeoutMs = BRIDGE_REQUEST_TIMEOUT_MS,
    signal,
    ...requestOptions
  } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort(signal?.reason);

  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...requestOptions,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `${options.method ?? "GET"} ${url} timed out after ${timeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!response.ok) {
    const responseText = (await response.text().catch(() => "")).trim();
    throw new Error(
      `${options.method ?? "GET"} ${url} failed (${response.status})${
        responseText ? `: ${responseText.slice(0, 400)}` : ""
      }`,
    );
  }
  return (await response.json()) as T;
}

function formatLogs(logs: PackagedProcessLogs | null | undefined): string {
  return [
    "App stdout:",
    logs?.stdout.join("") ?? "",
    "",
    "App stderr:",
    logs?.stderr.join("") ?? "",
  ].join("\n");
}

function normalizeEvalScript(script: string): string {
  const trimmed = script.trim();
  if (!trimmed) {
    return script;
  }
  if (/^return\b/.test(trimmed)) {
    return trimmed;
  }
  // Electrobun evaluates this as Function(script)(), so expression scripts need
  // an explicit top-level return to preserve their resolved value.
  return `return (\n${trimmed}\n);`;
}

async function seedPackagedTestFirstPartyRemoteState(
  stateDir: string,
): Promise<void> {
  if (process.env.ELIZA_TEST_ENABLE_LOCAL_MODEL_REMOTE === "1") {
    return;
  }

  const statePath = path.join(
    stateDir,
    "remote-plugins",
    "first-party-remotes.json",
  );
  let disabled: Record<string, boolean> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { disabled?: unknown }).disabled === "object" &&
      (parsed as { disabled?: unknown }).disabled !== null &&
      !Array.isArray((parsed as { disabled?: unknown }).disabled)
    ) {
      disabled = {
        ...((parsed as { disabled: Record<string, boolean> }).disabled ?? {}),
      };
    }
  } catch {
    // Fresh packaged test state has no first-party remote state file yet.
  }

  for (const id of PACKAGED_TEST_DISABLED_FIRST_PARTY_REMOTES) {
    disabled[id] = true;
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify({ version: 1, disabled }, null, 2)}\n`,
    "utf8",
  );
}

async function findBridgeListenerPids(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-tiTCP:${port}`,
      "-sTCP:LISTEN",
    ]);
    return stdout
      .trim()
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function getParentPid(pid: number): Promise<number | null> {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "ppid=",
      "-p",
      String(pid),
    ]);
    const parentPid = Number(stdout.trim());
    return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null;
  } catch {
    return null;
  }
}

export class PackagedDesktopHarness {
  readonly tempRoot: string;
  readonly stateDir: string;
  readonly appDataDir: string;
  readonly localAppDataDir: string;
  bridgePort: number;
  readonly bridgeToken: string;
  bridgeUrl: string;
  readonly launcherPath: string;
  readonly apiBase: string;
  readonly partition: string;
  appEnv: NodeJS.ProcessEnv;
  process: ChildProcess | null = null;
  logs: PackagedProcessLogs | null = null;

  constructor(args: {
    tempRoot: string;
    launcherPath: string;
    apiBase: string;
    /** Extra env vars layered onto the launch env (e.g. desktop shell flags). */
    extraEnv?: NodeJS.ProcessEnv;
  }) {
    this.tempRoot = args.tempRoot;
    this.stateDir = path.join(args.tempRoot, "state");
    this.appDataDir = path.join(args.tempRoot, "appdata");
    this.localAppDataDir = path.join(args.tempRoot, "localappdata");
    this.bridgePort = pickTempPort(31_500 + Math.floor(Math.random() * 500));
    this.bridgeToken = randomUUID();
    this.bridgeUrl = `http://127.0.0.1:${this.bridgePort}`;
    this.launcherPath = args.launcherPath;
    this.apiBase = args.apiBase;
    this.partition = `persist:packaged-regression-${randomUUID()}`;
    this.appEnv = createPackagedDesktopEnv({
      baseEnv: process.env,
      apiBase: args.apiBase,
      stateDir: this.stateDir,
      bridgePort: this.bridgePort,
      bridgeToken: this.bridgeToken,
      partition: this.partition,
      appData: this.appDataDir,
      localAppData: this.localAppDataDir,
    });
    if (args.extraEnv) {
      this.appEnv = { ...this.appEnv, ...args.extraEnv };
    }
  }

  async start(options: PackagedStartOptions = {}): Promise<void> {
    const bridgeHealthTimeoutMs = options.bridgeHealthTimeoutMs ?? 300_000;
    const shellReadyTimeoutMs = options.shellReadyTimeoutMs ?? 60_000;

    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.mkdir(this.appDataDir, { recursive: true });
    await fs.mkdir(this.localAppDataDir, { recursive: true });
    await seedPackagedTestFirstPartyRemoteState(this.stateDir);

    const useDedicatedXvfb =
      process.platform === "linux" &&
      process.env.ELIZA_ELECTROBUN_PACKAGED_USE_CURRENT_DISPLAY !== "1";
    const xvfbRun = useDedicatedXvfb
      ? resolveExecutableOnPath("xvfb-run")
      : null;
    const launchCommand = xvfbRun ?? this.launcherPath;
    const launchArgs = xvfbRun ? ["-a", this.launcherPath] : [];

    const child = spawn(launchCommand, launchArgs, {
      cwd: path.dirname(this.launcherPath),
      env: this.appEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.logs = collectProcessLogs(child);

    await this.waitForBridgeHealth(bridgeHealthTimeoutMs);
    await this.waitForState(
      (state) => state.mainWindow.present && state.shell.trayPresent,
      "Expected packaged desktop shell to create the main window and tray",
      shellReadyTimeoutMs,
    );
  }

  async stop(): Promise<void> {
    await this.requestGracefulQuit().catch(() => undefined);
    const pidsToKill = new Set<number>();
    if (await this.waitForBridgeExit(PACKAGED_GRACEFUL_QUIT_TIMEOUT_MS)) {
      if (await this.waitForChildExit(5_000)) {
        await waitAfterPackagedProcessExit();
        return;
      }
      // The bridge listener can disappear before the launcher/native child has
      // fully unwound. Do not report a clean stop in that half-exited state.
      // Fall through to the same SIGTERM/SIGKILL cleanup path used when the
      // bridge itself stays alive.
    } else {
      const bridgePids = await findBridgeListenerPids(this.bridgePort);
      for (const pid of bridgePids) {
        pidsToKill.add(pid);
        const parentPid = await getParentPid(pid);
        if (parentPid) {
          pidsToKill.add(parentPid);
        }
      }
    }

    const child = this.process;
    if (child?.pid && child.exitCode === null && !child.killed) {
      pidsToKill.add(child.pid);
    }

    if (pidsToKill.size === 0) {
      return;
    }

    for (const pid of pidsToKill) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process already exited.
      }
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        for (const pid of pidsToKill) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Process already exited.
          }
        }
        resolve();
      }, 5_000);
      const checkExited = async () => {
        if ((await findBridgeListenerPids(this.bridgePort)).length === 0) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        setTimeout(checkExited, 250);
      };
      void checkExited();
    });
    await this.waitForChildExit(1_000);
    await waitAfterPackagedProcessExit();
  }

  private async requestGracefulQuit(): Promise<void> {
    await fetchJson<{ ok: boolean }>(`${this.bridgeUrl}/app/quit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 2_000,
    });
  }

  private async waitForBridgeExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await findBridgeListenerPids(this.bridgePort)).length === 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  private async waitForChildExit(timeoutMs: number): Promise<boolean> {
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  async relaunch(options: PackagedStartOptions = {}): Promise<void> {
    // Trigger an empty eval to give WKWebView a chance to flush localStorage
    // to disk before the process is killed. Without this, SIGKILL after the
    // 5-second grace period can prevent the WebKit persistence layer from
    // writing seeded state, leaving localStorage empty on the next launch.
    await this.eval<unknown>(`void 0`).catch(() => undefined);

    await this.stop();
    this.process = null;
    this.logs = null;

    // Pick a fresh bridge port to avoid TIME_WAIT conflicts from the
    // previous process's listener socket.
    this.bridgePort = pickTempPort(31_500 + Math.floor(Math.random() * 500));
    this.bridgeUrl = `http://127.0.0.1:${this.bridgePort}`;
    this.appEnv = createPackagedDesktopEnv({
      baseEnv: process.env,
      apiBase: this.apiBase,
      stateDir: this.stateDir,
      bridgePort: this.bridgePort,
      bridgeToken: this.bridgeToken,
      partition: this.partition,
      appData: this.appDataDir,
      localAppData: this.localAppDataDir,
    });

    // Short delay to let the OS release the old process's resources (ports,
    // file handles, WebKit caches) before spawning the next instance.
    await delay(PACKAGED_RELAUNCH_DELAY_MS);

    await this.start(options);
  }

  private async waitForBridgeHealth(timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    let detachedLaunchStartedAt: number | null = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        await fetchJson<{ ok: boolean }>(`${this.bridgeUrl}/health`, {
          headers: { Authorization: `Bearer ${this.bridgeToken}` },
        });
        return;
      } catch {
        if (this.process && this.process.exitCode !== null) {
          if (process.platform !== "darwin") {
            throw new Error(
              `Packaged app exited before the desktop test bridge became ready.\n${formatLogs(this.logs)}`,
            );
          }
          detachedLaunchStartedAt ??= Date.now();
          if (Date.now() - detachedLaunchStartedAt > 60_000) {
            throw new Error(
              `Packaged app self-extractor exited, but no detached desktop test bridge became ready.\n${formatLogs(this.logs)}`,
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    throw new Error(
      `Timed out waiting for ${this.bridgeUrl}/health.\n${formatLogs(this.logs)}`,
    );
  }

  async getState(): Promise<DesktopTestBridgeState> {
    return await fetchJson<DesktopTestBridgeState>(`${this.bridgeUrl}/state`, {
      headers: { Authorization: `Bearer ${this.bridgeToken}` },
    });
  }

  async setMainWindowBounds(
    bounds: Partial<DesktopWindowBounds>,
  ): Promise<DesktopWindowBounds> {
    const response = await fetchJson<{ bounds: DesktopWindowBounds }>(
      `${this.bridgeUrl}/main-window/bounds`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.bridgeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bounds),
      },
    );
    return response.bounds;
  }

  async closeMainWindow(): Promise<void> {
    await fetchJson<{ ok: boolean }>(`${this.bridgeUrl}/main-window/close`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async showMainWindow(): Promise<void> {
    await fetchJson<{ ok: boolean }>(`${this.bridgeUrl}/main-window/show`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async focusMainWindow(): Promise<void> {
    await fetchJson<{ ok: boolean }>(`${this.bridgeUrl}/main-window/focus`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async waitForState(
    predicate: (state: DesktopTestBridgeState) => boolean,
    message: string,
    timeoutMs = 30_000,
  ): Promise<DesktopTestBridgeState> {
    const startedAt = Date.now();
    let lastState: DesktopTestBridgeState | null = null;
    let lastError: Error | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      if (
        this.process &&
        this.process.exitCode !== null &&
        (await findBridgeListenerPids(this.bridgePort)).length === 0
      ) {
        throw new Error(
          `${message}\nPackaged app exited early.\n${formatLogs(this.logs)}`,
        );
      }
      try {
        lastState = await this.getState();
        lastError = null;
        if (predicate(lastState)) {
          return lastState;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      `${message}\nLast state:\n${JSON.stringify(lastState, null, 2)}${
        lastError ? `\nLast bridge error: ${lastError.message}` : ""
      }\n${formatLogs(this.logs)}`,
    );
  }

  async eval<T>(script: string): Promise<T> {
    const startedAt = Date.now();
    let lastError: Error | null = null;
    const normalizedScript = normalizeEvalScript(script);

    while (Date.now() - startedAt < 30_000) {
      try {
        const response = await fetchJson<{ result: T }>(
          `${this.bridgeUrl}/main-window/eval`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.bridgeToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ script: normalizedScript }),
          },
        );
        return response.result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("/main-window/eval failed (500)")) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    throw (
      lastError ??
      new Error("Timed out waiting for main-window/eval to become ready")
    );
  }

  async screenshot(timeoutMs = 10_000): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchJson<{ data: string }>(
        `${this.bridgeUrl}/main-window/screenshot`,
        {
          headers: { Authorization: `Bearer ${this.bridgeToken}` },
          signal: controller.signal,
          timeoutMs,
        },
      );
      return response.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Timed out capturing packaged screenshot after ${timeoutMs}ms or the bridge failed.\n${message}\n${formatLogs(this.logs)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async menuAction(action: string): Promise<void> {
    await fetchJson<{ ok: boolean }>(`${this.bridgeUrl}/menu-action`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action }),
    });
  }

  async toggleTrayPopover(): Promise<
    NonNullable<DesktopTestBridgeState["shell"]["trayPopover"]>
  > {
    const response = await fetchJson<{
      ok: boolean;
      trayPopover: NonNullable<DesktopTestBridgeState["shell"]["trayPopover"]>;
    }>(`${this.bridgeUrl}/tray/popover/toggle`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
        "Content-Type": "application/json",
      },
    });
    return response.trayPopover;
  }

  async pressShortcut(id: string): Promise<void> {
    await fetchJson<{ ok: boolean }>(`${this.bridgeUrl}/shortcut/press`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id }),
    });
  }
}
