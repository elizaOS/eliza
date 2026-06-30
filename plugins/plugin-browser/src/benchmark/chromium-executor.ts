/**
 * Real-Chromium benchmark executor (#10333, follow-up to #9476).
 *
 * The JSDOM web-mode executor (`createWorkspaceBenchmarkExecutor` in adapter.ts)
 * drives the MiniWoB++ suite through `executeBrowserWorkspaceCommand` against a
 * scriptless JSDOM document — deterministic and CI-safe, but not a real engine.
 * This is the deferred "real Chromium" half: the SAME engine-agnostic
 * {@link BrowserCommandExecutor} seam, backed by a real Chromium/Edge rendering
 * the same routed pages and running the same `BenchmarkAction` → command mapping
 * — so the identical task suite + oracle/adversarial policies + DOM-grounded
 * reward run against an actual browser, not a DOM emulation.
 *
 * Engine: `puppeteer-core` (already a plugin-browser dependency — same as the
 * computeruse real lanes; no Chromium is bundled). The browser executable is
 * resolved from, in order: an explicit env override, a Playwright-installed
 * Chromium (the `bunx playwright install chromium` CI pattern), or a
 * system-installed Chrome/Edge/Brave. When none is found, callers skip the lane
 * (it is gated, exactly like the other `*.real.test.ts` lanes).
 *
 * puppeteer-core talks DevTools over a WebSocket (not the fd-pipe transport that
 * fails under Bun on Windows), so the lane runs on Linux CI and a Windows host.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "puppeteer-core";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "../workspace/browser-workspace-types.js";
import type { BrowserCommandExecutor } from "./types.js";

/** Default per-OS Playwright browser cache root (`PLAYWRIGHT_BROWSERS_PATH` wins). */
function defaultPlaywrightBrowsersDir(): string {
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "ms-playwright",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "ms-playwright");
  }
  return join(homedir(), ".cache", "ms-playwright");
}

/**
 * Candidate relative chrome binaries inside a Playwright `chromium-<rev>` dir.
 * Playwright has renamed these across versions (`chrome-win` → `chrome-win64`,
 * `chrome-linux` → occasionally `chrome-linux64`, arm64 mac variants), so we try
 * every known layout rather than pin one.
 */
