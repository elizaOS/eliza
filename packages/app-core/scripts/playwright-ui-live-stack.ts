/** Supports app-core build, packaging, or development orchestration for playwright ui live stack ts. */
import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { buildFirstRunRuntimeConfig } from "../src/first-run/first-run-config.ts";
import { createLiveRuntimeChildEnv } from "../test/helpers/live-child-env.ts";
import {
  getFirstRunProviderForLiveProvider,
  selectLiveProviderAsync,
} from "../test/helpers/live-provider.ts";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { shouldForceStubStack } from "./lib/ui-smoke-stub-decision.mjs";
import { viteRendererBuildNeeded } from "./lib/vite-renderer-dist-stale.mjs";
import {
  clearPendingWebSocketQueue,
  createPendingWebSocketQueueState,
  DEFAULT_PENDING_WEBSOCKET_QUEUE_LIMITS,
  drainPendingWebSocketQueue,
  enqueuePendingWebSocketMessage,
  type WebSocketSendData,
} from "./lib/websocket-pending-queue.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const CLEANUP_HELPER_SCRIPT = path.join(
  REPO_ROOT,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const APP_DIR = resolveMainAppDir(REPO_ROOT, "app");
const APP_DIST_DIR = path.join(APP_DIR, "dist");
const COMPANION_PUBLIC_DIR = path.join(
  REPO_ROOT,
  "plugins",
  "app-companion",
  "public",
);
const UI_SMOKE_STUB_SCRIPT = path.join(
  import.meta.dirname,
  "playwright-ui-smoke-api-stub.mjs",
);
const READY_TIMEOUT_MS = 180_000;
const API_PORT = Number(process.env.ELIZA_UI_SMOKE_API_PORT ?? "31337");
const UI_PORT = Number(process.env.ELIZA_UI_SMOKE_PORT ?? "2138");
const UI_SMOKE_RUN_ID = process.env.ELIZA_UI_SMOKE_RUN_ID?.trim() ?? "";
const LIVE_PROVIDER = await selectLiveProviderAsync();
// Precedence (force-stub > live opt-in > CI default) lives in one tested helper.
// The key behavior: ELIZA_UI_SMOKE_LIVE_STACK=1 overrides the CI-based stub force
// so a genuinely-real lane is possible (GitHub Actions always sets CI=true, which
// would otherwise re-force the stub even when a provider key was supplied).
const FORCE_STUB_STACK = shouldForceStubStack(process.env);
const LIVE_STACK_OPTIONAL_VIEW_PLUGIN_ENTRIES = [
  "calendar",
  "inbox",
  "todos",
  "wallet-ui",
] as const;
// Extra optional plugin entry ids (comma-separated, e.g. "personal-assistant")
// seeded as `{ enabled: true }` into the live-stack eliza.json alongside the
// default view set. Opt-in via ELIZA_UI_SMOKE_PLUGIN_ENTRIES: specs that need a
// plugin outside the default view set set it alongside ELIZA_UI_SMOKE_LIVE_STACK=1
// (e.g. the scheduled-reminder live spec enables @elizaos/plugin-personal-assistant
// so the LifeOps scheduler tick drives the ScheduledTask runner and its in_app
// notification dispatch). The plugin must already be resolvable/built. Ignored by
// the stub stack.
const LIVE_STACK_EXTRA_PLUGIN_ENTRIES: readonly string[] = (
  process.env.ELIZA_UI_SMOKE_PLUGIN_ENTRIES ?? ""
)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const LIVE_STACK_OPTIONAL_VIEW_PLUGIN_PACKAGES: ReadonlyArray<{
  id: (typeof LIVE_STACK_OPTIONAL_VIEW_PLUGIN_ENTRIES)[number];
  dir: string;
  requiredBuildOutputs: readonly string[];
}> = [
  {
    id: "calendar",
    dir: "plugin-calendar",
    requiredBuildOutputs: [
      "dist/index.js",
      "dist/plugin.js",
      "dist/views/bundle.js",
    ],
  },
  {
    id: "inbox",
    dir: "plugin-inbox",
    requiredBuildOutputs: [
      "dist/index.js",
      "dist/plugin.js",
      "dist/views/bundle.js",
    ],
  },
  {
    id: "todos",
    dir: "plugin-todos",
    requiredBuildOutputs: ["dist/index.js", "dist/views/bundle.js"],
  },
  {
    id: "wallet-ui",
    dir: "plugin-wallet-ui",
    requiredBuildOutputs: ["dist/index.js", "dist/views/bundle.js"],
  },
];
const pendingStateDirs = new Set<string>();
const ownedStateDirs = new Set<string>();

