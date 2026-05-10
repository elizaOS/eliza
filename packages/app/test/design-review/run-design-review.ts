import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type Request,
} from "@playwright/test";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import {
  type MockApiServer,
  startMockApiServer,
} from "../electrobun-packaged/mock-api";
import { getFreePort } from "../utils/get-free-port.mjs";

type ShellMode = "companion" | "native";
type ViewId =
  | "companion"
  | "chat"
  | "stream"
  | "character"
  | "wallets"
  | "knowledge"
  | "connectors"
  | "settings"
  | "triggers"
  | "advanced";
type ViewStateId =
  | "default"
  | "navigation-open"
  | "chats-open"
  | "customize-open";
type ViewportId =
  | "mobile-portrait"
  | "mobile-landscape"
  | "desktop-landscape"
  | "ipad-portrait"
  | "ipad-landscape";

interface ViewportSpec {
  id: ViewportId;
  label: string;
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
}

interface ReadyCheck {
  selector?: string;
  text?: string;
}

interface ViewSpec {
  id: ViewId;
  label: string;
  path: string;
  shellMode: ShellMode;
  lastNativeTab: string;
  readyChecks: ReadyCheck[];
  readyCheckMode?: "all" | "any";
}

interface CaptureSpec {
  view: ViewSpec;
  viewport: ViewportSpec;
  stateId: ViewStateId;
  stateLabel: string;
}

interface CaptureRecord {
  viewId: ViewId;
  viewLabel: string;
  viewportId: ViewportId;
  viewportLabel: string;
  viewportSize: string;
  stateId: ViewStateId;
  stateLabel: string;
  relativePath: string;
}

interface FailureRecord {
  viewId: ViewId;
  viewportId: ViewportId;
  stateId: ViewStateId;
  message: string;
  screenshotPath?: string;
  htmlPath?: string;
  consolePath?: string;
}

interface Manifest {
  generatedAt: string;
  appBaseUrl: string;
  captures: CaptureRecord[];
  failures: FailureRecord[];
}

interface CliFilters {
  view?: string;
  viewport?: string;
  state?: string;
}

interface NetworkTracker {
  pendingRequests: Set<Request>;
  lastActivityAt: number;
}

const CHAT_MOBILE_BREAKPOINT_PX = 820;
const READY_TIMEOUT_MS = 30_000;
const TRANSIENT_UI_TIMEOUT_MS = 10_000;
const NETWORK_QUIET_TIMEOUT_MS = 10_000;
const NETWORK_QUIET_WINDOW_MS = 750;
const DOM_QUIET_TIMEOUT_MS = 10_000;
const DOM_QUIET_WINDOW_MS = 500;
const DEFAULT_SETTLE_MS = Number.parseInt(
  process.env.ELIZA_DESIGN_REVIEW_SETTLE_MS ?? "1200",
  10,
);

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");
const outputRoot = path.resolve(appRoot, "test-results/design-review");
const screenshotsRoot = path.join(outputRoot, "screenshots");
const diagnosticsRoot = path.join(outputRoot, "diagnostics");

const viewports: ViewportSpec[] = [
  {
    id: "mobile-portrait",
    label: "Mobile Portrait",
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "mobile-landscape",
    label: "Mobile Landscape",
    width: 844,
    height: 390,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "desktop-landscape",
    label: "Desktop Landscape",
    width: 1440,
    height: 900,
    isMobile: false,
    hasTouch: false,
  },
  {
    id: "ipad-portrait",
    label: "iPad Portrait",
    width: 820,
    height: 1180,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "chat-shell-breakpoint",
    label: "Chat Shell Breakpoint",
    width: 819,
    height: 1180,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "ipad-landscape",
    label: "iPad Landscape",
    width: 1180,
    height: 820,
    isMobile: true,
    hasTouch: true,
  },
];

