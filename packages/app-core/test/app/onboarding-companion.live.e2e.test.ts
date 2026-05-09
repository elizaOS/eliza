import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { buildOnboardingRuntimeConfig } from "@elizaos/ui";
import { describeIf } from "../helpers/conditional-tests.ts";
import { selectLiveProvider } from "../helpers/live-provider.ts";

const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const LIVE_PROVIDER =
  (LIVE_TESTS_ENABLED && selectLiveProvider("openai")) ||
  (LIVE_TESTS_ENABLED ? selectLiveProvider() : null);
const LIVE_PROVIDER_LABELS = {
  anthropic: "Anthropic",
  google: "Gemini",
  groq: "Groq",
  openai: "OpenAI",
  openrouter: "OpenRouter",
} as const;
const LIVE_PROVIDER_LABEL = LIVE_PROVIDER
  ? LIVE_PROVIDER_LABELS[LIVE_PROVIDER.name]
  : null;
const describeLive = describeIf(LIVE_TESTS_ENABLED && LIVE_PROVIDER !== null);
const REPO_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
);
const APP_DIR = path.join(REPO_ROOT, "packages", "app");
const APP_DIST_DIR = path.join(APP_DIR, "dist");
const SCREENSHOT_DIR = path.join(REPO_ROOT, "test-results", "live-onboarding");
const READY_TIMEOUT_MS = 120_000;
const UI_SETTLE_MS = 4_000;
const CHROME_PATH =
  process.env.ELIZA_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type StartedStack = {
  apiBase: string;
  apiChild: ChildProcessWithoutNullStreams;
  browser: Browser;
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
  let filePath = resolveDistAssetPath(requestedPath);
  const isAssetRequest = path.extname(requestedPath).length > 0;
  if (!filePath && !isAssetRequest) {
    filePath = path.join(APP_DIST_DIR, "index.html");
  }

  let body: Buffer;
  try {
    body = await readFile(filePath ?? path.join(APP_DIST_DIR, "index.html"));
  } catch {
    body = await readFile(path.join(APP_DIST_DIR, "index.html"));
    filePath = path.join(APP_DIST_DIR, "index.html");
  }

  args.response.writeHead(200, {
    "Content-Type": contentTypeFor(
      filePath ?? path.join(APP_DIST_DIR, "index.html"),
    ),
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
      console.error("[onboarding-companion e2e] proxy error:", error);
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

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
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

async function waitForVisibleText(
  page: Page,
  labels: readonly (string | RegExp)[],
  timeoutMs: number = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const label of labels) {
      const locator =
        typeof label === "string"
          ? page.getByText(label, { exact: true }).first()
          : page.getByText(label).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.waitFor({ state: "visible", timeout: 5_000 });
        return locator;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Could not find any of: ${labels.map((label) => String(label)).join(", ")}`,
  );
}

async function clickVisibleText(
  page: Page,
  labels: readonly (string | RegExp)[],
  timeoutMs?: number,
) {
  const deadline = Date.now() + (timeoutMs ?? 30_000);
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    for (const label of labels) {
      const textLocator =
        typeof label === "string"
          ? page.getByText(label, { exact: true }).first()
          : page.getByText(label).first();
      const buttonByRole =
        typeof label === "string"
          ? page.getByRole("button", { exact: true, name: label }).first()
          : page.getByRole("button", { name: label }).first();
      const roleButtonAncestor = textLocator.locator(
        "xpath=ancestor-or-self::*[@role='button'][1]",
      );
      const buttonAncestor = textLocator.locator(
        "xpath=ancestor-or-self::button[1]",
      );

      for (const locator of [
        buttonByRole,
        roleButtonAncestor,
        buttonAncestor,
        textLocator,
      ]) {
        if (!(await locator.isVisible().catch(() => false))) {
          continue;
        }
        try {
          await locator.click({ force: true, timeout: 5_000 });
          return;
        } catch (error) {
          lastError = error;
        }
      }
    }

    await page.waitForTimeout(250);
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error(
    `Could not click any of: ${labels.map((label) => String(label)).join(", ")}`,
  );
}

async function startRealStack(): Promise<StartedStack> {
  await ensureUiDistReady();
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "eliza-onboarding-live-"),
  );
  const apiPort = await getFreePort();
  const uiPort = await getFreePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;

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
        ELIZA_API_PORT: String(apiPort),
        ELIZA_HOME_PORT: String(uiPort),
        ELIZA_PORT: String(apiPort),
        ELIZA_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  apiChild.stdout.on("data", (chunk) => {
    process.stdout.write(`[live-onboarding][api] ${chunk}`);
  });
  apiChild.stderr.on("data", (chunk) => {
    process.stdout.write(`[live-onboarding][api-err] ${chunk}`);
  });

  const onboardingStatus = await waitForJson<{ complete: boolean }>(
    `${apiBase}/api/onboarding/status`,
  );
  if (onboardingStatus.complete) {
    throw new Error(
      "Fresh live onboarding stack unexpectedly started complete",
    );
  }

  const uiServer = await startUiProxyServer({
    apiBase,
    port: uiPort,
  });
  process.env.ELIZA_API_PORT = String(apiPort);

  if (!existsSync(CHROME_PATH)) {
    throw new Error(
      `Chrome was not found at ${CHROME_PATH}; set ELIZA_CHROME_PATH to a valid browser executable.`,
    );
  }

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    args: ["--use-angle=swiftshader"],
    headless: true,
  });

  return {
    apiBase,
    apiChild,
    browser,
    stateDir,
    uiBase: `http://127.0.0.1:${uiPort}`,
    uiServer,
  };
}

async function stopRealStack(stack: StartedStack | null): Promise<void> {
  if (!stack) return;

  try {
    await stack.browser.close();
  } catch {
    // Best effort during cleanup.
  }
  try {
    await new Promise<void>((resolve, reject) =>
      stack.uiServer.close((error) => (error ? reject(error) : resolve())),
    );
  } catch {
    // Best effort during cleanup.
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

async function ensureUiDistReady(): Promise<void> {
  const distIndex = path.join(APP_DIST_DIR, "index.html");
  try {
    await access(distIndex);
    return;
  } catch {
    // Build the renderer bundle when this checkout only has partial assets.
  }

  const logs: string[] = [];
  const child = spawn("bun", ["scripts/build.mjs"], {
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
      `packages/app renderer build failed.\n${logs.join("").slice(-8_000)}`,
    );
  }
}

async function newLivePage(
  stack: StartedStack,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await stack.browser.newContext({
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1440 },
  });
  await context.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("eliza:ui-language", "en");
    localStorage.setItem("eliza:ui-language", "en");
    localStorage.setItem("eliza:ui-theme", "dark");
    localStorage.setItem("eliza:ui-theme", "dark");
    localStorage.setItem("eliza:onboarding-complete", "1");
    localStorage.setItem("eliza:onboarding:step", "activate");
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    );
  });

  const page = await context.newPage();
  page.on("console", (message) => {
    console.log(
      `[live-onboarding][browser:${message.type()}] ${message.text()}`,
    );
  });
  page.on("pageerror", (error) => {
    console.log(`[live-onboarding][pageerror] ${error.message}`);
  });

  return { context, page };
}

