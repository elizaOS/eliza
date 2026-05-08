import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
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
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildOnboardingRuntimeConfig } from "../../src/onboarding-config";
import { describeIf } from "../helpers/conditional-tests.ts";
import { selectLiveProvider } from "../helpers/live-provider.ts";

const DEFAULT_UI_URL = stripTrailingSlash(
  process.env.ELIZA_LIVE_UI_URL ??
    process.env.ELIZA_UI_URL ??
    "http://127.0.0.1:2138",
);
const DEFAULT_API_URL = stripTrailingSlash(
  process.env.ELIZA_LIVE_API_URL ??
    process.env.ELIZA_API_URL ??
    "http://127.0.0.1:31337",
);
const API_TOKEN = process.env.ELIZA_API_TOKEN?.trim() ?? "";
const CHROME_PATH =
  process.env.ELIZA_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const CHROME_AVAILABLE = existsSync(CHROME_PATH);
const LIVE_PROVIDER =
  (LIVE_TESTS_ENABLED && selectLiveProvider("groq")) ||
  (LIVE_TESTS_ENABLED ? selectLiveProvider() : null);
const ARTIFACT_DIR = path.resolve(
  import.meta.dirname,
  "../../../../.tmp/live-memory-relationships-e2e",
);
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
const READY_TIMEOUT_MS = 120_000;

type MemoryStatsResponse = {
  total: number;
  byType: Record<string, number>;
};

type MemoryBrowseResponse = {
  memories: Array<{
    id: string;
    text: string;
  }>;
  total: number;
  limit: number;
  offset: number;
};

type RelationshipsPersonSummary = {
  primaryEntityId: string;
  memberEntityIds: string[];
  displayName: string;
};

type RelationshipsPeopleResponse = {
  data: RelationshipsPersonSummary[];
  stats: {
    totalPeople: number;
    totalRelationships: number;
    totalIdentities: number;
  };
};

type RelationshipsActivityResponse = {
  count: number;
  activity: Array<{
    type: "relationship" | "identity" | "fact";
    summary: string;
    detail: string | null;
  }>;
};

type StartedStack = {
  apiBase: string;
  apiChild: ChildProcessWithoutNullStreams;
  stateDir: string;
  uiBase: string;
  uiServer: Server;
};

let browser: Browser | null = null;
let liveStack: StartedStack | null = null;
let uiUrl = DEFAULT_UI_URL;
let apiUrl = DEFAULT_API_URL;

const describeLive = describeIf(LIVE_TESTS_ENABLED && CHROME_AVAILABLE);

if (LIVE_TESTS_ENABLED && !CHROME_AVAILABLE) {
  console.info(
    `[live-memory-relationships] Chrome not found at ${CHROME_PATH}; suite unavailable until a real browser is installed there or ELIZA_CHROME_PATH is set.`,
  );
}

