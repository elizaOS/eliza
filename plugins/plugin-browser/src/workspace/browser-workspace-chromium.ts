/**
 * Runs the web-hosted Browser workspace in local or hosted Chromium.
 * The UI receives encoded frames and sends input through the workspace API, so
 * third-party pages never execute inside the app renderer.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import type { Browser, BrowserContext, KeyInput, Page } from "puppeteer-core";
import { createBrowserWorkspaceError } from "./browser-workspace-errors.js";
import {
  assertBrowserWorkspaceUrl,
  createBrowserWorkspaceNotFoundError,
  DEFAULT_WEB_PARTITION,
  inferBrowserWorkspaceTitle,
  sleep,
} from "./browser-workspace-helpers.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceDomElementSummary,
  BrowserWorkspaceEngine,
  BrowserWorkspaceInput,
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
  BrowserWorkspaceViewport,
  NavigateBrowserWorkspaceTabRequest,
  OpenBrowserWorkspaceTabRequest,
} from "./browser-workspace-types.js";

type ChromiumTab = {
  context: BrowserContext;
  elementRefs: Map<string, string>;
  page: Page;
  record: BrowserWorkspaceTab;
};

type ScreencastFrame = {
  data: string;
  metadata?: {
    deviceHeight?: number;
    deviceWidth?: number;
    offsetTop?: number;
    pageScaleFactor?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    timestamp?: number;
  };
  sessionId: number;
};

export type BrowserWorkspaceFrame = {
  data: string;
  height: number;
  width: number;
  timestamp: number;
};

const DEFAULT_VIEWPORT: BrowserWorkspaceViewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
};
const MAX_VIEWPORT_WIDTH = 2560;
const MAX_VIEWPORT_HEIGHT = 1600;
const MIN_VIEWPORT_EDGE = 240;
const NAMED_KEY_INPUTS = [
  "Alt",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Control",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "Home",
  "Insert",
  "Meta",
  "PageDown",
  "PageUp",
  "Shift",
  "Tab",
] as const satisfies readonly KeyInput[];

function namedKeyInput(key: string): KeyInput | null {
  return NAMED_KEY_INPUTS.find((candidate) => candidate === key) ?? null;
}

function browserBackend(env: NodeJS.ProcessEnv): string {
  return env.ELIZA_BROWSER_WORKSPACE_BACKEND?.trim().toLowerCase() ?? "";
}

/** Production web hosts use Chromium; document emulation remains test-only. */
export function usesChromiumBrowserWorkspace(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const requested = browserBackend(env);
  if (requested === "document-emulation" || requested === "jsdom") {
    return false;
  }
  if (
    requested === "local-chromium" ||
    requested === "hosted-chromium" ||
    requested === "chromium"
  ) {
    return true;
  }
  return (env.NODE_ENV ?? process.env.NODE_ENV) !== "test";
}

export function browserWorkspaceChromiumEngine(
  env: NodeJS.ProcessEnv = process.env,
): Extract<BrowserWorkspaceEngine, "hosted-chromium" | "local-chromium"> {
  return browserBackend(env) === "hosted-chromium" ||
    env.ELIZA_BROWSER_CDP_URL?.trim()
    ? "hosted-chromium"
    : "local-chromium";
}

function detectChromiumExecutable(env: NodeJS.ProcessEnv): string | null {
  const configured = env.ELIZA_BROWSER_CHROMIUM_PATH?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new ElizaError(
        `ELIZA_BROWSER_CHROMIUM_PATH does not exist: ${configured}`,
        {
          code: "BROWSER_CHROMIUM_PATH_INVALID",
          context: { configuredPath: configured },
          severity: "fatal",
        },
      );
    }
    return configured;
  }

  const platform = process.platform;
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "win32"
        ? [
            join(
              env.PROGRAMFILES ?? "C:\\Program Files",
              "Google/Chrome/Application/chrome.exe",
            ),
            join(
              env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
              "Microsoft/Edge/Application/msedge.exe",
            ),
            join(
              env.LOCALAPPDATA ?? "",
              "BraveSoftware/Brave-Browser/Application/brave.exe",
            ),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/usr/bin/brave-browser",
            "/snap/bin/chromium",
          ];

  const direct = candidates.find((candidate) => existsSync(candidate));
  if (direct) return direct;

  const command = platform === "win32" ? "where" : "which";
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
  ]) {
    try {
      const resolved = execFileSync(command, [name], {
        encoding: "utf8",
        timeout: 2_000,
      })
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry && existsSync(entry));
      if (resolved) return resolved;
    } catch {
      // error-policy:J3 executable discovery advances through a bounded list;
      // null below is the explicit unavailable result.
    }
  }
  return null;
}