type StartedStack = {
  apiBase: string;
  apiChild: ChildProcessWithoutNullStreams;
  stateDir: string;
  uiBase: string;
  uiServer: Server;
};

async function createStateDir(prefix: string): Promise<string> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  pendingStateDirs.add(stateDir);
  if (UI_SMOKE_RUN_ID) {
    await writeFile(
      path.join(stateDir, ".eliza-ui-smoke-run-id"),
      `${UI_SMOKE_RUN_ID}\n`,
      "utf8",
    );
  }
  return stateDir;
}

function markStateDirOwnedByStack(stateDir: string): void {
  pendingStateDirs.delete(stateDir);
  ownedStateDirs.add(stateDir);
}

async function removePathRecursive(targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [CLEANUP_HELPER_SCRIPT, targetPath], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`rm-path-recursive exited due to signal ${signal}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        reject(
          new Error(
            `rm-path-recursive failed for ${targetPath} with status ${
              code ?? 1
            }`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

async function cleanupPendingStateDirs(): Promise<void> {
  const stateDirs = Array.from(pendingStateDirs);
  pendingStateDirs.clear();
  await Promise.all(stateDirs.map(removePathRecursive));
}

function cleanupKnownStateDirsSync(): void {
  const stateDirs = new Set([...pendingStateDirs, ...ownedStateDirs]);
  pendingStateDirs.clear();
  ownedStateDirs.clear();
  for (const stateDir of stateDirs) {
    try {
      execFileSync(process.execPath, [CLEANUP_HELPER_SCRIPT, stateDir], {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
    } catch {
      // Best effort during process teardown.
    }
  }
}

function resolveBunCommand(): string {
  const bunFromEnv = process.env.BUN?.trim();
  if (bunFromEnv) {
    if (existsSync(bunFromEnv)) {
      return bunFromEnv;
    }
    const bunEnvFromPath = resolveExecutableFromPath(bunFromEnv);
    if (bunEnvFromPath) {
      return bunEnvFromPath;
    }
  }

  const bunInstallRoot = process.env.BUN_INSTALL?.trim();
  if (bunInstallRoot) {
    const bunFromInstall = path.join(
      bunInstallRoot,
      "bin",
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    if (existsSync(bunFromInstall)) {
      return bunFromInstall;
    }
  }

  const homeBun = path.join(
    os.homedir(),
    ".bun",
    "bin",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  if (existsSync(homeBun)) {
    return homeBun;
  }

  const bunFromPath = resolveExecutableFromPath("bun");
  if (bunFromPath) {
    return bunFromPath;
  }

  return process.platform === "win32" ? "bun.exe" : "bun";
}

/**
 * NODE_OPTIONS with the `--conditions=eliza-source` token removed, for build
 * subprocesses that must resolve workspace packages through their normal
 * (dist/browser) exports rather than source.
 *
 * The Playwright runner exports `NODE_OPTIONS=--conditions=eliza-source` so its
 * spec collector resolves app-core/agent source on a fresh `--ignore-scripts`
 * install (run-ui-playwright.mjs, #15764). That condition must NOT reach the
 * Vite renderer build: `node vite.js build` loads `vite.config.ts` under node's
 * native ESM/type-stripping loader, which — unlike tsx — does not rewrite
 * `.js`→`.ts` import specifiers. Under `eliza-source` a package like
 * `@elizaos/cloud-routing` resolves to `src/index.ts`, whose internal
 * `import "./features.js"` has no on-disk match, and the whole build dies at
 * config load (#15759). The renderer build resolves those packages via Vite's
 * own bundler/aliases and their built dist, so it never needs the condition.
 */
function nodeOptionsWithoutElizaSource(): string {
  const tokens = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token, index) => {
    if (token === "--conditions=eliza-source") return false;
    // Also handle the space-separated `--conditions eliza-source` form.
    if (token === "--conditions" && tokens[index + 1] === "eliza-source") {
      return false;
    }
    if (token === "eliza-source" && tokens[index - 1] === "--conditions") {
      return false;
    }
    return true;
  });
  return kept.join(" ");
}

function resolveExecutableFromPath(command: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  if (!pathValue) return null;

  const hasExtension = path.extname(command).length > 0;
  const pathExts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim())
          .filter(Boolean)
      : [""];
  const binaryNames =
    process.platform === "win32" && !hasExtension
      ? pathExts.map((ext) => `${command}${ext.toLowerCase()}`)
      : [command];

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const binaryName of binaryNames) {
      const candidate = path.join(dir, binaryName);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function resolveDistAssetPath(
  requestedPath: string,
  distDir: string,
): string | null {
  const normalizedPath = requestedPath.replace(/^\/+/, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const candidatePath = path.resolve(
      distDir,
      segments.slice(index).join("/"),
    );
    if (
      candidatePath.startsWith(distDir) &&
      existsSync(candidatePath) &&
      path.extname(candidatePath).length > 0
    ) {
      return candidatePath;
    }
  }
  return null;
}

function resolveCompanionPublicAssetPath(requestedPath: string): string | null {
  const normalizedPath = requestedPath.replace(/^\/+/, "");
  if (
    !normalizedPath.startsWith("animations/") &&
    !normalizedPath.startsWith("vrm-decoders/") &&
    !normalizedPath.startsWith("vrms/")
  ) {
    return null;
  }

  const candidatePath = path.resolve(COMPANION_PUBLIC_DIR, normalizedPath);
  if (
    candidatePath.startsWith(COMPANION_PUBLIC_DIR) &&
    existsSync(candidatePath) &&
    path.extname(candidatePath).length > 0
  ) {
    return candidatePath;
  }
  return null;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Proxy the request to the API, retrying the transient undici keep-alive race
 * (`UND_ERR_SOCKET: other side closed` → `TypeError: fetch failed`). The node
 * HTTP API server closes idle keep-alive connections on its own timeout; under
 * the app's concurrent boot fan-out undici reuses a socket the server just
 * closed and the fetch throws before the request is ever sent — so retrying on
 * a fresh connection is safe (the handler never ran) and is what keeps the app
 * boot (plugins/config/WS) from degrading into a "Reconnecting" partial render.
 */
async function fetchApiWithRetry(
  input: string,
  init: RequestInit,
  attempts = 5,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : "";
      const transient =
        message.includes("fetch failed") ||
        cause.includes("other side closed") ||
        cause.includes("UND_ERR_SOCKET") ||
        cause.includes("ECONNRESET");
      if (!transient || attempt === attempts - 1) {
        throw error;
      }
      await sleep(50 * (attempt + 1));
    }
  }
  throw lastError;
}

async function proxyUiRequest(args: {
  apiBase: string;
  request: IncomingMessage;
  response: ServerResponse<IncomingMessage>;
  uiDistDir: string;
}): Promise<void> {
  const requestUrl = new URL(args.request.url ?? "/", "http://127.0.0.1");

  if (requestUrl.pathname.startsWith("/api/")) {
    const body = await readRequestBody(args.request);
    const headers: Record<string, string> = {};
    const contentType = args.request.headers["content-type"];
    if (typeof contentType === "string") {
      headers["content-type"] = contentType;
    }
    const authorization = args.request.headers.authorization;
    if (typeof authorization === "string") {
      headers.authorization = authorization;
    }

    const upstream = await fetchApiWithRetry(
      `${args.apiBase}${requestUrl.pathname}${requestUrl.search}`,
      {
        body: body.byteLength > 0 ? body : undefined,
        headers,
        method: args.request.method ?? "GET",
      },
    );
    const proxyHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "transfer-encoding") {
        return;
      }
      proxyHeaders[key] = value;
    });
    args.response.writeHead(upstream.status, proxyHeaders);
    args.response.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }

  const requestedPath =
    requestUrl.pathname === "/"
      ? "index.html"
      : requestUrl.pathname.replace(/^\/+/, "");
  let filePath =
    resolveDistAssetPath(requestedPath, args.uiDistDir) ??
    resolveCompanionPublicAssetPath(requestedPath);
  const isAssetRequest = path.extname(requestedPath).length > 0;
  const indexHtmlPath = path.join(args.uiDistDir, "index.html");
  if (!filePath && isAssetRequest) {
    args.response.writeHead(404, {
      "Content-Type": "application/json",
    });
    args.response.end(JSON.stringify({ error: "Static asset not found" }));
    return;
  }
  if (!filePath && !isAssetRequest) {
    filePath = indexHtmlPath;
  }

  const primaryPath = filePath ?? indexHtmlPath;
  let body: Buffer | null = null;
  let resolvedPath = primaryPath;
  const maxReadAttempts = 300;
  for (let attempt = 0; attempt < maxReadAttempts; attempt++) {
    try {
      body = await readFile(primaryPath);
      resolvedPath = primaryPath;
      break;
    } catch {
      try {
        body = await readFile(indexHtmlPath);
        resolvedPath = indexHtmlPath;
        break;
      } catch {
        await sleep(100);
      }
    }
  }
  if (!body) {
    throw new Error(`UI dist unavailable after retries: ${indexHtmlPath}`);
  }

  args.response.writeHead(200, {
    "Content-Type": contentTypeFor(resolvedPath),
  });
  args.response.end(body);
}

function relayWebSocket(args: {
  apiBase: string;
  request: IncomingMessage;
  clientSocket: WebSocket;
}): void {
  const requestUrl = new URL(args.request.url ?? "/ws", "http://127.0.0.1");
  const upstreamUrl = new URL(args.apiBase);
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
  upstreamUrl.pathname = requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;

  const upstreamSocket = new WebSocket(upstreamUrl, {
    headers:
      typeof args.request.headers.authorization === "string"
        ? { authorization: args.request.headers.authorization }
        : undefined,
  });

  const pendingClientQueue =
    createPendingWebSocketQueueState<WebSocketSendData>();

  const closeSocket = (socket: WebSocket, code?: number, reason?: string) => {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(code, reason);
    }
  };

  args.clientSocket.on("message", (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
      return;
    }
    if (upstreamSocket.readyState === WebSocket.CONNECTING) {
      const accepted = enqueuePendingWebSocketMessage(
        pendingClientQueue,
        { data, isBinary },
        DEFAULT_PENDING_WEBSOCKET_QUEUE_LIMITS,
      );
      if (!accepted) {
        clearPendingWebSocketQueue(pendingClientQueue);
        closeSocket(
          args.clientSocket,
          1009,
          "Pending websocket queue overflow",
        );
        closeSocket(upstreamSocket);
      }
    }
  });

  upstreamSocket.on("open", () => {
    for (const message of drainPendingWebSocketQueue(pendingClientQueue)) {
      upstreamSocket.send(message.data, { binary: message.isBinary });
    }
  });

  upstreamSocket.on("message", (data, isBinary) => {
    if (args.clientSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    args.clientSocket.send(data, { binary: isBinary });
  });

  args.clientSocket.on("close", () => {
    clearPendingWebSocketQueue(pendingClientQueue);
    closeSocket(upstreamSocket);
  });
  upstreamSocket.on("close", () => {
    clearPendingWebSocketQueue(pendingClientQueue);
    closeSocket(args.clientSocket);
  });

  args.clientSocket.on("error", () => {
    clearPendingWebSocketQueue(pendingClientQueue);
    closeSocket(upstreamSocket);
  });
  upstreamSocket.on("error", () => {
    clearPendingWebSocketQueue(pendingClientQueue);
    closeSocket(args.clientSocket);
  });
}

async function startUiProxyServer(args: {
  apiBase: string;
  port: number;
  uiDistDir: string;
}): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      await proxyUiRequest({
        apiBase: args.apiBase,
        request,
        response,
        uiDistDir: args.uiDistDir,
      });
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        if (!response.writableEnded) {
          response.end();
        }
        return;
      }
      console.error("[playwright-ui-live-stack] proxy error:", error);
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "Internal proxy error" }));
    }
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (clientSocket) => {
      relayWebSocket({
        apiBase: args.apiBase,
        request,
        clientSocket,
      });
    });
  });
  server.on("close", () => {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", () => resolve());
  });
  return server;
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode != null) {
    return true;
  }

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const handleExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", handleExit);
      child.off("close", handleExit);
    };

    child.once("exit", handleExit);
    child.once("close", handleExit);
  });
}

async function closeUiServer(uiServer: Server | null): Promise<void> {
  if (!uiServer) return;
  try {
    await new Promise<void>((resolve, reject) =>
      uiServer.close((error) => (error ? reject(error) : resolve())),
    );
  } catch {
    // Best effort during shutdown.
  }
}

async function stopApiChild(
  apiChild: ChildProcessWithoutNullStreams | null,
): Promise<void> {
  if (!apiChild || apiChild.exitCode != null) return;
  apiChild.kill("SIGTERM");
  const exitedAfterTerm = await waitForChildExit(apiChild, 5_000);
  if (!exitedAfterTerm && apiChild.exitCode == null) {
    apiChild.kill("SIGKILL");
    await waitForChildExit(apiChild, 5_000);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${url}`);
  }
  return (await response.json()) as T;
}