const views: ViewSpec[] = [
  {
    id: "companion",
    label: "Companion",
    path: "/companion",
    shellMode: "companion",
    lastNativeTab: "chat",
    readyChecks: [{ selector: '[data-testid="companion-root"]' }],
  },
  {
    id: "chat",
    label: "Chat",
    path: "/chat",
    shellMode: "native",
    lastNativeTab: "chat",
    readyChecks: [{ selector: '[aria-label="Chat workspace"]' }],
  },
  {
    id: "stream",
    label: "Stream",
    path: "/stream",
    shellMode: "native",
    lastNativeTab: "stream",
    readyChecks: [{ text: "Go Live" }, { text: "Stop Stream" }],
    readyCheckMode: "any",
  },
  {
    id: "character",
    label: "Character",
    path: "/character-select",
    shellMode: "native",
    lastNativeTab: "character",
    readyChecks: [{ selector: '[data-testid="character-editor-view"]' }],
  },
  {
    id: "wallets",
    label: "Wallets",
    path: "/wallets",
    shellMode: "native",
    lastNativeTab: "wallets",
    readyChecks: [{ selector: '[data-testid="wallets-sidebar"]' }],
  },
  {
    id: "documents",
    label: "Knowledge",
    path: "/character/documents",
    shellMode: "native",
    lastNativeTab: "documents",
    readyChecks: [{ selector: '[aria-label="Knowledge upload controls"]' }],
  },
  {
    id: "connectors",
    label: "Connectors",
    path: "/connectors",
    shellMode: "native",
    lastNativeTab: "connectors",
    readyChecks: [{ selector: '[data-testid="connectors-settings-sidebar"]' }],
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    shellMode: "native",
    lastNativeTab: "settings",
    readyChecks: [{ selector: '[data-testid="settings-sidebar"]' }],
  },
  {
    id: "triggers",
    label: "Triggers",
    path: "/triggers",
    shellMode: "native",
    lastNativeTab: "triggers",
    readyChecks: [{ text: "New Heartbeat" }],
  },
  {
    id: "advanced",
    label: "Advanced",
    path: "/advanced",
    shellMode: "native",
    lastNativeTab: "advanced",
    readyChecks: [
      { selector: '[data-testid="advanced-subtab-nav"]' },
      { text: "Build Dataset" },
    ],
    readyCheckMode: "any",
  },
];

function parseCliArgs(argv: string[]): CliFilters {
  const filters: CliFilters = {};
  for (const arg of argv) {
    if (arg.startsWith("--view=")) filters.view = arg.slice(7);
    else if (arg.startsWith("--viewport=")) filters.viewport = arg.slice(11);
    else if (arg.startsWith("--state=")) filters.state = arg.slice(8);
  }
  return filters;
}

function formatViewport(viewport: ViewportSpec): string {
  return `${viewport.width}x${viewport.height}`;
}

function buildCaptureSpecs(filters: CliFilters): CaptureSpec[] {
  const captures: CaptureSpec[] = [];
  for (const view of views) {
    if (filters.view && filters.view !== view.id) continue;
    for (const viewport of viewports) {
      if (filters.viewport && filters.viewport !== viewport.id) continue;
      captures.push({
        view,
        viewport,
        stateId: "default",
        stateLabel: "Default",
      });
      if (
        view.shellMode === "native" &&
        view.id !== "character" &&
        viewport.width < CHAT_MOBILE_BREAKPOINT_PX
      ) {
        captures.push({
          view,
          viewport,
          stateId: "navigation-open",
          stateLabel: "Navigation Open",
        });
      }
      if (view.id === "chat" && viewport.width < CHAT_MOBILE_BREAKPOINT_PX) {
        captures.push({
          view,
          viewport,
          stateId: "chats-open",
          stateLabel: "Chats Open",
        });
      }
      if (view.id === "character") {
        captures.push({
          view,
          viewport,
          stateId: "customize-open",
          stateLabel: "Customize Open",
        });
      }
    }
  }
  return filters.state
    ? captures.filter((capture) => capture.stateId === filters.state)
    : captures;
}

