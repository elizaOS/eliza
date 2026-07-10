/**
 * Playwright configuration for the Playwright Android app test lane, including
 * browser projects and app-server wiring.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Playwright config for the REAL on-device Android WebView e2e suite. Unlike
// playwright.ui-smoke.config.ts (desktop Chromium + mocked /api), this drives
// the app installed on the emulator/device through Playwright's Android driver
// (`_android`), against the real on-device agent. There is no webServer and no
// browser project — the `page` fixture comes from the device WebView.
//
// Prereqs (handled by scripts/android-e2e.mjs, or run manually):
//   1. An emulator/device is attached (ANDROID_SERIAL selects it; emulator preferred).
//   2. The app is installed from an APK built with ELIZA_WEBVIEW_DEBUG=1.
//   3. The on-device local agent is up (mobile-local-chat-smoke bring-up) OR the
//      app is pointed at a reachable cloud agent.
const appDir = path.dirname(fileURLToPath(import.meta.url));
// Per-test artifact bundles (#15972): ELIZA_E2E_ARTIFACTS=1|full appends the
// bundle reporter and forces video+trace ("full" also every-step screenshots).
// Unset, this lane's capture behavior is untouched.
const e2eArtifactsMode = process.env.ELIZA_E2E_ARTIFACTS;
const e2eArtifactsEnabled =
  e2eArtifactsMode === "1" || e2eArtifactsMode === "full";
const reporters: (readonly [string] | readonly [string, object])[] = [
  ["list"] as const,
];
if (process.env.ELIZA_ANDROID_PLAYWRIGHT_JUNIT) {
  reporters.push([
    "junit",
    { outputFile: process.env.ELIZA_ANDROID_PLAYWRIGHT_JUNIT },
  ] as const);
}
if (process.env.ELIZA_ANDROID_PLAYWRIGHT_JSON) {
  reporters.push([
    "json",
    { outputFile: process.env.ELIZA_ANDROID_PLAYWRIGHT_JSON },
  ] as const);
}
if (!process.env.CI) {
  reporters.push(["html", { open: "never" }] as const);
}
if (e2eArtifactsEnabled) {
  reporters.push(["./test/e2e-artifacts/reporter.ts"] as const);
}

export default defineConfig({
  testDir: "./test/android",
  testMatch: /.*\.android\.spec\.ts$/,
  // The device exposes a single WebView; everything is serial.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Real device + real backend: generous timeouts. The on-device voice
  // round-trip cold-loads three large GGUF models in sequence (chat, ASR, TTS),
  // each tens of seconds on a CPU-only phone, so the full STT->agent->TTS turn
  // can run several minutes on the first pass.
  timeout: 420_000,
  expect: { timeout: 45_000 },
  reporter: reporters,
  outputDir:
    process.env.ELIZA_ANDROID_PLAYWRIGHT_OUTPUT_DIR ??
    "./test-results/android-playwright",
  globalSetup: path.join(appDir, "test/android/global-setup.ts"),
  use: {
    // Screenshots/trace over the Android CDP socket are slow; capture only on
    // failure and keep them bounded — unless a per-test artifact bundle was
    // requested, which needs the full recording regardless of cost.
    screenshot: e2eArtifactsMode === "full" ? "on" : "only-on-failure",
    trace: e2eArtifactsEnabled ? "on" : "retain-on-failure",
    ...(e2eArtifactsEnabled ? { video: "on" as const } : {}),
  },
});
