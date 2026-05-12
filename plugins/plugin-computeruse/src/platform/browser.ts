/**
 * Browser automation via Puppeteer Core + Chrome DevTools Protocol.
 *
 * Ported from coasty-ai/open-computer-use browser-automation.ts (Apache 2.0).
 *
 * Uses puppeteer-core (not full puppeteer) to avoid bundling Chromium.
 * Auto-detects installed Chrome, Edge, or Brave at launch.
 * Each session uses a temp user data directory to prevent conflicts.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserInfo,
  BrowserState,
  BrowserTab,
  ClickableElement,
} from "../types.js";
import { currentPlatform } from "./helpers.js";

// Lazy-load puppeteer-core so the plugin still loads if it's not installed
let puppeteer: typeof import("puppeteer-core") | null = null;
type Browser = import("puppeteer-core").Browser;
type Page = import("puppeteer-core").Page;

async function getPuppeteer() {
  if (!puppeteer) {
    try {
      puppeteer = await import("puppeteer-core");
    } catch {
      throw new Error(
        "puppeteer-core is required for browser automation. Install via: bun add puppeteer-core",
      );
    }
  }
  return puppeteer;
}

// ── State ───────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let activePage: Page | null = null;
let tempUserDataDir: string | null = null;
let browserHeadless = false;
const BROWSER_LAUNCH_ATTEMPTS = 3;

export function setBrowserRuntimeOptions(options: {
  headless?: boolean;
}): void {
  if (typeof options.headless === "boolean") {
    browserHeadless = options.headless;
  }
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

// ── Browser Detection ───────────────────────────────────────────────────────

function detectBrowserPath(): string | null {
  const os = currentPlatform();
  const candidates: string[] = [];

  if (os === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else if (os === "linux") {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/microsoft-edge",
      "/usr/bin/brave-browser",
      "/snap/bin/chromium",
    );
  } else if (os === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";
    candidates.push(
      join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
      join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(
        programFiles,
        "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      ),
    );
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  const lookup = os === "win32" ? "where" : "which";
  for (const candidate of [
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
    "microsoft-edge",
    "brave-browser",
    "chrome.exe",
    "msedge.exe",
  ]) {
    try {
      const output = execFileSync(lookup, [candidate], {
        encoding: "utf8",
        timeout: 3000,
      });
      const match = output
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find((value) => value && existsSync(value));
      if (match) {
        return match;
      }
    } catch {
      // Ignore PATH misses.
    }
  }

  return null;
}

/**
 * Check if a Chromium-based browser is available.
 */
