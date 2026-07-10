/**
 * Voice failure-mode acceptance (sol-voice-pwa-e2e). Runs in `chromium-voice-mic`.
 *
 * Proves the client degrades VISIBLY (never a silent no-op / infinite hang) on:
 *   F1  permission denied   — getUserMedia rejects NotAllowedError; the mic path
 *       must surface a denied/error state, not wedge.
 *   F2  provider timeout    — ASR endpoint hangs; the client must bound the wait
 *       and surface a retry/error, not hold the turn open indefinitely.
 *   F3  reconnect after error — after a transient ASR failure, a subsequent tap
 *       must be able to capture again (state not permanently poisoned).
 *
 * REAL: fake-device capture + the client state machine. MOCKED: backends.
 * (Double-tap idempotency is covered in voice-pwa-bargein.spec.ts B3.)
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-pwa-failure-modes.spec.ts
 */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const EXPECTED_PHRASE = "what time is it";

async function denyMicrophone(page: Page): Promise<void> {
  // Override getUserMedia to reject like a denied permission, BEFORE boot.
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (md) {
      md.getUserMedia = (() =>
        Promise.reject(
          new DOMException("Permission denied", "NotAllowedError"),
        )) as MediaDevices["getUserMedia"];
    }
  });
}

async function installAsr(
  page: Page,
  mode: "ok" | "hang" | "flaky",
): Promise<void> {
  await page.route("**/api/asr/local-inference/status", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: true, provider: "local-inference" }),
    }),
  );
  let call = 0;
  await page.route("**/api/asr/local-inference", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    call += 1;
    if (mode === "hang") {
      // Never fulfill within the client's bound; hold, then error late.
      await new Promise((r) => setTimeout(r, 20_000));
      return route.fulfill({ status: 504, body: "timeout" });
    }
    if (mode === "flaky" && call === 1) {
      return route.fulfill({ status: 500, body: "transient" });
    }
    const bytes = route.request().postDataBuffer()?.byteLength ?? 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: bytes > 1000 ? EXPECTED_PHRASE : "",
        capturedBytes: bytes,
      }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("F1 denied microphone surfaces a visible state and does not wedge the mic control", async ({
  page,
}) => {
  await denyMicrophone(page);
  await installAsr(page, "ok");
  await openAppPath(page, "/chat");
  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toBeVisible({ timeout: 30_000 });

  let asrPosts = 0;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    )
      asrPosts += 1;
  });

  await mic.click();
  // With permission denied, NO WAV can be captured/POSTed...
  await page.waitForTimeout(2500);
  expect(asrPosts, "denied mic must not POST captured audio").toBe(0);
  // ...and the control must remain interactive (recoverable), not stuck-busy.
  await expect(mic).toBeEnabled({ timeout: 10_000 });
  // The mic must not be stuck in an active-listening label after a denial.
  const label = await mic.getAttribute("aria-label");
  expect(label ?? "").not.toMatch(/stop transcription|end conversation/i);
});

test("F2 a hanging ASR provider is time-bounded, not an open-ended turn", async ({
  page,
}) => {
  await installAsr(page, "hang");
  await openAppPath(page, "/chat");
  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toHaveAttribute("aria-label", "talk", { timeout: 15_000 });

  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", /end conversation|stop/i, {
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  await mic.click(); // triggers the (hanging) ASR POST

  // The client must LEAVE the active-listening state within a bound well under
  // the mock's 20s hang. A still-"stop transcription"/"end conversation" label
  // is the user-visible stuck turn this test exists to reject, so being merely
  // `enabled` while the label stays active is NOT acceptable recovery: require
  // the label to drop out of the active-listening set (to talk/idle/error/retry).
  await expect(mic).not.toHaveAttribute(
    "aria-label",
    /stop transcription|end conversation/i,
    { timeout: 18_000 },
  );
  // And it must be interactive again (recoverable, not a dead disabled control).
  await expect(mic).toBeEnabled({ timeout: 2_000 });
  const elapsed = Date.now() - t0;
  expect(
    elapsed,
    "client must not hold the turn for the full 20s provider hang",
  ).toBeLessThan(19_000);
});

test("F3 the mic recovers after a transient ASR failure (state not poisoned)", async ({
  page,
}) => {
  await installAsr(page, "flaky");
  await openAppPath(page, "/chat");
  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toHaveAttribute("aria-label", "talk", { timeout: 15_000 });

  let asrPosts = 0;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    )
      asrPosts += 1;
  });

  // Turn 1: transient 500.
  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", /end conversation|stop/i, {
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  await mic.click();
  await expect
    .poll(() => asrPosts, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);

  // The control must return to a usable idle state to attempt a second turn.
  await expect(mic).toBeEnabled({ timeout: 15_000 });
  await expect(mic).toHaveAttribute("aria-label", "talk", { timeout: 15_000 });

  // Turn 2: succeeds — proves the failure did not poison capture state.
  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", /end conversation|stop/i, {
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  await mic.click();
  await expect
    .poll(() => asrPosts, {
      timeout: 20_000,
      message: "mic must capture again after a transient failure",
    })
    .toBeGreaterThanOrEqual(2);
});
