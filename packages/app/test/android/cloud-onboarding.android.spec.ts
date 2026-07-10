// Production cloud-onboarding on the real Android Capacitor WebView.
//
// This lane differs from the existing remote-connect onboarding smoke: it keeps
// the production cloud-only first-run surface, seeds the e2e SIWE wallet, and
// lets the app complete the real Eliza Cloud login/provisioning path. No API
// route is mocked; the test records `/api/first-run` attempts to enforce the
// Cloud architecture boundary while proving durable completion state.
import path from "node:path";
import { startAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import { expect, ORIGIN, test } from "./android-harness";

const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-cloud-onboarding",
);
const DEFAULT_E2E_WALLET_PRIVATE_KEY_PARTS = [
  "0x",
  "59c6995e",
  "998f97a5",
  "a0044966",
  "f094538d",
  "5f7e9e7f",
  "5b4c5f2f",
  "5a4f5c6e",
  "8f2d3a22",
];

type CloudOnboardingMode = "tap" | "autologin";

async function installCloudOnboardingHarness(
  page: import("@playwright/test").Page,
  mode: CloudOnboardingMode,
) {
  const privateKey =
    process.env.ELIZA_E2E_WALLET_PK?.trim() ||
    DEFAULT_E2E_WALLET_PRIVATE_KEY_PARTS.join("");
  const resetKeys = [
    "eliza:first-run-complete",
    "eliza:onboarding-complete",
    "eliza:setup:step",
    "eliza:mobile-runtime-mode",
    "elizaos:active-server",
    "steward_session_token",
    "eliza:first-run:cloud-resume",
    "elizaos:first-run:force-fresh",
    // A leftover shared→dedicated handoff marker from a previous run pins the
    // home provisioning tile and suppresses the fresh upgrade path (#15902).
    "eliza:cloud-handoff-pending",
  ];

  // Capacitor Preferences outlives WebView navigation and otherwise restores
  // the preceding serial test's authenticated state during app bootstrap.
  await page.evaluate(
    async ({ mode, privateKey }) => {
      const preferences = (
        window as Window & {
          Capacitor?: {
            Plugins?: {
              Preferences?: {
                clear(): Promise<void>;
                remove(options: { key: string }): Promise<void>;
                set(options: { key: string; value: string }): Promise<void>;
              };
            };
          };
        }
      ).Capacitor?.Plugins?.Preferences;
      if (!preferences) {
        throw new Error("Capacitor Preferences plugin is unavailable");
      }
      await preferences.clear();
      await preferences.set({ key: "eliza:e2e-wallet:pk", value: privateKey });
      if (mode === "autologin") {
        await preferences.set({
          key: "eliza:e2e-wallet:autologin",
          value: "1",
        });
      } else {
        await preferences.remove({ key: "eliza:e2e-wallet:autologin" });
      }
    },
    { mode, privateKey },
  );

  await page.addInitScript(
    ({ privateKey, resetKeys }) => {
      const mode =
        new URL(window.location.href).searchParams.get(
          "cloudOnboardingMode",
        ) === "autologin"
          ? "autologin"
          : "tap";
      const state = {
        firstRunPostCount: 0,
      };
      Object.defineProperty(window, "__ELIZA_CLOUD_ONBOARDING_SMOKE__", {
        configurable: true,
        value: state,
      });

      localStorage.setItem("eliza:e2e-wallet:pk", privateKey);
      if (mode === "autologin") {
        localStorage.setItem("eliza:e2e-wallet:autologin", "1");
      } else {
        localStorage.removeItem("eliza:e2e-wallet:autologin");
      }
      for (const key of resetKeys) {
        localStorage.removeItem(key);
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const method =
          init?.method ??
          (typeof input === "object" && "method" in input
            ? input.method
            : "GET");
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (
          String(method).toUpperCase() === "POST" &&
          /\/api\/first-run(?:[?#]|$)/.test(url)
        ) {
          state.firstRunPostCount += 1;
        }
        return originalFetch(input, init);
      }) as typeof window.fetch;
    },
    { privateKey, resetKeys },
  );
}

async function readCloudOnboardingState(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const activeServerRaw = localStorage.getItem("elizaos:active-server");
    let activeServer: unknown = null;
    try {
      activeServer = activeServerRaw ? JSON.parse(activeServerRaw) : null;
    } catch {
      activeServer = activeServerRaw;
    }
    return {
      activeServer,
      firstRunComplete: localStorage.getItem("eliza:first-run-complete"),
      stewardSessionPresent: Boolean(
        localStorage.getItem("steward_session_token"),
      ),
      firstRunPostCount:
        (
          window as Window & {
            __ELIZA_CLOUD_ONBOARDING_SMOKE__?: {
              firstRunPostCount?: number;
            };
          }
        ).__ELIZA_CLOUD_ONBOARDING_SMOKE__?.firstRunPostCount ?? 0,
      bodyText: document.body?.innerText ?? "",
    };
  });
}