export function isBrowserAvailable(): boolean {
  return detectBrowserPath() !== null;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

async function ensureBrowser(): Promise<Page> {
  if (browser && activePage) {
    try {
      await activePage.evaluate("1");
      return activePage;
    } catch {
      // Page disconnected, reset
      browser = null;
      activePage = null;
    }
  }
  throw new Error("Browser not open. Use the open action first.");
}

export async function openBrowser(url?: string): Promise<BrowserState> {
  const pup = await getPuppeteer();
  const executablePath = detectBrowserPath();
  if (!executablePath) {
    throw new Error(
      "No Chromium-based browser found. Install Chrome, Edge, or Brave.",
    );
  }

  // Close existing browser if any
  if (browser) {
    await closeBrowser();
  }

  const isCi =
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  const launchArgs = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    `--window-size=1280,900`,
  ];
  if (isCi) {
    launchArgs.push(
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    );
  }
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= BROWSER_LAUNCH_ATTEMPTS; attempt += 1) {
    tempUserDataDir = await mkdtemp(join(tmpdir(), "computeruse-browser-"));

    try {
      browser = await pup.default.launch({
        executablePath,
        headless: browserHeadless,
        userDataDir: tempUserDataDir,
        args: launchArgs,
        defaultViewport: { width: 1280, height: 900 },
      });

      const pages = await browser.pages();
      activePage = pages[0] ?? (await browser.newPage());

      if (url) {
        await activePage.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      }

      return {
        url: activePage.url(),
        title: await activePage.title(),
        isOpen: true,
        is_open: true,
      };
    } catch (error) {
      lastError = error;
      await closeBrowser();
      if (attempt < BROWSER_LAUNCH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to launch browser after retries: ${message}`);
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    browser = null;
    activePage = null;
  }

  if (tempUserDataDir) {
    try {
      await rm(tempUserDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    tempUserDataDir = null;
  }
}

// ── Navigation ──────────────────────────────────────────────────────────────

export async function navigateBrowser(url: string): Promise<BrowserState> {
  const page = await ensureBrowser();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return {
    url: page.url(),
    title: await page.title(),
    isOpen: true,
    is_open: true,
  };
}

// ── Click ───────────────────────────────────────────────────────────────────

export async function clickBrowser(
  selector?: string,
  coordinate?: [number, number],
  text?: string,
): Promise<void> {
  const page = await ensureBrowser();

  if (selector) {
    await page.click(selector);
  } else if (coordinate) {
    await page.mouse.click(coordinate[0], coordinate[1]);
  } else if (text) {
    const el = await page.evaluateHandle((t) => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.textContent?.includes(t)) {
          return node.parentElement;
        }
      }
      return null;
    }, text);
    const element = el.asElement() as
      | import("puppeteer-core").ElementHandle<Element>
      | null;
    if (!element) {
      await el.dispose();
      throw new Error(`Element with text "${text}" not found`);
    }
    await element.click();
    await el.dispose();
  } else {
    throw new Error(
      "selector, coordinate, or text is required for browser click",
    );
  }
}

// ── Type ────────────────────────────────────────────────────────────────────

export async function typeBrowser(
  text: string,
  selector?: string,
): Promise<void> {
  const page = await ensureBrowser();

  if (selector) {
    await page.click(selector);
    await page.type(selector, text);
  } else {
    await page.keyboard.type(text);
  }
}

// ── Scroll ──────────────────────────────────────────────────────────────────

export async function scrollBrowser(
  direction: "up" | "down",
  amount = 300,
): Promise<void> {
  const page = await ensureBrowser();
  const delta = direction === "up" ? -amount : amount;
  await page.evaluate((d) => window.scrollBy(0, d), delta);
}

// ── State ───────────────────────────────────────────────────────────────────

export async function getBrowserState(): Promise<BrowserState> {
  const page = await ensureBrowser();
  return {
    url: page.url(),
    title: await page.title(),
    isOpen: true,
    is_open: true,
  };
}

export async function getBrowserContext(): Promise<BrowserState> {
  return getBrowserState();
}

export async function getBrowserInfo(): Promise<BrowserInfo> {
  try {
    const state = await getBrowserState();
    return {
      success: true,
      isOpen: true,
      is_open: true,
      ...state,
    };
  } catch (error) {
    return {
      success: false,
      isOpen: false,
      is_open: false,
      url: "",
      title: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── DOM ─────────────────────────────────────────────────────────────────────

export async function getBrowserDom(): Promise<string> {
  const page = await ensureBrowser();
  const html = await page.content();
  // Limit to first 5000 chars to prevent context overflow
  return html.slice(0, 5000);
}

// ── Clickable Elements ──────────────────────────────────────────────────────

export async function getBrowserClickables(): Promise<ClickableElement[]> {
  const page = await ensureBrowser();
  return page.evaluate(() => {
    const selectors =
      "a, button, input, select, textarea, [role='button'], [role='link'], [onclick]";
    const elements = document.querySelectorAll(selectors);
    const result: Array<{
      tag: string;
      text: string;
      selector: string;
      type?: string;
      href?: string;
      ariaLabel?: string;
    }> = [];

    for (const el of elements) {
      if (result.length >= 50) break;
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent ?? "").trim().slice(0, 100);
      const id = el.id ? `#${el.id}` : "";
      const cls =
        el.className && typeof el.className === "string"
          ? `.${el.className.split(" ").filter(Boolean).join(".")}`
          : "";
      result.push({
        tag,
        text,
        selector: id || `${tag}${cls}`,
        type: (el as HTMLInputElement).type || undefined,
        href: (el as HTMLAnchorElement).href || undefined,
        ariaLabel: el.getAttribute("aria-label") || undefined,
      });
    }
    return result;
  });
}

// ── Screenshot ──────────────────────────────────────────────────────────────

export async function screenshotBrowser(): Promise<string> {
  const page = await ensureBrowser();
  const buffer = await page.screenshot({ encoding: "base64", type: "png" });
  return buffer as string;
}

// ── Execute JavaScript ──────────────────────────────────────────────────────