async function verifyWalletRpcRoundtrip(
  stack: StartedStack,
  page: Page,
): Promise<void> {
  const expectedSelections = {
    evm: "infura",
    bsc: "nodereal",
    solana: "helius-birdeye",
  } as const;

  await page.goto(`${stack.uiBase}/wallets`, { waitUntil: "domcontentloaded" });
  await waitForVisibleText(page, ["Tokens"]);

  const walletRpcButton = page.getByTestId("wallet-rpc-popup");
  await walletRpcButton.waitFor({
    state: "visible",
    timeout: READY_TIMEOUT_MS,
  });
  await walletRpcButton.click({ force: true, timeout: READY_TIMEOUT_MS });

  await waitForVisibleText(page, [/^Custom RPC$/i, /Custom RPC Providers/i]);
  await clickVisibleText(page, [/^Custom RPC$/i]);
  await waitForVisibleText(page, [/Custom RPC Providers/i]);
  await clickVisibleText(page, [/^Testnet$/i]);
  await clickVisibleText(page, [/^Infura$/i]);
  await clickVisibleText(page, [/^NodeReal$/i]);
  await clickVisibleText(page, [/^Helius \+ Birdeye$/i]);
  await clickVisibleText(page, [/^Save$/i]);

  const savedConfig = await waitForJsonPredicate<{
    selectedRpcProviders?: {
      evm?: string | null;
      bsc?: string | null;
      solana?: string | null;
    };
    walletNetwork?: string | null;
  }>(
    `${stack.apiBase}/api/wallet/config`,
    (config) =>
      config.walletNetwork === "testnet" &&
      config.selectedRpcProviders?.evm === expectedSelections.evm &&
      config.selectedRpcProviders?.bsc === expectedSelections.bsc &&
      config.selectedRpcProviders?.solana === expectedSelections.solana,
    READY_TIMEOUT_MS,
  );

  expect(savedConfig.walletNetwork).toBe("testnet");
  expect(savedConfig.selectedRpcProviders).toMatchObject(expectedSelections);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForVisibleText(page, ["Tokens"]);
  await walletRpcButton.waitFor({
    state: "visible",
    timeout: READY_TIMEOUT_MS,
  });
  await walletRpcButton.click({ force: true, timeout: READY_TIMEOUT_MS });
  await waitForVisibleText(page, [/Custom RPC Providers/i]);
  await waitForVisibleText(page, ["Infura API Key"]);
  await waitForVisibleText(page, ["NodeReal BSC RPC URL"]);
  await waitForVisibleText(page, ["Helius API Key"]);
  await waitForVisibleText(page, ["Birdeye API Key"]);
}