async function runCloudOnboardingMode({
  page,
  device,
  mode,
  testInfo,
}: {
  page: import("@playwright/test").Page;
  device: { serial(): string };
  mode: CloudOnboardingMode;
  testInfo: import("@playwright/test").TestInfo;
}) {
  test.setTimeout(240_000);

  await installCloudOnboardingHarness(page, mode);
  const recording = await startAndroidScreenRecord({
    serial: device.serial(),
    artifactDir: path.join(ARTIFACT_DIR, mode),
    filename: `cloud-onboarding-${mode}.mp4`,
    remotePath: `/sdcard/eliza-cloud-onboarding-${mode}.mp4`,
  });

  try {
    await page.goto(`${ORIGIN}/?reset&cloudOnboardingMode=${mode}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (mode === "tap") {
      await expect(page.getByText(/Sign in to Eliza Cloud/i)).toBeVisible({
        timeout: 90_000,
      });
      const greetingPath = path.join(
        ARTIFACT_DIR,
        mode,
        "sign-in-greeting.png",
      );
      await page.screenshot({ path: greetingPath, fullPage: true });
      await testInfo.attach("sign-in greeting", {
        path: greetingPath,
        contentType: "image/png",
      });
      await page
        .getByRole("button", { name: /Sign in to Eliza Cloud/i })
        .click();
    }

    const surface = page.getByTestId("home-launcher-surface");
    await expect(surface).toBeVisible({ timeout: 150_000 });
    await expect(surface).toHaveAttribute("data-page", "home");
    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/Sign in to Eliza Cloud/i)).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(page.getByTestId("first-run-chat")).toHaveCount(0);
    await expect(page.getByTestId("startup-first-run-background")).toHaveCount(
      0,
    );
    await expect(page.getByText(/Setting up/i)).toHaveCount(0, {
      timeout: 150_000,
    });
    await expect(
      page.getByText(/Logged in to Eliza Cloud successfully/i),
    ).toHaveCount(0, { timeout: 15_000 });

    const homePath = path.join(ARTIFACT_DIR, mode, "home-landing.png");
    await page.screenshot({ path: homePath, fullPage: true });
    await testInfo.attach("home landing", {
      path: homePath,
      contentType: "image/png",
    });

    const state = await readCloudOnboardingState(page);
    // Direct Cloud agent bases are chat runtimes, not app-shell setup servers;
    // posting /api/first-run there would be a guaranteed 404. Completion is
    // proven by durable local state plus the authenticated Cloud server below.
    expect(state.firstRunPostCount).toBe(0);
    expect(state.firstRunComplete).toBe("1");
    expect(state.stewardSessionPresent).toBe(true);
    expect(state.activeServer).toMatchObject({ kind: "cloud" });
    expect(state.bodyText).not.toMatch(/First, where should your agent run/i);
  } finally {
    const videoPath = await recording.stop();
    if (videoPath) {
      await testInfo.attach(`${mode} walkthrough video`, {
        path: videoPath,
        contentType: "video/mp4",
      });
    }
  }
}

test.describe
  .serial("android cloud onboarding via e2e SIWE wallet", () => {
    test.skip(
      process.env.ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE !== "1",
      "Set ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE=1 to run against real Eliza Cloud.",
    );

    test("tap-driven sign-in provisions cloud and lands on chat", async ({
      page,
      device,
    }, testInfo) => {
      await runCloudOnboardingMode({ page, device, mode: "tap", testInfo });
    });

    test("autologin skips the sign-in ask and lands on chat", async ({
      page,
      device,
    }, testInfo) => {
      await runCloudOnboardingMode({
        page,
        device,
        mode: "autologin",
        testInfo,
      });
    });
  });
