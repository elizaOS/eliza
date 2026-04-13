import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { describeIf } from "../../../../test/helpers/conditional-tests.ts";
import { selectLiveProvider } from "../../../../test/helpers/live-provider";

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
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const APP_DIST_DIR = path.join(REPO_ROOT, "apps/app", "dist");
const SCREENSHOT_DIR = path.join(REPO_ROOT, "test-results", "live-onboarding");
const READY_TIMEOUT_MS = 120_000;
const UI_SETTLE_MS = 4_000;

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
  let filePath = path.resolve(APP_DIST_DIR, requestedPath);
  const isAssetRequest = path.extname(filePath).length > 0;
  if (!isAssetRequest || !filePath.startsWith(APP_DIST_DIR)) {
    filePath = path.join(APP_DIST_DIR, "index.html");
  }

  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    body = await readFile(path.join(APP_DIST_DIR, "index.html"));
    filePath = path.join(APP_DIST_DIR, "index.html");
  }

  args.response.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
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
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "eliza-onboarding-live-"),
  );
  const apiPort = await getFreePort();
  const uiPort = await getFreePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;

  const apiChild = spawn("bun", ["run", "eliza", "start"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ALLOW_NO_DATABASE: "",
      ELIZA_STATE_DIR: stateDir,
      ELIZA_PORT: String(apiPort),
      FORCE_COLOR: "0",
      ELIZA_API_PORT: String(apiPort),
      ELIZA_HOME_PORT: String(uiPort),
      ELIZA_PORT: String(apiPort),
      ELIZA_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

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
  const browser = await chromium.launch({
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

describeLive("real onboarding handoff to companion mode", () => {
  let stack: StartedStack | null = null;

  beforeAll(async () => {
    if (!LIVE_PROVIDER || !LIVE_PROVIDER_LABEL) {
      throw new Error(
        "ELIZA_LIVE_TEST=1 requires a configured live model provider",
      );
    }
    stack = await startRealStack();
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
        await page.goto(stack.uiBase, { waitUntil: "domcontentloaded" });

        await waitForVisibleText(page, [
          /Choose your setup/i,
          /Connect to Remote Agent/i,
        ]);
        await page
          .getByRole("button", { name: /Connect to Remote Agent/i })
          .click({ force: true });
        const remoteApiBaseInput = page.locator("input").first();
        await remoteApiBaseInput.waitFor({
          state: "visible",
          timeout: READY_TIMEOUT_MS,
        });
        await remoteApiBaseInput.fill(stack.apiBase);
        await clickVisibleText(page, [/^Connect$/i]);
        await page.waitForTimeout(5_000);

        const companionRoot = page.locator('[data-testid="companion-root"]');
        const landedInCompanion = await companionRoot
          .isVisible()
          .catch(() => false);

        if (!landedInCompanion) {
          const identityContinue = page.getByRole("button", {
            name: /^CONTINUE$/i,
          });
          if (
            (await page
              .getByText(/Choose your style/i)
              .isVisible()
              .catch(() => false)) &&
            (await identityContinue.isVisible().catch(() => false))
          ) {
            await identityContinue.click({ force: true });
            await page.waitForTimeout(2_000);
          }

          if (
            await page
              .getByText(/Backend address/i)
              .isVisible()
              .catch(() => false)
          ) {
            const providerRemoteApiBaseInput = page.locator("input").first();
            await providerRemoteApiBaseInput.waitFor({
              state: "visible",
              timeout: READY_TIMEOUT_MS,
            });
            await providerRemoteApiBaseInput.fill(stack.apiBase);
            await clickVisibleText(page, [
              /Connect remote backend/i,
              /^Connect$/i,
            ]);
            await page.waitForTimeout(5_000);
          }

          await waitForVisibleText(page, [
            /Choose your AI provider/i,
            new RegExp(LIVE_PROVIDER_LABEL, "i"),
          ]);
          await clickVisibleText(page, [
            new RegExp(`^${LIVE_PROVIDER_LABEL}$`, "i"),
          ]);

          await waitForVisibleText(page, [
            new RegExp(LIVE_PROVIDER_LABEL, "i"),
            /Confirm/i,
          ]);
          const providerApiKeyInput = page.locator("#provider-api-key");
          if (await providerApiKeyInput.isVisible().catch(() => false)) {
            await providerApiKeyInput.fill(LIVE_PROVIDER.apiKey);
          }
          await clickVisibleText(page, [/Confirm/i]);

          await waitForVisibleText(page, [/Enable features/i, /Skip for now/i]);
          await clickVisibleText(page, [
            /Skip for now/i,
            /Continue without features/i,
          ]);
        }

        await page
          .waitForURL(/\/companion(?:$|[?#/])/, {
            timeout: READY_TIMEOUT_MS,
          })
          .catch(() => {});
        await companionRoot.waitFor({
          state: "visible",
          timeout: READY_TIMEOUT_MS,
        });
        await page
          .getByRole("button", { name: "New Chat" })
          .waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
        await page
          .getByRole("button", { name: /Agent voice on|Agent voice off/i })
          .waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
        await page.waitForTimeout(UI_SETTLE_MS);

        await page.screenshot({
          path: path.join(
            SCREENSHOT_DIR,
            "onboarding-live-companion-after-enter.png",
          ),
          timeout: READY_TIMEOUT_MS,
        });

        expect(page.url()).toContain("/companion");
        expect(await companionRoot.isVisible()).toBe(true);
        expect(
          await page.getByRole("button", { name: "New Chat" }).isVisible(),
        ).toBe(true);
        expect(
          await page
            .getByRole("button", { name: /Agent voice on|Agent voice off/i })
            .isVisible(),
        ).toBe(true);

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
