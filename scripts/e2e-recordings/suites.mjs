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
    name: "cloud-frontend",
    displayName: "Cloud frontend",
    configDir: "packages/cloud-frontend",
    script: "test:e2e",
    coverage:
      "Runs cloud login/session, dashboard routes, settings, API key, billing, route coverage, visual pages, screenshots, traces, and videos.",
  },
  {
    name: "cloud-e2e",
    displayName: "Cloud full-stack mock e2e",
    configDir: "packages/test/cloud-e2e",
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
    name: "os-homepage",
    displayName: "OS homepage",
    configDir: "packages/os-homepage",
    script: "test:e2e",
    coverage:
      "Runs OS homepage routes, checkout/preorder flows, link resilience, mobile/desktop screenshots, traces, and videos.",
  },
  {
    name: "os-usb-installer",
    displayName: "OS USB installer",
    configDir: "packages/os/usb-installer",
    script: "test:e2e",
    coverage:
      "Runs the installer wizard UI, visual pages, mobile/desktop screenshots, traces, and videos against the mocked installer API.",
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
    name: "app-xr",
    displayName: "Facewear XR app",
    configDir: "plugins/plugin-facewear/app-xr",
    script: "test:e2e",
    coverage:
      "Runs XR app view CRUD, camera pose, voice form interactions, screenshots, traces, and videos.",
  },
  {
    name: "feed-dag-visualizer",
    displayName: "Feed DAG visualizer",
    configDir: "packages/feed/tools/dag-visualizer",
    script: "test",
    coverage:
      "Runs the standalone Feed DAG visualizer browser e2e with screenshots, traces, and videos.",
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
  {
    name: "feed-web",
    configDir: "packages/feed",
    coveredBy: "feed-dag-visualizer",
    reason:
      "The full Feed web e2e lanes require an external app stack, wallet extension, and optional DB/services; deterministic standalone Feed UI recording is covered by the DAG visualizer suite.",
  },
];

export const SKIPPED_EXTERNAL_UI_E2E_SUITES = [
  {
    name: "feed-browser-wallet",
    configDir: "packages/feed/tools/e2e",
    script: "test",
    reason:
      "Requires RUN_FEED_E2E=1, a live Feed app on :3000, and the MetaMask extension.",
  },
  {
    name: "feed-chroma-wallet",
    configDir: "packages/feed/tools/chroma",
    script: "test",
    reason:
      "Requires RUN_FEED_E2E=1, a Feed app on :3100, Anvil, deployed contracts, and wallet state.",
  },
];

export function suiteByName(name) {
  return UI_E2E_SUITES.find((suite) => suite.name === name) ?? null;
}