async function submitOnboarding(apiBase: string): Promise<void> {
  if (!LIVE_PROVIDER) {
    throw new Error("A live provider is required to complete onboarding.");
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
      name: "Live Onboarding",
      bio: ["A test agent for live onboarding coverage."],
      systemPrompt: "You are a concise assistant for live browser tests.",
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

describeLive("real onboarding handoff to companion mode", () => {
  let stack: StartedStack | null = null;

  beforeAll(async () => {
    if (!LIVE_PROVIDER || !LIVE_PROVIDER_LABEL) {
      throw new Error(
        "ELIZA_LIVE_TEST=1 requires a configured live model provider",
      );
    }
    stack = await startRealStack();
    await submitOnboarding(stack.apiBase);
  }, READY_TIMEOUT_MS);

  afterAll(async () => {
    await stopRealStack(stack);
    stack = null;
  }, 30_000);

  it(
    "finishes onboarding against the live server and lands in companion mode",
    async () => {
      if (!stack) {
        throw new Error("Live onboarding stack did not start");
      }

      const { context, page } = await newLivePage(stack);
      try {
        const companionRoot = page.getByTestId("companion-root");
        const companionHeader = page.getByTestId("companion-header-shell");
        const companionShellToggle = page.getByTestId("companion-shell-toggle");
        const companionCenterControls = page.getByTestId(
          "companion-header-center-controls",
        );
        await page.goto(`${stack.uiBase}/apps/companion`, {
          waitUntil: "domcontentloaded",
        });

        await page
          .waitForURL(/\/apps\/companion(?:$|[?#/])/, {
            timeout: READY_TIMEOUT_MS,
          })
          .catch(() => {});
        await companionRoot.waitFor({
          state: "visible",
          timeout: READY_TIMEOUT_MS,
        });
        await companionHeader.waitFor({
          state: "visible",
          timeout: READY_TIMEOUT_MS,
        });
        await companionShellToggle.waitFor({
          state: "visible",
          timeout: READY_TIMEOUT_MS,
        });
        await companionCenterControls.waitFor({
          state: "visible",
          timeout: READY_TIMEOUT_MS,
        });
        await page.waitForTimeout(UI_SETTLE_MS);

        await page.screenshot({
          path: path.join(
            SCREENSHOT_DIR,
            "onboarding-live-companion-after-enter.png",
          ),
          timeout: READY_TIMEOUT_MS,
        });

        expect(page.url()).toContain("/apps/companion");
        expect(await companionRoot.isVisible()).toBe(true);
        expect(await companionHeader.isVisible()).toBe(true);
        expect(await companionShellToggle.isVisible()).toBe(true);
        expect(await companionCenterControls.isVisible()).toBe(true);

        const onboardingStatus = await waitForJsonPredicate<{
          complete: boolean;
        }>(
          `${stack.apiBase}/api/onboarding/status`,
          (status) => status.complete === true,
          READY_TIMEOUT_MS,
        );
        expect(onboardingStatus.complete).toBe(true);

        await verifyWalletRpcRoundtrip(stack, page);
      } finally {
        await context.close();
      }
    },
    READY_TIMEOUT_MS * 2,
  );
});
