/**
 * Playwright UI-smoke spec for the Onboarding Confused User app flow using the
 * real renderer fixture.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  expectOnlyAllowedPageDiagnostics,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import {
  expectChatFirstOnboarding,
  expectOnboardingSettleToHalf,
  injectFullCapabilityHost,
  installHomeRoutes,
  makeScreenshotter,
  PROVIDER_CHOICE,
  RUNTIME_CHOICE,
  settleHomeEntrance,
  TUTORIAL_CHOICE,
} from "./onboarding-to-home.shared";

// CONFUSED-USER onboarding e2e (#10722): the user who doesn't understand the
// flow — double-clicks every button, reloads mid-setup, and hits a failing
// backend — must still land on the home with EXACTLY ONE POST /api/first-run
// and ZERO `__first_run__:` sentinels leaking to the server as chat sends.
//
// These specs drive the REAL shell + REAL in-chat conductor with the same
// route mocks as onboarding-to-home.spec.ts. The finer-grained interleavings
// (picks landing while a provision call is mid-flight, malformed sentinel
// values, seeded 250-step storms) are covered at the conductor seam by
// packages/ui/src/first-run/use-first-run-conductor{,.fuzz}.test.ts.

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "onboarding-confused-user",
);
const screenshot = makeScreenshotter(SCREENSHOT_DIR);

/**
 * Record every POST whose body carries the reserved first-run sentinel — a
 * conductor/backstop leak would send it to the server as a chat message.
 */
function trackSentinelLeaks(page: Page): string[] {
  const leaks: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const body = request.postData();
    if (body?.includes("__first_run__")) {
      leaks.push(`${request.url()} :: ${body.slice(0, 200)}`);
    }
  });
  return leaks;
}

/**
 * Model a rapid double-tap on a first-run CHOICE. The first tap picks it; the
 * conductor self-locks the widget AND replaces the visible turn (onboarding
 * renders only the latest first-run turn — selectFirstRunDisplayMessages), so
 * the same button is disabled/detached by the time the second tap lands. Re-tap
 * the SAME testId (not whatever re-rendered into its old screen position, which
 * is where a raw `dblclick`'s second click would mis-land): the conductor's
 * guards (busyRef / provisionedRef / completedRef) absorb it. force + short
 * timeout, swallowing the "element gone" rejection.
 */
async function doubleTapChoice(page: Page, testId: string): Promise<void> {
  const button = page.getByTestId(testId);
  await button.click();
  await button.click({ force: true, timeout: 1500 }).catch(() => {});
}

