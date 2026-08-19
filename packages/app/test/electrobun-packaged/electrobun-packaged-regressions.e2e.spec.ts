/**
 * Packaged Electrobun spec for the Electrobun Packaged Regressions E2e desktop
 * app behavior.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";
import { assertScreenshotNotBlank } from "../ui-smoke/helpers/screenshot-quality";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  type DesktopNotificationDiagnostic,
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";
import { hasPackagedRendererBootstrapRequests } from "./windows-bootstrap";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

const SETTINGS_SELECTOR = '[data-testid="settings-shell"]';
const PLUGINS_SELECTOR = '[data-testid="plugins-shell"]';
// #9952: onboarding is now in-chat — a fresh / reset profile paints the home plus
// the auto-opened REAL floating ChatOverlay (the conductor seeds the
// greeting + choices into it), so the chat overlay IS the first-run surface. The
// removed full-screen `startup-first-run-background` gate no longer exists.
const FIRST_RUN_SELECTOR = '[data-testid="chat-overlay"]';
const SETTINGS_ROUTE = "/settings";
const SETTINGS_MEDIA_ROUTE = "/settings/voice";
const PLUGINS_ROUTE = "/apps/plugins";
const NAVIGATE_SETTINGS_EVENT = "eliza:navigate:settings";
const NAVIGATE_VIEW_EVENT = "eliza:navigate:view";
const NOTIFICATION_TEST_BRIDGE_SYMBOL = "elizaos.ui.notification-store-tests";
// Electrobun's own Linux shortcut tests use an uncommon multi-modifier chord:
// ordinary desktop chords can be unavailable under Xvfb even when native
// registration works. Other platforms exercise the product default.
const PACKAGED_CHAT_OVERLAY_ACCELERATOR =
  process.platform === "linux"
    ? "Alt+Shift+Super+F11"
    : "CommandOrControl+Shift+C";

test.describe.configure({ mode: "serial" });

function isPackagedPlatform(): boolean {
  return (
    process.platform === "darwin" ||
    process.platform === "win32" ||
    process.platform === "linux"
  );
}

function getApiBaseExpression(): string {
  // The boot config is the single source of truth for the API base; the
  // Electrobun renderer injection seeds its window mirror before renderer JS.
  return [
    "window.__ELIZAOS_APP_BOOT_CONFIG__?.apiBase",
    "window.__ELIZAOS_API_BASE__",
  ].join(" ?? ");
}

function debugPackagedPhase(label: string): void {
  if (!process.env.ELIZA_TEST_PACKAGED_DEBUG) {
    return;
  }
  console.warn(`[packaged-regression] ${label}`);
}

function getCurrentRouteExpression(): string {
  return [
    'window.location.protocol === "file:"',
    '  ? (window.location.hash.replace(/^#/, "") || "/")',
    "  : window.location.pathname",
  ].join("\n");
}

function getSettingsSectionForRoute(route: string): string | null {
  const match = /^\/settings\/([^/?#]+)$/.exec(route);
  return match ? decodeURIComponent(match[1]) : null;
}

function getRouteNavigationScript(route: string): string {
  const settingsSection = getSettingsSectionForRoute(route);
  if (settingsSection) {
    return [
      `const targetRoute = ${JSON.stringify(route)};`,
      `const settingsSection = ${JSON.stringify(settingsSection)};`,
      `const readCurrentRoute = () => ${getCurrentRouteExpression()};`,
      `const targetHash = "#" + settingsSection;`,
      `if (readCurrentRoute() !== ${JSON.stringify(SETTINGS_ROUTE)} || window.location.hash !== targetHash) {`,
      `  window.dispatchEvent(new CustomEvent(${JSON.stringify(NAVIGATE_SETTINGS_EVENT)}, {`,
      `    detail: { section: settingsSection },`,
      `  }));`,
      `  if (window.location.hash !== targetHash) {`,
      `    window.history.replaceState(null, "", targetHash);`,
      `    window.dispatchEvent(new HashChangeEvent("hashchange"));`,
      `  }`,
      `}`,
      `const currentRoute = readCurrentRoute();`,
    ].join("\n");
  }

  return [
    `const targetRoute = ${JSON.stringify(route)};`,
    `const readCurrentRoute = () => ${getCurrentRouteExpression()};`,
    `if (readCurrentRoute() !== targetRoute) {`,
    `  window.dispatchEvent(new CustomEvent(${JSON.stringify(NAVIGATE_VIEW_EVENT)}, {`,
    `    detail: { viewPath: targetRoute },`,
    `  }));`,
    `}`,
    `const currentRoute = readCurrentRoute();`,
  ].join("\n");
}

async function waitForEval<T>(
  harness: PackagedDesktopHarness,
  script: string,
  predicate: (result: T) => boolean,
  options: {
    timeout: number;
    message: string;
  },
): Promise<T> {
  let lastResult: T | undefined;
  let lastError: Error | null = null;
  try {
    await expect
      .poll(
        async () => {
          try {
            lastResult = await harness.eval<T>(script);
            lastError = null;
            return predicate(lastResult);
          } catch (error) {
            lastError =
              error instanceof Error ? error : new Error(String(error));
            return false;
          }
        },
        {
          timeout: options.timeout,
          message: options.message,
        },
      )
      .toBe(true);
  } catch (error) {
    const suffix =
      typeof lastResult === "undefined"
        ? `No renderer result was captured.${
            lastError ? ` Last eval error: ${lastError.message}` : ""
          }`
        : `Last renderer result: ${JSON.stringify(lastResult)}`;
    throw new Error(
      `${options.message}\n${suffix}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof lastResult === "undefined") {
    throw new Error(options.message);
  }

  return lastResult;
}

async function ingestPackagedNotification(
  harness: PackagedDesktopHarness,
  notification: {
    id: string;
    title: string;
    body: string;
    priority: "normal" | "high" | "urgent";
  },
): Promise<{ hasFocus: boolean; visibilityState: string }> {
  const result = await waitForEval<
    EvalResult<{ hasFocus: boolean; visibilityState: string }>
  >(
    harness,
    `(() => {
      try {
        const bridge = globalThis[Symbol.for(${JSON.stringify(
          NOTIFICATION_TEST_BRIDGE_SYMBOL,
        )})];
        if (!bridge?.ingestNotificationForTests) {
          return { ok: false, error: "notification store test bridge unavailable" };
        }
        bridge.ingestNotificationForTests({
          id: ${JSON.stringify(notification.id)},
          title: ${JSON.stringify(notification.title)},
          body: ${JSON.stringify(notification.body)},
          category: "system",
          priority: ${JSON.stringify(notification.priority)},
          source: "packaged-e2e",
          createdAt: Date.now(),
          readAt: null,
        }, 1);
        return {
          ok: true,
          hasFocus: document.hasFocus(),
          visibilityState: document.visibilityState,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    })()`,
    (value) => value.ok === true,
    {
      message:
        "Expected packaged renderer notification store test bridge to ingest a notification.",
      timeout: 30_000,
    },
  );
  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
  return result;
}

async function waitForNativeNotification(
  harness: PackagedDesktopHarness,
  title: string,
): Promise<DesktopNotificationDiagnostic> {
  const startedAt = Date.now();
  let lastNotifications: DesktopNotificationDiagnostic[] = [];
  while (Date.now() - startedAt < 30_000) {
    lastNotifications = await harness.readNotifications();
    const match = lastNotifications.find(
      (notification) => notification.title === title,
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for native notification ${JSON.stringify(
      title,
    )}.\nLast notifications: ${JSON.stringify(lastNotifications, null, 2)}`,
  );
}

async function writeHarnessScreenshot(
  harness: PackagedDesktopHarness,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  try {
    const data = await harness.screenshot();
    const base64 = data.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    await assertScreenshotNotBlank(buffer, `packaged ${name}`);
    await fs.writeFile(testInfo.outputPath(`${name}.png`), buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await testInfo
      .attach(`${name}-capture-error`, {
        body: Buffer.from(message, "utf8"),
        contentType: "text/plain",
      })
      .catch(() => undefined);
    throw error;
  }
}

async function openRouteAndWait(
  harness: PackagedDesktopHarness,
  route: string,
  selector: string,
): Promise<void> {
  const result = await waitForEval<
    EvalResult<{
      route: string;
      selector: string;
      found: boolean;
      text: string;
      firstRunFound: boolean;
      hash: string;
      activeSettingsSection: string | null;
      voiceSectionActive: boolean;
      rootHtmlLength: number;
      bodyText: string;
    }>
  >(
    harness,
    `(() => {
      try {
      const targetSelector = ${JSON.stringify(selector)};
      ${getRouteNavigationScript(route)}
      const node = document.querySelector(targetSelector);
      return {
        ok: true,
        route: currentRoute,
        selector: targetSelector,
        found: Boolean(node),
        text: (node?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240),
        firstRunFound: Boolean(
          document.querySelector(${JSON.stringify(FIRST_RUN_SELECTOR)}),
        ),
        hash: window.location.hash,
        activeSettingsSection:
          document
            .querySelector('[data-agent-id^="section-"][aria-current="page"]')
            ?.getAttribute("data-agent-id")
            ?.replace(/^section-/, "") ?? null,
        voiceSectionActive: Boolean(
          document.querySelector('[data-testid="voice-section-continuous-row"]'),
        ),
        rootHtmlLength: document.getElementById("root")?.innerHTML.length ?? 0,
        bodyText: (document.body?.innerText || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 240),
      };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) =>
      current.ok &&
      current.selector === selector &&
      current.found &&
      (route === SETTINGS_MEDIA_ROUTE
        ? current.route === SETTINGS_ROUTE &&
          current.hash === "#voice" &&
          current.voiceSectionActive
        : current.route === route),
    {
      timeout: 20_000,
      message: `Timed out waiting for ${selector} at ${route}.`,
    },
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
}

async function waitForMediaSettingsRoute(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await waitForEval<
    EvalResult<{
      shellReady: boolean;
      route: string;
      hash: string;
      activeSettingsSection: string | null;
      voiceSectionActive: boolean;
      rootHtmlLength: number;
      bodyText: string;
    }>
  >(
    harness,
    `(() => {
      try {
        ${getRouteNavigationScript(SETTINGS_MEDIA_ROUTE)}
        return {
          ok: true,
          shellReady: Boolean(document.querySelector(${JSON.stringify(SETTINGS_SELECTOR)})),
          route: currentRoute,
          hash: window.location.hash,
          activeSettingsSection:
            document
              .querySelector('[data-agent-id^="section-"][aria-current="page"]')
              ?.getAttribute("data-agent-id")
              ?.replace(/^section-/, "") ?? null,
          voiceSectionActive: Boolean(
            document.querySelector('[data-testid="voice-section-continuous-row"]'),
          ),
          rootHtmlLength: document.getElementById("root")?.innerHTML.length ?? 0,
          bodyText: (document.body?.innerText || "")
            .replace(/\\s+/g, " ")
            .trim()
            .slice(0, 240),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) =>
      current.ok &&
      current.shellReady &&
      current.route === SETTINGS_ROUTE &&
      current.hash === "#voice" &&
      current.voiceSectionActive,
    {
      timeout: 20_000,
      message: `Timed out waiting for media settings route at ${SETTINGS_MEDIA_ROUTE}.`,
    },
  );
}

async function waitForProviderTrigger(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await waitForEval<
    EvalResult<{
      shellReady: boolean;
    }>
  >(
    harness,
    `(() => {
      try {
        ${getRouteNavigationScript(SETTINGS_ROUTE)}
        return {
          ok: true,
          shellReady: Boolean(document.querySelector(${JSON.stringify(SETTINGS_SELECTOR)})),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) => current.ok && current.shellReady,
    {
      timeout: 20_000,
      message: `Timed out waiting for settings shell at ${SETTINGS_ROUTE}.`,
    },
  );
}

async function setPersistedSettingsState(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await waitForMediaSettingsRoute(harness);
  const result = await harness.eval<
    EvalResult<{
      provider: unknown;
    }>
  >(
    `(async () => {
      try {
        ${getRouteNavigationScript(SETTINGS_MEDIA_ROUTE)}

        const apiBase = ${getApiBaseExpression()};
        if (!apiBase) {
          return { ok: false, error: "Desktop renderer did not expose an API base." };
        }

        const providerResponse = await fetch(\`\${apiBase}/api/config\`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceRouting: {
              llmText: {
                transport: "direct",
                backend: "openai",
                primaryModel: "gpt-5.4-nano",
              },
            },
          }),
        });
        if (!providerResponse.ok) {
          return {
            ok: false,
            error: \`Provider config save failed (\${providerResponse.status})\`,
          };
        }
        await providerResponse.json();

        return {
          ok: true,
          provider: { success: true, provider: "openai" },
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(result.provider).toMatchObject({ success: true, provider: "openai" });
}

async function readPersistedSettingsState(
  harness: PackagedDesktopHarness,
): Promise<{
  providerLabel: string | null;
  backend: string | null;
}> {
  await waitForProviderTrigger(harness);
  const result = await harness.eval<
    EvalResult<{
      providerLabel: string | null;
      backend: string | null;
    }>
  >(
    `(async () => {
      try {
        ${getRouteNavigationScript(SETTINGS_ROUTE)}
        const apiBase = ${getApiBaseExpression()};
        if (!apiBase) {
          return { ok: false, error: "Desktop renderer did not expose an API base." };
        }

        const configResponse = await fetch(\`\${apiBase}/api/config\`);
        if (!configResponse.ok) {
          return {
            ok: false,
            error: \`Config fetch failed (\${configResponse.status})\`,
          };
        }
        const config = await configResponse.json();
        const backend =
          config &&
          typeof config === "object" &&
          config.serviceRouting &&
          typeof config.serviceRouting === "object" &&
          config.serviceRouting.llmText &&
          typeof config.serviceRouting.llmText === "object" &&
          typeof config.serviceRouting.llmText.backend === "string"
            ? config.serviceRouting.llmText.backend
            : null;

        return {
          ok: true,
          providerLabel: backend === "openai" ? "OpenAI" : backend,
          backend,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return result;
}

async function readVisiblePluginIds(
  harness: PackagedDesktopHarness,
): Promise<string[]> {
  const result = await waitForEval<EvalResult<{ ids: string[] }>>(
    harness,
    `(() => {
      try {
        ${getRouteNavigationScript(PLUGINS_ROUTE)}
        const shell = document.querySelector(${JSON.stringify(PLUGINS_SELECTOR)});
        const ids = Array.from(
          document.querySelectorAll('[data-plugin-id]'),
        )
          .map((node) => node.getAttribute("data-plugin-id"))
          .filter((value) => typeof value === "string");
        return {
          ok: true,
          shellReady: Boolean(shell),
          ids,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) =>
      current.ok &&
      current.ids.includes("openai") &&
      current.ids.includes("ollama"),
    {
      timeout: 20_000,
      message: `Timed out waiting for visible plugin catalog entries at ${PLUGINS_ROUTE}.`,
    },
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.ids;
}

async function seedResettableState(
  harness: PackagedDesktopHarness,
): Promise<void> {
  const result = await harness.eval<
    EvalResult<{
      firstRunComplete: string | null;
      activeServer: string | null;
    }>
  >(
    `(() => {
      try {
        const bridge = window.__ELIZA_PACKAGED_SHELL_STORAGE_TEST__;
        if (!bridge || typeof bridge.seedResettableState !== "function") {
          return {
            ok: false,
            error: "Packaged shell storage test bridge is unavailable.",
          };
        }
        return bridge.seedResettableState();
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
}

async function waitForResetUiState(
  harness: PackagedDesktopHarness,
): Promise<void> {
  const result = await waitForEval<
    EvalResult<{
      route: string;
      overlayVisible: boolean;
      settingsVisible: boolean;
      rootHtmlLength: number;
      bodyText: string;
      firstRunComplete: string | null;
      activeServer: string | null;
      resetTest: unknown;
    }>
  >(
    harness,
    `(() => {
      try {
        const overlayVisible = Boolean(
          document.querySelector(${JSON.stringify(FIRST_RUN_SELECTOR)}),
        );
        const settingsVisible = Boolean(
          document.querySelector(${JSON.stringify(SETTINGS_SELECTOR)}),
        );
        const firstRunComplete = localStorage.getItem("eliza:first-run-complete");
        const activeServer = localStorage.getItem("elizaos:active-server");
        return {
          ok: true,
          route: ${getCurrentRouteExpression()},
          overlayVisible,
          settingsVisible,
          rootHtmlLength: document.getElementById("root")?.innerHTML.length ?? 0,
          bodyText: (document.body?.innerText || "")
            .replace(/\\s+/g, " ")
            .trim()
            .slice(0, 500),
          firstRunComplete,
          activeServer,
          resetTest: window.__ELIZA_PACKAGED_RESET_TEST__ ?? null,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) =>
      current.ok &&
      current.overlayVisible === true &&
      current.firstRunComplete !== "1" &&
      current.activeServer == null,
    {
      timeout: 90_000,
      message: "Timed out waiting for first-run reset overlay.",
    },
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
}

async function waitForResetRequest(api: TestApiServer): Promise<void> {
  await expect
    .poll(
      () =>
        api.requests.filter((request) =>
          /^POST .*\/agent\/reset$/.test(request),
        ).length,
      {
        timeout: 30000,
        message: "Expected packaged reset flow to POST an /agent/reset route.",
      },
    )
    .toBe(1);
}

async function seedReturningInstallState(
  harness: PackagedDesktopHarness,
  fallbackApiBase?: string,
): Promise<void> {
  const result = await waitForEval<
    EvalResult<{
      firstRunComplete: string | null;
      setupStep: string | null;
      uiShellMode: string | null;
      activeServer: string | null;
    }>
  >(
    harness,
    `(() => {
      try {
        const apiBase = ${getApiBaseExpression()} ?? ${JSON.stringify(fallbackApiBase ?? null)};
        if (!apiBase) {
          return {
            ok: false,
            error: "Desktop renderer did not expose an API base while seeding returning-install state.",
          };
        }
        const bridge = window.__ELIZA_PACKAGED_SHELL_STORAGE_TEST__;
        if (!bridge || typeof bridge.seedReturningInstallState !== "function") {
          return {
            ok: false,
            error: "Packaged shell storage test bridge is unavailable.",
          };
        }
        return bridge.seedReturningInstallState(
          apiBase,
          ${JSON.stringify(PACKAGED_CHAT_OVERLAY_ACCELERATOR)},
        );
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) => current.ok,
    {
      timeout: process.env.CI ? 120_000 : 90_000,
      message: "Timed out seeding packaged returning-install state.",
    },
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
}

async function readMainWindowEffects(harness: PackagedDesktopHarness): Promise<{
  transparent: boolean | null;
  titleBarStyle: string | null;
  vibrancyEnabled: boolean | null;
  shadowEnabled: boolean | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
}> {
  const state = await harness.getState();
  return {
    transparent: state.mainWindow.transparent,
    titleBarStyle: state.mainWindow.titleBarStyle,
    vibrancyEnabled: state.mainWindow.vibrancyEnabled,
    shadowEnabled: state.mainWindow.shadowEnabled,
    bounds: state.mainWindow.bounds,
  };
}

async function resizeMainWindow(
  harness: PackagedDesktopHarness,
  width: number,
  height: number,
): Promise<void> {
  const bounds = await harness.setMainWindowBounds({ width, height });
  expect(bounds.width).toBe(width);
  expect(bounds.height).toBe(height);
}

async function withPackagedHarness(
  fn: (args: {
    api: TestApiServer;
    harness: PackagedDesktopHarness;
    tempRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-packaged-regressions-"),
  );
  const extractDir = path.join(tempRoot, "extract");
  const launcherPath = await resolvePackagedLauncher(extractDir);

  expect(
    launcherPath,
    "Packaged launcher is required for packaged desktop regressions.",
  ).toBeTruthy();

  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;

  try {
    api = await startMockApiServer({ firstRunComplete: true, port: 0 });
    harness = new PackagedDesktopHarness({
      tempRoot,
      launcherPath: launcherPath as string,
      apiBase: api.baseUrl,
      // These regressions assert the legacy full-window vibrancy/tray/resize
      // behaviour. Since #10350 flipped the default resting surface to the
      // chromeless bottom bar, opt out here so they keep testing the full window
      // (the bottom-bar default is covered by electrobun-bottom-bar.e2e.spec.ts).
      extraEnv: {
        ELIZA_DESKTOP_BOTTOM_BAR: "0",
      },
    });
    debugPackagedPhase("starting initial packaged launch");
    await harness.start({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 60_000,
    });
    debugPackagedPhase("initial packaged launch ready");
    await seedReturningInstallState(harness, api.baseUrl);
    debugPackagedPhase("seeded returning-install state");
    const rendererOriginBeforeRelaunch = await harness
      .eval<string | null>(`window.location.origin || null`)
      .catch(() => null);
    const requestCountBeforeRelaunch = api.requests.length;
    debugPackagedPhase("starting packaged relaunch");
    await harness.relaunch({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 60_000,
    });
    debugPackagedPhase("packaged relaunch ready");

    // Verify that localStorage state survived the relaunch. If not, the
    // startup coordinator will fall back to a fresh-install probe path and
    // may stall or show the first-run overlay instead of the app shell.
    const persistenceCheck = await waitForEval<
      EvalResult<{
        firstRunComplete: string | null;
        activeServer: string | null;
        apiBase: string | null;
        origin: string | null;
      }>
    >(
      harness,
      `(() => {
        try {
          return {
            ok: true,
            firstRunComplete: localStorage.getItem("eliza:first-run-complete"),
            activeServer: localStorage.getItem("elizaos:active-server"),
            apiBase: ${getApiBaseExpression()} ?? null,
            origin: window.location.origin || null,
          };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      })()`,
      (current) => current.ok,
      {
        timeout: process.env.CI ? 120_000 : 90_000,
        message:
          "Timed out waiting for renderer localStorage probe after packaged relaunch.",
      },
    );

    if (
      persistenceCheck.ok &&
      (!persistenceCheck.firstRunComplete || !persistenceCheck.activeServer)
    ) {
      console.warn(
        `[packaged-harness] localStorage was NOT persisted across relaunch.`,
        `firstRunComplete=${persistenceCheck.firstRunComplete}`,
        `activeServer=${persistenceCheck.activeServer}`,
        `apiBase=${persistenceCheck.apiBase}`,
        `originBefore=${rendererOriginBeforeRelaunch}`,
        `originAfter=${persistenceCheck.origin}`,
        `— re-seeding state for this session.`,
      );
      // Re-seed when WKWebView did not flush localStorage before process exit.
      await seedReturningInstallState(harness, api.baseUrl);
    }
    debugPackagedPhase("validated relaunch persistence state");

    const relaunchBootstrapObserved = await expect
      .poll(
        () =>
          hasPackagedRendererBootstrapRequests(
            api?.requests.slice(requestCountBeforeRelaunch) ?? [],
          ),
        {
          timeout: process.env.CI ? 180_000 : 90_000,
          message:
            "Expected the seeded packaged relaunch to reach the external API bootstrap requests before UI assertions.",
        },
      )
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    debugPackagedPhase(
      relaunchBootstrapObserved
        ? "relaunch bootstrap requests observed"
        : "relaunch reached app shell without bootstrap request signal",
    );

    // Wait for the startup coordinator to finish transitioning past the
    // StartupShell. Bootstrap requests prove the live API is reachable, but
    // the startup coordinator may still be in polling-backend → starting-runtime
    // → hydrating phases. Poll until the startup shell DOM element is gone
    // and the root element has substantial content.
    //
    // Previous approach used a regex on body text (/LOADING/i etc.) which
    // false-positived on app-shell "Loading messages…" text in ChatView,
    // causing the relaunch to stall even though the coordinator reached ready.
    await waitForEval<
      EvalResult<{
        ready: boolean;
        rootLength: number;
        bodySnippet: string;
        startupPhase: string | null;
      }>
    >(
      harness,
      `(() => {
        try {
          const rootHtml = document.getElementById("root")?.innerHTML ?? "";
          const startupShell = document.querySelector('[data-testid="startup-shell-loading"]');
          const firstRunOverlay = document.querySelector('[data-testid="first-run-shell"]');
          const startupPhase = startupShell?.getAttribute("data-startup-phase") ?? null;
          const bodyText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
          return {
            ok: true,
            ready: rootHtml.length > 200 && !startupShell && !firstRunOverlay,
            rootLength: rootHtml.length,
            bodySnippet: bodyText.slice(0, 120),
            startupPhase,
          };
        } catch (e) {
          return { ok: false, ready: false, rootLength: 0, bodySnippet: "", startupPhase: null };
        }
      })()`,
      (r) => r.ok && r.ready,
      {
        timeout: process.env.CI ? 120_000 : 60_000,
        message:
          "Timed out waiting for the app shell to render after relaunch (startup coordinator did not reach ready state).",
      },
    );
    debugPackagedPhase("post-relaunch app shell ready");

    try {
      debugPackagedPhase("entering test-specific assertions");
      await fn({ api, harness, tempRoot });
    } catch (error) {
      const requestLog = api.requests.slice(-80).join("\n");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nRecent packaged API requests:\n${requestLog}`,
      );
    }
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

test("packaged desktop persists media, provider, and plugin state across relaunch", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.skip(
    !isPackagedPlatform(),
    "Packaged desktop regressions require a macOS, Windows, or Linux launcher.",
  );

  await withPackagedHarness(async ({ harness }) => {
    await openRouteAndWait(harness, SETTINGS_MEDIA_ROUTE, SETTINGS_SELECTOR);
    await setPersistedSettingsState(harness);
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "persistence-before-relaunch",
    );

    await harness.relaunch();

    await openRouteAndWait(harness, SETTINGS_ROUTE, SETTINGS_SELECTOR);
    const settingsState = await readPersistedSettingsState(harness);
    expect(settingsState.providerLabel).toContain("OpenAI");
    expect(settingsState.backend).toBe("openai");
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "persistence-settings-after-relaunch",
    );

    await openRouteAndWait(harness, PLUGINS_ROUTE, PLUGINS_SELECTOR);
    const pluginIds = await readVisiblePluginIds(harness);
    expect(pluginIds).toEqual(expect.arrayContaining(["openai", "ollama"]));
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "persistence-plugins-after-relaunch",
    );
  });
});

test("packaged desktop reset from the application menu returns the shell to first-run setup", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.skip(
    process.platform === "linux" || !isPackagedPlatform(),
    "Application menu reset is only supported on packaged macOS or Windows launchers.",
  );

  await withPackagedHarness(async ({ api, harness }) => {
    await openRouteAndWait(harness, SETTINGS_ROUTE, SETTINGS_SELECTOR);
    await seedResettableState(harness);
    await harness.menuAction("reset-app");
    await waitForResetRequest(api);
    await waitForResetUiState(harness);
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "reset-from-application-menu",
    );
  });
});

test("packaged desktop summon shortcut follows the platform contract", async ({
  browserName: _browserName,
}) => {
  void _browserName;
  test.skip(
    !isPackagedPlatform(),
    "Packaged desktop regressions require a macOS, Windows, or Linux launcher.",
  );

  await withPackagedHarness(async ({ harness }) => {
    const initialState = await harness.getState();
    expect(initialState.shell.shortcuts ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "command-palette",
          accelerator: "CommandOrControl+K",
        }),
      ]),
    );

    if (process.platform === "darwin") {
      expect(initialState.shell.shortcuts ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "chat-overlay" }),
        ]),
      );
      // The macOS path is a trusted native left+right Option event tap. The
      // renderer dispatch is unit-tested; real key-state acceptance remains a
      // manual packaged-app gate because this HTTP harness cannot inject a
      // trusted modifier transition into a listen-only CGEventTap.
      return;
    }

    expect(initialState.shell.shortcuts ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "chat-overlay",
          accelerator: PACKAGED_CHAT_OVERLAY_ACCELERATOR,
        }),
      ]),
    );

    await harness.closeMainWindow();
    await harness.waitForState(
      (state) =>
        state.mainWindow.present &&
        state.shell.trayPresent &&
        // GTK/Xvfb can retain stale focus telemetry after a native hide. The
        // window's native visibility is the authoritative tray-hide contract;
        // the assertion below still requires focus after the shortcut summons it.
        !state.shell.windowVisible,
      "Expected closing the main window to hide it to the tray before shortcut summon.",
      30_000,
    );

    await harness.pressShortcut("chat-overlay");
    await harness.waitForState(
      (state) =>
        state.mainWindow.present &&
        state.shell.windowVisible &&
        // A synthetic HTTP shortcut press is not a macOS user-activation event,
        // so the interactive test host may immediately reclaim key-window
        // status. The native implementation still activates NSApp and orders
        // the window key; CUA covers that real user-initiated focus boundary.
        (process.platform === "darwin" || state.shell.windowFocused),
      "Expected shortcut bridge press to summon the main window.",
      30_000,
    );
  });
});

test("packaged desktop notification store reaches native OS notifications", async ({
  browserName: _browserName,
}) => {
  void _browserName;
  test.skip(
    !isPackagedPlatform(),
    "Packaged desktop notification regressions require a macOS, Windows, or Linux launcher.",
  );

  await withPackagedHarness(async ({ harness }) => {
    await harness.clearNotifications();
    await harness.focusMainWindow();
    await harness.waitForState(
      (state) => state.mainWindow.present && state.shell.windowFocused,
      "Expected the packaged main window to be focused before urgent notification injection.",
      30_000,
    );

    const urgentFocus = await ingestPackagedNotification(harness, {
      id: "packaged-focused-urgent",
      title: "Focused urgent packaged alert",
      body: "The focused urgent notification should still reach the OS bridge.",
      priority: "urgent",
    });
    expect(urgentFocus.visibilityState).toBe("visible");
    // The native shell focus probe above is authoritative under Linux/Xvfb;
    // Chromium's document.hasFocus() can remain false even after the host has
    // focused the visible window. Interactive desktop hosts must agree at both
    // layers so this case still proves the genuinely focused path there.
    if (process.platform !== "linux") {
      expect(urgentFocus.hasFocus).toBe(true);
    }

    expect(
      await waitForNativeNotification(harness, "Focused urgent packaged alert"),
    ).toMatchObject({
      title: "Focused urgent packaged alert",
      body: "The focused urgent notification should still reach the OS bridge.",
      silent: false,
    });

    await harness.clearNotifications();
    // GTK/Xvfb accepts the native minimize command but can leave both focus and
    // visibility telemetry unchanged. Closing this tray-backed window exercises
    // the same background notification path with an observable native state.
    await harness.closeMainWindow();
    await harness.waitForState(
      (state) => state.mainWindow.present && !state.shell.windowVisible,
      "Expected the packaged main window to hide before background notification injection.",
      30_000,
    );

    const backgroundFocus = await ingestPackagedNotification(harness, {
      id: "packaged-background-normal",
      title: "Background normal packaged alert",
      body: "The hidden normal notification should reach the OS bridge.",
      priority: "normal",
    });
    expect(backgroundFocus.hasFocus).toBe(false);

    expect(
      await waitForNativeNotification(
        harness,
        "Background normal packaged alert",
      ),
    ).toMatchObject({
      title: "Background normal packaged alert",
      body: "The hidden normal notification should reach the OS bridge.",
      silent: false,
    });
  });
});

test("packaged macOS desktop keeps the tray alive and preserves vibrancy through resize", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.skip(
    process.platform !== "darwin",
    "Tray and vibrancy regression checks are macOS-only.",
  );

  await withPackagedHarness(async ({ harness }) => {
    const initialState = await harness.waitForState(
      (state) =>
        state.shell.trayPresent &&
        state.mainWindow.present &&
        state.mainWindow.transparent === true &&
        state.mainWindow.vibrancyEnabled === true,
      "Expected a tray-backed transparent macOS main window with vibrancy enabled.",
      30000,
    );

    expect(initialState.mainWindow.titleBarStyle).toBe("hiddenInset");
    expect(initialState.shell.trayPopover).toMatchObject({
      configured: false,
      windowPresent: false,
      visible: false,
    });
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "macos-vibrancy-before-close",
    );

    const initialEffects = await readMainWindowEffects(harness);
    expect(initialEffects.shadowEnabled).toBe(true);

    await harness.closeMainWindow();

    await harness.waitForState(
      (state) => !state.mainWindow.present && state.shell.trayPresent,
      "Expected closing the main window to leave the tray active.",
      30000,
    );

    await harness.menuAction("show");

    await harness.waitForState(
      (state) =>
        state.mainWindow.present &&
        state.mainWindow.transparent === true &&
        state.mainWindow.vibrancyEnabled === true,
      "Expected the tray Show action to restore the transparent vibrancy window.",
      30000,
    );

    await resizeMainWindow(harness, 1240, 860);
    const resizedEffects = await readMainWindowEffects(harness);
    expect(resizedEffects.vibrancyEnabled).toBe(true);
    expect(resizedEffects.transparent).toBe(true);
    expect(resizedEffects.titleBarStyle).toBe(initialEffects.titleBarStyle);
    expect(resizedEffects.bounds?.width).toBe(1240);
    expect(resizedEffects.bounds?.height).toBe(860);
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "macos-vibrancy-after-resize",
    );
  });
});
