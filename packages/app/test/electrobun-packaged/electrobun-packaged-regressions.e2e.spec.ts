import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";
import { startLiveApiServer, type TestApiServer } from "./live-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";
import { hasPackagedRendererBootstrapRequests } from "./windows-bootstrap";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

const SETTINGS_SELECTOR = '[data-testid="settings-shell"]';
const PLUGINS_SELECTOR = '[data-testid="connectors-settings-content"]';
const ONBOARDING_SELECTOR = '[data-testid="onboarding-ui-overlay"]';
const SETTINGS_ROUTE = "/settings";
const SETTINGS_MEDIA_ROUTE = "/settings/voice";
const PLUGINS_ROUTE = "/apps/plugins";

test.describe.configure({ mode: "serial" });

function isPackagedPlatform(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

function getApiBaseExpression(): string {
  return ["window.__ELIZAOS_API_BASE__", "window.__ELIZA_API_BASE__"].join(
    " ?? ",
  );
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

function getRouteNavigationScript(route: string): string {
  return [
    `const targetRoute = ${JSON.stringify(route)};`,
    `const readCurrentRoute = () => ${getCurrentRouteExpression()};`,
    `if (window.location.protocol === "file:") {`,
    `  const targetHash = "#" + targetRoute;`,
    `  if (window.location.hash !== targetHash) {`,
    `    window.location.hash = targetHash;`,
    `  }`,
    `} else if (window.location.pathname !== targetRoute) {`,
    `  window.history.pushState(null, "", targetRoute);`,
    `  window.dispatchEvent(new Event("popstate"));`,
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
  try {
    await expect
      .poll(
        async () => {
          lastResult = await harness.eval<T>(script);
          return predicate(lastResult);
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
        ? "No renderer result was captured."
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

async function writeHarnessScreenshot(
  harness: PackagedDesktopHarness,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  try {
    const data = await harness.screenshot();
    const base64 = data.replace(/^data:image\/png;base64,/, "");
    await fs.writeFile(
      testInfo.outputPath(`${name}.png`),
      Buffer.from(base64, "base64"),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await testInfo
      .attach(`${name}-capture-error`, {
        body: Buffer.from(message, "utf8"),
        contentType: "text/plain",
      })
      .catch(() => undefined);
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
      onboardingFound: boolean;
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
        onboardingFound: Boolean(
          document.querySelector(${JSON.stringify(ONBOARDING_SELECTOR)}),
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
      current.route === route &&
      current.selector === selector &&
      current.found,
    {
      timeout: 20_000,
      message: `Timed out waiting for ${selector} at ${route}.`,
    },
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
}

async function waitForSettingsControls(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await waitForEval<
    EvalResult<{
      powerReady: boolean;
      animateReady: boolean;
    }>
  >(
    harness,
    `(() => {
      try {
        ${getRouteNavigationScript(SETTINGS_MEDIA_ROUTE)}
        const powerRoot = document.querySelector('[data-testid="settings-companion-vrm-power"]');
        const animateSwitch = document.querySelector('[data-testid="settings-companion-animate-when-hidden"] [role="switch"]');
        const powerButtons = powerRoot ? Array.from(powerRoot.querySelectorAll("button")) : [];
        const qualityButton = powerButtons.find((button) =>
          /always quality/i.test((button.textContent || "").trim()),
        );
        return {
          ok: true,
          powerReady: Boolean(qualityButton),
          animateReady: Boolean(animateSwitch),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) => current.ok && current.powerReady && current.animateReady,
    {
      timeout: 20_000,
      message: `Timed out waiting for media settings controls at ${SETTINGS_MEDIA_ROUTE}.`,
    },
  );
}

async function waitForProviderTrigger(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await waitForEval<
    EvalResult<{
      shellReady: boolean;
      providerReady: boolean;
    }>
  >(
    harness,
    `(() => {
      try {
        ${getRouteNavigationScript(SETTINGS_ROUTE)}
        return {
          ok: true,
          shellReady: Boolean(document.querySelector(${JSON.stringify(SETTINGS_SELECTOR)})),
          providerReady: Boolean(document.getElementById("provider-switcher-select")),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) => current.ok && current.shellReady && current.providerReady,
    {
      timeout: 20_000,
      message: `Timed out waiting for provider switcher at ${SETTINGS_ROUTE}.`,
    },
  );
}

async function setPersistedSettingsState(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await waitForSettingsControls(harness);
  const result = await harness.eval<
    EvalResult<{
      vrmPower: string | null;
      animateWhenHidden: string | null;
      provider: unknown;
    }>
  >(
    `(async () => {
      try {
        ${getRouteNavigationScript(SETTINGS_MEDIA_ROUTE)}

        const powerRoot = document.querySelector('[data-testid="settings-companion-vrm-power"]');
        const animateSwitch = document.querySelector('[data-testid="settings-companion-animate-when-hidden"] [role="switch"]');
        const powerButtons = powerRoot ? Array.from(powerRoot.querySelectorAll("button")) : [];
        const qualityButton = powerButtons.find((button) =>
          /always quality/i.test((button.textContent || "").trim()),
        );

        if (!qualityButton || !animateSwitch) {
          return {
            ok: false,
            error: "Media settings controls were not ready when applying persisted state.",
          };
        }

        qualityButton.click();
        if (animateSwitch.getAttribute("aria-checked") !== "true") {
          animateSwitch.click();
        }

        const apiBase = ${getApiBaseExpression()};
        if (!apiBase) {
          return { ok: false, error: "Desktop renderer did not expose an API base." };
        }

        const providerResponse = await fetch(\`\${apiBase}/api/provider/switch\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "openai",
            primaryModel: "gpt-5.4-nano",
          }),
        });
        if (!providerResponse.ok) {
          return {
            ok: false,
            error: \`Provider switch failed (\${providerResponse.status})\`,
          };
        }
        const provider = await providerResponse.json();

        return {
          ok: true,
          vrmPower: localStorage.getItem("eliza:companion-vrm-power"),
          animateWhenHidden: localStorage.getItem(
            "eliza:companion-animate-when-hidden",
          ),
          provider,
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

  expect(result.vrmPower).toBe("quality");
  expect(result.animateWhenHidden).toBe("1");
  expect(result.provider).toMatchObject({ success: true, provider: "openai" });
}

async function readPersistedSettingsState(
  harness: PackagedDesktopHarness,
): Promise<{
  vrmPower: string | null;
  animateWhenHidden: string | null;
  providerLabel: string | null;
  backend: string | null;
}> {
  await waitForProviderTrigger(harness);
  const result = await harness.eval<
    EvalResult<{
      vrmPower: string | null;
      animateWhenHidden: string | null;
      providerLabel: string | null;
      backend: string | null;
    }>
  >(
    `(async () => {
      try {
        ${getRouteNavigationScript(SETTINGS_ROUTE)}
        const providerTrigger = document.getElementById("provider-switcher-select");
        if (!providerTrigger) {
          return {
            ok: false,
            error: "Provider switcher was not ready when reading persisted settings.",
          };
        }

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
          vrmPower: localStorage.getItem("eliza:companion-vrm-power"),
          animateWhenHidden: localStorage.getItem(
            "eliza:companion-animate-when-hidden",
          ),
          providerLabel: (providerTrigger.textContent || "")
            .replace(/\\s+/g, " ")
            .trim(),
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

async function readVisiblePluginSectionIds(
  harness: PackagedDesktopHarness,
): Promise<string[]> {
  const result = await waitForEval<EvalResult<{ ids: string[] }>>(
    harness,
    `(() => {
      try {
        ${getRouteNavigationScript(PLUGINS_ROUTE)}
        const shell = document.querySelector(${JSON.stringify(PLUGINS_SELECTOR)});
        const ids = Array.from(
          document.querySelectorAll('[data-testid^="connector-section-"]'),
        )
          .map((node) => node.getAttribute("data-testid"))
          .filter((value) => typeof value === "string");
        return {
          ok: true,
          shellReady: Boolean(shell),
          ids: ids.map((value) => value.replace(/^connector-section-/, "")),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) => current.ok && current.ids.length >= 2,
    {
      timeout: 20_000,
      message: `Timed out waiting for visible plugin sections at ${PLUGINS_ROUTE}.`,
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
      onboardingComplete: string | null;
      activeServer: string | null;
      vrmPower: string | null;
    }>
  >(
    `(() => {
      try {
        localStorage.setItem("eliza:onboarding-complete", "1");
        localStorage.setItem("eliza:companion-vrm-power", "quality");
        localStorage.setItem(
          "elizaos:active-server",
          JSON.stringify({
            id: "local:embedded",
            kind: "local",
            label: "This device",
          }),
        );
        return {
          ok: true,
          onboardingComplete: localStorage.getItem("eliza:onboarding-complete"),
          activeServer: localStorage.getItem("elizaos:active-server"),
          vrmPower: localStorage.getItem("eliza:companion-vrm-power"),
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
}

async function triggerSettingsReset(
  harness: PackagedDesktopHarness,
): Promise<void> {
  const buttonState = await waitForEval<EvalResult<{ label: string }>>(
    harness,
    `(() => {
      try {
        ${getRouteNavigationScript(SETTINGS_ROUTE)}
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="settings-shell"] button'),
        );
        const resetButton = buttons.find((button) =>
          /reset everything/i.test((button.textContent || "").trim()),
        );
        return resetButton
          ? {
              ok: true,
              label: (resetButton.textContent || "").trim(),
            }
          : {
              ok: false,
              error: "Timed out waiting for the Settings reset button.",
            };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) => current.ok,
    {
      timeout: 20_000,
      message: "Timed out waiting for the Settings reset button.",
    },
  );

  expect(buttonState.ok, buttonState.ok ? undefined : buttonState.error).toBe(
    true,
  );

  const result = await harness.eval<
    EvalResult<{ label: string; autoConfirmed: boolean }>
  >(
    `(() => {
      try {
        ${getRouteNavigationScript(SETTINGS_ROUTE)}
        const rpc = window.__ELIZAOS_ELECTROBUN_RPC__;
        const canAutoConfirm = Boolean(rpc?.request?.desktopShowMessageBox);
        window.confirm = () => true;
        if (canAutoConfirm) {
          rpc.request.desktopShowMessageBox = async () => ({ response: 0 });
        }
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="settings-shell"] button'),
        );
        const resetButton = buttons.find((button) =>
          /reset everything/i.test((button.textContent || "").trim()),
        );
        if (!resetButton) {
          return {
            ok: false,
            error: "Settings reset button disappeared before click.",
          };
        }
        resetButton.click();
        return {
          ok: true,
          label: (resetButton.textContent || "").trim(),
          autoConfirmed: canAutoConfirm,
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
}

async function waitForResetUiState(
  harness: PackagedDesktopHarness,
): Promise<void> {
  const result = await waitForEval<
    EvalResult<{
      route: string;
      overlayVisible: boolean;
      onboardingComplete: string | null;
      activeServer: string | null;
    }>
  >(
    harness,
    `(() => {
      try {
        const overlayVisible = Boolean(
          document.querySelector(${JSON.stringify(ONBOARDING_SELECTOR)}),
        );
        const onboardingComplete = localStorage.getItem("eliza:onboarding-complete");
        const activeServer = localStorage.getItem("elizaos:active-server");
        return {
          ok: true,
          route: ${getCurrentRouteExpression()},
          overlayVisible,
          onboardingComplete,
          activeServer,
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
      current.onboardingComplete !== "1" &&
      current.activeServer == null,
    {
      timeout: 90_000,
      message: "Timed out waiting for onboarding reset overlay.",
    },
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
}

async function waitForResetRequest(api: MockApiServer): Promise<void> {
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
  const result = await harness.eval<
    EvalResult<{
      onboardingComplete: string | null;
      onboardingStep: string | null;
      uiShellMode: string | null;
      activeServer: string | null;
    }>
  >(
    `(() => {
      try {
        const apiBase = ${getApiBaseExpression()} ?? ${JSON.stringify(fallbackApiBase ?? null)};
        if (!apiBase) {
          return {
            ok: false,
            error: "Desktop renderer did not expose an API base while seeding returning-install state.",
          };
        }
        const label = (() => {
          try {
            return new URL(apiBase).host || apiBase;
          } catch {
            return apiBase;
          }
        })();
        localStorage.setItem("eliza:onboarding-complete", "1");
        localStorage.setItem("eliza:onboarding:step", "activate");
        localStorage.setItem("eliza:ui-shell-mode", "native");
        localStorage.setItem(
          "elizaos:active-server",
          JSON.stringify({
            id: \`remote:\${apiBase}\`,
            kind: "remote",
            label,
            apiBase,
          }),
        );
        return {
          ok: true,
          onboardingComplete: localStorage.getItem("eliza:onboarding-complete"),
          onboardingStep: localStorage.getItem("eliza:onboarding:step"),
          uiShellMode: localStorage.getItem("eliza:ui-shell-mode"),
          activeServer: localStorage.getItem("elizaos:active-server"),
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
  const result = await harness.eval<
    EvalResult<{
      width: number;
      height: number;
    }>
  >(
    `(() => {
      const rpc = window.__ELIZAOS_ELECTROBUN_RPC__;
      if (!rpc?.request?.desktopSetWindowBounds || !rpc?.request?.desktopGetWindowBounds) {
        return { ok: false, error: "Desktop window bounds RPCs are unavailable." };
      }
      return rpc.request.desktopGetWindowBounds(undefined)
        .then((bounds) =>
          rpc.request.desktopSetWindowBounds({
            ...bounds,
            width: ${width},
            height: ${height},
          }).then(() => ({
            ok: true,
            width: ${width},
            height: ${height},
          })),
        )
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    })()`,
  );

  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
}

async function withPackagedHarness(
  fn: (args: {
    api: MockApiServer;
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

  let api: TestApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;

  try {
    api = await startLiveApiServer({ onboardingComplete: true, port: 0 });
    harness = new PackagedDesktopHarness({
      tempRoot,
      launcherPath: launcherPath as string,
      apiBase: api.baseUrl,
    });
    debugPackagedPhase("starting initial packaged launch");
    await harness.start({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 60_000,
    });
    debugPackagedPhase("initial packaged launch ready");
    await expect
      .poll(() => hasPackagedRendererBootstrapRequests(api?.requests ?? []), {
        timeout: process.env.CI ? 180_000 : 90_000,
        message:
          "Expected the packaged renderer to reach its external API bootstrap requests before UI assertions.",
      })
      .toBe(true);
    debugPackagedPhase("initial bootstrap requests observed");
    await seedReturningInstallState(harness, api.baseUrl);
    debugPackagedPhase("seeded returning-install state");
    const requestCountBeforeRelaunch = api.requests.length;
    debugPackagedPhase("starting packaged relaunch");
    await harness.relaunch({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 60_000,
    });
    debugPackagedPhase("packaged relaunch ready");

    // Verify that localStorage state survived the relaunch. If not, the
    // startup coordinator will fall back to a fresh-install probe path and
    // may stall or show the onboarding overlay instead of the app shell.
    const persistenceCheck = await harness
      .eval<{
        ok: boolean;
        onboardingComplete: string | null;
        activeServer: string | null;
        apiBase: string | null;
      }>(
        `(() => {
        try {
          return {
            ok: true,
            onboardingComplete: localStorage.getItem("eliza:onboarding-complete"),
            activeServer: localStorage.getItem("elizaos:active-server"),
            apiBase: ${getApiBaseExpression()} ?? null,
          };
        } catch (e) {
          return { ok: false, onboardingComplete: null, activeServer: null, apiBase: null };
        }
      })()`,
      )
      .catch(() => ({
        ok: false,
        onboardingComplete: null,
        activeServer: null,
        apiBase: null,
      }));

    if (
      !persistenceCheck.onboardingComplete ||
      !persistenceCheck.activeServer
    ) {
      console.warn(
        `[packaged-harness] localStorage was NOT persisted across relaunch.`,
        `onboardingComplete=${persistenceCheck.onboardingComplete}`,
        `activeServer=${persistenceCheck.activeServer}`,
        `apiBase=${persistenceCheck.apiBase}`,
        `— re-seeding state for this session.`,
      );
      // Re-seed when WKWebView did not flush localStorage before process exit.
      await seedReturningInstallState(harness, api.baseUrl);
    }
    debugPackagedPhase("validated relaunch persistence state");

    await expect
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
      .toBe(true);
    debugPackagedPhase("relaunch bootstrap requests observed");

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
          const onboardingOverlay = document.querySelector('[data-testid="onboarding-ui-overlay"]');
          const startupPhase = startupShell?.getAttribute("data-startup-phase") ?? null;
          const bodyText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
          return {
            ok: true,
            ready: rootHtml.length > 200 && !startupShell && !onboardingOverlay,
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
    "Packaged desktop regressions require a macOS or Windows launcher.",
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
    expect(settingsState.vrmPower).toBe("quality");
    expect(settingsState.animateWhenHidden).toBe("1");
    expect(settingsState.providerLabel).toContain("OpenAI");
    expect(settingsState.backend).toBe("openai");
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "persistence-settings-after-relaunch",
    );

    await openRouteAndWait(harness, PLUGINS_ROUTE, PLUGINS_SELECTOR);
    const pluginIds = await readVisiblePluginSectionIds(harness);
    expect(pluginIds).toEqual(expect.arrayContaining(["openai", "ollama"]));
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "persistence-plugins-after-relaunch",
    );
  });
});

test("packaged desktop reset from Settings returns the shell to onboarding", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.skip(
    !isPackagedPlatform(),
    "Packaged desktop regressions require a macOS or Windows launcher.",
  );

  await withPackagedHarness(async ({ api, harness }) => {
    await openRouteAndWait(harness, SETTINGS_ROUTE, SETTINGS_SELECTOR);
    await seedResettableState(harness);
    await triggerSettingsReset(harness);
    await waitForResetRequest(api);
    await waitForResetUiState(harness);
    await writeHarnessScreenshot(harness, testInfo, "reset-from-settings");
  });
});

test("packaged desktop reset from the application menu returns the shell to onboarding", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.skip(
    !isPackagedPlatform(),
    "Packaged desktop regressions require a macOS or Windows launcher.",
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
    await writeHarnessScreenshot(
      harness,
      testInfo,
      "macos-vibrancy-before-close",
    );

    const initialEffects = await readMainWindowEffects(harness);
    expect(initialEffects.shadowEnabled).toBe(true);

    const closeResult = await harness.eval<EvalResult<Record<string, never>>>(
      `(() => {
        const rpc = window.__ELIZAOS_ELECTROBUN_RPC__;
        if (!rpc?.request?.desktopCloseWindow) {
          return { ok: false, error: "desktopCloseWindow RPC is unavailable." };
        }
        return rpc.request.desktopCloseWindow(undefined)
          .then(() => ({ ok: true }))
          .catch((error) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      })()`,
    );
    expect(closeResult.ok, closeResult.ok ? undefined : closeResult.error).toBe(
      true,
    );

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