function playwrightChromeLeaves(): string[] {
  if (process.platform === "win32") {
    return [
      join("chrome-win64", "chrome.exe"),
      join("chrome-win", "chrome.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      join("chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
    ];
  }
  return [join("chrome-linux", "chrome"), join("chrome-linux64", "chrome")];
}

function findPlaywrightChromium(): string | null {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ||
    defaultPlaywrightBrowsersDir();
  if (!existsSync(root)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(root).filter((d) => d.startsWith("chromium-"));
  } catch {
    return null;
  }
  // Highest build revision first (lexicographic is fine for zero-padded revs).
  dirs.sort().reverse();
  const leaves = playwrightChromeLeaves();
  for (const dir of dirs) {
    for (const leaf of leaves) {
      const candidate = join(root, dir, leaf);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** System Chrome/Edge/Brave candidates (mirrors plugin-computeruse's detector). */
function systemBrowserCandidates(): string[] {
  if (process.platform === "win32") {
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const pfx86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    return [
      join(pf, "Google\\Chrome\\Application\\chrome.exe"),
      join(pfx86, "Google\\Chrome\\Application\\chrome.exe"),
      join(local, "Google\\Chrome\\Application\\chrome.exe"),
      join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pfx86, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
    "/snap/bin/chromium",
  ];
}

/**
 * Resolve a Chromium-family executable for the real benchmark lane, or `null`
 * when none is installed (caller skips). Order: explicit override →
 * Playwright-installed Chromium → system Chrome/Edge/Brave.
 */
export function resolveChromiumExecutable(): string | null {
  for (const override of [
    process.env.ELIZA_BENCHMARK_CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ]) {
    if (override?.trim() && existsSync(override.trim())) return override.trim();
  }
  const playwright = findPlaywrightChromium();
  if (playwright) return playwright;
  for (const candidate of systemBrowserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const HTML_PAGE_FALLBACK =
  "<!doctype html><html><head><title></title></head><body></body></html>";

function evalGet(
  page: Page,
  getMode: string,
  selector?: string,
): Promise<unknown> {
  switch (getMode) {
    case "value":
      return page.$eval(
        selector ?? ":root",
        (el) => (el as HTMLInputElement).value ?? "",
      );
    case "checked":
      return page.$eval(selector ?? ":root", (el) =>
        Boolean((el as HTMLInputElement).checked),
      );
    case "text":
      return page.$eval(
        selector ?? "body",
        (el) => (el as HTMLElement).innerText ?? el.textContent ?? "",
      );
    case "count":
      return page.$$(selector ?? ":root").then((els) => els.length);
    case "title":
      return page.title();
    case "url":
      return Promise.resolve(page.url());
    case "html":
      return page.$eval(selector ?? "html", (el) => el.outerHTML);
    case "enabled":
      return page.$eval(
        selector ?? ":root",
        (el) => !(el as HTMLInputElement).disabled,
      );
    case "attr":
      return Promise.resolve("");
    default:
      return Promise.resolve("");
  }
}

/**
 * The real-Chromium engine. Launches one shared browser; hands out one isolated
 * `BrowserContext`+`Page` per episode (the `makeExecutor` the suite runner
 * calls). Each page intercepts every request and serves the task's routed HTML
 * — there is no external network, exactly like the JSDOM lane's `network route`.
 */
export interface ChromiumBenchmarkEngine {
  readonly executablePath: string;
  makeExecutor(): Promise<{
    executor: BrowserCommandExecutor;
    dispose: () => Promise<void>;
  }>;
  /** Latest page handed out (for evidence capture: screenshot/PDF). */
  currentPage(): Page | null;
  close(): Promise<void>;
}

export async function createChromiumBenchmarkEngine(opts?: {
  executablePath?: string;
  headless?: boolean;
  launchTimeoutMs?: number;
}): Promise<ChromiumBenchmarkEngine> {
  const executablePath = opts?.executablePath ?? resolveChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      "No Chromium-family browser found for the real benchmark lane. " +
        "Install Chrome/Edge/Brave, run `bunx playwright install chromium`, or " +
        "set ELIZA_BENCHMARK_CHROMIUM_PATH.",
    );
  }
  const puppeteer = await import("puppeteer-core");
  const browser: Browser = await puppeteer.launch({
    executablePath,
    headless: opts?.headless ?? true,
    timeout: opts?.launchTimeoutMs ?? 300_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  let latestPage: Page | null = null;

  async function makeExecutor() {
    const context: BrowserContext = await browser.createBrowserContext();
    const page = await context.newPage();
    latestPage = page;
    const routes = new Map<string, string>();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      const html =
        routes.get(url) ??
        routes.get(url.replace(/\/$/, "")) ??
        routes.get(`${url}/`);
      void req
        .respond({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: html ?? HTML_PAGE_FALLBACK,
        })
        .catch(() => {
          // Request may already be handled/aborted on rapid navigation.
        });
    });

    const web: BrowserWorkspaceCommandResult["mode"] = "web";
    const executor: BrowserCommandExecutor = {
      engine: "chromium",
      execute: async (
        command: BrowserWorkspaceCommand,
      ): Promise<BrowserWorkspaceCommandResult> => {
        const base = { mode: web, subaction: command.subaction };
        switch (command.subaction) {
          case "network": {
            if (command.networkAction === "route" && command.url) {
              routes.set(
                command.url,
                command.responseBody ?? HTML_PAGE_FALLBACK,
              );
            }
            return base;
          }
          case "navigate": {
            if (command.url) {
              await page
                .goto(command.url, { waitUntil: "load" })
                .catch(() => {});
            }
            return base;
          }
          case "snapshot": {
            const value = {
              url: page.url(),
              title: await page.title().catch(() => ""),
              bodyText: await page
                .$eval("body", (el) => (el as HTMLElement).innerText ?? "")
                .catch(() => ""),
            };
            return { ...base, value };
          }
          case "click": {
            if (!command.selector) return base;
            await page
              .waitForSelector(command.selector, { timeout: 4000 })
              .catch(() => {});
            const navigation = page
              .waitForNavigation({ waitUntil: "load", timeout: 1500 })
              .catch(() => null);
            await page.click(command.selector).catch(() => {});
            await navigation;
            return base;
          }
          case "type": {
            if (command.selector) {
              await page
                .waitForSelector(command.selector, { timeout: 4000 })
                .catch(() => {});
              await page
                .type(command.selector, command.value ?? "")
                .catch(() => {});
            }
            return base;
          }
          case "fill": {
            if (command.selector) {
              await page
                .waitForSelector(command.selector, { timeout: 4000 })
                .catch(() => {});
              await page
                .$eval(command.selector, (el) => {
                  (el as HTMLInputElement).value = "";
                })
                .catch(() => {});
              await page
                .type(command.selector, command.value ?? "")
                .catch(() => {});
            }
            return base;
          }
          case "check":
          case "uncheck": {
            if (command.selector) {
              await page
                .waitForSelector(command.selector, { timeout: 4000 })
                .catch(() => {});
              const isChecked = await page
                .$eval(command.selector, (el) =>
                  Boolean((el as HTMLInputElement).checked),
                )
                .catch(() => false);
              const want = command.subaction === "check";
              if (isChecked !== want) {
                await page.click(command.selector).catch(() => {});
              }
            }
            return base;
          }
          case "press": {
            if (command.selector) {
              await page.focus(command.selector).catch(() => {});
            }
            if (command.key) {
              const navigation = page
                .waitForNavigation({ waitUntil: "load", timeout: 1500 })
                .catch(() => null);
              await page.keyboard
                .press(command.key as Parameters<Page["keyboard"]["press"]>[0])
                .catch(() => {});
              await navigation;
            }
            return base;
          }
          case "get": {
            const value = await evalGet(
              page,
              command.getMode ?? "text",
              command.selector,
            ).catch(() => "");
            return { ...base, value };
          }
          default:
            return base;
        }
      },
    };
    return {
      executor,
      dispose: async () => {
        if (latestPage === page) latestPage = null;
        await context.close().catch(() => {});
      },
    };
  }

  return {
    executablePath,
    makeExecutor,
    currentPage: () => latestPage,
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}