async function startAppServer(apiBaseUrl: string): Promise<{
  server: ViteDevServer;
  baseUrl: string;
}> {
  process.env.ELIZA_API_PORT = new URL(apiBaseUrl).port;
  const port = await getFreePort();
  const server = await createViteServer({
    configFile: path.join(appRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function waitForReady(page: Page, view: ViewSpec): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const visibility = await Promise.all(
      view.readyChecks.map((check) => isReadyCheckVisible(page, check)),
    );
    const isReady =
      view.readyCheckMode === "any"
        ? visibility.some(Boolean)
        : visibility.every(Boolean);
    if (isReady) {
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${view.id}`);
}

async function isReadyCheckVisible(
  page: Page,
  check: ReadyCheck,
): Promise<boolean> {
  if (check.selector) {
    return await page
      .locator(check.selector)
      .first()
      .isVisible()
      .catch(() => false);
  }
  if (check.text) {
    return await page
      .getByText(check.text, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
  }
  return false;
}

async function resetOutputDir(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(screenshotsRoot, { recursive: true });
}

function screenshotRelativePath(capture: CaptureSpec): string {
  return path.posix.join(
    "screenshots",
    capture.view.id,
    `${capture.viewport.id}--${capture.stateId}.png`,
  );
}

function diagnosticStem(capture: CaptureSpec): string {
  return `${capture.view.id}--${capture.viewport.id}--${capture.stateId}`;
}

async function createPage(
  browser: Browser,
  apiBaseUrl: string,
  capture: CaptureSpec,
): Promise<{
  context: BrowserContext;
  page: Page;
  consoleLines: string[];
  network: NetworkTracker;
}> {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: {
      width: capture.viewport.width,
      height: capture.viewport.height,
    },
    isMobile: capture.viewport.isMobile,
    hasTouch: capture.viewport.hasTouch,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(
    (init) => {
      try {
        window.localStorage.clear();
        window.sessionStorage.clear();
        window.localStorage.setItem("eliza:ui-language", "en");
        window.localStorage.setItem("eliza:ui-theme", "dark");
        window.localStorage.setItem("eliza:ui-shell-mode", init.shellMode);
        window.localStorage.setItem(
          "eliza:last-native-tab",
          init.lastNativeTab,
        );
        window.localStorage.setItem("eliza:ui-language", "en");
        window.localStorage.setItem("eliza:ui-theme", "dark");
        window.localStorage.setItem("eliza:ui-shell-mode", init.shellMode);
        window.localStorage.setItem(
          "eliza:last-native-tab",
          init.lastNativeTab,
        );
        window.localStorage.setItem(
          "eliza:chat:activeConversationId",
          "conv-1",
        );
        window.sessionStorage.setItem("eliza_api_base", init.apiBaseUrl);
        window.__ELIZA_API_BASE__ = init.apiBaseUrl;
      } catch {
        // Ignore storage setup failures on intermediate documents.
      }
    },
    {
      apiBaseUrl,
      shellMode: capture.view.shellMode,
      lastNativeTab: capture.view.lastNativeTab,
    },
  );
  const page = await context.newPage();
  const consoleLines: string[] = [];
  const network: NetworkTracker = {
    pendingRequests: new Set(),
    lastActivityAt: Date.now(),
  };

  const markNetworkActivity = () => {
    network.lastActivityAt = Date.now();
  };
  const shouldTrackRequest = (request: Request): boolean => {
    const resourceType = request.resourceType();
    const url = request.url();
    return (
      resourceType !== "websocket" &&
      !url.startsWith("data:") &&
      !url.startsWith("blob:")
    );
  };

  page.on("request", (request) => {
    if (!shouldTrackRequest(request)) return;
    network.pendingRequests.add(request);
    markNetworkActivity();
  });
  page.on("requestfinished", (request) => {
    if (!shouldTrackRequest(request)) return;
    network.pendingRequests.delete(request);
    markNetworkActivity();
  });
  page.on("requestfailed", (request) => {
    if (!shouldTrackRequest(request)) return;
    network.pendingRequests.delete(request);
    markNetworkActivity();
  });
  page.on("console", (message) => {
    consoleLines.push(`[${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    consoleLines.push(`[pageerror] ${error.message}`);
  });
  return { context, page, consoleLines, network };
}

async function waitForTransientUi(page: Page): Promise<void> {
  const deadline = Date.now() + TRANSIENT_UI_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const loadingScreenVisible = await page
      .locator(".loading-screen")
      .first()
      .isVisible()
      .catch(() => false);
    const reconnectingVisible = await page
      .locator('[aria-label="Reconnecting"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (!loadingScreenVisible && !reconnectingVisible) {
      return;
    }
    await page.waitForTimeout(150);
  }
  throw new Error("Timed out waiting for transient UI to disappear");
}

async function waitForVisibleAssets(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if ("fonts" in document) {
      await document.fonts.ready;
    }

    for (const image of Array.from(document.images)) {
      const rect = image.getBoundingClientRect();
      const isVisible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      if (!isVisible || image.complete) {
        continue;
      }
      await new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      });
    }
  });
}

