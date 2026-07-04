/**
 * Capability probe + Chromium resolution for meeting bots.
 *
 * The meeting bots drive a real Chromium via playwright-core. That only works on
 * a host that (a) is not a mobile embedding — Android / iOS app sandboxes cannot
 * spawn a browser — and (b) can actually resolve a Chromium executable (bundled
 * playwright download, an explicit override, or a system Chrome/Edge channel).
 *
 * `resolveMeetingRuntimeSupport()` answers "can this host run a meeting bot?" as
 * a typed result so the plugin can refuse cleanly (logged, no crash) instead of
 * launching into a doomed browser start. The Chromium resolution logic lives
 * here (not in launch.ts) so both the probe and the launcher agree on exactly
 * which binary would be used.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { isMobilePlatform } from "@elizaos/shared";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

/** System-browser channel a platform prefers for its fallback. */
export type BrowserChannel = "chrome" | "msedge";

/** How Chromium was resolved — for logging and the capability report. */
export type ChromiumSource = "override" | "system" | "bundled" | "channel";

/** A resolved Chromium target: either an explicit binary or a system channel. */
export interface ResolvedChromium {
  source: ChromiumSource;
  /** Absolute path to a Chromium/Chrome/Edge binary (override or bundled). */
  executablePath?: string;
  /** System-browser channel to hand playwright when no binary path is known. */
  channel?: BrowserChannel;
}

/** Result of the meeting-runtime capability probe. */
export interface MeetingRuntimeSupport {
  /** True when a meeting bot can be launched on this host. */
  supported: boolean;
  /** Human-readable reason when `supported` is false. */
  reason?: string;
  /** The headless mode that would be used (see {@link resolveHeadlessMode}). */
  headless: boolean;
  /** Explicit Chromium binary path, when one is resolvable. */
  chromiumPath?: string;
}

/**
 * Known install locations for a system Chrome/Chromium, by platform. The bots
 * drive the browser the user already has rather than downloading a separate one.
 */
const SYSTEM_CHROME_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/usr/bin/brave-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

/** Known install locations for a system Microsoft Edge, by platform. */
const SYSTEM_EDGE_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  linux: ["/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge"],
  win32: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

/**
 * First existing system-browser binary on this host, honoring the caller's
 * channel preference (Teams prefers Edge; Meet/Zoom prefer Chrome). Returns
 * `null` when the user has no Chrome/Edge/Chromium installed.
 */
export function detectSystemBrowser(
  prefer: BrowserChannel = "chrome",
  platform: NodeJS.Platform = process.platform,
): string | null {
  const chrome = SYSTEM_CHROME_PATHS[platform] ?? [];
  const edge = SYSTEM_EDGE_PATHS[platform] ?? [];
  const ordered =
    prefer === "msedge" ? [...edge, ...chrome] : [...chrome, ...edge];
  for (const candidate of ordered) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve which Chromium executable (or system channel) the bots would launch,
 * per the documented precedence:
 *   1. `ELIZA_MEETINGS_CHROMIUM_PATH` — explicit override (must exist).
 *   2. The system Chrome/Edge already installed on the machine — the bots drive
 *      the user's own browser, never a separate download.
 *   3. Playwright's bundled Chromium — only if a download happens to be present
 *      (e.g. a headless server image that ran `playwright install`).
 *   4. System channel fallback ("chrome" / "msedge") for playwright to resolve.
 *
 * @throws when the override path is set but does not exist — a misconfiguration
 *   the operator must fix, not something to silently downgrade.
 */
export function chromiumExecutable(
  channel: BrowserChannel = "chrome",
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedChromium {
  const override = env.ELIZA_MEETINGS_CHROMIUM_PATH?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `[MeetingSupport] ELIZA_MEETINGS_CHROMIUM_PATH does not exist: ${override}`,
      );
    }
    return { source: "override", executablePath: override };
  }

  // Prefer the Chrome/Edge already on the machine — no separate download.
  const system = detectSystemBrowser(channel, platform);
  if (system) {
    return { source: "system", executablePath: system };
  }

  // Only when no system browser exists: playwright's bundled Chromium, if a
  // download is present. executablePath() throws when it is not installed.
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) {
      return { source: "bundled", executablePath: bundled };
    }
  } catch {
    // Bundled browser not downloaded — fall through to the system channel.
  }

  return { source: "channel", channel };
}

