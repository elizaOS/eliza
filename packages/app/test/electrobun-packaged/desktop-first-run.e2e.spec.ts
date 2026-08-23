/**
 * Packaged Electrobun first-run + pairing coverage (#13683).
 *
 * The packaged desktop lane used to boot every spec with `firstRunComplete:true`,
 * which skipped the two startup paths most likely to diverge in the real shell:
 * chat-first onboarding and remote pairing. These tests drive both through the
 * desktop bridge `eval` seam against the packaged app.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startLiveApiServer, type TestApiServer } from "./live-api";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";
import { dismissPermissionPrimingIfShown } from "./packaged-ui-actions";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

const RUNTIME_CHOICE = (id: "cloud" | "local" | "remote") =>
  `choice-__first_run__:runtime:${id}`;
const PROVIDER_CHOICE = (id: "on-device" | "elizacloud" | "other") =>
  `choice-__first_run__:provider:${id}`;
const TUTORIAL_CHOICE = (id: "start" | "skip") =>
  `choice-__first_run__:tutorial:${id}`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cssString(value: string): string {
  return JSON.stringify(value);
}

async function bridgeEval<T>(
  harness: PackagedDesktopHarness,
  script: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await harness.eval<T>(script);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out after|main-window\/eval failed \(500\)/.test(message)) {
        throw error;
      }
      lastError = error;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForDom(
  harness: PackagedDesktopHarness,
  predicateScript: string,
  options: { message: string; timeoutMs?: number },
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let last: unknown;
  while (Date.now() < deadline) {
    last = await bridgeEval<unknown>(harness, predicateScript);
    if (last === true) return;
    await delay(500);
  }
  const diagnostics = await bridgeEval(
    harness,
    `(() => ({
    body: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(-1200),
    choiceIds: Array.from(document.querySelectorAll('[data-testid^="choice-"]'))
      .map((element) => element.getAttribute('data-testid'))
      .filter(Boolean)
      .slice(-40),
    firstRunStep: localStorage.getItem('eliza:setup:step'),
    firstRunComplete: localStorage.getItem('eliza:first-run-complete'),
    externalApiBase: window.__ELIZA_DESKTOP_EXTERNAL_API_BASE__ ?? null,
    bootApiBase: window.__ELIZAOS_APP_BOOT_CONFIG__?.apiBase ?? null,
  }))()`,
  );
  throw new Error(
    `${options.message}. Last result: ${JSON.stringify(last)}. DOM diagnostics: ${JSON.stringify(diagnostics)}`,
  );
}

async function clickTestId(
  harness: PackagedDesktopHarness,
  testId: string,
): Promise<void> {
  const result = await bridgeEval<EvalResult<{ clicked: boolean }>>(
    harness,
    `(() => {
      try {
        const el = document.querySelector('[data-testid=${cssString(testId)}]');
        if (!(el instanceof HTMLElement)) {
          return { ok: false, error: ${cssString(`missing test id ${testId}`)} };
        }
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return { ok: true, clicked: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!result.ok) {
    throw new Error(`clickTestId(${testId}) failed: ${result.error}`);
  }
}

async function waitForTestId(
  harness: PackagedDesktopHarness,
  testId: string,
  timeoutMs = 60_000,
): Promise<void> {
  await waitForDom(
    harness,
    `Boolean(document.querySelector('[data-testid=${cssString(testId)}]'))`,
    { message: `Expected [data-testid=${testId}]`, timeoutMs },
  );
}

async function waitForRestingShell(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await waitForDom(
    harness,
    `(() => {
      const startupShell = document.querySelector('[data-testid="startup-shell-loading"]');
      const firstRunBackdrop = document.querySelector('[data-testid="chat-first-run-backdrop"]');
      const composer = document.querySelector('[data-testid="chat-composer-textarea"]');
      const home =
        document.querySelector('[data-testid="home-launcher-surface"]') ||
        document.querySelector('[data-testid="shell-home-pill"]');
      return Boolean(!startupShell && !firstRunBackdrop && composer && home);
    })()`,
    {
      message: "Expected packaged desktop to land on the resting shell",
      timeoutMs: process.env.CI ? 120_000 : 60_000,
    },
  );
}

async function launchHarness(args: {
  tempPrefix: string;
  apiBase: string;
}): Promise<{ tempRoot: string; harness: PackagedDesktopHarness }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), args.tempPrefix));
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  );
  expect(
    launcherPath,
    "Packaged Electrobun launcher is required (run the desktop build first).",
  ).toBeTruthy();

  const harness = new PackagedDesktopHarness({
    tempRoot,
    launcherPath: launcherPath as string,
    apiBase: args.apiBase,
    extraEnv: {
      // Startup auth and first-run are full-shell surfaces; the default
      // bottom-bar path intentionally bypasses StartupScreen.
      ELIZA_DESKTOP_BOTTOM_BAR: "0",
      ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER: "1",
    },
  });

  await harness.start({
    bridgeHealthTimeoutMs: 300_000,
    shellReadyTimeoutMs: process.env.CI ? 120_000 : 90_000,
  });
  await harness.showMainWindow();
  await harness.focusMainWindow();
  return { tempRoot, harness };
}

test("packaged desktop drives chat-first onboarding and persists first-run", async () => {
  test.setTimeout(600_000);

  let api: TestApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    api = await startLiveApiServer({ firstRunComplete: false, port: 0 });
    ({ harness } = await launchHarness({
      tempPrefix: "eliza-desktop-first-run-",
      apiBase: api.baseUrl,
    }));

    await waitForTestId(harness, RUNTIME_CHOICE("local"), 120_000);
    await clickTestId(harness, RUNTIME_CHOICE("local"));
    await waitForTestId(harness, PROVIDER_CHOICE("on-device"));
    await clickTestId(harness, PROVIDER_CHOICE("on-device"));
    await waitForTestId(harness, TUTORIAL_CHOICE("skip"));
    await clickTestId(harness, TUTORIAL_CHOICE("skip"));

    await dismissPermissionPrimingIfShown(harness);
    await waitForRestingShell(harness);
    expect(
      api.requests.filter((request) => request === "POST /api/first-run"),
      "packaged onboarding should persist first-run exactly once",
    ).toHaveLength(1);
    expect(
      api.responses,
      "the first-run write should be handled successfully by the live upstream",
    ).toContain("POST /api/first-run -> 200");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nRecent live API responses:\n${api?.responses.slice(-80).join("\n") ?? "(server unavailable)"}`,
    );
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});

test("packaged desktop pairing auth redeems a code and reaches auth/me", async () => {
  test.setTimeout(600_000);

  const pairedToken = "packaged-paired-token";
  const pairingCode = "ABCD-EFGH-IJKL";
  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    api = await startMockApiServer({
      firstRunComplete: true,
      port: 0,
      // The packaged shell intentionally treats 127.0.0.1 as its embedded
      // local agent and resolves auth through native RPC. A paired device is
      // an external HTTP target, so use a private alternate loopback alias to
      // exercise that production route without exposing the fixture on LAN.
      host: "127.0.0.2",
      auth: {
        token: pairedToken,
        pairingCode,
        pairingEnabled: true,
      },
    });
    ({ harness } = await launchHarness({
      tempPrefix: "eliza-desktop-pairing-",
      apiBase: api.baseUrl,
    }));

    await waitForDom(
      harness,
      `document.body.innerText.includes("Pairing Required")`,
      {
        message: "Expected packaged desktop pairing screen",
        timeoutMs: 120_000,
      },
    );
    await waitForDom(
      harness,
      `Boolean(document.querySelector("#pairing-code"))`,
      {
        message: "Expected pairing screen to expose the pair-code field",
        timeoutMs: 10_000,
      },
    );

    const pairResult = await bridgeEval<EvalResult<{ submitted: boolean }>>(
      harness,
      `(() => {
        try {
          const input = document.querySelector("#pairing-code");
          if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
            return { ok: false, error: "pairing input not found" };
          }
          input.focus();
          const prototype = input instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (!setter) return { ok: false, error: "no native value setter" };
          setter.call(input, ${cssString(pairingCode)});
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const button = input.form?.querySelector('button[type="submit"]');
          if (!(button instanceof HTMLButtonElement)) {
            return { ok: false, error: "pairing submit button not found" };
          }
          button.click();
          return { ok: true, submitted: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })()`,
    );
    if (!pairResult.ok) {
      throw new Error(`pairing submit failed: ${pairResult.error}`);
    }

    await waitForDom(
      harness,
      `!document.body.innerText.includes("Pairing Required")`,
      {
        message: "Expected pairing screen to disappear after redeeming code",
        timeoutMs: 60_000,
      },
    );
    await dismissPermissionPrimingIfShown(harness);
    await waitForRestingShell(harness);

    const storedToken = await bridgeEval<string | null>(
      harness,
      `(() => {
        const raw = window.localStorage.getItem("elizaos:active-server");
        if (!raw) return null;
        try {
          return JSON.parse(raw).accessToken ?? null;
        } catch {
          return null;
        }
      })()`,
    );
    expect(storedToken).toBe(pairedToken);
    expect(api.requests).toContain("POST /api/auth/pair");
    expect(api.requests).toContain("GET /api/auth/me");
    expect(api.requests).not.toContain("POST /api/auth/login/password");
    expect(api.authStatusResponses).toContainEqual(
      expect.objectContaining({
        required: true,
        authenticated: false,
        pairingEnabled: true,
      }),
    );
    // The cold auth gate may establish the unauthenticated pairing state from
    // /api/auth/status without issuing a redundant pre-pair /api/auth/me. The
    // status assertion above proves the starting state; the bearer response
    // below proves the authenticated post-reload end state.
    expect(api.authMeResponses).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({
          id: "bearer-agent",
          kind: "machine",
        }),
        session: expect.objectContaining({ id: "bearer", kind: "machine" }),
        access: expect.objectContaining({
          mode: "bearer",
          passwordConfigured: true,
          ownerConfigured: false,
          role: "OWNER",
        }),
      }),
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Mock API requests: ${JSON.stringify(api?.requests ?? [])}\n` +
        `Auth status responses: ${JSON.stringify(api?.authStatusResponses ?? [])}\n` +
        `Auth/me challenges: ${JSON.stringify(api?.authMeChallenges ?? [])}\n` +
        `Auth/me responses: ${JSON.stringify(api?.authMeResponses ?? [])}`,
    );
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});