async function waitForNetworkQuiet(network: NetworkTracker): Promise<boolean> {
  const deadline = Date.now() + NETWORK_QUIET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const isQuiet =
      network.pendingRequests.size === 0 &&
      Date.now() - network.lastActivityAt >= NETWORK_QUIET_WINDOW_MS;
    if (isQuiet) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForDomQuiet(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(
      (quietWindowMs) => {
        const win = window as Window & {
          __elizaLastMutationAt?: number;
          __elizaMutationObserver?: MutationObserver;
        };
        if (!win.__elizaMutationObserver) {
          win.__elizaLastMutationAt = performance.now();
          win.__elizaMutationObserver = new MutationObserver(() => {
            win.__elizaLastMutationAt = performance.now();
          });
          win.__elizaMutationObserver.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        }
        const lastMutationAt = win.__elizaLastMutationAt ?? performance.now();
        return performance.now() - lastMutationAt >= quietWindowMs;
      },
      DOM_QUIET_WINDOW_MS,
      { timeout: DOM_QUIET_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForPageSettled(
  page: Page,
  network: NetworkTracker,
  view: ViewSpec,
): Promise<void> {
  await page.waitForLoadState("domcontentloaded", {
    timeout: READY_TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => document.readyState === "complete",
    undefined,
    {
      timeout: READY_TIMEOUT_MS,
    },
  );
  await waitForReady(page, view);
  await waitForTransientUi(page);
  await waitForVisibleAssets(page);

  const networkQuiet = await waitForNetworkQuiet(network);
  if (!networkQuiet) {
    console.warn(`Proceeding without full network quiet on ${view.id}`);
  }

  const domQuiet = await waitForDomQuiet(page);
  if (!domQuiet) {
    console.warn(`Proceeding without full DOM quiet on ${view.id}`);
  }

  await page.waitForTimeout(DEFAULT_SETTLE_MS);
}

async function applyState(page: Page, capture: CaptureSpec): Promise<void> {
  if (capture.stateId === "default") return;
  if (capture.stateId === "navigation-open") {
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await page.getByRole("dialog", { name: "Navigation menu" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    return;
  }
  if (capture.stateId === "chats-open") {
    await page.getByRole("button", { name: "Open chats panel" }).click();
    await page.locator('[data-testid="conversations-sidebar"]').waitFor({
      state: "visible",
      timeout: 10_000,
    });
    return;
  }
  if (capture.stateId === "customize-open") {
    await page.getByText("Style", { exact: true }).first().click();
    await page.locator('[data-testid="style-section-all"]').waitFor({
      state: "visible",
      timeout: 10_000,
    });
  }
}

async function captureOneAttempt(
  browser: Browser,
  appBaseUrl: string,
  api: MockApiServer,
  capture: CaptureSpec,
): Promise<{ record?: CaptureRecord; failure?: FailureRecord }> {
  const { context, page, consoleLines, network } = await createPage(
    browser,
    api.baseUrl,
    capture,
  );
  try {
    await page.goto(`${appBaseUrl}${capture.view.path}`, {
      waitUntil: "commit",
      timeout: READY_TIMEOUT_MS,
    });
    await waitForPageSettled(page, network, capture.view);
    await applyState(page, capture);
    await waitForTransientUi(page);
    await waitForVisibleAssets(page);
    const postStateNetworkQuiet = await waitForNetworkQuiet(network);
    if (!postStateNetworkQuiet) {
      console.warn(
        `Proceeding without full post-state network quiet on ${capture.view.id} · ${capture.stateId}`,
      );
    }
    await waitForDomQuiet(page);
    await page.waitForTimeout(DEFAULT_SETTLE_MS);

    const relativePath = screenshotRelativePath(capture);
    const absolutePath = path.join(outputRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await page.screenshot({ path: absolutePath, fullPage: false });

    return {
      record: {
        viewId: capture.view.id,
        viewLabel: capture.view.label,
        viewportId: capture.viewport.id,
        viewportLabel: capture.viewport.label,
        viewportSize: formatViewport(capture.viewport),
        stateId: capture.stateId,
        stateLabel: capture.stateLabel,
        relativePath,
      },
    };
  } catch (error) {
    const stem = diagnosticStem(capture);
    await mkdir(diagnosticsRoot, { recursive: true });
    const screenshotPath = path.join(diagnosticsRoot, `${stem}.png`);
    const htmlPath = path.join(diagnosticsRoot, `${stem}.html`);
    const consolePath = path.join(diagnosticsRoot, `${stem}.log`);
    await page
      .screenshot({ path: screenshotPath, fullPage: false })
      .catch(() => {});
    await writeFile(htmlPath, await page.content().catch(() => ""), "utf8");
    await writeFile(consolePath, `${consoleLines.join("\n")}\n`, "utf8");
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: {
        viewId: capture.view.id,
        viewportId: capture.viewport.id,
        stateId: capture.stateId,
        message,
        screenshotPath: path.relative(outputRoot, screenshotPath),
        htmlPath: path.relative(outputRoot, htmlPath),
        consolePath: path.relative(outputRoot, consolePath),
      },
    };
  } finally {
    await context.close();
  }
}

async function captureOne(
  browser: Browser,
  appBaseUrl: string,
  api: MockApiServer,
  capture: CaptureSpec,
): Promise<{ record?: CaptureRecord; failure?: FailureRecord }> {
  let last: { record?: CaptureRecord; failure?: FailureRecord } | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    last = await captureOneAttempt(browser, appBaseUrl, api, capture);
    if (last.record) return last;
    if (attempt < 2) {
      console.warn(
        `Retrying ${capture.view.id} · ${capture.viewport.id} · ${capture.stateId}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return last ?? {};
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeGallery(manifest: Manifest): Promise<void> {
  const byView = new Map<ViewId, CaptureRecord[]>();
  for (const capture of manifest.captures) {
    const existing = byView.get(capture.viewId) ?? [];
    existing.push(capture);
    byView.set(capture.viewId, existing);
  }

  const dateLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(manifest.generatedAt));

  const sections = views
    .map((view) => {
      const captures = byView.get(view.id);
      if (!captures?.length) return "";
      return `
        <section class="view-section">
          <div class="view-header">
            <h2>${escapeHtml(view.label)}</h2>
            <p>${escapeHtml(view.path)}</p>
          </div>
          <div class="shot-grid">
            ${captures
              .map(
                (capture) => `
                  <figure class="shot">
                    <img src="./${escapeHtml(capture.relativePath)}" alt="${escapeHtml(
                      `${capture.viewLabel} ${capture.viewportLabel} ${capture.stateLabel}`,
                    )}" loading="lazy" />
                    <figcaption>
                      <strong>${escapeHtml(capture.viewportLabel)}</strong>
                      <span>${escapeHtml(
                        `${capture.viewportSize} · ${capture.stateLabel}`,
                      )}</span>
                    </figcaption>
                  </figure>`,
              )
              .join("")}
          </div>
        </section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Eliza Design Review</title>
    <style>
      :root { color-scheme: dark; --bg: #090b0f; --panel: #11161d; --panel-2: #171e28; --border: rgba(255, 255, 255, 0.08); --text: #edf2f7; --muted: #9aa8bc; --accent: #f0b232; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: radial-gradient(circle at top, rgba(240, 178, 50, 0.16), transparent 30%), linear-gradient(180deg, #0b0f14 0%, var(--bg) 100%); color: var(--text); }
      main { width: min(1800px, calc(100vw - 40px)); margin: 0 auto; padding: 32px 0 64px; }
      h1, h2, p { margin: 0; }
      header { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
      .meta { color: var(--muted); font-size: 14px; }
      .view-section { margin-top: 28px; padding: 18px; border: 1px solid var(--border); border-radius: 20px; background: linear-gradient(180deg, rgba(23, 30, 40, 0.94), rgba(13, 18, 24, 0.96)); }
      .view-header { display: flex; justify-content: space-between; gap: 8px 16px; margin-bottom: 16px; flex-wrap: wrap; }
      .view-header p { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
      .shot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
      .shot { margin: 0; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: var(--panel); }
      .shot img { display: block; width: 100%; height: auto; background: #05070a; }
      figcaption { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; background: var(--panel-2); }
      figcaption span { color: var(--muted); font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Eliza Design Review</h1>
          <p class="meta">${escapeHtml(
            `${dateLabel} · ${manifest.captures.length} screenshots`,
          )}</p>
        </div>
      </header>
      ${sections}
    </main>
  </body>
</html>`;

  await writeFile(path.join(outputRoot, "index.html"), html, "utf8");
}

async function main(): Promise<void> {
  const filters = parseCliArgs(process.argv.slice(2));
  const captures = buildCaptureSpecs(filters);
  if (!captures.length) {
    throw new Error("No captures matched the supplied filters.");
  }

  await resetOutputDir();
  const api = await startMockApiServer({ onboardingComplete: true, port: 0 });
  const { server, baseUrl: appBaseUrl } = await startAppServer(api.baseUrl);
  const browser = await chromium.launch({
    headless: process.env.ELIZA_DESIGN_REVIEW_HEADLESS === "1",
    args: [
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-webgpu",
    ],
    timeout: 300_000,
  });

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    appBaseUrl,
    captures: [],
    failures: [],
  };

  try {
    for (const [index, capture] of captures.entries()) {
      console.log(
        `[${index + 1}/${captures.length}] ${capture.view.id} · ${capture.viewport.id} · ${capture.stateId}`,
      );
      const result = await captureOne(browser, appBaseUrl, api, capture);
      if (result.record) manifest.captures.push(result.record);
      if (result.failure) manifest.failures.push(result.failure);
    }
  } finally {
    await browser.close();
    await server.close();
    await api.close();
  }

  await writeFile(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeGallery(manifest);

  console.log(`Wrote ${manifest.captures.length} screenshots to ${outputRoot}`);
  if (manifest.failures.length) {
    console.error(`Encountered ${manifest.failures.length} failures.`);
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