test.describe("confused-user onboarding", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.title.includes("failing first-run POST")) {
      // That spec INJECTS a 500 on POST /api/first-run; only the injected
      // fault's diagnostics are allowed — anything else still fails.
      await expectOnlyAllowedPageDiagnostics(page, testInfo.title, [
        /api\/first-run/,
        /Failed to load resource.*500/,
      ]);
      return;
    }
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("the sign-in-first composer is locked during onboarding — prefilled/typed text is ignored and never reaches the server, and tapping still completes", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    const leaks = trackSentinelLeaks(page);
    // The confused user's attempt to type must NEVER reach the agent as a chat
    // POST — capture any body that carries the attempted sentence.
    const chatSends: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const body = request.postData();
      if (body?.includes("does this thing even work")) {
        chatSends.push(`${request.url()} :: ${body.slice(0, 200)}`);
      }
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    // The onboarding surface is sign-in-first (#15339): the composer mounts
    // LOCKED (disabled) with a "Sign in to start chatting" placeholder — the
    // helper asserts that — so the confused user CANNOT type past setup, and the
    // old #12178 "type free text → in-transcript reply" affordance is gone.
    await expectChatFirstOnboarding(page);

    const composer = page.getByTestId("chat-composer-textarea");
    await expect(composer).toBeDisabled();

    // The "just type at it" instinct — modeled by the same programmatic prefill
    // path the app uses (CHAT_PREFILL_EVENT) — is IGNORED while onboarding is
    // open: the draft is never set and nothing is sent. (The unit suite
    // ChatOverlay.firstrun.test asserts the same behavior at the seam.)
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("eliza:chat:prefill", {
          detail: { text: "does this thing even work?" },
        }),
      );
    });
    await page.waitForTimeout(500);
    await expect(composer).toHaveValue("");
    await screenshot(page, "locked-composer-ignores-typing");

    // Nothing was POSTed to /api/first-run, and no typed text leaked as a send.
    expect(
      state.firstRunPosts.length,
      "a locked onboarding composer must not trigger any first-run POST",
    ).toBe(0);
    expect(
      chatSends,
      "prefilled/typed text must never reach the server before completion",
    ).toEqual([]);
    expect(leaks).toEqual([]);

    // The user finishes by tapping through — the only real path forward. One
    // POST at the end, still zero leaks.
    await page.getByTestId(RUNTIME_CHOICE("local")).click();
    const onDevice = page.getByTestId(PROVIDER_CHOICE("on-device"));
    await expect(onDevice).toBeVisible({ timeout: 15_000 });
    await onDevice.click();
    const skip = page.getByTestId(TUTORIAL_CHOICE("skip"));
    await expect(skip).toBeVisible({ timeout: 30_000 });
    await skip.click();

    await expectOnboardingSettleToHalf(page);
    await settleHomeEntrance(page);
    await screenshot(page, "tapped-through-home");

    expect(state.firstRunPosts.length).toBe(1);
    expect(chatSends).toEqual([]);
    expect(leaks).toEqual([]);
  });

  test("double-clicking every choice still yields exactly one POST and no sentinel leaks", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    const leaks = trackSentinelLeaks(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expectChatFirstOnboarding(page);

    // Double-tap every step. The second tap of each pair lands after the widget
    // self-locked and the conductor replaced the visible turn, so the guards
    // absorb it — and the flow still advances one step per choice, never
    // double-POSTing or leaking a sentinel.
    await doubleTapChoice(page, RUNTIME_CHOICE("local"));
    const onDevice = page.getByTestId(PROVIDER_CHOICE("on-device"));
    await expect(onDevice).toBeVisible({ timeout: 15_000 });
    await doubleTapChoice(page, PROVIDER_CHOICE("on-device"));
    const skip = page.getByTestId(TUTORIAL_CHOICE("skip"));
    await expect(skip).toBeVisible({ timeout: 30_000 });
    await doubleTapChoice(page, TUTORIAL_CHOICE("skip"));

    await expectOnboardingSettleToHalf(page);
    await settleHomeEntrance(page);
    await screenshot(page, "double-click-home");

    expect(
      state.firstRunPosts.length,
      "POST /api/first-run must fire exactly once under double-clicks",
    ).toBe(1);
    expect(leaks, "no __first_run__ sentinel may reach the server").toEqual([]);
  });

  test("a failing first-run POST re-offers UNLOCKED choices and the retry completes", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    // Registered AFTER installHomeRoutes → takes precedence. Fail the FIRST
    // POST /api/first-run with a 500, then fall back to the recording mock.
    let failedOnce = false;
    await page.route("**/api/first-run", async (route) => {
      if (route.request().method() !== "POST" || failedOnce) {
        await route.fallback();
        return;
      }
      failedOnce = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "disk full" }),
      });
    });
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    const leaks = trackSentinelLeaks(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expectChatFirstOnboarding(page);

    await page.getByTestId(RUNTIME_CHOICE("local")).click();
    const onDevice = page.getByTestId(PROVIDER_CHOICE("on-device"));
    await expect(onDevice).toBeVisible({ timeout: 15_000 });
    await onDevice.click();

    // The finish fails at the POST → the conductor seeds a DISTINCT error
    // turn with its own recovery choice (retry / different-way / Settings) —
    // deliberately NOT an automatic runtime re-offer, which would loop forever
    // on a persistent finish error. Picking "Choose a different way to run"
    // seeds a FRESH (unlocked) runtime CHOICE turn. During onboarding the
    // overlay renders ONLY the latest first-run turn
    // (`selectFirstRunDisplayMessages`), so the stale locked greeting row is
    // hidden and exactly ONE unlocked runtime:local widget is on screen.
    const differentWay = page.getByTestId("choice-__first_run__:error:restart");
    await expect(differentWay).toBeVisible({ timeout: 30_000 });
    await screenshot(page, "first-run-post-failed");
    await differentWay.click();
    await expect(page.getByTestId(RUNTIME_CHOICE("local"))).toHaveCount(1, {
      timeout: 30_000,
    });

    // Retry: re-pick local → the conductor seeds a FRESH provider turn, which
    // (again, latest-turn-only) is the single visible provider row → on-device
    // → tutorial → home.
    await page.getByTestId(RUNTIME_CHOICE("local")).last().click();
    await expect(page.getByTestId(PROVIDER_CHOICE("on-device"))).toHaveCount(
      1,
      { timeout: 15_000 },
    );
    await page.getByTestId(PROVIDER_CHOICE("on-device")).last().click();
    const skip = page.getByTestId(TUTORIAL_CHOICE("skip"));
    await expect(skip).toBeVisible({ timeout: 30_000 });
    await skip.click();

    await expectOnboardingSettleToHalf(page);
    await settleHomeEntrance(page);
    await screenshot(page, "retry-after-failure-home");

    expect(
      state.firstRunPosts.length,
      "exactly one SUCCESSFUL POST is recorded (the 500 was intercepted)",
    ).toBe(1);
    expect(leaks).toEqual([]);
  });

  test("reloading mid-onboarding re-seeds a fresh flow that still completes exactly once", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    const leaks = trackSentinelLeaks(page);

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expectChatFirstOnboarding(page);

    // The user gets halfway (runtime picked, provider offered) and reloads.
    await page.getByTestId(RUNTIME_CHOICE("local")).click();
    await expect(page.getByTestId(PROVIDER_CHOICE("on-device"))).toBeVisible({
      timeout: 15_000,
    });
    await page.reload({ waitUntil: "domcontentloaded" });

    // Nothing was persisted (no POST yet) → the conductor re-seeds a fresh
    // onboarding surface: the runtime CHOICE is unlocked (re-offered) while the
    // composer stays sign-in-first locked, same contract as the first paint.
    await expectChatFirstOnboarding(page);
    await screenshot(page, "after-reload-fresh-onboarding");

    await page.getByTestId(RUNTIME_CHOICE("local")).click();
    const onDevice = page.getByTestId(PROVIDER_CHOICE("on-device"));
    await expect(onDevice).toBeVisible({ timeout: 15_000 });
    await onDevice.click();
    const skip = page.getByTestId(TUTORIAL_CHOICE("skip"));
    await expect(skip).toBeVisible({ timeout: 30_000 });
    await skip.click();

    await expectOnboardingSettleToHalf(page);
    await settleHomeEntrance(page);
    await screenshot(page, "after-reload-home");

    expect(
      state.firstRunPosts.length,
      "the interrupted pre-reload attempt must not have posted",
    ).toBe(1);
    expect(leaks).toEqual([]);
  });
});
