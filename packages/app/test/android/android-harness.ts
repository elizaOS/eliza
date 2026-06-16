// Playwright fixtures + helpers for driving the real on-device Capacitor
// WebView via Playwright's Android driver (`_android`). Unlike the browser
// ui-smoke suite (which mocks every /api route in a desktop Chromium), this
// runs against the ACTUAL app installed on the emulator/device, talking to the
// real on-device agent. There is no webServer and no network mocking — the
// assertions exercise real render + real backend.
import {
  _android as android,
  type AndroidDevice,
  expect,
  type Page,
  test as base,
} from "@playwright/test";
// The shared device lib is plain ESM (.mjs); import the values we need.
import {
  APP_ID,
  appPid,
  connectPlaywrightDevice,
  launchApp,
  resolveAdb,
} from "../../scripts/lib/android-device.mjs";

export const ORIGIN = "https://localhost";

/**
 * localStorage the app reads on boot: mark onboarding done, native shell, local
 * runtime mode, and a local active-server so the WebView drives the on-device
 * agent instead of showing the first-run "Choose your setup" picker.
 */
// Which backend the WebView talks to. `local` = the embedded on-device agent
// over the Capacitor Agent IPC (needs the agent running on-device). `host` =
// a real agent on the dev host, reached via `adb reverse tcp:31337` — used for
// route coverage on an emulator where the embedded agent can't run. Cloud/remote
// modes seed their own active-server out of band.
const BACKEND = (process.env.ELIZA_ANDROID_BACKEND ?? "local").toLowerCase();

function activeServerSeed(): string {
  if (BACKEND === "host") {
    return JSON.stringify({
      id: "remote:host",
      kind: "remote",
      label: "Host agent",
      apiBase: "http://127.0.0.1:31337",
    });
  }
  // The renderer reads runtime mode from localStorage (a SEPARATE store from the
  // native SharedPreferences that gate agent autostart), so seeding this is what
  // makes the WebView talk to the local agent instead of cloud onboarding.
  return JSON.stringify({
    id: "local:android",
    kind: "remote",
    label: "On-device agent",
    apiBase: "eliza-local-agent://ipc",
  });
}

export const SEED_STORAGE: Record<string, string> = {
  "eliza:onboarding-complete": "1",
  "eliza:ui-shell-mode": "native",
  "eliza:mobile-runtime-mode": BACKEND === "host" ? "remote" : "local",
  "elizaos:active-server": activeServerSeed(),
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type TestFixtures = { page: Page };
type WorkerFixtures = {
  device: AndroidDevice;
  appPage: Page;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // One connected device per worker (workers are forced to 1 — the device has a
  // single WebView). Closed at the end so adb is released for the next run.
  device: [
    async ({}, use) => {
      const device = await connectPlaywrightDevice(
        android,
        process.env.ANDROID_SERIAL,
      );
      await use(device);
      await device.close();
    },
    { scope: "worker" },
  ],

  // One app session per worker. Launches the app, attaches to its WebView,
  // seeds storage, reloads, and waits for the shell to leave the "Connecting to
  // backend…" splash. Subsequent specs SPA-navigate this same page.
  appPage: [
    async ({ device }, use) => {
      const adb = resolveAdb();
      launchApp(adb, device.serial());
      for (let i = 0; i < 30 && !appPid(adb, device.serial()); i += 1) {
        await delay(500);
      }
      const webview = await device.webView({ pkg: APP_ID }, { timeout: 60_000 });
      const page = await webview.page();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.evaluate((seed: Record<string, string>) => {
        for (const [key, value] of Object.entries(seed)) {
          localStorage.setItem(key, value);
        }
      }, SEED_STORAGE);
      await page
        .goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 20_000 })
        .catch(() => {});
      await waitForShellReady(page);
      await use(page);
    },
    { scope: "worker" },
  ],

  // Override the built-in test-scoped `page` with the worker WebView page, so
  // the specs read like ordinary Playwright but drive the real device WebView.
  // It does NOT depend on browser/context, so no Chromium is launched.
  page: async ({ appPage }, use) => {
    await use(appPage);
  },
});

export { expect, android };

/** True once the React shell has rendered past the connecting/loading splash. */
export async function waitForShellReady(
  page: Page,
  timeoutMs = 180_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const text = await page
          .evaluate(() => document.body?.innerText ?? "")
          .catch(() => "");
        if (/BACKEND UNREACHABLE/i.test(text)) {
          throw new Error(`App reported backend unreachable: ${text.slice(0, 200)}`);
        }
        const stillBooting =
          /Connecting to backend|INITIALIZING AGENT|^\s*Loading\s*$/i.test(text);
        return !stillBooting && text.trim().length > 40;
      },
      { timeout: timeoutMs, message: "app shell never left the connecting splash" },
    )
    .toBe(true);
}

/**
 * Client-side SPA navigation. Capacitor's WebView has no server-side fallback
 * for nested paths, so a hard page.goto('/apps/x') serves a blank 404. We drive
 * the app's own router via the History API instead, exactly like a user tap.
 */
export async function gotoRoute(page: Page, routePath: string): Promise<void> {
  await page.evaluate((path: string) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, routePath);
}

export type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

/** Resolve when ANY (mode="any") or ALL (mode="all") ready-checks are visible. */
export async function expectRouteReady(
  page: Page,
  label: string,
  checks: readonly ReadyCheck[],
  { mode = "any", timeoutMs = 45_000 }: { mode?: "any" | "all"; timeoutMs?: number } = {},
): Promise<void> {
  const evaluate = async () => {
    const results = await Promise.all(
      checks.map(async (check) => {
        const locator =
          "selector" in check
            ? page.locator(check.selector)
            : page.getByText(check.text, { exact: false });
        return locator
          .first()
          .isVisible()
          .catch(() => false);
      }),
    );
    return mode === "all" ? results.every(Boolean) : results.some(Boolean);
  };
  await expect
    .poll(evaluate, {
      timeout: timeoutMs,
      message: `${label}: route ready-checks failed (${checks
        .map((c) => ("selector" in c ? c.selector : `text:${c.text}`))
        .join(", ")})`,
    })
    .toBe(true);
}
