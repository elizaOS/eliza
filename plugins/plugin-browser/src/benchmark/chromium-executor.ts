/**
 * Real-Chromium benchmark executor (#10333 / #9476 secondary gap).
 *
 * The JSDOM web-mode executor (`createWorkspaceBenchmarkExecutor`) proves the
 * MiniWoB++ suite is wired through the real BROWSER command router; this drives
 * the SAME suite against a REAL Chromium engine (Edge/Chrome via puppeteer-core)
 * — closing the deferred "real-engine lane" from #9476's Definition of Done.
 *
 * It implements the same engine-agnostic {@link BrowserCommandExecutor} seam the
 * adapter already drives, so no benchmark/task/runner code changes: the adapter
 * issues `network route` / `navigate` / `click` / `type` / `check` / `get`
 * commands and this executor maps each to a puppeteer page action. Routed task
 * HTML is served via puppeteer **request interception** (the exact analog of the
 * web-mode `network route` interceptor) — no external network, no local server,
 * fully deterministic.
 *
 * gated: requires a Chromium binary (auto-detected, or `PUPPETEER_EXECUTABLE_PATH`
 * / `BENCHMARK_CHROMIUM_PATH`). Used by the `*.real.test.ts` lane + the runnable
 * harness, never the default CI lane.
 */

import { existsSync } from "node:fs";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "../workspace/browser-workspace-types.js";
import type { BrowserCommandExecutor } from "./types.js";

// Minimal puppeteer-core surface we use (kept local so the benchmark barrel
// doesn't hard-depend on puppeteer types in the default build).
interface PptrRequest {
  url(): string;
  respond(r: {
    status: number;
    contentType: string;
    body: string;
  }): Promise<void>;
  continue(): Promise<void>;
}
interface PptrPage {
  setRequestInterception(on: boolean): Promise<void>;
  on(event: "request", handler: (req: PptrRequest) => void): void;
  goto(url: string, opts?: object): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: puppeteer evaluate is generically typed
  evaluate(fn: (...a: any[]) => any, ...args: any[]): Promise<any>;
  screenshot(opts: { path?: string; type?: string }): Promise<Buffer>;
  waitForNavigation(opts?: object): Promise<unknown>;
}
interface PptrBrowser {
  newPage(): Promise<PptrPage>;
  close(): Promise<void>;
}
interface PptrModule {
  launch(opts: object): Promise<PptrBrowser>;
}

const CHROMIUM_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.BENCHMARK_CHROMIUM_PATH,
  process.env.CHROME_BIN,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** Resolve a Chromium-family executable, or null if none is installed. */