/**
 * Whether a system Chrome/Edge channel is a plausible launch target. On desktop
 * OSes we assume the operator has (or can install) Chrome/Edge; playwright will
 * surface a precise error at launch if it is genuinely missing. On non-desktop
 * hosts we do NOT assume a channel exists.
 */
function channelFallbackPlausible(env: NodeJS.ProcessEnv): boolean {
  return !isMobilePlatform(env);
}

/**
 * Detect whether a graphical display is available for a headed browser.
 *   - macOS / Windows: a display is always present.
 *   - Linux: only when `DISPLAY` (X11) or `WAYLAND_DISPLAY` is set — including
 *     the `:99` that `Xvfb`/`xvfb-run` exports in a container.
 */
export function hasDisplay(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

/**
 * Resolve the headless mode for a meeting browser:
 *   1. Explicit `ELIZA_MEETINGS_HEADLESS` (`true`/`1`/`yes` → headless;
 *      `false`/`0`/`no` → headed) always wins.
 *   2. Otherwise auto-detect: headed when a display is available
 *      ({@link hasDisplay}), headless when it is not.
 *
 * Headless uses Chromium's modern "new" headless (playwright-core's
 * `headless: true` maps to `--headless=new`), which keeps getUserMedia /
 * WebAudio working — the classic headless mode disabled them.
 *
 * IMPORTANT tradeoff: Google Meet's `isTrusted`-click bot-detection is much
 * harder to satisfy in pure headless mode; the humanized XTEST input path needs
 * a real X server. The recommended server topology is therefore HEADED Chromium
 * under `Xvfb` (headless=false + `DISPLAY=:99`), which this auto-detect selects
 * for you once Xvfb has exported `DISPLAY`. Pure headless is best-effort for
 * Meet but reliable for Teams / Zoom.
 */
export function resolveHeadlessMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const explicit = env.ELIZA_MEETINGS_HEADLESS?.trim().toLowerCase();
  if (explicit) {
    if (["true", "1", "yes", "on"].includes(explicit)) return true;
    if (["false", "0", "no", "off"].includes(explicit)) return false;
    logger.warn(
      { ELIZA_MEETINGS_HEADLESS: explicit },
      "[MeetingSupport] unrecognized ELIZA_MEETINGS_HEADLESS value; falling back to display auto-detect",
    );
  }
  return !hasDisplay(platform, env);
}

/**
 * Probe whether this runtime host can run a meeting bot. Unsupported when the
 * host is a mobile embedding (browser automation cannot run in the Android / iOS
 * app sandbox) or when no Chromium is resolvable. On unsupported hosts the
 * service should refuse to launch with this typed reason rather than crash.
 */
export function resolveMeetingRuntimeSupport(
  _runtime: IAgentRuntime,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): MeetingRuntimeSupport {
  const headless = resolveHeadlessMode(env, platform);

  if (isMobilePlatform(env)) {
    return {
      supported: false,
      reason:
        "meeting bots require a desktop/server browser; they cannot run on a mobile (Android/iOS) host — route to a cloud-hosted agent instead",
      headless,
    };
  }

  let resolved: ResolvedChromium;
  try {
    resolved = chromiumExecutable("chrome", env, platform);
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
      headless,
    };
  }

  if (resolved.source === "channel" && !channelFallbackPlausible(env)) {
    return {
      supported: false,
      reason:
        "no Chromium resolvable: no bundled playwright browser, no ELIZA_MEETINGS_CHROMIUM_PATH, and no system Chrome/Edge channel on this host",
      headless,
    };
  }

  return {
    supported: true,
    headless,
    chromiumPath: resolved.executablePath,
  };
}
