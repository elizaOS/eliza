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
// the auto-opened REAL floating ContinuousChatOverlay (the conductor seeds the
// greeting + choices into it), so the chat overlay IS the first-run surface. The
// removed full-screen `startup-first-run-background` gate no longer exists.
const FIRST_RUN_SELECTOR = '[data-testid="continuous-chat-overlay"]';
const SETTINGS_ROUTE = "/settings";
const SETTINGS_MEDIA_ROUTE = "/settings/voice";
const PLUGINS_ROUTE = "/apps/plugins";
const NAVIGATE_SETTINGS_EVENT = "eliza:navigate:settings";

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

function getDesktopRpcExpression(): string {
  return [
    "window.__ELIZA_ELECTROBUN_RPC__",
    "window.__ELIZAOS_ELECTROBUN_RPC__",
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
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(NAVIGATE_SETTINGS_EVENT)}, {`,
      `  detail: { section: settingsSection },`,
      `}));`,
      `const targetHash = "#" + settingsSection;`,
      `if (window.location.hash !== targetHash) {`,
      `  window.history.replaceState(null, "", targetHash);`,
      `  window.dispatchEvent(new HashChangeEvent("hashchange"));`,
      `}`,
      `const currentRoute = readCurrentRoute();`,
    ].join("\n");
  }

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
          window.location.hash === "#voice" &&
            document.querySelector(${JSON.stringify(SETTINGS_SELECTOR)}),
        ) || Boolean(
          document.querySelector('[data-agent-id="section-voice"][aria-current="page"]'),
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
        ? current.hash === "#voice" &&
          current.activeSettingsSection === "voice" &&
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
            window.location.hash === "#voice" &&
              document.querySelector(${JSON.stringify(SETTINGS_SELECTOR)}),
          ) || Boolean(
            document.querySelector('[data-agent-id="section-voice"][aria-current="page"]'),
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
      current.hash === "#voice" &&
      current.activeSettingsSection === "voice" &&
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
        localStorage.setItem("eliza:first-run-complete", "1");
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
          firstRunComplete: localStorage.getItem("eliza:first-run-complete"),
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

async function triggerSettingsReset(
  harness: PackagedDesktopHarness,
): Promise<void> {
  const buttonState = await waitForEval<EvalResult<{ label: string }>>(
    harness,
    `(() => {
      try {
        const shell = document.querySelector(${JSON.stringify(SETTINGS_SELECTOR)});
        if (!shell) {
          ${getRouteNavigationScript(SETTINGS_ROUTE)}
          return {
            ok: false,
            error: "Settings shell was not mounted; navigating to Settings.",
          };
        }
        const resetByAgentId = document.querySelector(
          '[data-agent-id="advanced-reset-open"]',
        );
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="settings-shell"] button'),
        );
        const resetButton =
          resetByAgentId instanceof HTMLButtonElement
            ? resetByAgentId
            : buttons.find((button) =>
                /reset everything/i.test((button.textContent || "").trim()),
              );
        if (!resetButton) {
          const advancedSection = document.querySelector(
            '[data-agent-id="section-advanced"]',
          );
          if (advancedSection instanceof HTMLButtonElement) {
            advancedSection.click();
          }
        }
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

  const result = await waitForEval<
    EvalResult<{
      label: string;
      confirmClicked: boolean;
      restartStubCalls: number;
    }>
  >(
    harness,
    `(() => {
      try {
        const shell = document.querySelector(${JSON.stringify(SETTINGS_SELECTOR)});
        if (!shell) {
          return {
            ok: false,
            error: "Settings shell disappeared before reset confirmation.",
          };
        }
        const rpc = ${getDesktopRpcExpression()};
        window.confirm = () => true;
        if (rpc?.request) {
          const resetTest =
            window.__ELIZA_PACKAGED_RESET_TEST__ ??
            (window.__ELIZA_PACKAGED_RESET_TEST__ = {
              messageBoxStubCalls: 0,
              restartStubCalls: 0,
            });
          if (!resetTest.rpcPatched) {
            const patchedRequest = Object.create(rpc.request);
            patchedRequest.desktopShowMessageBox = async () => {
              window.__ELIZA_PACKAGED_RESET_TEST__.messageBoxStubCalls += 1;
              return { response: 0 };
            };
            patchedRequest.agentRestartClearLocalDb = async () => {
              window.__ELIZA_PACKAGED_RESET_TEST__.restartStubCalls += 1;
              return {
                state: "running",
                agentName: "PackagedDesktopTest",
                model: undefined,
                uptime: 0,
                startedAt: Date.now(),
              };
            };
            const patchedRpc = { ...rpc, request: patchedRequest };
            window.__ELIZA_ELECTROBUN_RPC__ = patchedRpc;
            window.__ELIZAOS_ELECTROBUN_RPC__ = patchedRpc;
            resetTest.rpcPatched = true;
          }
        }
        const resetTest = window.__ELIZA_PACKAGED_RESET_TEST__ ?? null;
        if (resetTest?.confirmClicked) {
          return {
            ok: true,
            label: "Reset Everything",
            confirmClicked: true,
            restartStubCalls: resetTest.restartStubCalls ?? 0,
          };
        }
        const confirmButton = document.querySelector(
          '[data-agent-id="advanced-reset-confirm"]',
        );
        if (confirmButton instanceof HTMLButtonElement) {
          window.__ELIZA_PACKAGED_RESET_TEST__ = {
            ...(window.__ELIZA_PACKAGED_RESET_TEST__ ?? {}),
            confirmClicked: true,
          };
          confirmButton.click();
          return {
            ok: true,
            label: (confirmButton.textContent || "").trim(),
            confirmClicked: true,
            restartStubCalls:
              window.__ELIZA_PACKAGED_RESET_TEST__?.restartStubCalls ?? 0,
          };
        }
        const resetByAgentId = document.querySelector(
          '[data-agent-id="advanced-reset-open"]',
        );
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="settings-shell"] button'),
        );
        const resetButton =
          resetByAgentId instanceof HTMLButtonElement
            ? resetByAgentId
            : buttons.find((button) =>
                /reset everything/i.test((button.textContent || "").trim()),
              );
        if (!resetButton) {
          const advancedSection = document.querySelector(
            '[data-agent-id="section-advanced"]',
          );
          if (advancedSection instanceof HTMLButtonElement) {
            advancedSection.click();
          }
          return {
            ok: false,
            error: "Settings reset button disappeared before click.",
          };
        }
        resetButton.click();
        return {
          ok: false,
          error: "Clicked Settings reset button; waiting for confirmation handler.",
          label: (resetButton.textContent || "").trim(),
          confirmClicked: false,
          restartStubCalls:
            window.__ELIZA_PACKAGED_RESET_TEST__?.restartStubCalls ?? 0,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    (current) => current.ok && current.confirmClicked,
    {
      timeout: 30_000,
      message:
        "Timed out waiting for the Settings reset click to enter the reset confirmation path.",
    },
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
        const label = (() => {
          try {
            return new URL(apiBase).host || apiBase;
          } catch {
            return apiBase;
          }
        })();
        localStorage.removeItem("elizaos:first-run:force-fresh");
        localStorage.setItem("eliza:first-run-complete", "1");
        localStorage.setItem("eliza:setup:step", "activate");
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
          firstRunComplete: localStorage.getItem("eliza:first-run-complete"),
          setupStep: localStorage.getItem("eliza:setup:step"),
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
        ELIZA_DESKTOP_TRAY_POPOVER: "1",
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

test("packaged desktop reset from Settings returns the shell to first-run setup", async ({
  browserName: _browserName,
}, testInfo) => {
  void _browserName;
  test.skip(
    !isPackagedPlatform(),
    "Packaged desktop regressions require a macOS, Windows, or Linux launcher.",
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

test("packaged desktop shortcut bridge summons the main window", async ({
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
      expect.arrayContaining([expect.objectContaining({ id: "chat-overlay" })]),
    );

    await harness.closeMainWindow();
    await harness.waitForState(
      (state) => !state.mainWindow.present && state.shell.trayPresent,
      "Expected closing the main window to leave the tray active before shortcut summon.",
      30_000,
    );

    await harness.pressShortcut("chat-overlay");
    await harness.waitForState(
      (state) => state.mainWindow.present && state.shell.windowFocused,
      "Expected shortcut bridge press to summon and focus the main window.",
      30_000,
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
    expect(initialState.shell.trayPopover).toMatchObject({
      configured: true,
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

    const openedPopover = await harness.toggleTrayPopover();
    expect(openedPopover).toMatchObject({
      configured: true,
      windowPresent: true,
      visible: true,
    });
    expect(openedPopover.lastAnchorBounds).toMatchObject({
      width: 360,
      height: 480,
    });

    const hiddenPopover = await harness.toggleTrayPopover();
    expect(hiddenPopover).toMatchObject({
      configured: true,
      windowPresent: true,
      visible: false,
    });
    expect(hiddenPopover.lastAnchorBounds).toEqual(
      openedPopover.lastAnchorBounds,
    );

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
