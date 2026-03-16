/**
 * Headless browser capture — opens the StreamView in headless Chrome and
 * saves screenshots to a temp file. FFmpeg reads the temp file using
 * -loop 1 to continuously re-read the latest frame.
 *
 * This approach avoids the pipe bottleneck — FFmpeg reads at its own
 * pace while the browser updates the file independently.
 *
 * Visual parity with Electron:
 * - Appends `?popout` to the URL so the app renders StreamView directly
 *   (skips onboarding, auth gates, navigation chrome).
 * - Enables SwiftShader for WebGL so VRM avatar renders identically.
 * - Seeds localStorage with overlay layout, theme, and avatar index so
 *   the first rendered frame matches the configured appearance.
 * - Uses `waitUntil: "networkidle0"` to ensure all assets load before capture.
 * - Keeps CSS animations/transitions enabled for visual parity.
 */

import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const CHROME_PATH =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google Chrome\\Application\\chrome.exe"
      : "/usr/bin/google-chrome-stable";

let activeBrowser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
let stopSignal = false;

/** Path to the temp frame file that FFmpeg reads */
export const FRAME_FILE = join(tmpdir(), "milady-stream-frame.jpg");

export interface BrowserCaptureConfig {
  url: string;
  width?: number;
  height?: number;
  fps?: number;
  quality?: number;
  /** Optional overlay layout JSON to seed into localStorage before page load. */
  overlayLayout?: string;
  /** Theme name to apply (e.g. "milady", "haxor", "psycho"). */
  theme?: string;
  /** Avatar VRM index (1–8). */
  avatarIndex?: number;
  /** Destination ID — seeds the destination-specific localStorage key. */
  destinationId?: string;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
}

/**
 * Ensure the URL includes the `?popout` parameter so the app renders only
 * StreamView, skipping startup gates and navigation chrome.
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
    console.log("[browser-capture] Already running");
    return;
  }

  const { url, width = 1280, height = 720, quality = 70 } = config;
  const captureUrl = ensurePopoutUrl(url);

  stopSignal = false;
  console.log(`[browser-capture] Launching headless Chrome → ${captureUrl}`);

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

  // Seed localStorage before navigation so the first render matches Electron.
  // Keys must match exactly what the React app reads:
  //   - "milady:theme"                        → ThemeName
  //   - "milady_avatar_index"                 → VRM index (1–8)
  //   - "milady.stream.overlay-layout.v1[.destId]" → OverlayLayout JSON
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
        localStorage.setItem("milady.stream.overlay-layout.v1", overlayLayout);
        if (destinationId) {
          localStorage.setItem(
            `milady.stream.overlay-layout.v1.${destinationId}`,
            overlayLayout,
          );
        }
      }
      if (theme) {
        localStorage.setItem("milady:theme", theme);
      }
      if (avatarIndex != null) {
        localStorage.setItem("milady_avatar_index", String(avatarIndex));
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

  console.log(`[browser-capture] Page loaded, writing frames to ${FRAME_FILE}`);

  // Use CDP screencast for efficient frame delivery
  const cdp = await page.createCDPSession();
  let frameCount = 0;

  cdp.on("Page.screencastFrame", async (params: ScreencastFrameEvent) => {
    if (stopSignal) return;
    try {
      const buf = Buffer.from(params.data, "base64");
      if (buf.length > 0) {
        writeFileSync(FRAME_FILE, buf);
        frameCount++;
        if (frameCount % 100 === 0) {
          console.log(`[browser-capture] ${frameCount} frames written`);
        }
      }
      await cdp.send("Page.screencastFrameAck", {
        sessionId: params.sessionId,
      });
    } catch {
      // Ignore
    }
  });

  // Capture every frame from Chrome's compositor (~60fps internally,
  // limited by everyNthFrame to ~15-30fps actual delivery)
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 2, // ~30fps from 60fps compositor
  });

  console.log(
    `[browser-capture] CDP screencast active, saving to ${FRAME_FILE}`,
  );
}

export async function stopBrowserCapture() {
  stopSignal = true;
  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch {}
    activeBrowser = null;
  }
  console.log("[browser-capture] Stopped");
}

export function isBrowserCaptureRunning(): boolean {
  return activeBrowser !== null;
}

export function hasFrameFile(): boolean {
  return existsSync(FRAME_FILE);
}