async function waitForJson<T>(
  url: string,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetchJson<T>(url);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

async function waitForJsonPredicate<T>(
  url: string,
  predicate: (value: T) => boolean,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | null = null;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const value = await fetchJson<T>(url);
      lastValue = value;
      if (predicate(value)) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }

  if (lastValue != null) {
    throw new Error(`Timed out waiting for predicate match: ${url}`);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

function createProcessLogSignal(matchText: string): {
  observe: (chunk: Buffer | string) => void;
  wait: (timeoutMs: number, label: string) => Promise<void>;
} {
  let matched = false;
  let tail = "";
  const waiters = new Set<() => void>();

  return {
    observe(chunk) {
      if (matched) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      tail = `${tail}${text}`.slice(-Math.max(matchText.length * 2, 4096));
      if (!tail.includes(matchText)) {
        return;
      }
      matched = true;
      tail = "";
      for (const resolve of waiters) {
        resolve();
      }
      waiters.clear();
    },
    async wait(timeoutMs, label) {
      if (matched) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);
        const finish = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          clearTimeout(timeout);
          waiters.delete(finish);
        };
        waiters.add(finish);
      });
    },
  };
}

async function ensureUiDistReady(): Promise<void> {
  const distIndex = path.join(APP_DIST_DIR, "index.html");
  let needsBuild = false;

  try {
    await access(distIndex);
    needsBuild = viteRendererBuildNeeded(APP_DIR, REPO_ROOT);
  } catch {
    needsBuild = true;
  }

  // Escape hatch symmetric to ELIZA_DESKTOP_RENDERER_BUILD=always: when the dist
  // is known-current and only the stub API or specs changed, skip the ~12 min
  // rebuild. The mtime heuristic false-positives whenever an unrelated bulk op
  // (git checkout, repo-wide formatter) bumps source mtimes without touching the
  // renderer. Only honored when a built index.html already exists.
  if (needsBuild && process.env.ELIZA_UI_SMOKE_SKIP_BUILD === "1") {
    try {
      await access(distIndex);
      needsBuild = false;
    } catch {
      throw new Error(
        `ELIZA_UI_SMOKE_SKIP_BUILD=1 but no built renderer at ${distIndex}. Build once (bun run --cwd packages/app build:web) before skipping.`,
      );
    }
  }

  if (!needsBuild) {
    return;
  }

  await removePathRecursive(path.join(APP_DIR, ".vite"));

  const logs: string[] = [];
  const child = spawn(resolveBunCommand(), ["run", "build:web"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      // The renderer build resolves workspace packages via Vite/dist, not the
      // Playwright collector's `eliza-source` condition; leaving it in leaks
      // into `node vite.js build`'s config load and kills it (#15759).
      NODE_OPTIONS: nodeOptionsWithoutElizaSource(),
      FORCE_COLOR: "0",
      VITE_ELIZA_RENDER_TELEMETRY: "1",
      // ui-smoke serves the dist locally and never ships it, so skip the
      // memory-heavy esbuild minify pass that otherwise OOMs (EPIPE) on a
      // ~6.5MB bundle in CI/sandbox builds.
      ELIZA_DESKTOP_VITE_FAST_DIST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  // Cold renderer build transforms ~3000 modules and measures ~12 min on a
  // clean dist; cap at 18 min so a legitimately slow first build is not killed
  // mid-flight (the previous 5/10 min caps produced spurious "service stopped").
  const RENDERER_BUILD_TIMEOUT_MS = 1_080_000;
  const exited = await waitForChildExit(child, RENDERER_BUILD_TIMEOUT_MS);
  if (!exited) {
    child.kill("SIGKILL");
    throw new Error(
      `app renderer build timed out after ${RENDERER_BUILD_TIMEOUT_MS}ms.\n${logs.join("").slice(-8_000)}`,
    );
  }
  if (child.exitCode !== 0) {
    throw new Error(
      `app renderer build failed (exit ${child.exitCode}).\n${logs.join("").slice(-8_000)}`,
    );
  }
}

async function snapshotUiDist(stateDir: string): Promise<string> {
  const snapshotDir = path.join(stateDir, "ui-dist");
  await cp(APP_DIST_DIR, snapshotDir, {
    recursive: true,
    force: true,
  });
  await access(path.join(snapshotDir, "index.html"));
  return snapshotDir;
}

async function submitFirstRun(apiBase: string): Promise<void> {
  if (!LIVE_PROVIDER) {
    throw new Error(
      "UI smoke needs a real provider. Set OPENAI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, or ELIZAOS_CLOUD_API_KEY.",
    );
  }

  const runtimeConfig = buildFirstRunRuntimeConfig({
    firstRunRuntimeTarget: "local",
    firstRunCloudApiKey: "",
    firstRunProvider: getFirstRunProviderForLiveProvider(LIVE_PROVIDER),
    firstRunApiKey: LIVE_PROVIDER.apiKey,
    firstRunVoiceProvider: "",
    firstRunVoiceApiKey: "",
    firstRunPrimaryModel: LIVE_PROVIDER.largeModel,
    firstRunOpenRouterModel: LIVE_PROVIDER.largeModel,
    firstRunRemoteConnected: false,
    firstRunRemoteApiBase: "",
    firstRunRemoteToken: "",
    firstRunSmallModel: LIVE_PROVIDER.smallModel,
    firstRunLargeModel: LIVE_PROVIDER.largeModel,
  });

  const response = await fetch(`${apiBase}/api/first-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Playwright Smoke",
      bio: ["A real runtime used by the UI smoke suite."],
      systemPrompt: "Concise assistant for Playwright smoke tests.",
      language: "en",
      presetId: "default",
      avatarIndex: 0,
      deploymentTarget: runtimeConfig.deploymentTarget,
      ...(runtimeConfig.linkedAccounts
        ? { linkedAccounts: runtimeConfig.linkedAccounts }
        : {}),
      ...(runtimeConfig.serviceRouting
        ? { serviceRouting: runtimeConfig.serviceRouting }
        : {}),
      ...(runtimeConfig.credentialInputs
        ? { credentialInputs: runtimeConfig.credentialInputs }
        : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Onboarding failed with ${response.status}: ${await response.text()}`,
    );
  }

  await waitForJsonPredicate<{ complete: boolean }>(
    `${apiBase}/api/first-run/status`,
    (status) => status.complete === true,
    READY_TIMEOUT_MS,
  );
}

async function seedLiveStackConfig(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const configPath = path.join(stateDir, "eliza.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        logging: { level: "error" },
        plugins: {
          entries: Object.fromEntries(
            [
              ...LIVE_STACK_OPTIONAL_VIEW_PLUGIN_ENTRIES,
              ...LIVE_STACK_EXTRA_PLUGIN_ENTRIES,
            ].map((pluginId) => [pluginId, { enabled: true }]),
          ),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function ensureLiveStackOptionalViewPluginsReady(): Promise<void> {
  for (const plugin of LIVE_STACK_OPTIONAL_VIEW_PLUGIN_PACKAGES) {
    const pluginDir = path.join(REPO_ROOT, "plugins", plugin.dir);
    const outputPaths = plugin.requiredBuildOutputs.map((output) =>
      path.join(pluginDir, output),
    );
    const missingOutputPaths: string[] = [];
    for (const outputPath of outputPaths) {
      try {
        await access(outputPath);
      } catch {
        missingOutputPaths.push(outputPath);
      }
    }
    if (missingOutputPaths.length === 0) continue;

    const logs: string[] = [];
    const child = spawn(resolveBunCommand(), ["run", "build"], {
      cwd: pluginDir,
      env: {
        ...process.env,
        // Same reason as the renderer build: a plugin's own build must resolve
        // through dist/Vite, not the collector's `eliza-source` condition
        // (#15759).
        NODE_OPTIONS: nodeOptionsWithoutElizaSource(),
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr.on("data", (chunk) => logs.push(String(chunk)));

    const BUILD_TIMEOUT_MS = 300_000;
    const exited = await waitForChildExit(child, BUILD_TIMEOUT_MS);
    if (!exited) {
      child.kill("SIGKILL");
      throw new Error(
        `Timed out building optional live-stack plugin ${plugin.id} after ${BUILD_TIMEOUT_MS}ms.\n${logs.join("").slice(-8_000)}`,
      );
    }
    if (child.exitCode !== 0) {
      throw new Error(
        `Failed to build optional live-stack plugin ${plugin.id}.\n${logs.join("").slice(-8_000)}`,
      );
    }
    for (const outputPath of outputPaths) {
      await access(outputPath);
    }
  }
}

async function startStubStack(): Promise<StartedStack> {
  const stateDir = await createStateDir("eliza-ui-smoke-stub-");
  let apiChild: ChildProcessWithoutNullStreams | null = null;
  let uiServer: Server | null = null;
  try {
    const uiDistDir = await snapshotUiDist(stateDir);
    const apiBase = `http://127.0.0.1:${API_PORT}`;
    apiChild = spawn("node", [UI_SMOKE_STUB_SCRIPT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        ELIZA_UI_SMOKE_API_PORT: String(API_PORT),
        ELIZA_UI_SMOKE_STUB_IGNORE_SIGTERM: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    apiChild.stdout.on("data", (chunk) => {
      process.stdout.write(`[ui-smoke][stub] ${chunk}`);
    });
    apiChild.stderr.on("data", (chunk) => {
      process.stdout.write(`[ui-smoke][stub-err] ${chunk}`);
    });

    await waitForJson<{ complete: boolean }>(`${apiBase}/api/first-run/status`);
    await waitForJsonPredicate<{ state?: string }>(
      `${apiBase}/api/status`,
      (status) => status.state === "running",
      READY_TIMEOUT_MS,
    );
    await waitForJsonPredicate<{ session?: { kind?: string } }>(
      `${apiBase}/api/auth/me`,
      (me) => me.session?.kind === "local",
      READY_TIMEOUT_MS,
    );

    uiServer = await startUiProxyServer({
      apiBase,
      port: UI_PORT,
      uiDistDir,
    });
    process.env.ELIZA_API_PORT = String(API_PORT);
    markStateDirOwnedByStack(stateDir);
    const startedApiChild = apiChild;
    const startedUiServer = uiServer;

    return {
      apiBase,
      apiChild: startedApiChild,
      stateDir,
      uiBase: `http://127.0.0.1:${UI_PORT}`,
      uiServer: startedUiServer,
    };
  } catch (error) {
    await closeUiServer(uiServer);
    await stopApiChild(apiChild);
    await removePathRecursive(stateDir);
    pendingStateDirs.delete(stateDir);
    throw error;
  }
}

async function startRealStack(): Promise<StartedStack> {
  await ensureUiDistReady();

  if (FORCE_STUB_STACK || !LIVE_PROVIDER) {
    return startStubStack();
  }

  await ensureLiveStackOptionalViewPluginsReady();

  const stateDir = await createStateDir("eliza-ui-smoke-live-");
  let apiChild: ChildProcessWithoutNullStreams | null = null;
  let uiServer: Server | null = null;
  try {
    await seedLiveStackConfig(stateDir);
    const uiDistDir = await snapshotUiDist(stateDir);
    const apiBase = `http://127.0.0.1:${API_PORT}`;
    const deferredBootComplete = createProcessLogSignal(
      "[eliza-boot] deferred:complete",
    );
    apiChild = spawn(
      "node",
      [
        path.join(REPO_ROOT, "packages/app-core/scripts/run-node-tsx.mjs"),
        path.join(REPO_ROOT, "packages/app-core/src/runtime/eliza.ts"),
      ],
      {
        cwd: REPO_ROOT,
        env: createLiveRuntimeChildEnv({
          ...(LIVE_PROVIDER?.env ?? {}),
          ALLOW_NO_DATABASE: "",
          FORCE_COLOR: "0",
          ELIZA_API_PORT: String(API_PORT),
          ELIZA_HOME_PORT: String(UI_PORT),
          ELIZA_PORT: String(API_PORT),
          ELIZA_STATE_DIR: stateDir,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    apiChild.stdout.on("data", (chunk) => {
      deferredBootComplete.observe(chunk);
      process.stdout.write(`[ui-smoke][api] ${chunk}`);
    });
    apiChild.stderr.on("data", (chunk) => {
      deferredBootComplete.observe(chunk);
      process.stdout.write(`[ui-smoke][api-err] ${chunk}`);
    });

    await waitForJson<{ complete: boolean }>(`${apiBase}/api/first-run/status`);
    // Cloud-live mode (ELIZA_UI_SMOKE_CLOUD_LIVE=1) leaves first-run UNcompleted so
    // the spec can drive the real cloud onboarding (login -> provision) through the
    // UI against real Eliza Cloud. The default lane auto-completes a local first-run
    // so chat/view specs land on a ready agent.
    const skipAutoFirstRun = process.env.ELIZA_UI_SMOKE_CLOUD_LIVE === "1";
    if (!skipAutoFirstRun) {
      const onboardingStatus = await fetchJson<{ complete: boolean }>(
        `${apiBase}/api/first-run/status`,
      );
      if (!onboardingStatus.complete) {
        await submitFirstRun(apiBase);
      }

      await waitForJsonPredicate<{ complete: boolean }>(
        `${apiBase}/api/first-run/status`,
        (status) => status.complete === true,
        READY_TIMEOUT_MS,
      );
    }
    await waitForJsonPredicate<{ state?: string }>(
      `${apiBase}/api/status`,
      (status) => status.state === "running",
      READY_TIMEOUT_MS,
    );
    await waitForJsonPredicate<{ session?: { kind?: string } }>(
      `${apiBase}/api/auth/me`,
      (me) => me.session?.kind === "local",
      READY_TIMEOUT_MS,
    );
    if (!skipAutoFirstRun) {
      // App-control and plugin views are deferred capabilities. Treat the live
      // harness as ready only after those runtime plugins have had a chance to
      // register; otherwise chat-driven view switching can race boot.
      await deferredBootComplete.wait(
        READY_TIMEOUT_MS,
        "deferred runtime plugin registration",
      );
    }

    uiServer = await startUiProxyServer({
      apiBase,
      port: UI_PORT,
      uiDistDir,
    });
    process.env.ELIZA_API_PORT = String(API_PORT);
    markStateDirOwnedByStack(stateDir);
    const startedApiChild = apiChild;
    const startedUiServer = uiServer;

    return {
      apiBase,
      apiChild: startedApiChild,
      stateDir,
      uiBase: `http://127.0.0.1:${UI_PORT}`,
      uiServer: startedUiServer,
    };
  } catch (error) {
    await closeUiServer(uiServer);
    await stopApiChild(apiChild);
    await removePathRecursive(stateDir);
    pendingStateDirs.delete(stateDir);
    throw error;
  }
}

async function stopRealStack(stack: StartedStack | null): Promise<void> {
  if (!stack) {
    return;
  }

  await closeUiServer(stack.uiServer);
  await stopApiChild(stack.apiChild);

  await removePathRecursive(stack.stateDir);
  ownedStateDirs.delete(stack.stateDir);
}

let stack: StartedStack | null = null;
let shuttingDown = false;

process.once("exit", cleanupKnownStateDirsSync);

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await stopRealStack(stack);
  await cleanupPendingStateDirs();
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown(0);
});
process.once("SIGTERM", () => {
  void shutdown(0);
});

try {
  stack = await startRealStack();
  stack.apiChild.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const reason =
      signal != null ? `signal ${signal}` : `exit code ${String(code ?? 1)}`;
    console.error(`[ui-smoke] runtime exited unexpectedly (${reason}).`);
    void shutdown(1);
  });
  console.log(`[ui-smoke] live UI ready at ${stack.uiBase}`);
  await new Promise(() => {});
} catch (error) {
  console.error(
    `[ui-smoke] failed to start live stack: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`,
  );
  await stopRealStack(stack);
  await cleanupPendingStateDirs();
  process.exit(1);
}