function normalizedViewport(
  viewport: BrowserWorkspaceViewport,
): Required<BrowserWorkspaceViewport> {
  const finite = (value: number, fallback: number): number =>
    Number.isFinite(value) ? value : fallback;
  return {
    width: Math.round(
      Math.min(
        MAX_VIEWPORT_WIDTH,
        Math.max(MIN_VIEWPORT_EDGE, finite(viewport.width, 1280)),
      ),
    ),
    height: Math.round(
      Math.min(
        MAX_VIEWPORT_HEIGHT,
        Math.max(MIN_VIEWPORT_EDGE, finite(viewport.height, 800)),
      ),
    ),
    deviceScaleFactor: Math.min(
      2,
      Math.max(1, finite(viewport.deviceScaleFactor ?? 1, 1)),
    ),
  };
}

function toBase64(data: Uint8Array | string): string {
  return typeof data === "string"
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
        "base64",
      );
}

function pointerButton(
  button: "left" | "middle" | "right" | undefined,
): "left" | "middle" | "right" {
  return button ?? "left";
}

async function removeProfileDirectory(profileDir: string): Promise<void> {
  try {
    await rm(profileDir, { recursive: true, force: true });
  } catch (error) {
    // error-policy:J6 Chromium may already have removed or released its
    // temporary profile while process teardown is racing this cleanup.
    logger.debug(
      `[BrowserWorkspace] Chromium profile cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

class ChromiumBrowserWorkspace {
  private browser: Browser | null = null;
  private engine: Extract<
    BrowserWorkspaceEngine,
    "hosted-chromium" | "local-chromium"
  > = browserWorkspaceChromiumEngine();
  private ownsBrowserProcess = false;
  private profileDir: string | null = null;
  private nextId = 1;
  private readonly tabs = new Map<string, ChromiumTab>();
  private readonly contexts = new Map<string, BrowserContext>();
  private launchPromise: Promise<Browser> | null = null;

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    if (this.launchPromise) return this.launchPromise;

    this.launchPromise = this.launchBrowser();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const remoteEndpoint = process.env.ELIZA_BROWSER_CDP_URL?.trim();
    if (remoteEndpoint) {
      let endpoint: URL;
      try {
        endpoint = new URL(remoteEndpoint);
      } catch (error) {
        // error-policy:J2 preserve URL parser provenance while exposing a
        // stable configuration error without echoing endpoint credentials.
        throw new ElizaError(
          "ELIZA_BROWSER_CDP_URL must be a valid ws, wss, http, or https URL.",
          {
            code: "BROWSER_CDP_URL_INVALID",
            cause: error,
            severity: "fatal",
          },
        );
      }
      if (!["ws:", "wss:", "http:", "https:"].includes(endpoint.protocol)) {
        throw new ElizaError(
          "ELIZA_BROWSER_CDP_URL must use ws, wss, http, or https.",
          {
            code: "BROWSER_CDP_PROTOCOL_INVALID",
            context: { protocol: endpoint.protocol },
            severity: "fatal",
          },
        );
      }
      const puppeteer = await import("puppeteer-core");
      try {
        const browser = await puppeteer.connect({
          ...(endpoint.protocol === "ws:" || endpoint.protocol === "wss:"
            ? { browserWSEndpoint: remoteEndpoint }
            : { browserURL: remoteEndpoint }),
          defaultViewport: normalizedViewport(DEFAULT_VIEWPORT),
        });
        this.engine = "hosted-chromium";
        this.ownsBrowserProcess = false;
        this.bindBrowser(browser, null);
        logger.info(
          `[BrowserWorkspace] hosted Chromium connected (${endpoint.host})`,
        );
        return browser;
      } catch (error) {
        // error-policy:J2 the browser pool owns transport details; callers
        // receive one stable connection failure with its original cause.
        throw new ElizaError(
          `Unable to connect to hosted Chromium at ${endpoint.host}.`,
          {
            code: "BROWSER_CDP_CONNECT_FAILED",
            cause: error,
            context: { host: endpoint.host },
            severity: "ephemeral",
          },
        );
      }
    }

    if (browserBackend(process.env) === "hosted-chromium") {
      throw new ElizaError(
        "ELIZA_BROWSER_CDP_URL is required when ELIZA_BROWSER_WORKSPACE_BACKEND=hosted-chromium.",
        {
          code: "BROWSER_CDP_URL_REQUIRED",
          severity: "fatal",
        },
      );
    }

    const executablePath = detectChromiumExecutable(process.env);
    if (!executablePath) {
      throw new ElizaError(
        "A Chromium browser is required for the Browser workspace. Install Chrome, Brave, Edge, or Chromium, or configure ELIZA_BROWSER_CHROMIUM_PATH.",
        {
          code: "BROWSER_CHROMIUM_UNAVAILABLE",
          severity: "fatal",
        },
      );
    }

    const puppeteer = await import("puppeteer-core");
    const profileDir = await mkdtemp(
      join(tmpdir(), `eliza-browser-${process.pid}-`),
    );
    this.profileDir = profileDir;
    let browser: Browser;
    try {
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: profileDir,
        defaultViewport: normalizedViewport(DEFAULT_VIEWPORT),
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--disable-features=Translate,MediaRouter",
        ],
      });
    } catch (error) {
      // error-policy:J2 local launch failure cleans its owned profile before
      // rethrowing a classified error with the original browser cause.
      if (this.profileDir === profileDir) this.profileDir = null;
      await removeProfileDirectory(profileDir);
      throw new ElizaError("Unable to launch local Chromium.", {
        code: "BROWSER_CHROMIUM_LAUNCH_FAILED",
        cause: error,
        context: { executablePath },
        severity: "ephemeral",
      });
    }
    this.engine = "local-chromium";
    this.ownsBrowserProcess = true;
    this.bindBrowser(browser, profileDir);
    logger.info(`[BrowserWorkspace] local Chromium ready (${executablePath})`);
    return browser;
  }

  private bindBrowser(browser: Browser, profileDir: string | null): void {
    browser.on("disconnected", () => {
      if (this.browser !== browser) return;
      this.browser = null;
      this.tabs.clear();
      this.contexts.clear();
      this.ownsBrowserProcess = false;
      if (profileDir && this.profileDir === profileDir) {
        this.profileDir = null;
      }
      if (profileDir) void removeProfileDirectory(profileDir);
    });
    this.browser = browser;
  }

  private async contextForPartition(
    partition: string,
  ): Promise<BrowserContext> {
    const existing = this.contexts.get(partition);
    if (existing) return existing;
    const browser = await this.ensureBrowser();
    const context = await browser.createBrowserContext();
    this.contexts.set(partition, context);
    return context;
  }

  private async refreshRecord(tab: ChromiumTab): Promise<BrowserWorkspaceTab> {
    const url = tab.page.url();
    let title = tab.record.title;
    try {
      title =
        (await tab.page.title()).trim() || inferBrowserWorkspaceTitle(url);
    } catch (error) {
      // error-policy:J4 a page can close between list and title read; retain
      // the last observed title while close detection removes it next.
      logger.debug(
        `[BrowserWorkspace] title refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const now = new Date().toISOString();
    tab.record = {
      ...tab.record,
      title,
      url,
      updatedAt:
        url === tab.record.url && title === tab.record.title
          ? tab.record.updatedAt
          : now,
      provider: this.engine,
      status: "ready",
    };
    return { ...tab.record };
  }

  private requireTab(id: string): ChromiumTab {
    const tab = this.tabs.get(id);
    if (!tab || tab.page.isClosed()) {
      this.tabs.delete(id);
      throw createBrowserWorkspaceNotFoundError(id);
    }
    return tab;
  }

  private bindPage(tab: ChromiumTab): void {
    const { page } = tab;
    page.on("popup", (popup) => {
      if (!popup) return;
      void this.registerPopup(tab, popup).catch((error) => {
        // error-policy:J1 popup discovery is an event boundary; the original
        // tab remains usable while the failed child is reported explicitly.
        logger.error(
          `[BrowserWorkspace] popup registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) tab.elementRefs.clear();
    });
    page.on("close", () => {
      this.tabs.delete(tab.record.id);
    });
  }

  private resolveSelector(tab: ChromiumTab, requested: string): string {
    const selector = requested.trim();
    const match = selector.match(/^(@e\d+)([\s\S]*)$/i);
    if (!match?.[1]) return selector;
    const resolved = tab.elementRefs.get(match[1].toLowerCase());
    if (!resolved) {
      throw createBrowserWorkspaceError(
        "unknown_element_ref",
        "element_ref",
        `Unknown browser snapshot element ref ${match[1]}. Run snapshot or inspect again before reusing element refs.`,
      );
    }
    return `${resolved}${match[2] ?? ""}`;
  }

  private async targetTab(
    command: BrowserWorkspaceCommand,
  ): Promise<ChromiumTab> {
    if (command.id?.trim()) return this.requireTab(command.id.trim());
    const tabs = [...this.tabs.values()].filter((tab) => !tab.page.isClosed());
    if (typeof command.index === "number") {
      const indexed = tabs[command.index];
      if (indexed) return indexed;
    }
    const visible = tabs.find((tab) => tab.record.visible);
    const target = visible ?? tabs.at(-1);
    if (!target) {
      throw new ElizaError("Browser workspace has no open tab.", {
        code: "BROWSER_TAB_REQUIRED",
      });
    }
    return target;
  }

  async snapshot(): Promise<BrowserWorkspaceSnapshot> {
    return {
      mode: "web",
      engine: this.engine,
      presentation: "remote-stream",
      tabs: await this.list(),
    };
  }

  async list(): Promise<BrowserWorkspaceTab[]> {
    const live = [...this.tabs.entries()];
    const records: BrowserWorkspaceTab[] = [];
    for (const [id, tab] of live) {
      if (tab.page.isClosed()) {
        this.tabs.delete(id);
        continue;
      }
      records.push(await this.refreshRecord(tab));
    }
    return records;
  }

  async open(
    request: OpenBrowserWorkspaceTabRequest,
  ): Promise<BrowserWorkspaceTab> {
    const url = assertBrowserWorkspaceUrl(request.url?.trim() || "about:blank");
    const partition = request.partition?.trim() || DEFAULT_WEB_PARTITION;
    const context = await this.contextForPartition(partition);
    const page = await context.newPage();
    await page.setViewport(
      normalizedViewport({
        width: request.width ?? DEFAULT_VIEWPORT.width,
        height: request.height ?? DEFAULT_VIEWPORT.height,
      }),
    );

    const id = `btab_${this.nextId++}`;
    const now = new Date().toISOString();
    const visible = request.show !== false;
    if (visible) {
      for (const sibling of this.tabs.values()) sibling.record.visible = false;
    }
    const tab: ChromiumTab = {
      context,
      elementRefs: new Map(),
      page,
      record: {
        id,
        title: request.title?.trim() || inferBrowserWorkspaceTitle(url),
        url,
        partition,
        kind: request.kind === "internal" ? "internal" : "standard",
        visible,
        createdAt: now,
        updatedAt: now,
        lastFocusedAt: visible ? now : null,
        provider: this.engine,
        status: "starting",
      },
    };
    this.tabs.set(id, tab);
    this.bindPage(tab);

    try {
      if (url !== "about:blank") {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
      }
      tab.record.status = "ready";
      return await this.refreshRecord(tab);
    } catch (error) {
      // error-policy:J2 navigation failure retains its low-level network or
      // renderer cause while adding the target URL and tab context.
      tab.record.status = "error";
      tab.record.url = page.url() || url;
      tab.record.updatedAt = new Date().toISOString();
      throw new ElizaError(
        `Browser navigation failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: "BROWSER_NAVIGATION_FAILED",
          cause: error,
          context: { tabId: id, url },
          severity: "ephemeral",
        },
      );
    }
  }

  private async registerPopup(parent: ChromiumTab, page: Page): Promise<void> {
    const id = `btab_${this.nextId++}`;
    const now = new Date().toISOString();
    for (const sibling of this.tabs.values()) sibling.record.visible = false;
    const tab: ChromiumTab = {
      context: parent.context,
      elementRefs: new Map(),
      page,
      record: {
        id,
        title: inferBrowserWorkspaceTitle(page.url()),
        url: page.url(),
        partition: parent.record.partition,
        kind: "standard",
        visible: true,
        createdAt: now,
        updatedAt: now,
        lastFocusedAt: now,
        provider: this.engine,
        status: "ready",
      },
    };
    this.tabs.set(id, tab);
    this.bindPage(tab);
    await this.refreshRecord(tab);
  }

  async navigate(
    request: NavigateBrowserWorkspaceTabRequest,
  ): Promise<BrowserWorkspaceTab> {
    const tab = this.requireTab(request.id);
    const url = assertBrowserWorkspaceUrl(request.url);
    tab.record.status = "loading";
    tab.elementRefs.clear();
    try {
      await tab.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      tab.record.status = "ready";
      return await this.refreshRecord(tab);
    } catch (error) {
      // error-policy:J2 navigation failure retains its low-level network or
      // renderer cause while adding the target URL and tab context.
      tab.record.status = "error";
      await this.refreshRecord(tab);
      throw new ElizaError(
        `Browser navigation failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: "BROWSER_NAVIGATION_FAILED",
          cause: error,
          context: { tabId: tab.record.id, url },
          severity: "ephemeral",
        },
      );
    }
  }

  async show(id: string): Promise<BrowserWorkspaceTab> {
    const tab = this.requireTab(id);
    const now = new Date().toISOString();
    for (const sibling of this.tabs.values()) {
      sibling.record.visible = sibling === tab;
    }
    tab.record.lastFocusedAt = now;
    tab.record.updatedAt = now;
    await tab.page.bringToFront();
    return this.refreshRecord(tab);
  }

  async hide(id: string): Promise<BrowserWorkspaceTab> {
    const tab = this.requireTab(id);
    tab.record.visible = false;
    tab.record.updatedAt = new Date().toISOString();
    return this.refreshRecord(tab);
  }

  async close(id: string): Promise<boolean> {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    this.tabs.delete(id);
    if (!tab.page.isClosed()) await tab.page.close();
    const partitionStillUsed = [...this.tabs.values()].some(
      (candidate) => candidate.record.partition === tab.record.partition,
    );
    if (!partitionStillUsed) {
      this.contexts.delete(tab.record.partition);
      await tab.context.close();
    }
    return true;
  }

  async screenshot(id: string): Promise<{ data: string }> {
    const tab = this.requireTab(id);
    return {
      data: toBase64(
        await tab.page.screenshot({
          type: "png",
          fullPage: false,
          optimizeForSpeed: true,
        }),
      ),
    };
  }

  async evaluate(id: string, script: string): Promise<unknown> {
    const session = await this.requireTab(id).page.createCDPSession();
    try {
      const evaluated = await session.send("Runtime.evaluate", {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
      });
      if (evaluated.exceptionDetails) {
        throw new ElizaError(
          evaluated.exceptionDetails.exception?.description ??
            evaluated.exceptionDetails.text,
          {
            code: "BROWSER_SCRIPT_EVALUATION_FAILED",
            context: { tabId: id },
          },
        );
      }
      return evaluated.result.value;
    } finally {
      try {
        await session.detach();
      } catch (error) {
        // error-policy:J6 page teardown can detach the CDP session first.
        logger.debug(
          `[BrowserWorkspace] screencast session detach skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async resize(id: string, viewport: BrowserWorkspaceViewport): Promise<void> {
    await this.requireTab(id).page.setViewport(normalizedViewport(viewport));
  }

  async dispatchInput(id: string, input: BrowserWorkspaceInput): Promise<void> {
    const page = this.requireTab(id).page;
    if (input.type === "pointer") {
      const button = pointerButton(input.button);
      if (input.phase === "move") {
        await page.mouse.move(input.x, input.y);
      } else if (input.phase === "down") {
        await page.mouse.move(input.x, input.y);
        await page.mouse.down({ button });
      } else {
        await page.mouse.move(input.x, input.y);
        await page.mouse.up({ button });
      }
      return;
    }
    if (input.type === "wheel") {
      await page.mouse.move(input.x, input.y);
      await page.mouse.wheel({ deltaX: input.deltaX, deltaY: input.deltaY });
      return;
    }
    if (input.type === "text") {
      await page.keyboard.type(input.text);
      return;
    }
    if (input.text && input.phase === "down") {
      await page.keyboard.type(input.text);
      return;
    }
    if (input.key.length === 1 && input.phase === "up") return;
    const key = namedKeyInput(input.key);
    if (!key) {
      throw new ElizaError(`Unsupported browser key: ${input.key}`, {
        code: "BROWSER_KEY_UNSUPPORTED",
        context: { key: input.key },
      });
    }
    if (input.phase === "down") {
      await page.keyboard.down(key);
    } else {
      await page.keyboard.up(key);
    }
  }

  async subscribeFrames(
    id: string,
    onFrame: (frame: BrowserWorkspaceFrame) => void,
  ): Promise<() => Promise<void>> {
    const page = this.requireTab(id).page;
    const session = await page.createCDPSession();
    const viewport = page.viewport() ?? normalizedViewport(DEFAULT_VIEWPORT);
    const listener = (frame: ScreencastFrame): void => {
      void session
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch((error) => {
          // error-policy:J6 the stream may close between frame delivery and
          // acknowledgement; teardown below owns the session lifecycle.
          logger.debug(
            `[BrowserWorkspace] frame acknowledgement skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      onFrame({
        data: frame.data,
        width: frame.metadata?.deviceWidth ?? viewport.width,
        height: frame.metadata?.deviceHeight ?? viewport.height,
        timestamp: frame.metadata?.timestamp ?? Date.now() / 1000,
      });
    };
    session.on("Page.screencastFrame", listener);
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 78,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    });

    return async () => {
      session.off("Page.screencastFrame", listener);
      try {
        await session.send("Page.stopScreencast");
      } catch (error) {
        // error-policy:J6 page/session teardown can race stream cleanup.
        logger.debug(
          `[BrowserWorkspace] screencast stop skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await session.detach();
      } catch (error) {
        // error-policy:J6 closing a page or browser may detach CDP first.
        logger.debug(
          `[BrowserWorkspace] screencast session detach skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
  }

  private async inspect(
    tab: ChromiumTab,
  ): Promise<BrowserWorkspaceDomElementSummary[]> {
    const elements = await tab.page.evaluate(() => {
      const selectorFor = (element: HTMLElement): string => {
        if (element.id) return `#${CSS.escape(element.id)}`;
        const parts: string[] = [];
        let current: HTMLElement | null = element;
        while (current) {
          if (current.id) {
            parts.unshift(`#${CSS.escape(current.id)}`);
            break;
          }
          const tag = current.tagName.toLowerCase();
          const parent: HTMLElement | null = current.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const sameTagSiblings = Array.from(parent.children).filter(
            (sibling) => sibling.tagName === current?.tagName,
          );
          const position = sameTagSiblings.indexOf(current) + 1;
          parts.unshift(
            sameTagSiblings.length > 1
              ? `${tag}:nth-of-type(${position})`
              : tag,
          );
          if (parent === document.documentElement) {
            parts.unshift("html");
            break;
          }
          current = parent;
        }
        return parts.join(" > ");
      };
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>(
          "a[href],button,input,textarea,select,[role],[tabindex]",
        ),
      ).slice(0, 200);
      return elements.map((element, index) => {
        const tag = element.tagName.toLowerCase();
        return {
          ref: `@e${index + 1}`,
          selector: selectorFor(element),
          tag,
          text: (element.innerText || element.textContent || "")
            .trim()
            .slice(0, 500),
          type: element instanceof HTMLInputElement ? element.type : null,
          name:
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
              ? element.name || null
              : null,
          href: element instanceof HTMLAnchorElement ? element.href : null,
          value:
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
              ? element.value
              : null,
        };
      });
    });
    tab.elementRefs.clear();
    for (const element of elements) {
      tab.elementRefs.set(element.ref.toLowerCase(), element.selector);
    }
    return elements;
  }

  async execute(
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult> {
    const result = (value: Partial<BrowserWorkspaceCommandResult>) => ({
      mode: "web" as const,
      subaction: command.subaction,
      ...value,
    });

    if (command.subaction === "batch") {
      const steps = command.steps ?? [];
      if (steps.length === 0) {
        throw new ElizaError("Browser batch requires steps.", {
          code: "BROWSER_BATCH_EMPTY",
        });
      }
      const completed: BrowserWorkspaceCommandResult[] = [];
      for (const step of steps) completed.push(await this.execute(step));
      return result({ steps: completed, value: completed.at(-1)?.value });
    }
    if (command.subaction === "list")
      return result({ tabs: await this.list() });
    if (command.subaction === "open") {
      return result({
        tab: await this.open({
          url: command.url,
          title: command.title,
          show: command.show,
          partition: command.partition,
          width: command.width,
          height: command.height,
        }),
      });
    }
    if (command.subaction === "tab") {
      if ((command.tabAction ?? "list") === "list") {
        return result({ tabs: await this.list() });
      }
      if (command.tabAction === "new") {
        return result({
          tab: await this.open({
            url: command.url,
            title: command.title,
            show: command.show ?? true,
            partition: command.partition,
          }),
        });
      }
      const tab = await this.targetTab(command);
      if (command.tabAction === "switch") {
        return result({ tab: await this.show(tab.record.id) });
      }
      return result({ closed: await this.close(tab.record.id) });
    }
    if (command.subaction === "window") {
      return result({
        tab: await this.open({
          url: command.url,
          title: command.title,
          show: true,
          partition: command.partition,
        }),
      });
    }

    const tab = await this.targetTab(command);
    const page = tab.page;
    const selector = command.selector?.trim()
      ? this.resolveSelector(tab, command.selector)
      : undefined;
    switch (command.subaction) {
      case "navigate":
        return result({
          tab: await this.navigate({
            id: tab.record.id,
            url: command.url ?? "",
          }),
        });
      case "show":
        return result({ tab: await this.show(tab.record.id) });
      case "hide":
        return result({ tab: await this.hide(tab.record.id) });
      case "close":
        return result({ closed: await this.close(tab.record.id) });
      case "screenshot":
        return result({ snapshot: await this.screenshot(tab.record.id) });
      case "eval":
        return result({
          value: await this.evaluate(tab.record.id, command.script ?? ""),
        });
      case "back":
        tab.elementRefs.clear();
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 45_000 });
        return result({ tab: await this.refreshRecord(tab) });
      case "forward":
        tab.elementRefs.clear();
        await page.goForward({
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        return result({ tab: await this.refreshRecord(tab) });
      case "reload":
        tab.elementRefs.clear();
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
        return result({ tab: await this.refreshRecord(tab) });
      case "click":
      case "realistic-click":
      case "dblclick": {
        if (selector) {
          await page.click(selector, {
            clickCount: command.subaction === "dblclick" ? 2 : 1,
          });
        } else if (Number.isFinite(command.x) && Number.isFinite(command.y)) {
          await page.mouse.click(command.x ?? 0, command.y ?? 0, {
            clickCount: command.subaction === "dblclick" ? 2 : 1,
          });
        } else {
          throw new ElizaError(
            "Browser click requires selector or coordinates.",
            { code: "BROWSER_CLICK_TARGET_REQUIRED" },
          );
        }
        return result({ value: { clicked: true } });
      }
      case "fill":
      case "realistic-fill":
      case "type":
      case "realistic-type":
      case "keyboardtype":
      case "keyboardinserttext": {
        const text = command.text ?? command.value ?? "";
        if (selector) {
          await page.click(selector, { clickCount: 3 });
        }
        await page.keyboard.type(text, {
          delay: command.perCharDelayMs ?? 0,
        });
        return result({ value: { typed: text.length } });
      }
      case "press":
      case "realistic-press": {
        const requested = command.key ?? "Enter";
        const key = namedKeyInput(requested);
        if (key) await page.keyboard.press(key);
        else if (requested.length === 1) await page.keyboard.type(requested);
        else {
          throw new ElizaError(`Unsupported browser key: ${requested}`, {
            code: "BROWSER_KEY_UNSUPPORTED",
            context: { key: requested },
          });
        }
        return result({ value: { key: requested } });
      }
      case "keydown": {
        const requested = command.key ?? "";
        const key = namedKeyInput(requested);
        if (!key) {
          throw new ElizaError(`Unsupported browser key: ${requested}`, {
            code: "BROWSER_KEY_UNSUPPORTED",
            context: { key: requested },
          });
        }
        await page.keyboard.down(key);
        return result({ value: { key: requested } });
      }
      case "keyup": {
        const requested = command.key ?? "";
        const key = namedKeyInput(requested);
        if (!key) {
          throw new ElizaError(`Unsupported browser key: ${requested}`, {
            code: "BROWSER_KEY_UNSUPPORTED",
            context: { key: requested },
          });
        }
        await page.keyboard.up(key);
        return result({ value: { key: requested } });
      }
      case "hover":
        if (!selector) {
          throw new ElizaError("Browser hover requires selector.", {
            code: "BROWSER_SELECTOR_REQUIRED",
            context: { subaction: command.subaction },
          });
        }
        await page.hover(selector);
        return result({ value: { hovered: true } });
      case "focus":
        if (!selector) {
          throw new ElizaError("Browser focus requires selector.", {
            code: "BROWSER_SELECTOR_REQUIRED",
            context: { subaction: command.subaction },
          });
        }
        await page.focus(selector);
        return result({ value: { focused: true } });
      case "check":
      case "uncheck": {
        if (!selector) {
          throw new ElizaError("Browser checkbox control requires selector.", {
            code: "BROWSER_SELECTOR_REQUIRED",
            context: { subaction: command.subaction },
          });
        }
        const desired = command.subaction === "check";
        const checked = await page.$eval(
          selector,
          (element, shouldBeChecked) => {
            if (
              !(element instanceof HTMLInputElement) ||
              (element.type !== "checkbox" && element.type !== "radio")
            ) {
              throw new Error(
                "Browser check/uncheck target must be a checkbox or radio input.",
              );
            }
            if (element.checked !== shouldBeChecked) element.click();
            return element.checked;
          },
          desired,
        );
        return result({ value: { checked } });
      }
      case "select": {
        if (!selector) {
          throw new ElizaError("Browser select requires selector.", {
            code: "BROWSER_SELECTOR_REQUIRED",
            context: { subaction: command.subaction },
          });
        }
        const selected = await page.select(
          selector,
          command.value ?? command.text ?? "",
        );
        return result({ value: { selected } });
      }
      case "scrollinto": {
        if (!selector) {
          throw new ElizaError("Browser scroll into view requires selector.", {
            code: "BROWSER_SELECTOR_REQUIRED",
            context: { subaction: command.subaction },
          });
        }
        const position = await page.$eval(selector, (element) => {
          element.scrollIntoView({ block: "center", inline: "nearest" });
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y };
        });
        return result({ value: { scrolled: true, position } });
      }
      case "scroll": {
        const pixels = Math.max(1, Math.abs(command.pixels ?? 600));
        const vertical = command.direction === "up" ? -pixels : pixels;
        const horizontal =
          command.direction === "left"
            ? -pixels
            : command.direction === "right"
              ? pixels
              : 0;
        const deltaX = horizontal;
        const deltaY = horizontal === 0 ? vertical : 0;
        if (selector) {
          const position = await page.$eval(
            selector,
            (element, delta) => {
              element.scrollBy(delta.x, delta.y);
              return {
                x: element.scrollLeft,
                y: element.scrollTop,
              };
            },
            { x: deltaX, y: deltaY },
          );
          return result({
            value: {
              direction: command.direction ?? "down",
              pixels,
              position,
            },
          });
        }
        await page.mouse.wheel({ deltaX, deltaY });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
        const position = await page.evaluate(() => ({
          x: window.scrollX,
          y: window.scrollY,
        }));
        return result({
          value: {
            direction: command.direction ?? "down",
            pixels,
            position,
          },
        });
      }
      case "wait":
        if (selector) {
          await page.waitForSelector(selector, {
            timeout: command.timeoutMs ?? 30_000,
            visible: command.state !== "hidden",
            hidden: command.state === "hidden",
          });
        } else {
          await sleep(
            command.timeoutMs ?? command.ms ?? command.milliseconds ?? 500,
          );
        }
        return result({ value: { waited: true } });
      case "get": {
        const mode = command.getMode ?? "text";
        if (mode === "url") return result({ value: page.url() });
        if (mode === "title") return result({ value: await page.title() });
        if (!selector) {
          const value = await page.evaluate(
            () => document.body?.innerText ?? "",
          );
          return result({ value });
        }
        if (mode === "count") {
          return result({
            value: await page.$$eval(selector, (matches) => matches.length),
          });
        }
        const value = await page.$eval(
          selector,
          (element, input) => {
            const mode = input.mode;
            if (mode === "html") return element.outerHTML;
            if (mode === "text") return element.textContent ?? "";
            if (mode === "visible") {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }
            if (mode === "value" && "value" in element) {
              return (element as HTMLInputElement).value;
            }
            if (mode === "attr")
              return element.getAttribute(input.attribute ?? "");
            return element.textContent ?? "";
          },
          { mode, attribute: command.attribute },
        );
        return result({ value });
      }
      case "inspect":
      case "snapshot": {
        const elements = await this.inspect(tab);
        return result({
          elements,
          value: {
            title: await page.title(),
            url: page.url(),
            text: await page.evaluate(() => document.body?.innerText ?? ""),
          },
        });
      }
      case "state":
        return result({
          value: {
            title: await page.title(),
            url: page.url(),
            viewport: page.viewport(),
          },
        });
      default:
        throw new ElizaError(
          `The Chromium Browser workspace does not support subaction "${command.subaction}" yet.`,
          {
            code: "BROWSER_SUBACTION_UNSUPPORTED",
            context: { subaction: command.subaction },
          },
        );
    }
  }

  async stop(): Promise<void> {
    const pendingLaunch = this.launchPromise;
    if (pendingLaunch) {
      try {
        await pendingLaunch;
      } catch (error) {
        // error-policy:J6 a failed launch already cleaned its temporary
        // profile; shutdown only needs to finish any remaining state cleanup.
        logger.debug(
          `[BrowserWorkspace] Chromium launch ended during teardown: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const browser = this.browser;
    const ownsBrowserProcess = this.ownsBrowserProcess;
    const profileDir = this.profileDir;
    this.browser = null;
    this.profileDir = null;
    this.ownsBrowserProcess = false;
    this.tabs.clear();
    this.contexts.clear();
    if (browser?.connected && ownsBrowserProcess) {
      try {
        await browser.close();
      } catch (error) {
        // error-policy:J6 process shutdown owns the outer lifecycle; a browser
        // that exited first must not prevent its temporary profile cleanup.
        logger.debug(
          `[BrowserWorkspace] Chromium close skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (browser?.connected) {
      browser.disconnect();
    }
    if (profileDir) await removeProfileDirectory(profileDir);
  }
}

const chromiumWorkspace = new ChromiumBrowserWorkspace();

export function getChromiumBrowserWorkspaceSnapshot(): Promise<BrowserWorkspaceSnapshot> {
  return chromiumWorkspace.snapshot();
}

export function listChromiumBrowserWorkspaceTabs(): Promise<
  BrowserWorkspaceTab[]
> {
  return chromiumWorkspace.list();
}

export function openChromiumBrowserWorkspaceTab(
  request: OpenBrowserWorkspaceTabRequest,
): Promise<BrowserWorkspaceTab> {
  return chromiumWorkspace.open(request);
}

export function navigateChromiumBrowserWorkspaceTab(
  request: NavigateBrowserWorkspaceTabRequest,
): Promise<BrowserWorkspaceTab> {
  return chromiumWorkspace.navigate(request);
}

export function showChromiumBrowserWorkspaceTab(
  id: string,
): Promise<BrowserWorkspaceTab> {
  return chromiumWorkspace.show(id);
}

export function hideChromiumBrowserWorkspaceTab(
  id: string,
): Promise<BrowserWorkspaceTab> {
  return chromiumWorkspace.hide(id);
}

export function closeChromiumBrowserWorkspaceTab(id: string): Promise<boolean> {
  return chromiumWorkspace.close(id);
}

export function snapshotChromiumBrowserWorkspaceTab(
  id: string,
): Promise<{ data: string }> {
  return chromiumWorkspace.screenshot(id);
}

export function evaluateChromiumBrowserWorkspaceTab(
  id: string,
  script: string,
): Promise<unknown> {
  return chromiumWorkspace.evaluate(id, script);
}

export function resizeChromiumBrowserWorkspaceTab(
  id: string,
  viewport: BrowserWorkspaceViewport,
): Promise<void> {
  return chromiumWorkspace.resize(id, viewport);
}

export function dispatchChromiumBrowserWorkspaceInput(
  id: string,
  input: BrowserWorkspaceInput,
): Promise<void> {
  return chromiumWorkspace.dispatchInput(id, input);
}

export function subscribeChromiumBrowserWorkspaceFrames(
  id: string,
  onFrame: (frame: BrowserWorkspaceFrame) => void,
): Promise<() => Promise<void>> {
  return chromiumWorkspace.subscribeFrames(id, onFrame);
}

export function executeChromiumBrowserWorkspaceCommand(
  command: BrowserWorkspaceCommand,
): Promise<BrowserWorkspaceCommandResult> {
  return chromiumWorkspace.execute(command);
}

export function stopChromiumBrowserWorkspace(): Promise<void> {
  return chromiumWorkspace.stop();
}
