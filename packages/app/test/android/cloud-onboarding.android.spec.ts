/**
 * Exercises production Cloud onboarding in the real Android Capacitor WebView.
 *
 * This lane keeps the production cloud-only first-run surface, seeds the e2e
 * SIWE wallet, and completes the real Cloud login/provisioning path without
 * mocked routes. It records `/api/first-run` attempts to enforce the direct-
 * Cloud boundary, then requires a token-bound non-stub chat reply and complete
 * MP4/JPG evidence for both tap and autologin modes.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import { startChunkedAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import {
  assertOnboardingLiveness,
  buildLivenessChallenge,
  extractLivenessChallengeToken,
} from "../liveness-contract";
import { expect, ORIGIN, test } from "./android-harness";
import { buildAndroidCloudOnboardingJpegArtifact } from "./cloud-onboarding-evidence";

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

// The wallet private key crosses the browser evaluation boundary below.
// Playwright traces serialize evaluation arguments, so this secret-bearing
// lane must use the separately captured Android video and screenshots only.
test.use({ trace: "off" });

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
  // First-run cold start (SIWE provision + cloud agent first turn) can exceed
  // 240s end-to-end on a live run; the per-step waits below stay unchanged.
  test.setTimeout(420_000);

  await installCloudOnboardingHarness(page, mode);
  // This live-cloud path can outlast Android's 180-second screenrecord cap.
  // Chunking keeps sign-in, provisioning, home, and the reply in one evidence
  // artifact instead of silently ending the recording before liveness runs.
  const recording = await startChunkedAndroidScreenRecord({
    serial: device.serial(),
    artifactDir: path.join(ARTIFACT_DIR, mode),
    filename: `cloud-onboarding-${mode}.mp4`,
    requireComplete: true,
  });
  let videoPath: string | null = null;

  try {
    await page.goto(`${ORIGIN}/?reset&cloudOnboardingMode=${mode}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (mode === "tap") {
      await expect(page.getByText(/Sign in to Eliza Cloud/i)).toBeVisible({
        timeout: 90_000,
      });
      const greetingArtifact = buildAndroidCloudOnboardingJpegArtifact(
        path.join(ARTIFACT_DIR, mode),
        "sign-in-greeting",
      );
      await page.screenshot(greetingArtifact.screenshot);
      await testInfo.attach("sign-in greeting", greetingArtifact.attachment);
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

    const homeArtifact = buildAndroidCloudOnboardingJpegArtifact(
      path.join(ARTIFACT_DIR, mode),
      "home-landing",
    );
    await page.screenshot(homeArtifact.screenshot);
    await testInfo.attach("home landing", homeArtifact.attachment);

    const state = await readCloudOnboardingState(page);
    // Direct Cloud agent bases are chat runtimes, not app-shell setup servers;
    // posting /api/first-run there would be a guaranteed 404. Completion is
    // proven by durable local state plus the authenticated Cloud server below.
    expect(state.firstRunPostCount).toBe(0);
    expect(state.firstRunComplete).toBe("1");
    expect(state.stewardSessionPresent).toBe(true);
    expect(state.activeServer).toMatchObject({ kind: "cloud" });
    expect(state.bodyText).not.toMatch(/First, where should your agent run/i);

    // Liveness contract (#14359 / #16936): every SIWE cloud-onboarding lane
    // ends with a real chat turn. Strict non-stub liveness is intrinsic to the
    // lane — the cloud agent is SIWE-provisioned and live, so a stub or empty
    // reply means the lane fails. The run-unique challenge token binds the
    // accepted reply to this exact run: a pending status row, the first-run
    // greeting, a cached reply, or a wrong-code answer all fail the wait.
    const challenge = buildLivenessChallenge(randomBytes(4).toString("hex"));
    const reply = await assertOnboardingLiveness(page, {
      label: `android-cloud-onboarding-${mode}`,
      prompt: challenge,
      challengeToken: extractLivenessChallengeToken(challenge),
      // A freshly provisioned cloud agent's FIRST turn pays model + tool
      // registration cold start and can exceed the 120s default (observed on
      // a live run: the token-bearing reply rendered after the poll gave up).
      // This widens only how long we wait — the token gate and row-phase
      // classification are unchanged.
      replyTimeoutMs: 300_000,
    });
    await testInfo.attach(`liveness reply (${mode})`, {
      body: reply,
      contentType: "text/plain",
    });
    // Issue #16936 requires a reply JPG artifact alongside the existing
    // greeting and home screenshots.
    const replyArtifact = buildAndroidCloudOnboardingJpegArtifact(
      path.join(ARTIFACT_DIR, mode),
      "reply-liveness",
    );
    await page.screenshot(replyArtifact.screenshot);
    await testInfo.attach(
      "reply liveness screenshot",
      replyArtifact.attachment,
    );
  } finally {
    videoPath = await recording.stop();
    if (videoPath) {
      await testInfo.attach(`${mode} walkthrough video`, {
        path: videoPath,
        contentType: "video/mp4",
      });
    }
  }
  if (!videoPath) {
    throw new Error(
      `Android cloud onboarding ${mode} passed but the required MP4 walkthrough was not produced`,
    );
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
