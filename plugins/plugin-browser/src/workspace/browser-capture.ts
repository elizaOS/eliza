/**
 * Headless browser capture — opens the StreamView in headless Chrome and
 * saves screenshots to a temp file. FFmpeg reads the temp file using
 * -loop 1 to continuously re-read the latest frame.
 *
 * This approach avoids the pipe bottleneck — FFmpeg reads at its own
 * pace while the browser updates the file independently.
 *
 * Visual parity with the desktop shell:
 * - Appends `?popout` to the URL so the app renders StreamView directly
 *   (without onboarding, auth gates, or navigation chrome).
 * - Enables SwiftShader for WebGL so VRM avatar renders identically.
 * - Seeds localStorage with overlay layout, theme, and avatar index so
 *   the first rendered frame matches the configured appearance.
 * - Uses `waitUntil: "networkidle0"` to ensure all assets load before capture.
 * - Keeps CSS animations/transitions enabled for visual parity.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "@elizaos/core";
import type { Browser } from "puppeteer-core";

function resolveChromePath(): string {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (process.platform === "win32") {
    // Chrome installs under Google/Chrome/Application (a subdirectory), not a
    // "Google Chrome" folder, and may be 64-bit, 32-bit, or per-user. Probe the
    // standard locations and pick the first that exists. (join normalizes the
    // forward-slash fallbacks to the Windows separator.)
    const candidates = [
      join(
        process.env.PROGRAMFILES ?? "C:/Program Files",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(
        process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    ];
    return candidates.find((p) => existsSync(p)) ?? candidates[0];
  }
  return "/usr/bin/google-chrome-stable";
}

const CHROME_PATH = resolveChromePath();

let activeBrowser: Browser | null = null;
let activeCaptureLoop: Promise<void> | null = null;
let stopSignal = false;

/** Path to the temp frame file that FFmpeg reads */
export const FRAME_FILE = join(tmpdir(), "eliza-stream-frame.jpg");

export interface BrowserCaptureConfig {
  url: string;
  width?: number;
  height?: number;
  fps?: number;
  quality?: number;
  /** Optional overlay layout JSON to seed into localStorage before page load. */
  overlayLayout?: string;
  /** Theme name to apply (e.g. "eliza", "haxor", "psycho"). */
  theme?: string;
  /** Avatar VRM index (1–8). */
  avatarIndex?: number;
  /** Destination ID — seeds the destination-specific localStorage key. */
  destinationId?: string;
}

export function getBrowserCaptureExecutablePath(): string {
  return CHROME_PATH;
}

export function isBrowserCaptureSupported(): boolean {
  return existsSync(CHROME_PATH);
}

/**
 * Ensure the URL includes the `?popout` parameter so the app renders only
 * StreamView without startup gates or navigation chrome.
 */
function ensurePopoutUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Handle both query and hash-based routing
    if (u.hash?.includes("?")) {
      if (!u.hash.includes("popout")) {
        u.hash = `${u.hash}&popout`;
      }
    } else if (u.hash) {
      u.hash = `${u.hash}?popout`;
    } else if (!u.searchParams.has("popout")) {
      u.searchParams.set("popout", "");
    }
    return u.toString();
  } catch {
    // Fallback: just append
    const sep = raw.includes("?") ? "&" : "?";
    return `${raw}${sep}popout`;
  }
}

export async function startBrowserCapture(config: BrowserCaptureConfig) {
  if (activeBrowser) {
    logger.info("[browser-capture] Already running");
    return;
  }

  if (!isBrowserCaptureSupported()) {
    throw new Error(
      `Google Chrome not found at ${CHROME_PATH}. Install Chrome or update browser-capture before enabling screen capture.`,
    );
  }

  const { url, width = 1280, height = 720, fps = 4, quality = 70 } = config;
  const captureUrl = ensurePopoutUrl(url);

  stopSignal = false;
  logger.info(`[browser-capture] Launching headless Chrome to ${captureUrl}`);

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      `--window-size=${width},${height}`,
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--mute-audio",
      // WebGL / SwiftShader — required for VRM avatar rendering parity
      "--use-gl=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
    ],
  });

  activeBrowser = browser;

  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // Seed localStorage before navigation so the first render matches the desktop shell.
  // Keys must match exactly what the React app reads:
  //   - "eliza:theme"                        → ThemeName
  //   - "eliza_avatar_index"                 → VRM index (1–8)
  //   - "eliza.stream.overlay-layout.v1[.destId]" → OverlayLayout JSON
  await page.evaluateOnNewDocument(
    (
      overlayLayout: string | undefined,
      theme: string | undefined,
      avatarIndex: number | undefined,
      destinationId: string | undefined,
    ) => {
      if (overlayLayout) {
        // Seed both global and destination-specific keys so the hook
        // resolves correctly regardless of when activeDestination loads.
        localStorage.setItem("eliza.stream.overlay-layout.v1", overlayLayout);
        if (destinationId) {
          localStorage.setItem(
            `eliza.stream.overlay-layout.v1.${destinationId}`,
            overlayLayout,
          );
        }
      }
      if (theme) {
        localStorage.setItem("eliza:theme", theme);
      }
      if (avatarIndex != null) {
        localStorage.setItem("eliza_avatar_index", String(avatarIndex));
      }
    },
    config.overlayLayout,
    config.theme,
    config.avatarIndex,
    config.destinationId,
  );

  // Use networkidle0 so fonts, VRM models, and preview images finish loading
  await page.goto(captureUrl, {
    waitUntil: "networkidle0",
    timeout: 60_000,
  });

  logger.info(`[browser-capture] Page loaded, writing frames to ${FRAME_FILE}`);

  let frameCount = 0;
  const frameIntervalMs = Math.max(100, Math.round(1000 / Math.max(1, fps)));
  activeCaptureLoop = (async () => {
    while (!stopSignal) {
      try {
        await page.screenshot({
          path: FRAME_FILE,
          quality,
          type: "jpeg",
        });
        frameCount += 1;
        if (frameCount % 20 === 0) {
          logger.debug(`[browser-capture] ${frameCount} frames written`);
        }
      } catch (error) {
        if (!stopSignal) {
          logger.warn(
            `[browser-capture] frame capture failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (!stopSignal) {
        await sleep(frameIntervalMs);
      }
    }
  })();

  logger.info(
    `[browser-capture] Screenshot loop active (${fps} fps), saving to ${FRAME_FILE}`,
  );
}

export async function stopBrowserCapture() {
  stopSignal = true;
  if (activeCaptureLoop) {
    try {
      await activeCaptureLoop;
    } catch (err) {
      // error-policy:J6 best-effort teardown — the capture loop is being torn
      // down; a late frame-capture rejection is already surfaced inside the loop
      // (see logger.warn above) and must not block shutdown.
      logger.debug(
        `[browser-capture] capture loop settled with error during stop: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    activeCaptureLoop = null;
  }
  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch (err) {
      // error-policy:J6 best-effort teardown — a browser that fails to close
      // cleanly during shutdown cannot be recovered here; drop the reference.
      logger.debug(
        `[browser-capture] browser close failed during stop: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    activeBrowser = null;
  }
  logger.info("[browser-capture] Stopped");
}

export function isBrowserCaptureRunning(): boolean {
  return activeBrowser !== null;
}

export function hasFrameFile(): boolean {
  return existsSync(FRAME_FILE);
}
