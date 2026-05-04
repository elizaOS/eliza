import { afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { delimiter } from "node:path";
import type { Subprocess } from "bun";

const EXPLICIT_TEST_BASE_URL = process.env.TEST_BASE_URL;
const TEST_SERVER_PORT = process.env.TEST_SERVER_PORT || "8787";
const SERVER_URL = EXPLICIT_TEST_BASE_URL || `http://localhost:${TEST_SERVER_PORT}`;
process.env.TEST_BASE_URL = SERVER_URL;
const REUSE_EXISTING_SERVER =
  process.env.TEST_REUSE_SERVER === "1" || typeof EXPLICIT_TEST_BASE_URL === "string";
const TEST_SERVER_STATE_DIR =
  process.env.TEST_SERVER_STATE_DIR ||
  process.env.TEST_SERVER_DIST_DIR ||
  `.cloud-e2e-test-${TEST_SERVER_PORT}`;
const HEALTH_ENDPOINT = `${SERVER_URL}/api/health`;
const STARTUP_TIMEOUT_MS = 120_000;
const HEALTHCHECK_TIMEOUT_MS = 10_000;
const WARMUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const MANAGED_FETCH_RETRIES = 4;
const TEST_SERVER_SCRIPT = process.env.TEST_SERVER_SCRIPT || "dev:api";
const baseFetch: typeof fetch = globalThis.fetch;
const forwardBasePreconnect: NonNullable<typeof baseFetch.preconnect> = (...args) => {
  if (typeof baseFetch.preconnect === "function") {
    baseFetch.preconnect(...args);
  }
};

let serverProcess: Subprocess | null = null;
let startedServer = false;
let serverStartupPromise: Promise<void> | null = null;
let serverExitError: Error | null = null;
let detectedPeerServerStartup = false;
let serverProcessPids = new Set<number>();

function getSubprocessPid(proc: Subprocess | null | undefined): number | null {
  const pid = proc?.pid;
  return typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : null;
}

function getDescendantPids(parentPid: number): number[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
      continue;
    }
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  const descendants: number[] = [];
  const stack = [...(childrenByParent.get(parentPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    descendants.push(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }

  return descendants;
}

function killProcessTree(rootPid: number, signal: NodeJS.Signals | number): void {
  const pids = [
    ...new Set([...serverProcessPids, ...getDescendantPids(rootPid), rootPid].reverse()),
  ];

  try {
    process.kill(-rootPid, signal);
  } catch {
    // Some Bun child process trees are not in a process group named after the root PID.
  }

  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function rememberServerProcessTree(proc: Subprocess | null | undefined): void {
  const pid = getSubprocessPid(proc);
  if (pid === null) {
    return;
  }

  serverProcessPids = new Set([pid, ...getDescendantPids(pid)]);
}

function cleanupTestServerDistDir(): void {
  try {
    rmSync(TEST_SERVER_STATE_DIR, { force: true, recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[E2E Server] Failed to clean ${TEST_SERVER_STATE_DIR}: ${message}`);
  }
}

function getBunExecutable(): string {
  const execPath = process.execPath?.trim();
  if (execPath && execPath.length > 0) {
    return execPath;
  }

  throw new Error("Bun executable path is unavailable in the current test runtime");
}

function extendPathWithExecutableDirectory(
  envPath: string | undefined,
  executablePath: string,
): string {
  const executableDir = executablePath.slice(0, Math.max(executablePath.lastIndexOf("/"), 0));
  if (executableDir.length === 0) {
    return envPath ?? "";
  }

  if (!envPath || envPath.length === 0) {
    return executableDir;
  }

  const segments = envPath.split(delimiter);
  if (segments.includes(executableDir)) {
    return envPath;
  }

  return `${executableDir}${delimiter}${envPath}`;
}

async function isServerRunning(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);

  try {
    const response = await baseFetch(HEALTH_ENDPOINT, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForServer(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (serverExitError) {
      throw serverExitError;
    }
    if (await isServerRunning()) {
      return;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Server failed to start within ${timeoutMs / 1000}s`);
}

async function warmServerRoutes(): Promise<void> {
  const testApiKey = process.env.TEST_API_KEY?.trim();
  const warmups: Array<{ path: string; init?: RequestInit }> = [
    { path: "/api/health" },
    ...(testApiKey
      ? [
          {
            path: "/api/test/auth/session",
            init: {
              method: "POST",
              headers: {
                Authorization: `Bearer ${testApiKey}`,
                "X-API-Key": testApiKey,
                "Content-Type": "application/json",
              },
            },
          },
        ]
      : []),
  ];

  for (const warmup of warmups) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);

    try {
      await baseFetch(`${SERVER_URL}${warmup.path}`, {
        ...warmup.init,
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[E2E Server] Warmup failed for ${warmup.path}: ${message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function pipeServerLogs(
  stream: ReadableStream<Uint8Array> | null,
  label: "stdout" | "stderr",
): void {
  if (!stream) return;

  const reader = stream.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value).trim();
        if (
          text.length > 0 &&
          (label === "stderr" ||
            text.includes("Ready") ||
            text.includes("Local:") ||
            text.includes("Error"))
        ) {
          if (
            label === "stderr" &&
            (text.includes("Unable to acquire lock") || text.includes("EADDRINUSE"))
          ) {
            detectedPeerServerStartup = true;
          }
          console.log(`[E2E Server:${label}] ${text}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("closed")) {
        console.warn(`[E2E Server:${label}] log stream ended unexpectedly: ${message}`);
      }
    }
  })();
}

function watchServerExit(proc: Subprocess): void {
  void proc.exited.then(async (code) => {
    if (serverProcess !== proc) {
      return;
    }

    const pid = getSubprocessPid(proc);
    if (pid !== null) {
      killProcessTree(pid, "SIGKILL");
    }
    serverProcess = null;
    serverProcessPids = new Set();
    if (!startedServer) {
      return;
    }

    if (code !== 0 && code !== 15) {
      await Bun.sleep(250);
      if (detectedPeerServerStartup || (await isServerRunning())) {
        console.warn("[E2E Server] Detected another worker-owned dev server; waiting for health");
        return;
      }
      serverExitError = new Error(`E2E server exited with code ${code}`);
      console.error(`[E2E Server] ${serverExitError.message}`);
    }
  });
}

function isPortAvailable(port: number): boolean {
  try {
    const server = Bun.serve({ port, fetch: () => new Response("") });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function waitForPortRelease(port: number, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isPortAvailable(port)) {
      return true;
    }
    await Bun.sleep(250);
  }
  return false;
}

async function stopServer(): Promise<void> {
  const proc = serverProcess;
  rememberServerProcessTree(proc);
  serverProcess = null;
  startedServer = false;
  serverStartupPromise = null;
  serverExitError = null;
  detectedPeerServerStartup = false;

  const pid = getSubprocessPid(proc);
  if (proc && pid !== null) {
    killProcessTree(pid, "SIGTERM");

    try {
      await Promise.race([proc.exited, Bun.sleep(2_000)]);
    } catch {
      // ignore
    }

    killProcessTree(pid, "SIGKILL");

    try {
      await Promise.race([proc.exited, Bun.sleep(5_000)]);
    } catch {
      // ignore
    }
  }
  serverProcessPids = new Set();

  // Always wait for the port to be released, even without a process —
  // something else may still hold the port.
  if (await waitForPortRelease(Number(TEST_SERVER_PORT))) {
    cleanupTestServerDistDir();
  }
}

export async function ensureServer(): Promise<void> {
  if (await isServerRunning()) {
    if (!serverProcess && !REUSE_EXISTING_SERVER) {
      const released = await waitForPortRelease(Number(TEST_SERVER_PORT), STARTUP_TIMEOUT_MS);
      if (released) {
        cleanupTestServerDistDir();
      } else {
        throw new Error(
          `Port ${TEST_SERVER_PORT} is occupied by an unmanaged server; set TEST_REUSE_SERVER=1 or TEST_BASE_URL to reuse it.`,
        );
      }
    } else {
      // Server is already responding to health checks — clear any stale error.
      serverExitError = null;
      await warmServerRoutes();
      return;
    }
  }

  if (await isServerRunning()) {
    // Server is already responding to health checks — clear any stale error.
    serverExitError = null;
    await warmServerRoutes();
    return;
  }

  if (serverStartupPromise) {
    await serverStartupPromise;
    return;
  }

  serverStartupPromise = (async () => {
    if (await isServerRunning()) {
      serverExitError = null;
      return;
    }

    // If a previous server process is lingering, clean it up first.
    if (serverProcess || serverExitError) {
      await stopServer();
    }

    const portIsFree = await waitForPortRelease(Number(TEST_SERVER_PORT));
    if (!portIsFree) {
      if (REUSE_EXISTING_SERVER) {
        detectedPeerServerStartup = true;
        console.warn("[E2E Server] Port is occupied; waiting for existing server health");
        await waitForServer(STARTUP_TIMEOUT_MS);
        serverExitError = null;
        return;
      }

      throw new Error(
        `Port ${TEST_SERVER_PORT} is occupied by an unmanaged server; set TEST_REUSE_SERVER=1 or TEST_BASE_URL to reuse it.`,
      );
    }

    cleanupTestServerDistDir();

    startedServer = true;
    serverExitError = null;
    detectedPeerServerStartup = false;
    const bunExecutable = getBunExecutable();
    serverProcess = Bun.spawn([bunExecutable, "run", TEST_SERVER_SCRIPT], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "development",
        PORT: TEST_SERVER_PORT,
        RATE_LIMIT_MULTIPLIER: process.env.RATE_LIMIT_MULTIPLIER || "100",
        PATH: extendPathWithExecutableDirectory(process.env.PATH, bunExecutable),
      },
    });

    pipeServerLogs(
      serverProcess.stdout instanceof ReadableStream ? serverProcess.stdout : null,
      "stdout",
    );
    pipeServerLogs(
      serverProcess.stderr instanceof ReadableStream ? serverProcess.stderr : null,
      "stderr",
    );
    rememberServerProcessTree(serverProcess);
    watchServerExit(serverProcess);

    try {
      await waitForServer(STARTUP_TIMEOUT_MS);
      await warmServerRoutes();
      rememberServerProcessTree(serverProcess);
    } catch (error) {
      await stopServer();
      throw error;
    }
  })();

  try {
    await serverStartupPromise;
  } finally {
    serverStartupPromise = null;
  }
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function createRequestFactory(
  input: RequestInfo | URL,
  init?: RequestInit,
): () => [RequestInfo | URL, RequestInit | undefined] {
  if (input instanceof Request) {
    return () => [input.clone(), init];
  }

  return () => [input, init];
}

function isRecoverableServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ConnectionRefused") ||
    message.includes("Unable to connect") ||
    message.includes("ECONNRESET") ||
    message.includes("socket connection was closed unexpectedly") ||
    message.includes("E2E server exited with code")
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

async function isRecoverableManagedFetchError(error: unknown): Promise<boolean> {
  if (isRecoverableServerError(error)) {
    return true;
  }

  if (!isTimeoutError(error)) {
    return false;
  }

  return !(await isServerRunning());
}

const fetchWithServer: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = getRequestUrl(input);
    const isManagedRequest = requestUrl.startsWith(SERVER_URL);

    if (!isManagedRequest) {
      return await baseFetch(input, init);
    }

    const nextRequest = createRequestFactory(input, init);

    for (let attempt = 0; attempt < MANAGED_FETCH_RETRIES; attempt += 1) {
      const isLastAttempt = attempt === MANAGED_FETCH_RETRIES - 1;
      try {
        await ensureServer();

        const [requestInput, requestInit] = nextRequest();
        const response = await baseFetch(requestInput, requestInit);
        if (response.status >= 500 && !isLastAttempt && !(await isServerRunning())) {
          await response.body?.cancel();
          await Bun.sleep(POLL_INTERVAL_MS * (attempt + 1));
          continue;
        }

        return response;
      } catch (error) {
        if (!(await isRecoverableManagedFetchError(error)) || isLastAttempt) {
          throw error;
        }

        await Bun.sleep(POLL_INTERVAL_MS * (attempt + 1));
      }
    }

    throw new Error("Managed fetch exhausted all retry attempts");
  },
  { preconnect: forwardBasePreconnect },
);

globalThis.fetch = fetchWithServer;

afterAll(async () => {
  await stopServer();
});

process.on("exit", () => {
  // Sync-only: forcefully kill the server process if still running
  if (serverProcess) {
    killProcessTree(serverProcess.pid, "SIGKILL");
  }
  cleanupTestServerDistDir();
});
process.on("SIGINT", () => {
  void stopServer().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void stopServer().finally(() => process.exit(0));
});

export const serverReady = ensureServer();

await serverReady;

export const serverUrl = SERVER_URL;