export function resolveChromiumExecutable(): string | null {
  for (const p of CHROMIUM_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Build a {@link BrowserCommandExecutor} backed by a real Chromium engine.
 * `dispose()` closes the browser. Throws if no Chromium binary is found.
 */
export async function createChromiumBenchmarkExecutor(
  options: { executablePath?: string; headless?: boolean } = {},
): Promise<{
  executor: BrowserCommandExecutor;
  page: PptrPage;
  screenshot: (path: string) => Promise<void>;
  dispose: () => Promise<void>;
}> {
  const executablePath = options.executablePath ?? resolveChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      "No Chromium binary found. Set PUPPETEER_EXECUTABLE_PATH / BENCHMARK_CHROMIUM_PATH.",
    );
  }
  const puppeteer = (await import("puppeteer-core")) as unknown as {
    default: PptrModule;
  };
  const browser = await puppeteer.default.launch({
    executablePath,
    headless: options.headless ?? true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const page = await browser.newPage();

  // Route table populated by `network route` commands — the puppeteer analog of
  // the web-mode network interceptor. A request whose URL is registered is
  // fulfilled from the table; anything else continues (and, for wob.test, 404s).
  const routes = new Map<string, string>();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const html = routes.get(req.url());
    if (html !== undefined) {
      void req.respond({ status: 200, contentType: "text/html", body: html });
    } else if (req.url().includes("wob.test")) {
      // Unrouted task URL → empty page (keeps a click on a missing route inert).
      void req.respond({
        status: 404,
        contentType: "text/html",
        body: "<html><body>404</body></html>",
      });
    } else {
      void req.continue();
    }
  });

  const execute = async (
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult> => {
    const mode = "chromium" as BrowserWorkspaceCommandResult["mode"];
    switch (command.subaction) {
      case "network": {
        if (command.networkAction === "route" && command.url) {
          routes.set(command.url, command.responseBody ?? "");
        }
        return { mode, subaction: command.subaction };
      }
      case "navigate": {
        if (command.url) {
          await page.goto(command.url, { waitUntil: "domcontentloaded" });
        }
        return {
          mode,
          subaction: command.subaction,
          tab: { id: "chromium", url: page.url(), title: await page.title() },
        } as BrowserWorkspaceCommandResult;
      }
      case "click": {
        const before = page.url();
        await clickAndMaybeNavigate(page, command.selector ?? "");
        // Settle a possible navigation triggered by an <a>/submit.
        if (page.url() !== before) {
          /* navigated */
        }
        return {
          mode,
          subaction: command.subaction,
          tab: { id: "chromium", url: page.url(), title: await page.title() },
        } as BrowserWorkspaceCommandResult;
      }
      case "type":
      case "fill": {
        const selector = command.selector ?? "";
        const value = command.value ?? "";
        if (command.subaction === "fill") {
          await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            if (el) el.value = "";
          }, selector);
        }
        await page.type(selector, value);
        const got = await page.evaluate((sel: string) => {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          return el ? el.value : null;
        }, selector);
        return {
          mode,
          subaction: command.subaction,
          value: { selector, value: got },
        };
      }
      case "check":
      case "uncheck": {
        const selector = command.selector ?? "";
        const want = command.subaction === "check";
        const checked = await page.evaluate(
          (sel: string, w: boolean) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            if (!el) throw new Error("Target element was not found.");
            if (el.checked !== w) el.click();
            return el.checked;
          },
          selector,
          want,
        );
        return {
          mode,
          subaction: command.subaction,
          value: { selector, checked },
        };
      }
      case "snapshot": {
        const value = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          bodyText: document.body?.innerText ?? "",
        }));
        return { mode, subaction: command.subaction, value };
      }
      case "get": {
        const value = await readGet(page, command);
        return { mode, subaction: command.subaction, value };
      }
      default:
        return { mode, subaction: command.subaction };
    }
  };

  const executor: BrowserCommandExecutor = { engine: "chromium", execute };

  return {
    executor,
    page,
    screenshot: async (path: string) => {
      await page.screenshot({ path, type: "png" });
    },
    dispose: async () => {
      await browser.close();
    },
  };
}

/** Click a selector; if it is a link/submit, wait for the resulting navigation. */
async function clickAndMaybeNavigate(
  page: PptrPage,
  selector: string,
): Promise<void> {
  if (!selector) throw new Error("Target element was not found.");
  const exists = await page.evaluate(
    (sel: string) => !!document.querySelector(sel),
    selector,
  );
  if (!exists) throw new Error("Target element was not found.");
  const isNav = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return (
      el.tagName === "A" ||
      (el as HTMLElement).getAttribute?.("type") === "submit" ||
      !!el.closest("form")
    );
  }, selector);
  if (isNav) {
    await Promise.all([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded" })
        .catch(() => undefined),
      page.click(selector),
    ]);
  } else {
    await page.click(selector);
  }
}

async function readGet(
  page: PptrPage,
  command: BrowserWorkspaceCommand,
): Promise<unknown> {
  const mode = command.getMode;
  if (mode === "title") return page.title();
  if (mode === "url") return page.url();
  const selector = command.selector ?? "";
  return page.evaluate(
    (sel: string, m: string | undefined, attr: string | undefined) => {
      if (m === "count") return document.querySelectorAll(sel).length;
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      if (m === "checked") return Boolean((el as HTMLInputElement).checked);
      if (m === "value") return (el as HTMLInputElement).value ?? "";
      if (m === "attr") return attr ? el.getAttribute(attr) : null;
      if (m === "html") return el.innerHTML;
      return (el.textContent ?? "").trim();
    },
    selector,
    mode,
    command.attribute,
  );
}

export { asString as __asString_chromium };
