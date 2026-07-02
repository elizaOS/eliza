/**
 * Real-Chromium benchmark executor (#10333, the "Needs CI infra" follow-up to
 * #9476).
 *
 * The deferred real-engine counterpart to `createWorkspaceBenchmarkExecutor`
 * (JSDOM web mode). It drives the SAME {@link BrowserBenchmarkAdapter} task
 * suite against a real Chromium via `puppeteer-core` — the adapter is
 * engine-agnostic ({@link BrowserCommandExecutor}), so this is a new executor,
 * not a rewrite. `report.engine` flips from `"jsdom-web"` to `"chromium"` and
 * every action runs through a real browser process, exactly mirroring how
 * plugin-computeruse's OSWorld `*.real.test.ts` lanes drive a real OS.
 *
 * Network is hard-sealed, like web mode: only the task's registered
 * `network route` pages are served (via puppeteer request interception); every
 * other request is aborted, so the reward stays grounded in the routed DOM and
 * no external site or page script can influence the run.
 *
 * Command semantics intentionally mirror `executeWebBrowserWorkspaceDomCommand`
 * (`browser-workspace-web.ts`): `type` appends, `fill` replaces, `check` sets
 * `checked = true`, `get value/checked/text/count/url/title` read observable DOM
 * state, a missing element throws a `target_missing`-tagged error, and `snapshot`
 * returns `{ url, title, bodyText }` (body text capped at 800 chars). That parity
 * is what lets the identical oracle sequences solve every task on both engines.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Browser, ElementHandle, HTTPRequest, Page } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "../workspace/browser-workspace-types.js";
import type { BrowserCommandExecutor } from "./types.js";

const SNAPSHOT_BODY_TEXT_CAP = 800;

/** Common system Chrome/Chromium install locations, checked as a last resort. */
const SYSTEM_CHROME_PATHS: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

const require = createRequire(import.meta.url);

