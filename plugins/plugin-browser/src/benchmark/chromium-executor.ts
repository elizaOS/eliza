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

/**
 * Resolve a real Chromium executable for the gated lane, or `null` when none is
 * installed (the lane self-skips). Resolution order:
 *   1. `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` (explicit override),
 *   2. a Playwright-installed Chromium (the CI lane runs
 *      `bunx playwright install --with-deps chromium`, mirroring
 *      `scenario-pr.yml` `app-browser-core`),
 *   3. a system Chrome/Chromium/Edge install.
 */
export function resolveChromiumExecutablePath(): string | null {
  const override =
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    process.env.CHROME_PATH?.trim();
  if (override && existsSync(override)) {
    return override;
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
    // Old ("shell") headless: new-headless `Page.captureScreenshot` crashes the
    // renderer ("Target closed") on an intercepted/navigated page in this
    // environment, which the grounding lane needs; shell headless screenshots
    // reliably and drives request interception + navigation the same way.
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
 */
export async function createChromiumBenchmarkExecutor(
  options: ChromiumBenchmarkExecutorOptions = {},
): Promise<{
  executor: BrowserCommandExecutor;
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
    // Seal external network with a graceful empty 404 rather than `abort()`:
    // aborting an in-flight request while the renderer is compositing can crash
    // the page on `captureScreenshot` ("Target closed"). A 404 blocks the
    // content just as effectively without destabilising the renderer.
    void request
      .respond({ status: 404, contentType: "text/plain", body: "" })
      .catch(() => {});
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

      case "screenshot": {
        // Real PNG bytes from the real browser — the grounding lane's image. The
        // viewport dims are returned so a grounder can reason in image pixels.
        // `Page.captureScreenshot` crashes the renderer ("Target closed") while
        // request interception is ENABLED in this Chromium, so toggle it off
        // across the capture (no page request fires during a static screenshot)
        // and restore it after — the `request` handler stays attached.
        await page.setRequestInterception(false).catch(() => {});
        let data = "";
        try {
          data = (await page.screenshot({
            encoding: "base64",
            fullPage: false,
          })) as string;
        } finally {
          await page.setRequestInterception(true).catch(() => {});
        }
        const viewport = page.viewport();
        return {
          mode: "chromium",
          subaction: command.subaction,
          snapshot: { data },
          value: {
            width: viewport?.width ?? 0,
            height: viewport?.height ?? 0,
          },
        };
      }

      case "mouse": {
        // Coordinate-level pointer ops for the grounding lane's click path: a
        // grounder predicts (x, y) in image pixels, we click there for real.
        const action = command.mouseAction ?? "move";
        const x = command.x ?? 0;
        const y = command.y ?? 0;
        if (action === "click") {
          // A coordinate click may land on a navigating element; wait for the
          // navigation to settle (bounded) so a follow-up `get url` is accurate.
          // No navigation (a miss / non-nav target) resolves null after the
          // short timeout.
          const nav = page
            .waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: navigationTimeoutMs,
            })
            .catch(() => null);
          await page.mouse.click(x, y);
          await nav;
        } else if (action === "down") {
          await page.mouse.down();
        } else if (action === "up") {
          await page.mouse.up();
        } else {
          await page.mouse.move(x, y);
        }
        return result(command.subaction, { action, x, y, url: page.url() });
      }

      case "click":
      case "dblclick": {
        const handle = await resolveHandle(requireSelector(command));
        const navigates = await handle.evaluate(
          (el) =>
            el.tagName === "A" &&
            !!(el as HTMLAnchorElement).getAttribute("href"),
        );
        if (navigates) {
          await Promise.all([
            page
              .waitForNavigation({
                waitUntil: "domcontentloaded",
                timeout: navigationTimeoutMs,
              })
              .catch(() => null),
            command.subaction === "dblclick"
              ? handle.click({ clickCount: 2 })
              : handle.click(),
          ]);
        } else {
          await handle.click(
            command.subaction === "dblclick" ? { clickCount: 2 } : {},
          );
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
        // Mirror web mode: match an <option> by value OR visible text, set it,
        // dispatch change. Used by the Mind2Web SELECT op.
        const handle = await resolveHandle(requireSelector(command));
        const want = command.value ?? "";
        const value = await handle.evaluate((el, target) => {
          const select = el as HTMLSelectElement;
          const option = Array.from(select.options).find(
            (o) => o.value === target || (o.textContent ?? "").trim() === target,
          );
          if (!option) {
            return null;
          }
          select.value = option.value;
          option.selected = true;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return select.value;
        }, want);
        await handle.dispose();
        if (value === null) {
          throw new Error(`Select option was not found: ${want}`);
        }
        return result(command.subaction, { value });
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
          case "box": {
            const handle = await resolveHandle(requireSelector(command));
            // page-pixel bounding box {x, y, width, height} — the grounding
            // lane's ground-truth target, in the same frame as a mouse click.
            const box = await handle.boundingBox();
            await handle.dispose();
            return result(command.subaction, box);
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
    dispose: async () => {
      await page.close().catch(() => {});
      if (ownedBrowser) {
        await ownedBrowser.close().catch(() => {});
      }
    },
  };
}