describeLive("Live memory + relationships browser E2E", () => {
  beforeAll(async () => {
    if (!LIVE_PROVIDER) {
      throw new Error(
        "A live LLM provider is required for the memory + relationships browser suite.",
      );
    }

    await ensureUiDistReady();
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    liveStack = await startRealStack();
    uiUrl = stripTrailingSlash(liveStack.uiBase);
    apiUrl = stripTrailingSlash(liveStack.apiBase);
    await ensureHttpOk(`${uiUrl}/`);
    await ensureHttpOk(`${apiUrl}/api/status`);
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      protocolTimeout: 180_000,
      args: [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--use-angle=swiftshader",
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await stopRealStack(liveStack);
    liveStack = null;
  }, 30_000);

  it("verifies the live memories view, search flow, and person filtering", async () => {
    const activeBrowser = ensureBrowser(browser);
    const page = await activeBrowser.newPage();
    page.setDefaultTimeout(45_000);
    page.setDefaultNavigationTimeout(60_000);
    await configureLivePage(page);

    const token = `live-e2e-memory-${crypto.randomUUID()}`;
    const rememberResponse = await apiJson<{ ok: boolean; text: string }>(
      "/api/memory/remember",
      {
        method: "POST",
        body: JSON.stringify({ text: token }),
      },
    );
    expect(rememberResponse.ok).toBe(true);
    expect(rememberResponse.text).toBe(token);

    const stats = await apiJson<MemoryStatsResponse>("/api/memories/stats");
    expect(stats.total).toBeGreaterThan(0);

    await navigate(page, `${uiUrl}/memories`);
    await waitForText(page, "Memories");
    await waitForText(page, token, 45_000);

    const initialBody = await bodyText(page);
    expect(initialBody).toContain(String(stats.total));
    expect(initialBody).not.toContain("(empty)");

    await clickByText(page, "Browse");
    await typeInto(page, '[data-testid="memory-browser-search"]', token);
    await waitForText(page, token, 30_000);

    const searchResult = await apiJson<MemoryBrowseResponse>(
      `/api/memories/browse?q=${encodeURIComponent(token)}&limit=10`,
    );
    expect(searchResult.total).toBeGreaterThanOrEqual(1);

    const people = await apiJson<RelationshipsPeopleResponse>(
      "/api/relationships/people?limit=200",
    );
    const candidate = await findPersonWithMemories(people.data, stats.total);
    if (candidate) {
      await typeInto(
        page,
        'input[aria-label="Search people"]',
        candidate.person.displayName,
      );
      await clickSidebarItem(page, candidate.person.displayName);
      await waitForText(page, "Filtered to", 30_000);
      await waitForText(page, candidate.person.displayName, 30_000);
      await waitForSummaryTotal(page, candidate.total, 30_000);

      const filteredBody = await bodyText(page);
      expect(filteredBody).toContain(`of ${candidate.total}`);
      if (candidate.total < stats.total) {
        expect(filteredBody).not.toContain(`of ${stats.total}`);
      }
    } else {
      expect(Array.isArray(people.data)).toBe(true);
    }

    await saveScreenshot(page, "memories-live");
    await page.close();
  }, 180_000);

  it("verifies the live relationships activity panel against the backend", async () => {
    const activeBrowser = ensureBrowser(browser);
    const page = await activeBrowser.newPage();
    page.setDefaultTimeout(45_000);
    page.setDefaultNavigationTimeout(60_000);
    await configureLivePage(page);

    const stats = await apiJson<MemoryStatsResponse>("/api/memories/stats");
    const activity = await apiJson<RelationshipsActivityResponse>(
      "/api/relationships/activity?limit=10",
    );

    await navigate(page, `${uiUrl}/relationships`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    if (activity.activity.length === 0) {
      await waitForText(
        page,
        "No relationship activity yet. Events will appear as the agent extracts relationships, identities, and facts from conversations.",
      );
    } else {
      const firstSummary = activity.activity[0]?.summary;
      if (!firstSummary) {
        throw new Error("Expected a live activity item summary.");
      }
      await waitForText(page, firstSummary, 30_000);
      expect(activity.count).toBeGreaterThanOrEqual(activity.activity.length);
      expect(
        activity.activity.every((item) =>
          ["relationship", "identity", "fact"].includes(item.type),
        ),
      ).toBe(true);
    }

    if (stats.byType.facts > 0) {
      const factItem = activity.activity.find((item) => item.type === "fact");
      expect(factItem).toBeDefined();
      if (factItem) {
        await waitForText(page, factItem.summary, 30_000);
      }
    }

    await saveScreenshot(page, "relationships-live");
    await page.close();
  }, 180_000);
});

function ensureBrowser(current: Browser | null): Browser {
  if (!current) {
    throw new Error("Browser was not initialized.");
  }
  return current;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function ensureHttpOk(url: string): Promise<void> {
  const response = await fetch(url, {
    headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`Expected ${url} to be reachable, got ${response.status}.`);
  }
}

async function apiJson<T>(route: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  if (API_TOKEN) {
    headers.set("authorization", `Bearer ${API_TOKEN}`);
  }
  const response = await fetch(`${apiUrl}${route}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(`API ${route} failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function configureLivePage(page: Page): Promise<void> {
  await page.setViewport({ width: 1440, height: 1000 });
  if (API_TOKEN) {
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${API_TOKEN}`,
    });
  }
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("eliza:onboarding-complete", "1");
    localStorage.setItem("eliza:onboarding:step", "activate");
    localStorage.setItem("eliza:ui-shell-mode", "native");
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    );
  });
}

async function navigate(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !window.location.pathname.includes("/onboarding"),
    { timeout: 60_000 },
  );
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 60_000 });
}

async function waitForText(
  page: Page,
  text: string,
  timeout = 20_000,
): Promise<void> {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    { timeout },
    text,
  );
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

async function typeInto(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  const input = await page.waitForSelector(selector, { visible: true });
  if (!input) {
    throw new Error(`Input ${selector} was not found.`);
  }
  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await input.type(value);
}

async function clickByText(
  page: Page,
  text: string,
  rootSelector = "body",
): Promise<void> {
  await page.waitForFunction(
    ({ expected, root }) => {
      const scope = document.querySelector(root) ?? document.body;
      const nodes = Array.from(scope.querySelectorAll("*"));
      return nodes.some((node) => {
        const label = node.textContent?.trim();
        if (label !== expected) return false;
        return Boolean(node.closest("button,[role='button'],a"));
      });
    },
    { timeout: 20_000 },
    { expected: text, root: rootSelector },
  );

  const clicked = await page.evaluate(
    ({ expected, root }) => {
      const scope = document.querySelector(root) ?? document.body;
      const nodes = Array.from(scope.querySelectorAll("*"));
      for (const node of nodes) {
        const label = node.textContent?.trim();
        if (label !== expected) continue;
        const target = node.closest("button,[role='button'],a") ?? node;
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ block: "center" });
          target.click();
          return true;
        }
      }
      return false;
    },
    { expected: text, root: rootSelector },
  );

  expect(clicked).toBe(true);
}

async function clickSidebarItem(page: Page, text: string): Promise<void> {
  const clicked = await page.evaluate((expected) => {
    const sidebar = document.querySelector(
      '[data-testid="memory-viewer-sidebar"]',
    );
    if (!sidebar) return false;
    const nodes = Array.from(sidebar.querySelectorAll("*"));
    for (const node of nodes) {
      const label = node.textContent?.trim();
      if (label !== expected) continue;
      const target = node.closest("button,[role='button'],a") ?? node;
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: "center" });
        target.click();
        return true;
      }
    }
    return false;
  }, text);
  expect(clicked).toBe(true);
}

async function waitForSummaryTotal(
  page: Page,
  total: number,
  timeout = 20_000,
): Promise<void> {
  await page.waitForFunction(
    (expectedTotal) => {
      const text = document.body.innerText;
      const match = text.match(/\d+–\d+ of (\d+)/);
      return match
        ? Number.parseInt(match[1] ?? "", 10) === expectedTotal
        : false;
    },
    { timeout },
    total,
  );
}

async function findPersonWithMemories(
  people: RelationshipsPersonSummary[],
  globalTotal: number,
): Promise<{ person: RelationshipsPersonSummary; total: number } | null> {
  for (const person of people) {
    const qs = new URLSearchParams();
    if (person.memberEntityIds.length > 0) {
      qs.set("entityIds", person.memberEntityIds.join(","));
    }
    qs.set("limit", "1");
    const result = await apiJson<MemoryBrowseResponse>(
      `/api/memories/by-entity/${encodeURIComponent(person.primaryEntityId)}?${qs.toString()}`,
    );
    if (result.total > 0 && result.total < globalTotal) {
      return { person, total: result.total };
    }
  }

  for (const person of people) {
    const qs = new URLSearchParams();
    if (person.memberEntityIds.length > 0) {
      qs.set("entityIds", person.memberEntityIds.join(","));
    }
    qs.set("limit", "1");
    const result = await apiJson<MemoryBrowseResponse>(
      `/api/memories/by-entity/${encodeURIComponent(person.primaryEntityId)}?${qs.toString()}`,
    );
    if (result.total > 0) {
      return { person, total: result.total };
    }
  }

  return null;
}

async function saveScreenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(ARTIFACT_DIR, `${name}.png`),
    fullPage: true,
  });
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
    body = await fs.readFile(filePath ?? path.join(APP_DIST_DIR, "index.html"));
  } catch {
    body = await fs.readFile(path.join(APP_DIST_DIR, "index.html"));
    filePath = path.join(APP_DIST_DIR, "index.html");
  }

  args.response.writeHead(200, {
    "Content-Type": contentTypeFor(
      filePath ?? path.join(APP_DIST_DIR, "index.html"),
    ),
  });
  args.response.end(body);
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
      console.error("[memory-relationships e2e] proxy error:", error);
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "Internal proxy error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", () => resolve());
  });
  return server;
}

async function ensureUiDistReady(): Promise<void> {
  const distIndex = path.join(APP_DIST_DIR, "index.html");
  try {
    await fs.access(distIndex);
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
  const response = await fetch(url, {
    headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : undefined,
  });
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
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      name: "Live Memory Relationships",
      bio: ["A test agent for live memory and relationships coverage."],
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
}

async function startRealStack(): Promise<StartedStack> {
  if (!LIVE_PROVIDER) {
    throw new Error("A live provider is required to start the live stack.");
  }

  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-memory-live-"),
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
        ...LIVE_PROVIDER.env,
        ALLOW_NO_DATABASE: "",
        FORCE_COLOR: "0",
        ELIZA_API_PORT: String(apiPort),
        ELIZA_PORT: String(apiPort),
        ELIZA_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  apiChild.stdout.on("data", (chunk) => {
    process.stdout.write(`[live-memory][api] ${chunk}`);
  });
  apiChild.stderr.on("data", (chunk) => {
    process.stdout.write(`[live-memory][api-err] ${chunk}`);
  });

  await waitForJson<{ complete: boolean }>(`${apiBase}/api/onboarding/status`);
  await submitOnboarding(apiBase);
  await waitForJsonPredicate<{ complete: boolean }>(
    `${apiBase}/api/onboarding/status`,
    (status) => status.complete === true,
  );

  const uiServer = await startUiProxyServer({
    apiBase,
    port: uiPort,
  });

  process.env.ELIZA_API_PORT = String(apiPort);

  return {
    apiBase,
    apiChild,
    stateDir,
    uiBase: `http://127.0.0.1:${uiPort}`,
    uiServer,
  };
}

async function stopRealStack(stack: StartedStack | null): Promise<void> {
  if (!stack) return;

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

  await fs.rm(stack.stateDir, { force: true, recursive: true });
}
