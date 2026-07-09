// Playwright fixtures + helpers for driving the real on-device Capacitor
// WebView via Playwright's Android driver (`_android`). Unlike the browser
// ui-smoke suite (which mocks every /api route in a desktop Chromium), this
// runs against the ACTUAL app installed on the emulator/device, talking to the
// real on-device agent. There is no webServer and no network mocking — the
// assertions exercise real render + real backend.
import {
  type AndroidDevice,
  type AndroidWebView,
  _android as android,
  type Browser,
  test as base,
  chromium,
  expect,
  type Page,
} from "@playwright/test";
// The shared device lib is plain ESM (.mjs); import the values we need.
import {
  APP_ID,
  adbRemoveForward,
  appPid,
  connectPlaywrightDevice,
  discoverWebViewTarget,
  foregroundApp,
  forwardWebViewCdp,
  resolveAdb,
  resolveSerial,
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
const ALLOW_FIRST_RUN =
  process.env.ELIZA_ANDROID_ALLOW_FIRST_RUN === "1" ||
  process.env.ELIZA_ANDROID_ALLOW_FIRST_RUN === "true";

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
  "eliza:first-run-complete": "1",
  "eliza:ui-shell-mode": "native",
  "eliza:mobile-runtime-mode": BACKEND === "host" ? "remote" : "local",
  "elizaos:active-server": activeServerSeed(),
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findAppWebView(device: AndroidDevice): AndroidWebView | undefined {
  return device.webViews().find((webview) => webview.pkg() === APP_ID);
}

async function waitForAppWebView(
  device: AndroidDevice,
  timeoutMs: number,
): Promise<AndroidWebView> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const existing = findAppWebView(device);
    if (existing) {
      return existing;
    }
    try {
      return await device.webView({ pkg: APP_ID }, { timeout: 1_000 });
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  const existing = findAppWebView(device);
  if (existing) {
    return existing;
  }
  throw new Error(
    `Timed out waiting for ${APP_ID} WebView after ${timeoutMs}ms: ${errorMessage(
      lastError,
    )}`,
  );
}

type TestFixtures = { page: Page };
type WorkerFixtures = {
  device: AndroidDevice;
  appPage: Page;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // One connected device per worker (workers are forced to 1 — the device has a
  // single WebView). Closed at the end so adb is released for the next run.
  device: [
    // Playwright requires the first fixture argument to be an object-destructuring
    // pattern; this fixture depends on no other fixtures, so the empty pattern `{}`
    // is correct. A bare identifier (`_fixtures`) makes Playwright reject it with
    // "First argument must use the object destructuring pattern".
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature requires the empty `{}` pattern
    async ({}, use) => {
      const adb = resolveAdb();
      const serial = resolveSerial(adb, process.env.ANDROID_SERIAL);
      foregroundApp(adb, serial);
      for (let i = 0; i < 30 && !appPid(adb, serial); i += 1) {
        await delay(500);
      }
      await delay(1_500);
      const device = await connectPlaywrightDevice(android, serial);
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
      let cdpBrowser: Browser | null = null;
      let cdpPort: number | null = null;
      // Foreground (don't force-stop) so an already-connected agent/device-bridge
      // session survives; force-stopping resets it and the shell never recovers.
      foregroundApp(adb, device.serial());
      for (let i = 0; i < 30 && !appPid(adb, device.serial()); i += 1) {
        await delay(500);
      }

      let page: Page | undefined;
      try {
        const webview = await waitForAppWebView(device, 60_000);
        page = await webview.page();
      } catch (error) {
        const nativeAttachError = error;
        // Some Android WebView builds expose the devtools socket a little before
        // Playwright can bind the target. Retry the supported `_android.webView`
        // path before falling back to browser-level CDP, which older WebViews do
        // not fully implement.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await delay(1_000);
          try {
            const webview = await waitForAppWebView(device, 5_000);
            page = await webview.page();
            break;
          } catch {
            // keep retrying the native attach path
          }
        }
        if (page === undefined) {
          cdpPort = Number(process.env.ELIZA_ANDROID_WEBVIEW_CDP_PORT ?? 9222);
          try {
            forwardWebViewCdp(adb, device.serial(), cdpPort);
            const target = await discoverWebViewTarget(cdpPort, {
              timeoutMs: 60_000,
            });
            cdpBrowser = await chromium.connectOverCDP(
              `http://127.0.0.1:${cdpPort}`,
            );
            const pages = cdpBrowser
              .contexts()
              .flatMap((context) => context.pages());
            page =
              pages.find((candidate) => candidate.url() === target.url) ??
              pages.find((candidate) => candidate.url().startsWith(ORIGIN)) ??
              pages[0];
            if (!page) {
              throw new Error(
                `Connected to Android WebView CDP on ${cdpPort}, but no page target was available after _android.webView() failed: ${errorMessage(
                  nativeAttachError,
                )}`,
              );
            }
          } catch (fallbackError) {
            await cdpBrowser?.close().catch(() => {});
            adbRemoveForward(adb, device.serial(), cdpPort);
            cdpPort = null;
            cdpBrowser = null;
            throw new Error(
              `Unable to attach to Android WebView. ` +
                `_android.webView failed first: ${errorMessage(nativeAttachError)}. ` +
                `CDP fallback failed: ${errorMessage(fallbackError)}`,
            );
          }
        }
      }

      if (!page) {
        throw new Error("Unable to attach to Android WebView: no page handle");
      }

      try {
        const storageSeed = ALLOW_FIRST_RUN ? {} : SEED_STORAGE;
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        await page.addInitScript(
          (args: { seed: Record<string, string>; allowFirstRun: boolean }) => {
            const globalObject = globalThis as typeof globalThis & {
              process?: {
                cwd?: () => string;
                env?: Record<string, string>;
              };
              __ELIZA_RENDER_TELEMETRY_ENABLED__?: boolean;
              __ELIZAOS_UI_APP_STORE__?: {
                value?: {
                  setState?: (key: string, value: unknown) => void;
                } | null;
              };
            };
            globalObject.process ??= {};
            globalObject.process.cwd ??= () => "/";
            globalObject.process.env ??= {};
            globalObject.process.env.VITE_ELIZA_RENDER_TELEMETRY = "1";
            globalObject.process.env.NODE_ENV = "test";
            globalObject.__ELIZA_RENDER_TELEMETRY_ENABLED__ = true;
            if (!args.allowFirstRun) {
              globalObject.__ELIZAOS_UI_APP_STORE__?.value?.setState?.(
                "firstRunComplete",
                true,
              );
            }
            for (const [key, value] of Object.entries(args.seed)) {
              localStorage.setItem(key, value);
            }
          },
          { seed: storageSeed, allowFirstRun: ALLOW_FIRST_RUN },
        );
        await page.evaluate(
          async (args: {
            seed: Record<string, string>;
            allowFirstRun: boolean;
          }) => {
            const globalObject = globalThis as typeof globalThis & {
              process?: {
                cwd?: () => string;
                env?: Record<string, string>;
              };
              __ELIZA_RENDER_TELEMETRY_ENABLED__?: boolean;
              __ELIZAOS_UI_APP_STORE__?: {
                value?: {
                  setState?: (key: string, value: unknown) => void;
                } | null;
              };
            };
            globalObject.process ??= {};
            globalObject.process.cwd ??= () => "/";
            globalObject.process.env ??= {};
            globalObject.process.env.VITE_ELIZA_RENDER_TELEMETRY = "1";
            globalObject.process.env.NODE_ENV = "test";
            globalObject.__ELIZA_RENDER_TELEMETRY_ENABLED__ = true;
            if (!args.allowFirstRun) {
              globalObject.__ELIZAOS_UI_APP_STORE__?.value?.setState?.(
                "firstRunComplete",
                true,
              );
            }
            for (const [key, value] of Object.entries(args.seed)) {
              localStorage.setItem(key, value);
            }
            const preferences = (
              window as Window & {
                Capacitor?: {
                  Plugins?: {
                    Preferences?: {
                      set?: (args: {
                        key: string;
                        value: string;
                      }) => Promise<void>;
                    };
                  };
                };
              }
            ).Capacitor?.Plugins?.Preferences;
            if (preferences?.set) {
              await Promise.all(
                Object.entries(args.seed).map(([key, value]) =>
                  preferences.set?.({ key, value }),
                ),
              );
            }
          },
          { seed: storageSeed, allowFirstRun: ALLOW_FIRST_RUN },
        );
        // Native localStorage is proxied to Capacitor Preferences on a later
        // task. Let those writes land before the reload that rehydrates startup
        // state from Preferences.
        await delay(750);
        if (ALLOW_FIRST_RUN) {
          await use(page);
          return;
        }
        if (!(await isShellReady(page)) || (await isFirstRunShowing(page))) {
          await page
            .goto(`${ORIGIN}/`, {
              waitUntil: "domcontentloaded",
              timeout: 20_000,
            })
            .catch(() => {});
          await waitForShellReady(page);
          await page
            .evaluate(() => {
              (
                window as Window & {
                  __ELIZAOS_UI_APP_STORE__?: {
                    value?: {
                      setState?: (key: string, value: unknown) => void;
                    } | null;
                  };
                }
              ).__ELIZAOS_UI_APP_STORE__?.value?.setState?.(
                "firstRunComplete",
                true,
              );
            })
            .catch(() => {});
        }
        await use(page);
      } finally {
        await cdpBrowser?.close().catch(() => {});
        if (cdpPort !== null) {
          adbRemoveForward(adb, device.serial(), cdpPort);
        }
      }
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

export { android, expect };

/** One-shot check: is the React shell rendered past the connecting splash? */
export async function isShellReady(page: Page): Promise<boolean> {
  const text = await page
    .evaluate(() => document.body?.innerText ?? "")
    .catch(() => "");
  const stillBooting = /Connecting to backend|INITIALIZING AGENT/i.test(text);
  return !stillBooting && text.trim().length > 40;
}

/** True when stale in-chat first-run UI is still mounted after fixture seeding. */
export async function isFirstRunShowing(page: Page): Promise<boolean> {
  return page
    .evaluate(() =>
      Boolean(
        document.querySelector(
          '[data-testid="first-run-runtime-chooser"], [data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
        ) ||
          // Chooser-mode greeting OR the cloud-only sign-in greeting (#13377).
          /First, where should your agent run|Sign in to Eliza Cloud and I['’]ll get you set up/i.test(
            document.body?.innerText ?? "",
          ),
      ),
    )
    .catch(() => false);
}

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
          throw new Error(
            `App reported backend unreachable: ${text.slice(0, 200)}`,
          );
        }
        const stillBooting =
          /Connecting to backend|INITIALIZING AGENT|^\s*Loading\s*$/i.test(
            text,
          );
        return !stillBooting && text.trim().length > 40;
      },
      {
        timeout: timeoutMs,
        message: "app shell never left the connecting splash",
      },
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
  {
    mode = "any",
    timeoutMs = 45_000,
  }: { mode?: "any" | "all"; timeoutMs?: number } = {},
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
