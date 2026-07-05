/**
 * Playwright configuration for the Playwright Ui Smoke app test lane,
 * including browser projects and app-server wiring.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
// The committed source of truth for the known-phrase audio is the data-URL .ts
// (a real omnivoice.cpp speech clip). Binary .wav fixtures are gitignored, so
// derive the on-disk WAV from it for Chromium's --use-file-for-fake-audio-capture.
import { KNOWN_PHRASE_WAV_DATA_URL } from "../ui/src/voice/voice-selftest/fixtures/known-phrase";
import {
  ASSERTION_GRADE_DASHBOARD_SPECS,
  DASHBOARD_E2E_DEVICE_MATRIX,
} from "./test/ui-smoke/device-matrix";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");
const uiSmokeLiveStack = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "playwright-ui-live-stack.ts",
);
const uiSmokeApiPort = Number(process.env.ELIZA_UI_SMOKE_API_PORT || "31337");
const uiSmokePort = Number(process.env.ELIZA_UI_SMOKE_PORT || "2138");
const reuseExistingServer = process.env.ELIZA_UI_SMOKE_REUSE_SERVER === "1";
const nodeExecutable =
  process.env.ELIZA_NODE_PATH?.trim() ||
  process.env.npm_node_execpath?.trim() ||
  process.execPath;
const chromiumExecutablePath =
  process.env.ELIZA_UI_SMOKE_CHROMIUM_EXECUTABLE?.trim();
// Real audio fed to the browser mic for the voice button-press e2e: Chromium
// plays this WAV file as the fake capture device so the REAL local-ASR recorder
// (getUserMedia + WAV encode + POST) runs end-to-end with no human/microphone.
// Materialized from the committed data-URL fixture (no gitignored binary).
const fakeAudioWav = path.join(
  appDir,
  "test-results",
  ".voice",
  "known-phrase.wav",
);
mkdirSync(path.dirname(fakeAudioWav), { recursive: true });
writeFileSync(
  fakeAudioWav,
  Buffer.from(KNOWN_PHRASE_WAV_DATA_URL.split(",")[1] ?? "", "base64"),
);
const VOICE_MIC_SPEC = /(voice-realaudio|transcript-realaudio)\.spec\.ts/;
// WebKit (Safari engine) pointer/focus/text-input lane. iOS/iPadOS ship Safari's
// WebKit, but every default lane above is Chromium-only, so pointer, focus, and
// text-input regressions specific to WebKit go uncaught. This lane re-runs the
// chat pointer/focus/composer specs plus the plugin-views keyboard focus-order
// audit on WebKit. Scoped to keyless, stub-backed specs that need no
// Chromium-only permissions (clipboard/microphone) or fake-media launch flags,
// so they run green on WebKit (chat-message-actions and wallet-inventory grant
// clipboard permissions WebKit does not support and are intentionally excluded).
// CDP-touch specs (Input.dispatchTouchEvent is Chromium-only) stay on Chromium.
// plugin-views-visual is included for its Tab-order keyboard-navigation audit:
// the registered plugin views ship in the iOS/macOS WKWebView, so a WebKit focus
// or sequential-focus-navigation divergence must be caught here, not only on
// Chromium. Opt-in via PLAYWRIGHT_WEBKIT=1: WebKit is a separate browser download
// (`playwright install webkit`) not present on every machine, so gating keeps the
// default lane from reddening where WebKit is absent.
const WEBKIT_POINTER_FOCUS_SPEC =
  /(chat-overlay-controls-interactions|conversation-management|slash-commands|plugin-views-visual)\.spec\.ts/;
const webkitLaneEnabled = process.env.PLAYWRIGHT_WEBKIT === "1";
// The all-views aesthetic audit (#8796) walks ~50 views × 2 viewports; it is a
// dedicated tool run via `audit:app`, not part of the default e2e smoke.
const AUDIT_APP_SPEC = /all-views-aesthetic-audit\.spec\.ts/;
// The cloud-surface aesthetic audit (#10725/#11342) walks every registered
// cloud route (packages/ui/src/cloud/register-all.ts) at desktop + mobile; a
// dedicated tool run via `audit:cloud`, not part of the default e2e smoke.
const AUDIT_CLOUD_SPEC = /cloud-surfaces-aesthetic-audit\.spec\.ts/;
// Focused light/dark contrast proof for the Applications dropdown/select
// popovers (#14232): renders the two touched surfaces in BOTH themes with the
// SelectContent popover open. Run via `--project=audit-app-dropdown`; kept out
// of the default e2e lane like the other dedicated aesthetic-audit tools.
const AUDIT_APP_DROPDOWN_SPEC = /applications-dropdown-contrast\.spec\.ts/;
// The WebKit lane (#10104/#10722): the assertion-grade dashboard specs, the
// core shell smoke, and the input-modality spec on a real Desktop Safari
// engine. WebKit-only behavior differences are real (see
// packages/ui/src/spatial/WEBXR_PLATFORMS.md — e.g. foreignObject canvas
// uploads still taint in WebKit while current Chromium accepts them), so the
// shipped Capacitor iOS WebView / desktop WKWebView engine must run in CI, not
// only Chromium wearing a Safari viewport.
const WEBKIT_SMOKE_SPECS =
  /(browser-workspace|character-editor|wallet-inventory|workflow-editor|ui-smoke|input-modality)\.spec\.ts/;
const recording = !!process.env.E2E_RECORD;
const videoMode =
  process.env.ELIZA_UI_SMOKE_DISABLE_VIDEO === "1"
    ? "off"
    : recording
      ? "on"
      : "retain-on-failure";
const humanSlowMo = Number.parseInt(
  process.env.ELIZA_UI_PLAYWRIGHT_SLOWMO || "0",
  10,
);
const slowMoLaunchOptions =
  Number.isFinite(humanSlowMo) && humanSlowMo > 0
    ? { slowMo: humanSlowMo }
    : {};

function withLaunchOptions(options: Record<string, unknown> = {}): {
  launchOptions?: Record<string, unknown>;
} {
  const launchOptions = { ...slowMoLaunchOptions, ...options };
  return Object.keys(launchOptions).length > 0 ? { launchOptions } : {};
}

function withChromiumLaunchOptions(options: Record<string, unknown> = {}): {
  launchOptions?: Record<string, unknown>;
} {
  return withLaunchOptions({
    ...options,
    ...(chromiumExecutablePath
      ? { executablePath: chromiumExecutablePath }
      : {}),
  });
}

// Keep the app's API port env aligned with the live stack when the suite runs
// on non-default ports.
if (!process.env.ELIZA_API_PORT) {
  process.env.ELIZA_API_PORT = String(uiSmokeApiPort);
}

export default defineConfig({
  testDir: "./test/ui-smoke",
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: recording
    ? path.resolve(appDir, "../../e2e-recordings/app/test-results")
    : "./test-results",
  use: {
    baseURL: `http://127.0.0.1:${uiSmokePort}`,
    trace: recording ? "on" : "retain-on-failure",
    video: videoMode,
    screenshot: recording ? "on" : "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // The voice button-press spec needs the fake-audio launch flags; it runs
      // in the dedicated `chromium-voice-mic` project below, not here. The
      // all-views aesthetic audit runs only via the `audit:app` project; the
      // cloud-surface audit only via `audit:cloud`.
      testIgnore: [
        VOICE_MIC_SPEC,
        AUDIT_APP_SPEC,
        AUDIT_CLOUD_SPEC,
        AUDIT_APP_DROPDOWN_SPEC,
      ],
      use: {
        ...devices["Desktop Chrome"],
        ...withChromiumLaunchOptions(),
      },
    },
    ...DASHBOARD_E2E_DEVICE_MATRIX.map((viewport) => ({
      name: `dashboard-${viewport.id}`,
      testMatch: ASSERTION_GRADE_DASHBOARD_SPECS,
      use: {
        ...devices["Desktop Chrome"],
        viewport: viewport.viewport,
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
        ...withChromiumLaunchOptions(),
      },
    })),
    {
      name: "chromium-voice-mic",
      testMatch: VOICE_MIC_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: {
          ...slowMoLaunchOptions,
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${fakeAudioWav}`,
            "--autoplay-policy=no-user-gesture-required",
          ],
          ...(chromiumExecutablePath
            ? { executablePath: chromiumExecutablePath }
            : {}),
        },
      },
    },
    {
      name: "mobile-chromium",
      // Mobile-viewport (Pixel 7, hasTouch) lane: the decomposed
      // personal-assistant domain views plus the real-touch chat gesture specs
      // and the input-modality spec (its real-touch tests need hasTouch + CDP),
      // so each surface is exercised at the same WebView viewport that ships on
      // Capacitor iOS/Android.
      testMatch:
        /(apps-personal-assistant-decomposed-interactions|chat-clear-swipe|chat-send-voice-newchat-fuzz|gesture-matrix|input-modality|launcher-gesture-loop)\.spec\.ts/,
      use: { ...devices["Pixel 7"], ...withLaunchOptions() },
    },
    // WebKit cross-engine lane (opt-in). Only added when PLAYWRIGHT_WEBKIT=1 so a
    // machine without the WebKit browser download never reds the default lane.
    ...(webkitLaneEnabled
      ? [
          {
            name: "webkit",
            testMatch: WEBKIT_POINTER_FOCUS_SPEC,
            use: {
              ...devices["Desktop Safari"],
              ...withLaunchOptions(),
              // Same parity as the desktop-webkit lane below: the PROD renderer
              // registers /sw.js (skipWaiting + clients.claim), and WebKit —
              // unlike Chromium — does NOT bypass a controlling service worker
              // when page.route interception is active. Once the SW claims the
              // page, every /api/* fetch silently goes AROUND the per-spec
              // route fixtures to the real stub server (verified via an
              // in-page probe: a route-fulfilled /api/conversations returned
              // the stub server's conversations instead of the fixture's), so
              // e.g. the conversation-persistence reload rehydrated a foreign
              // thread and timed out (#11112 finding 2).
              serviceWorkers: "block" as const,
            },
          },
        ]
      : []),
    {
      name: "desktop-webkit",
      // Real WebKit (Desktop Safari device profile) over the dashboard +
      // shell-smoke + input-modality specs. This is the only lane where the
      // engine that ships in every iOS WebView and macOS WKWebView actually
      // executes the dashboard flows; Chromium-only skips inside these specs
      // must carry a written engine-difference justification.
      testMatch: WEBKIT_SMOKE_SPECS,
      use: {
        ...devices["Desktop Safari"],
        ...withLaunchOptions(),
        // Parity with the Chromium lanes, not an app change: Chromium
        // force-bypasses the registered service worker whenever page.route
        // interception is active; WebKit does not, so the app SW would
        // silently serve /api/* AROUND every helpers.ts fixture stub (verified:
        // with the SW active, a route-fulfilled /api/conversations list came
        // back with the stub server's conversations instead of the fixture).
        serviceWorkers: "block",
      },
    },
    {
      // All-views aesthetic audit (#8796) — run with `audit:app`
      // (`--project=audit-app`). Walks every view at desktop + mobile internally.
      name: "audit-app",
      testMatch: AUDIT_APP_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        ...withChromiumLaunchOptions(),
      },
    },
    {
      // Cloud-surface aesthetic audit (#10725/#11342) — run with `audit:cloud`
      // (`--project=audit-cloud`). Walks every registered cloud route at
      // desktop + mobile internally. Requires a renderer built with
      // VITE_PLAYWRIGHT_TEST_AUTH=true; the runner invalidates dist for this
      // project so a cached non-auth build cannot skip the local auth shell.
      name: "audit-cloud",
      testMatch: AUDIT_CLOUD_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        ...withChromiumLaunchOptions(),
      },
    },
    {
      // Applications dropdown/select light+dark contrast proof (#14232), run
      // via `--project=audit-app-dropdown`. Like audit-cloud it needs the
      // renderer built with VITE_PLAYWRIGHT_TEST_AUTH=true so the Steward auth
      // shell serves the app-detail route.
      name: "audit-app-dropdown",
      testMatch: AUDIT_APP_DROPDOWN_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        ...withChromiumLaunchOptions(),
      },
    },
  ],
  webServer: {
    command: `${JSON.stringify(nodeExecutable)} ${JSON.stringify(path.join(repoRoot, "packages", "app-core", "scripts", "run-node-tsx.mjs"))} ${JSON.stringify(uiSmokeLiveStack)}`,
    cwd: repoRoot,
    url: `http://127.0.0.1:${uiSmokePort}`,
    reuseExistingServer,
    // A cold renderer build transforms ~3000 modules (~12 min) before the smoke
    // harness can bind the port; the live stack caps the build at 18 min, so the
    // outer wait must exceed that (was 7 min, which killed every cold build).
    timeout: 1_200_000,
  },
});
