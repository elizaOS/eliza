import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildOnboardingRuntimeConfig } from "@elizaos/ui/onboarding-config";
import { WebSocket, WebSocketServer } from "ws";
import { selectLiveProvider } from "../test/helpers/live-provider.ts";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { viteRendererBuildNeeded } from "./lib/vite-renderer-dist-stale.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
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
const LIVE_PROVIDER = selectLiveProvider();
const FORCE_STUB_STACK =
  process.env.ELIZA_UI_SMOKE_FORCE_STUB === "1" || process.env.CI === "true";

type StartedStack = {
  apiBase: string;
  apiChild: ChildProcessWithoutNullStreams;
  stateDir: string;
  uiBase: string;
  uiServer: Server;
};

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

function resolveDistAssetPath(requestedPath: string): string | null {
  const normalizedPath = requestedPath.replace(/^\/+/, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const candidatePath = path.resolve(
      APP_DIST_DIR,
      segments.slice(index).join("/"),
    );
    if (
      candidatePath.startsWith(APP_DIST_DIR) &&
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

async function proxyUiRequest(args: {
  apiBase: string;
  request: IncomingMessage;
  response: ServerResponse<IncomingMessage>;
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

    const upstream = await fetch(
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
    resolveDistAssetPath(requestedPath) ??
    resolveCompanionPublicAssetPath(requestedPath);
  const isAssetRequest = path.extname(requestedPath).length > 0;
  const indexHtmlPath = path.join(APP_DIST_DIR, "index.html");
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
  const maxReadAttempts = 40;
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

  const pendingClientMessages: Array<{
    data: Parameters<WebSocket["send"]>[0];
    isBinary: boolean;
  }> = [];

  const closeSocket = (socket: WebSocket) => {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  };

  args.clientSocket.on("message", (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
      return;
    }
    if (upstreamSocket.readyState === WebSocket.CONNECTING) {
      pendingClientMessages.push({ data, isBinary });
    }
  });

  upstreamSocket.on("open", () => {
    for (const message of pendingClientMessages.splice(0)) {
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
    closeSocket(upstreamSocket);
  });
  upstreamSocket.on("close", () => {
    closeSocket(args.clientSocket);
  });

  args.clientSocket.on("error", () => {
    closeSocket(upstreamSocket);
  });
  upstreamSocket.on("error", () => {
    closeSocket(args.clientSocket);
  });
}

async function startUiProxyServer(args: {
  apiBase: string;
  port: number;
}): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      await proxyUiRequest({
        apiBase: args.apiBase,
        request,
        response,
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

async function ensureUiDistReady(): Promise<void> {
  const distIndex = path.join(APP_DIST_DIR, "index.html");
  let needsBuild = false;

  try {
    await access(distIndex);
    needsBuild = viteRendererBuildNeeded(APP_DIR, REPO_ROOT);
  } catch {
    needsBuild = true;
  }

  if (!needsBuild) {
    return;
  }

  const logs: string[] = [];
  const child = spawn("bun", ["run", "build:web"], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const exited = await waitForChildExit(child, 300_000);
  if (!exited || child.exitCode !== 0) {
    throw new Error(
      `app renderer build failed.\n${logs.join("").slice(-8_000)}`,
    );
  }
}

async function submitOnboarding(apiBase: string): Promise<void> {
  if (!LIVE_PROVIDER) {
    throw new Error(
      "UI smoke needs a real provider. Set OPENAI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, or ELIZAOS_CLOUD_API_KEY.",
    );
  }

  const runtimeConfig = buildOnboardingRuntimeConfig({
    onboardingServerTarget: "local",
    onboardingCloudApiKey: "",
    onboardingProvider: LIVE_PROVIDER.name,
    onboardingApiKey: LIVE_PROVIDER.apiKey,
    onboardingVoiceProvider: "",
    onboardingVoiceApiKey: "",
    onboardingPrimaryModel: LIVE_PROVIDER.largeModel,
    onboardingOpenRouterModel: LIVE_PROVIDER.largeModel,
    onboardingRemoteConnected: false,
    onboardingRemoteApiBase: "",
    onboardingRemoteToken: "",
    onboardingSmallModel: LIVE_PROVIDER.smallModel,
    onboardingLargeModel: LIVE_PROVIDER.largeModel,
  });

  const response = await fetch(`${apiBase}/api/onboarding`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Playwright Smoke",
      bio: ["A real runtime used by the UI smoke suite."],
      systemPrompt: "You are a concise assistant for Playwright smoke tests.",
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
    `${apiBase}/api/onboarding/status`,
    (status) => status.complete === true,
    READY_TIMEOUT_MS,
  );
}

async function startStubStack(): Promise<StartedStack> {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "eliza-ui-smoke-stub-"),
  );
  const apiBase = `http://127.0.0.1:${API_PORT}`;
  const apiChild = spawn("node", [UI_SMOKE_STUB_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      ELIZA_UI_SMOKE_API_PORT: String(API_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  apiChild.stdout.on("data", (chunk) => {
    process.stdout.write(`[ui-smoke][stub] ${chunk}`);
  });
  apiChild.stderr.on("data", (chunk) => {
    process.stdout.write(`[ui-smoke][stub-err] ${chunk}`);
  });

  await waitForJson<{ complete: boolean }>(`${apiBase}/api/onboarding/status`);
  await waitForJsonPredicate<{ state?: string }>(
    `${apiBase}/api/status`,
    (status) => status.state === "running",
    READY_TIMEOUT_MS,
  );

  const uiServer = await startUiProxyServer({
    apiBase,
    port: UI_PORT,
  });
  process.env.ELIZA_API_PORT = String(API_PORT);

  return {
    apiBase,
    apiChild,
    stateDir,
    uiBase: `http://127.0.0.1:${UI_PORT}`,
    uiServer,
  };
}

async function startRealStack(): Promise<StartedStack> {
  await ensureUiDistReady();

  if (FORCE_STUB_STACK || !LIVE_PROVIDER) {
    return startStubStack();
  }

  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "eliza-ui-smoke-live-"),
  );
  const apiBase = `http://127.0.0.1:${API_PORT}`;
  const apiChild = spawn(
    "node",
    [
      path.join(REPO_ROOT, "eliza/packages/app-core/scripts/run-node-tsx.mjs"),
      path.join(REPO_ROOT, "eliza/packages/app-core/src/runtime/eliza.ts"),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ALLOW_NO_DATABASE: "",
        FORCE_COLOR: "0",
        ELIZA_API_PORT: String(API_PORT),
        ELIZA_HOME_PORT: String(UI_PORT),
        ELIZA_PORT: String(API_PORT),
        ELIZA_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  apiChild.stdout.on("data", (chunk) => {
    process.stdout.write(`[ui-smoke][api] ${chunk}`);
  });
  apiChild.stderr.on("data", (chunk) => {
    process.stdout.write(`[ui-smoke][api-err] ${chunk}`);
  });

  await waitForJson<{ complete: boolean }>(`${apiBase}/api/onboarding/status`);
  const onboardingStatus = await fetchJson<{ complete: boolean }>(
    `${apiBase}/api/onboarding/status`,
  );
  if (!onboardingStatus.complete) {
    await submitOnboarding(apiBase);
  }

  await waitForJsonPredicate<{ complete: boolean }>(
    `${apiBase}/api/onboarding/status`,
    (status) => status.complete === true,
    READY_TIMEOUT_MS,
  );
  await waitForJsonPredicate<{ state?: string }>(
    `${apiBase}/api/status`,
    (status) => status.state === "running",
    READY_TIMEOUT_MS,
  );

  const uiServer = await startUiProxyServer({
    apiBase,
    port: UI_PORT,
  });
  process.env.ELIZA_API_PORT = String(API_PORT);

  return {
    apiBase,
    apiChild,
    stateDir,
    uiBase: `http://127.0.0.1:${UI_PORT}`,
    uiServer,
  };
}

async function stopRealStack(stack: StartedStack | null): Promise<void> {
  if (!stack) {
    return;
  }

  try {
    await new Promise<void>((resolve, reject) =>
      stack.uiServer.close((error) => (error ? reject(error) : resolve())),
    );
  } catch {
    // Best effort during shutdown.
  }

  if (stack.apiChild.exitCode == null) {
    stack.apiChild.kill("SIGTERM");
    const exitedAfterTerm = await waitForChildExit(stack.apiChild, 5_000);
    if (!exitedAfterTerm && stack.apiChild.exitCode == null) {
      stack.apiChild.kill("SIGKILL");
      await waitForChildExit(stack.apiChild, 5_000);
    }
  }

  await rm(stack.stateDir, { force: true, recursive: true });
}

let stack: StartedStack | null = null;
let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await stopRealStack(stack);
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
  process.exit(1);
}