export async function executeBrowser(code: string): Promise<string> {
  const page = await ensureBrowser();
  try {
    const result = await page.evaluate(async (script) => {
      const AsyncFunction = Object.getPrototypeOf(async function placeholder() {
        // noop
      }).constructor as new (
        ...args: string[]
      ) => (...fnArgs: unknown[]) => Promise<unknown>;
      const fn = new AsyncFunction(script);
      return await fn();
    }, code);
    return renderPlainData(result);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function renderPlainData(value: unknown, indent = 0): string {
  const prefix = "  ".repeat(indent);
  if (value === null || value === undefined) {
    return "none";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "items[0]:";
    }
    return [
      `items[${value.length}]:`,
      ...value.map((item) => `${prefix}- ${renderPlainData(item, indent + 1)}`),
    ].join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nestedValue]) => {
        if (nestedValue && typeof nestedValue === "object") {
          return `${key}:\n${renderPlainData(nestedValue, indent + 1)}`;
        }
        return `${key}: ${renderPlainData(nestedValue, indent + 1)}`;
      })
      .join("\n");
  }
  return String(value);
}

// ── Wait ────────────────────────────────────────────────────────────────────

export async function waitBrowser(
  selector?: string,
  text?: string,
  timeout = 5000,
): Promise<void> {
  const page = await ensureBrowser();
  if (selector) {
    await page.waitForSelector(selector, { timeout });
  } else if (text) {
    await page.waitForFunction(
      (t) => document.body.textContent?.includes(t),
      { timeout },
      text,
    );
  } else {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(timeout, 5000)),
    );
  }
}

export async function browserWait(
  selector?: string,
  text?: string,
  timeout = 5000,
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    await waitBrowser(selector, text, timeout);
    if (selector) {
      return { success: true, message: `Element "${selector}" found` };
    }
    if (text) {
      return { success: true, message: `Text "${text}" found on page` };
    }
    return { success: true, message: `Waited ${Math.min(timeout, 5000)}ms` };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Tab Management ──────────────────────────────────────────────────────────

export async function listBrowserTabs(): Promise<BrowserTab[]> {
  if (!browser) throw new Error("Browser not open.");
  const pages = await browser.pages();
  const tabs: BrowserTab[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    tabs.push({
      id: String(i),
      url: page.url(),
      title: await page.title(),
      active: page === activePage,
    });
  }
  return tabs;
}

export async function openBrowserTab(url?: string): Promise<BrowserTab> {
  if (!browser) throw new Error("Browser not open.");
  const page = await browser.newPage();
  activePage = page;
  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  const pages = await browser.pages();
  return {
    id: String(pages.indexOf(page)),
    url: page.url(),
    title: await page.title(),
    active: true,
  };
}

export async function closeBrowserTab(tabId: string): Promise<void> {
  if (!browser) throw new Error("Browser not open.");
  const pages = await browser.pages();
  const idx = Number.parseInt(tabId, 10);
  const page = pages[idx];
  if (!page) throw new Error(`Tab ${tabId} not found.`);
  if (page === activePage) {
    // Switch to another tab before closing
    activePage = pages.find((p) => p !== page) ?? null;
  }
  await page.close();
}

export async function switchBrowserTab(tabId: string): Promise<BrowserState> {
  if (!browser) throw new Error("Browser not open.");
  const pages = await browser.pages();
  const idx = Number.parseInt(tabId, 10);
  const page = pages[idx];
  if (!page) throw new Error(`Tab ${tabId} not found.`);
  activePage = page;
  await page.bringToFront();
  return {
    url: page.url(),
    title: await page.title(),
    isOpen: true,
    is_open: true,
  };
}

export const browser_open = openBrowser;
export const browser_connect = openBrowser;
export const browser_navigate = navigateBrowser;
export const browser_click = clickBrowser;
export const browser_type = typeBrowser;
export const browser_scroll = scrollBrowser;
export const browser_close = closeBrowser;
export const browser_execute = executeBrowser;
export const browser_screenshot = screenshotBrowser;
export const browser_dom = getBrowserDom;
export const browser_get_dom = getBrowserDom;
export const browser_get_clickables = getBrowserClickables;
export const browser_state = getBrowserState;
export const browser_get_context = getBrowserContext;
export const browser_info = getBrowserInfo;
export const browser_wait = browserWait;
export const browser_list_tabs = listBrowserTabs;
export const browser_open_tab = openBrowserTab;
export const browser_close_tab = closeBrowserTab;
export const browser_switch_tab = switchBrowserTab;
