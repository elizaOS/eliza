/**
 * Declarative catalog of the UI end-to-end recording suites (name, working
 * directory, run script, coverage blurb, and any record-mode env). The
 * run-all.mjs orchestrator iterates this list to execute each suite and collect
 * its screenshots, traces, and videos into RECORDINGS_DIR.
 */
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const RECORDINGS_DIR = path.join(REPO_ROOT, "e2e-recordings");

export const UI_E2E_SUITES = [
  {
    name: "app",
    displayName: "Main app shell",
    configDir: "packages/app",
    script: "test:e2e",
    coverage:
      "Runs the installed app shell, login/session startup, chat, all registered plugin views, settings, mobile viewport, inputs, screenshots, traces, and videos.",
    recordEnv: { ELIZA_UI_SMOKE_FORCE_STUB: "1" },
  },
  {
    name: "cloud-e2e",
    displayName: "Cloud full-stack mock e2e",
    configDir: "packages/cloud/e2e",
    script: "test",
    coverage:
      "Boots the local cloud API, cloud frontend, auth cookie login, provisioning flows, screenshots, traces, and videos.",
  },
  {
    name: "homepage",
    displayName: "Homepage",
    configDir: "packages/homepage",
    script: "test:e2e",
    coverage:
      "Runs marketing routes, navigation, onboarding controls, contact capture, route coverage, screenshots, traces, and videos.",
  },
  {
    name: "ui-agent-surface",
    displayName: "Shared UI agent surface",
    configDir: "packages/ui",
    script: "test:agent-surface-e2e",
    coverage:
      "Runs the shared agent-surface fixture in Chromium, drives fill/click/focus capability bridge interactions, and records screenshots.",
  },
  {
    name: "ui-launcher",
    displayName: "Launcher view launcher",
    configDir: "packages/ui",
    script: "test:launcher-e2e",
    coverage:
      "Runs the Launcher launcher fixture in Chromium, asserts tiles + image tiles render, captures desktop/mobile rest + edit screenshots, drives tap-launch/long-press-edit/favorite/page-nav with a recorded video, and asserts the view-interaction telemetry stream fired.",
  },
  {
    name: "android-emu",
    displayName: "Android emulator app capture",
    configDir: "packages/app",
    command: ["node", "scripts/e2e-recordings/capture-android-emu.mjs"],
    checkCommand: [
      "node",
      "scripts/e2e-recordings/capture-android-emu.mjs",
      "--check",
    ],
    coverage:
      "Boots or reuses an Android emulator, starts the deterministic host agent, drives the real Capacitor onboarding flow, and writes emulator screenshot, screenrecord, logcat, and capture logs to generated native-capture output.",
  },
  {
    name: "ios-sim",
    displayName: "iOS simulator app capture",
    configDir: "packages/app",
    command: ["node", "scripts/e2e-recordings/capture-ios-sim.mjs"],
    checkCommand: [
      "node",
      "scripts/e2e-recordings/capture-ios-sim.mjs",
      "--check",
    ],
    coverage:
      "Boots or reuses an iOS Simulator, starts the deterministic host agent, drives first-run onboarding, and writes simulator screenshots, recordVideo output, smoke result JSON, and capture logs to generated native-capture output.",
  },
];

export const UI_E2E_COVERED_BY_APP = [
  {
    name: "app-core",
    configDir: "packages/app-core",
    coveredBy: "app",
    reason:
      "App-core owns the app API/dev stack used by packages/app Playwright; its standalone Playwright config is not runnable because the package has no storybook script/e2e dir.",
  },
  {
    name: "plugin-views",
    configDir: "plugins/* with build:views",
    coveredBy: "app",
    reason:
      "Plugin view packages are registered and clicked through inside packages/app/test/ui-smoke plugin and app interaction suites.",
  },
];

export const SKIPPED_EXTERNAL_UI_E2E_SUITES = [];

export function suiteByName(name) {
  return UI_E2E_SUITES.find((suite) => suite.name === name) ?? null;
}