function headlessShellCandidatesFor(chromiumPath: string): string[] {
  const normalized = chromiumPath.replaceAll("\\", "/");
  const match = normalized.match(/^(.*\/)chromium-(\d+)\//);
  if (!match) {
    return [];
  }
  const [, cacheRoot, revision] = match;
  const shellRoot = path.join(cacheRoot, `chromium_headless_shell-${revision}`);
  return [
    path.join(
      shellRoot,
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell",
    ),
    path.join(
      shellRoot,
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    ),
    path.join(
      shellRoot,
      "chrome-headless-shell-win64",
      "chrome-headless-shell.exe",
    ),
    path.join(shellRoot, "chrome-linux", "headless_shell"),
    path.join(shellRoot, "chrome-linux64", "headless_shell"),
    path.join(shellRoot, "chrome-win", "headless_shell.exe"),
  ];
}

export function resolveChromiumHeadlessShellExecutablePath(): string | null {
  for (const packageName of ["playwright-core", "playwright"] as const) {
    try {
      const playwright = require(packageName) as {
        chromium?: { executablePath?: () => string };
      };
      const playwrightPath = playwright.chromium?.executablePath?.();
      if (!playwrightPath) {
        continue;
      }
      for (const candidate of headlessShellCandidatesFor(playwrightPath)) {
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // Package not resolvable / no browser installed — try the next source.
    }
  }
  return null;
}

/**
 * Resolve a real Chromium executable for the gated lane, or `null` when none is
 * installed (the lane self-skips). Resolution order:
 *   1. `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` (explicit override),
 *   2. Playwright's Chromium headless shell when present (more stable for
 *      real screenshot capture under request interception),
 *   3. a Playwright-installed Chromium (the CI lane runs
 *      `bunx playwright install --with-deps chromium`, mirroring
 *      `scenario-pr.yml` `app-browser-core`),
 *   4. a system Chrome/Chromium/Edge install.
 */
export function resolveChromiumExecutablePath(): string | null {
  const override =
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    process.env.CHROME_PATH?.trim();
  if (override && existsSync(override)) {
    return override;
  }

  const headlessShell = resolveChromiumHeadlessShellExecutablePath();
  if (headlessShell) {
    return headlessShell;
  }

  for (const packageName of ["playwright-core", "playwright"] as const) {
    try {
      const playwright = require(packageName) as {
        chromium?: { executablePath?: () => string };
      };
      const playwrightPath = playwright.chromium?.executablePath?.();
      if (playwrightPath && existsSync(playwrightPath)) {
        return playwrightPath;
      }
    } catch {
      // Package not resolvable / no browser installed — try the next source.
    }
  }

  for (const candidate of SYSTEM_CHROME_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function targetMissingError(selector: string | undefined): Error {
  // Mirror web mode, which throws a bare `Error("Target element was not
  // found.")` (the adapter then classifies it as `command_failed`). Same
  // message keeps the `/not found|target/i` contract identical across engines.
  return new Error(
    `Target element was not found${selector ? `: ${selector}` : ""}.`,
  );
}

function requireSelector(command: BrowserWorkspaceCommand): string {
  const selector = command.selector?.trim();
  if (!selector) {
    throw targetMissingError(undefined);
  }
  return selector;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") && !url.endsWith("://") ? url.slice(0, -1) : url;
}

function noChromiumError(): Error {
  return new Error(
    "No Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH/CHROME_PATH " +
      "or run `bunx playwright install --with-deps chromium`.",
  );
}

function chromiumLaunchOptions(executablePath: string) {
  return {
    executablePath,
    headless: "shell" as const,
    // The default 30s browser-start / protocol timeouts are too tight on a
    // loaded CI box; bump them so a slow Chromium start isn't a flake.
    timeout: 60_000,
    protocolTimeout: 180_000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
}

/**
 * Launch ONE real Chromium for a whole benchmark suite. Pass the returned
 * `browser` into {@link createChromiumBenchmarkExecutor} per episode — a fresh
 * page is cheap, a fresh browser is not. Launching 30 browsers per suite both
 * blows the wall-clock and flakes the 30s WS-endpoint start under load; one
 * browser + one page-per-episode is the robust shape.
 */
export async function launchChromiumBenchmarkBrowser(
  options: { executablePath?: string } = {},
): Promise<{ browser: Browser; close: () => Promise<void> }> {
  const executablePath =
    options.executablePath ?? resolveChromiumExecutablePath();
  if (!executablePath) {
    throw noChromiumError();
  }
  const browser = await puppeteer.launch(chromiumLaunchOptions(executablePath));
  return {
    browser,
    close: async () => {
      await browser.close().catch(() => {});
    },
  };
}

interface ChromiumBenchmarkExecutorOptions {
  /** Reuse an existing browser (from {@link launchChromiumBenchmarkBrowser}). */
  browser?: Browser;
  /** Override the Chromium binary (else {@link resolveChromiumExecutablePath}). */
  executablePath?: string;
  /** Per-action navigation settle budget (ms). */
  navigationTimeoutMs?: number;
}

/**
 * Build a {@link BrowserCommandExecutor} backed by a real Chromium page. When an
 * `options.browser` is supplied (the suite shape), the executor opens a fresh
 * page on it and `dispose()` closes only that page; otherwise it launches its
 * own browser and `dispose()` closes the whole browser (standalone shape).
 *
 * The live puppeteer {@link Page} is also returned so callers that need the real
 * screenshot / element-bbox path (the web-grounding lane, #10333) can read it
 * while the page is mounted. The benchmark runner ignores the extra field — the
 * `{ executor, dispose }` shape it consumes is structurally satisfied.
 */
export async function createChromiumBenchmarkExecutor(
  options: ChromiumBenchmarkExecutorOptions = {},
): Promise<{
  executor: BrowserCommandExecutor;
  page: Page;
  dispose: () => Promise<void>;
}> {
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 5000;

  let ownedBrowser: Browser | null = null;
  let browser: Browser;
  if (options.browser) {
    browser = options.browser;
  } else {
    const executablePath =
      options.executablePath ?? resolveChromiumExecutablePath();
    if (!executablePath) {
      throw noChromiumError();
    }
    ownedBrowser = await puppeteer.launch(
      chromiumLaunchOptions(executablePath),
    );
    browser = ownedBrowser;
  }

  const page: Page = await browser.newPage();

  // Network seal: serve only registered routes, abort everything else. This is
  // the puppeteer analog of web mode's `runtime.networkRoutes` + no-external
  // policy — the agent cannot reach a real site or load a page script.
  const routes = new Map<string, string>();
  await page.setRequestInterception(true);
  page.on("request", (request: HTTPRequest) => {
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    const url = request.url();
    const html = routes.get(url) ?? routes.get(stripTrailingSlash(url));
    if (html != null) {
      void request
        .respond({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: html,
        })
        .catch(() => {});
      return;
    }
    void request.abort().catch(() => {});
  });

  async function resolveHandle(
    selector: string,
  ): Promise<ElementHandle<Element>> {
    const handle = await page.$(selector);
    if (!handle) {
      throw targetMissingError(selector);
    }
    return handle;
  }

  const result = (
    subaction: BrowserWorkspaceCommand["subaction"],
    value: unknown,
  ): BrowserWorkspaceCommandResult => ({
    mode: "chromium",
    subaction,
    value,
  });

  async function execute(
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult> {
    switch (command.subaction) {
      case "network": {
        if (command.networkAction === "route") {
          const url = command.url?.trim();
          if (!url) {
            throw new Error("network route requires url.");
          }
          routes.set(url, command.responseBody ?? "");
          return result(command.subaction, { pattern: url });
        }
        if (command.networkAction === "unroute") {
          if (command.url?.trim()) {
            routes.delete(command.url.trim());
          } else {
            routes.clear();
          }
          return result(command.subaction, { routes: routes.size });
        }
        return result(command.subaction, null);
      }

      case "open":
      case "navigate": {
        const url = command.url?.trim();
        if (!url) {
          throw new Error(`${command.subaction} requires url.`);
        }
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeoutMs * 4,
        });
        return result(command.subaction, { url: page.url() });
      }

      case "snapshot":
      case "inspect": {
        const bodyText = await page.evaluate(
          () => document.body?.innerText ?? "",
        );
        return result(command.subaction, {
          url: page.url(),
          title: await page.title(),
          bodyText: normalizeText(bodyText).slice(0, SNAPSHOT_BODY_TEXT_CAP),
        });
      }

      case "click":
      case "dblclick": {
        const handle = await resolveHandle(requireSelector(command));
        const navigates = await handle.evaluate(
          (el) =>
            el.tagName === "A" &&
            !!(el as HTMLAnchorElement).getAttribute("href"),
        );
        const clickOptions =
          command.subaction === "dblclick" ? { clickCount: 2 } : {};
        if (navigates) {
          await Promise.all([
            page
              .waitForNavigation({
                waitUntil: "domcontentloaded",
                timeout: navigationTimeoutMs,
              })
              .catch(() => null),
            handle.click(clickOptions),
          ]);
        } else {
          await handle.click(clickOptions);
        }
        await handle.dispose();
        return result(command.subaction, { url: page.url() });
      }

      case "type": {
        const handle = await resolveHandle(requireSelector(command));
        await handle.type(command.value ?? "");
        const value = await handle.evaluate(
          (el) => (el as HTMLInputElement).value ?? "",
        );
        await handle.dispose();
        return result(command.subaction, { value });
      }

      case "fill": {
        const handle = await resolveHandle(requireSelector(command));
        const next = command.value ?? "";
        await handle.evaluate((el, v) => {
          const control = el as HTMLInputElement;
          control.value = v;
          control.dispatchEvent(new Event("input", { bubbles: true }));
          control.dispatchEvent(new Event("change", { bubbles: true }));
        }, next);
        await handle.dispose();
        return result(command.subaction, { value: next });
      }

      case "check":
      case "uncheck": {
        const handle = await resolveHandle(requireSelector(command));
        const checked = command.subaction === "check";
        await handle.evaluate((el, want) => {
          const input = el as HTMLInputElement;
          input.checked = want;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, checked);
        await handle.dispose();
        return result(command.subaction, { checked });
      }

      case "select": {
        const handle = await resolveHandle(requireSelector(command));
        const wanted = command.value ?? "";
        const selected = await handle.evaluate((el, value) => {
          if (el.tagName !== "SELECT") {
            throw new Error("select requires a select target.");
          }
          const select = el as HTMLSelectElement;
          const option = Array.from(select.options).find((candidate) => {
            const text = (candidate.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim();
            return candidate.value === value || text === value;
          });
          if (!option) {
            throw new Error(`Select option was not found: ${value}`);
          }
          select.value = option.value;
          option.selected = true;
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return {
            value: select.value,
            text: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
          };
        }, wanted);
        await handle.dispose();
        return result(command.subaction, selected);
      }

      case "press": {
        if (command.selector?.trim()) {
          const handle = await resolveHandle(command.selector.trim());
          await handle.focus();
          await handle.dispose();
        }
        const key = command.key?.trim() || "Enter";
        await page.keyboard.press(
          key as Parameters<Page["keyboard"]["press"]>[0],
        );
        return result(command.subaction, { key });
      }

      case "focus": {
        const handle = await resolveHandle(requireSelector(command));
        await handle.focus();
        await handle.dispose();
        return result(command.subaction, { focused: true });
      }

      case "get": {
        switch (command.getMode) {
          case "url":
            return result(command.subaction, page.url());
          case "title":
            return result(command.subaction, await page.title());
          case "count": {
            const selector = requireSelector(command);
            const handles = await page.$$(selector);
            await Promise.all(handles.map((h) => h.dispose()));
            return result(command.subaction, handles.length);
          }
          case "value": {
            const handle = await resolveHandle(requireSelector(command));
            const value = await handle.evaluate(
              (el) => (el as HTMLInputElement).value ?? "",
            );
            await handle.dispose();
            return result(command.subaction, value);
          }
          case "checked": {
            const handle = await resolveHandle(requireSelector(command));
            const checked = await handle.evaluate((el) =>
              el.tagName === "INPUT"
                ? Boolean((el as HTMLInputElement).checked)
                : el.tagName === "OPTION"
                  ? Boolean((el as HTMLOptionElement).selected)
                  : false,
            );
            await handle.dispose();
            return result(command.subaction, checked);
          }
          case "text":
          case undefined: {
            const handle = await resolveHandle(requireSelector(command));
            const text = await handle.evaluate((el) => el.textContent ?? "");
            await handle.dispose();
            return result(command.subaction, normalizeText(text));
          }
          case "html": {
            const handle = await resolveHandle(requireSelector(command));
            const html = await handle.evaluate((el) => el.innerHTML);
            await handle.dispose();
            return result(command.subaction, html);
          }
          case "attr": {
            const attribute = command.attribute?.trim();
            if (!attribute) {
              throw new Error("get attr requires attribute.");
            }
            const handle = await resolveHandle(requireSelector(command));
            const attr = await handle.evaluate(
              (el, name) => el.getAttribute(name),
              attribute,
            );
            await handle.dispose();
            return result(command.subaction, attr);
          }
          case "enabled":
          case "visible": {
            const handle = await resolveHandle(requireSelector(command));
            const value = await handle.evaluate((el, mode) => {
              if (mode === "enabled") {
                return "disabled" in el
                  ? !(el as HTMLButtonElement).disabled
                  : true;
              }
              const rect = (el as HTMLElement).getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }, command.getMode);
            await handle.dispose();
            return result(command.subaction, value);
          }
          default:
            throw new Error(
              `Unsupported chromium get mode: ${String(command.getMode)}`,
            );
        }
      }

      case "state":
        return result(command.subaction, { url: page.url() });

      default:
        throw new Error(
          `Unsupported chromium benchmark subaction: ${command.subaction}`,
        );
    }
  }

  const executor: BrowserCommandExecutor = {
    engine: "chromium",
    execute,
  };

  return {
    executor,
    page,
    dispose: async () => {
      await page.close().catch(() => {});
      if (ownedBrowser) {
        await ownedBrowser.close().catch(() => {});
      }
    },
  };
}

/**
 * A benchmark "engine": one launched Chromium browser plus a `makeExecutor`
 * seam that opens a fresh page-backed executor per episode and a `currentPage`
 * accessor for the lanes that need the real screenshot / element-bbox path
 * (web-grounding, #10333). This is a thin convenience wrapper over
 * {@link launchChromiumBenchmarkBrowser} + {@link createChromiumBenchmarkExecutor}
 * — `engine: "chromium"`, the network seal, and the fail-loud no-Chromium error
 * all come straight from those primitives; nothing here weakens them.
 */
export interface ChromiumBenchmarkEngine {
  /** The resolved Chromium binary this engine launched. */
  readonly executablePath: string;
  /** Open a fresh page-backed executor on the shared browser. */
  makeExecutor(): Promise<{
    executor: BrowserCommandExecutor;
    dispose: () => Promise<void>;
  }>;
  /** The live page of the most recent {@link makeExecutor}, or `null`. */
  currentPage(): Page | null;
  /** Close the underlying browser. */
  close(): Promise<void>;
}

/**
 * Launch a {@link ChromiumBenchmarkEngine}. Resolves the Chromium binary
 * up-front (fail-loud via {@link launchChromiumBenchmarkBrowser} when none is
 * installed) so callers can record the exact executable used.
 */
export async function createChromiumBenchmarkEngine(
  options: { headless?: boolean; executablePath?: string } = {},
): Promise<ChromiumBenchmarkEngine> {
  const executablePath =
    options.executablePath ?? resolveChromiumExecutablePath();
  if (!executablePath) {
    throw noChromiumError();
  }
  const { browser, close } = await launchChromiumBenchmarkBrowser({
    executablePath,
  });

  let page: Page | null = null;
  return {
    executablePath,
    async makeExecutor() {
      const created = await createChromiumBenchmarkExecutor({ browser });
      page = created.page;
      return { executor: created.executor, dispose: created.dispose };
    },
    currentPage() {
      return page;
    },
    close,
  };
}

/**
 * Alias for {@link resolveChromiumExecutablePath} used by the web-grounding lane
 * (#10333). Same resolution order; same `null` skip-guard.
 */
export const resolveChromiumExecutable = resolveChromiumExecutablePath;
