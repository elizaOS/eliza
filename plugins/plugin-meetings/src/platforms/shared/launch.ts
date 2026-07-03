/**
 * Chromium bootstrap for meeting bots (playwright-core, no playwright-extra).
 *
 * Executable resolution order:
 *   1. env ELIZA_MEETINGS_CHROMIUM_PATH — explicit override.
 *   2. Playwright's bundled Chromium (if the browser download is installed).
 *   3. System channel fallback ("chrome" / "msedge"). Teams prefers Edge via
 *      the `channel` param; Meet/Zoom use Chrome.
 *
 * Stealth is applied as explicit init scripts (navigator.webdriver removal,
 * plugin/language shims) — NOT playwright-extra. The User-Agent is pinned to
 * match the bundled Chromium's real major version + platform: Google Meet's
 * anti-abuse cross-checks the UA string against navigator.userAgentData (Client
 * Hints), which report the REAL platform + major version and cannot be spoofed.
 * A stale/cross-platform UA triggers a reCAPTCHA + "You can't join" interstitial.
 * When we cannot determine the real major version we OMIT the UA override and
 * let Chromium's honest, self-consistent UA flow through.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { existsSync } from "node:fs";
import { logger } from "@elizaos/core";

/** Channel a platform prefers for its system-browser fallback. */
export type BrowserChannel = "chrome" | "msedge";

export interface LaunchMeetingBrowserOptions {
  /** System-browser channel to prefer when no bundled/override binary exists. */
  channel?: BrowserChannel;
  /** Extra environment for the browser process (e.g. Zoom's PULSE_SINK). */
  env?: Record<string, string>;
  /** Run headless. Default false — Meet bot-detection is harsher on headless. */
  headless?: boolean;
}

export interface MeetingBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Stealth-critical launch args ported from Vexa's runBot. Certificate-error and
 * web-security flags are intentionally ABSENT — they are detectable by Google's
 * bot-detection and cause the "You can't join this meeting" interstitial on
 * datacenter egress. `--disable-blink-features=AutomationControlled` hides the
 * automation flag; `--use-fake-ui-for-media-stream` auto-grants mic/cam without
 * a permission prompt.
 */
const LAUNCH_ARGS: readonly string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor",
  "--disable-infobars",
  "--disable-blink-features=AutomationControlled",
  "--disable-site-isolation-trials",
  "--use-fake-ui-for-media-stream",
];

/**
 * Init script that removes the most obvious automation tells. Injected before
 * any page script runs (addInitScript), so `meet.google.com`'s detection sees a
 * consistent, non-automated navigator.
 */
function stealthInitScript(): string {
  return `
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", {
      get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }],
    });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  `;
}

/**
 * Derive a UA whose Chrome major version matches the running Chromium. Returns
 * null when the version can't be read (then we let the native UA flow through
 * rather than risk a UA↔Client-Hints mismatch).
 */
function consistentUserAgent(browser: Browser): string | null {
  const version = browser.version(); // e.g. "141.0.7340.0"
  const major = version.split(".")[0];
  if (!/^\d+$/.test(major)) return null;
  const platformToken =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Resolve the Chromium executable per the documented precedence. */
function resolveExecutable(channel: BrowserChannel): { executablePath?: string; channel?: BrowserChannel } {
  const override = process.env.ELIZA_MEETINGS_CHROMIUM_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`[MeetingLaunch] ELIZA_MEETINGS_CHROMIUM_PATH does not exist: ${override}`);
    }
    return { executablePath: override };
  }
  // Playwright's bundled Chromium — executablePath() throws if not installed.
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return { executablePath: bundled };
  } catch {
    // Bundled browser not downloaded — fall through to system channel.
  }
  return { channel };
}

/**
 * Launch a Chromium browser + context + page ready for a meeting join. The
 * caller owns the returned handle and must `close()` it.
 */
export async function launchMeetingBrowser(
  opts: LaunchMeetingBrowserOptions = {},
): Promise<MeetingBrowser> {
  const channel = opts.channel ?? "chrome";
  const resolved = resolveExecutable(channel);
  logger.info(
    {
      channel: resolved.channel,
      executablePath: resolved.executablePath,
      headless: opts.headless === true,
    },
    "[MeetingLaunch] launching Chromium",
  );

  const browser = await chromium.launch({
    headless: opts.headless === true,
    args: [...LAUNCH_ARGS],
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    ...resolved,
  });

  const userAgent = consistentUserAgent(browser) ?? undefined;
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
    userAgent,
    viewport: null,
  });
  await context.addInitScript(stealthInitScript());

  const page = await context.newPage();
  // Accept any beforeunload/permission dialogs so they can't wedge the bot.
  page.on("dialog", (dialog) => {
    dialog.accept().catch(() => {
      /* already dismissed */
    });
  });

  return {
    browser,
    context,
    page,
    async close() {
      try {
        await context.close();
      } catch {
        /* context may already be gone */
      }
      try {
        await browser.close();
      } catch {
        /* browser may already be gone */
      }
    },
  };
}
