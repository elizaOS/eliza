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

  return {
    ...buildMinimalMacEnv(args.baseEnv),
    ...commonEnv,
  };
}

async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, options);
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
  }

  async start(options: PackagedStartOptions = {}): Promise<void> {
    const bridgeHealthTimeoutMs = options.bridgeHealthTimeoutMs ?? 300_000;
    const shellReadyTimeoutMs = options.shellReadyTimeoutMs ?? 60_000;

    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.mkdir(this.appDataDir, { recursive: true });
    await fs.mkdir(this.localAppDataDir, { recursive: true });

    const child = spawn(this.launcherPath, [], {
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
    const pidsToKill = new Set<number>();
    for (const pid of await findBridgeListenerPids(this.bridgePort)) {
      pidsToKill.add(pid);
      const parentPid = await getParentPid(pid);
      if (parentPid) {
        pidsToKill.add(parentPid);
      }
    }

    const child = this.process;
    if (child?.pid && child.exitCode === null && !child.killed) {
      pidsToKill.add(child.pid);
    }

    for (const pid of pidsToKill) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process already exited.
      }
    }

    if (pidsToKill.size === 0) {
      return;
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
  }

  async relaunch(options: PackagedStartOptions = {}): Promise<void> {
    // Trigger a no-op eval to give WKWebView a chance to flush localStorage
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
    await new Promise((resolve) => setTimeout(resolve, 1_000));

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

  async waitForState(
    predicate: (state: DesktopTestBridgeState) => boolean,
    message: string,
    timeoutMs = 30_000,
  ): Promise<DesktopTestBridgeState> {
    const startedAt = Date.now();
    let lastState: DesktopTestBridgeState | null = null;

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
      lastState = await this.getState();
      if (predicate(lastState)) {
        return lastState;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      `${message}\nLast state:\n${JSON.stringify(lastState, null, 2)}\n${formatLogs(this.logs)}`,
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
}
