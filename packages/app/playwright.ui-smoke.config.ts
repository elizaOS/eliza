import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
// The committed source of truth for the known-phrase audio is the data-URL .ts
// (a real omnivoice.cpp speech clip). Binary .wav fixtures are gitignored, so
// derive the on-disk WAV from it for Chromium's --use-file-for-fake-audio-capture.
import { KNOWN_PHRASE_WAV_DATA_URL } from "../ui/src/voice/voice-selftest/fixtures/known-phrase";

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
const VOICE_MIC_SPEC = /voice-realaudio\.spec\.ts/;
const recording = !!process.env.E2E_RECORD;
const videoMode =
  process.env.ELIZA_UI_SMOKE_DISABLE_VIDEO === "1"
    ? "off"
    : recording
      ? "on"
      : "retain-on-failure";

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
      // in the dedicated `chromium-voice-mic` project below, not here.
      testIgnore: VOICE_MIC_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumExecutablePath
          ? { launchOptions: { executablePath: chromiumExecutablePath } }
          : {}),
      },
    },
    {
      name: "chromium-voice-mic",
      testMatch: VOICE_MIC_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: {
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
      // Mobile-viewport (Pixel 7) lane: background rendering + the decomposed
      // personal-assistant domain views, so each lifeops view is exercised at
      // the same WebView viewport that ships on Capacitor iOS/Android.
      testMatch:
        /(backgrounds|apps-personal-assistant-decomposed-interactions)\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: {
    command: `node ${JSON.stringify(path.join(repoRoot, "packages", "app-core", "scripts", "run-node-tsx.mjs"))} ${JSON.stringify(uiSmokeLiveStack)}`,
    cwd: repoRoot,
    port: uiSmokePort,
    reuseExistingServer,
    // A cold renderer build transforms ~3000 modules (~12 min) before the smoke
    // harness can bind the port; the live stack caps the build at 18 min, so the
    // outer wait must exceed that (was 7 min, which killed every cold build).
    timeout: 1_200_000,
  },
});
