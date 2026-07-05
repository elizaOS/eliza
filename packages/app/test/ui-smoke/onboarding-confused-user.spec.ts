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

  test("typing free text during onboarding gets an in-transcript reply and never reaches the server", async ({
    page,
  }) => {
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    const leaks = trackSentinelLeaks(page);
    // The confused user types instead of tapping. Every keystroke-send must be
    // answered locally by the conductor and NEVER reach the agent as a chat
    // POST — capture any body that carries the typed sentence.
    const chatSends: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const body = request.postData();
      if (body?.includes("does this thing even work")) {
        chatSends.push(`${request.url()} :: ${body.slice(0, 200)}`);
      }
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expectChatFirstOnboarding(page);

    // Type a question BEFORE picking a runtime: the "choosing" persona answers.
    const composer = page.getByTestId("chat-composer-textarea");
    await composer.fill("does this thing even work?");
    await composer.press("Enter");

    // The typed sentence appears as a local user turn, and the conductor's
    // deterministic not-ready reply appears within the transcript.
    await expect(
      page.getByText("does this thing even work?", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("pick one of the options above", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await screenshot(page, "typed-free-text-reply");

    // A second impatient send is acknowledged too (monotonic ids — never deduped).
    await composer.fill("hello?? are you there");
    await composer.press("Enter");
    await expect(
      page.getByText("hello?? are you there", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });

    // Nothing was POSTed to /api/first-run, and no typed text leaked as a send.
    expect(
      state.firstRunPosts.length,
      "typing free text must not trigger any first-run POST",
    ).toBe(0);
    expect(
      chatSends,
      "typed free text must never reach the server before completion",
    ).toEqual([]);
    expect(leaks).toEqual([]);

    // The user can still finish by tapping through — proving the composer never
    // blocked the flow. One POST at the end, still zero leaks.
    await page.getByTestId(RUNTIME_CHOICE("local")).click();
    const onDevice = page.getByTestId(PROVIDER_CHOICE("on-device"));
    await expect(onDevice).toBeVisible({ timeout: 15_000 });
    await onDevice.click();
    const skip = page.getByTestId(TUTORIAL_CHOICE("skip"));
    await expect(skip).toBeVisible({ timeout: 30_000 });
    await skip.click();

    await expectOnboardingSettleToHalf(page);
    await settleHomeEntrance(page);
    await screenshot(page, "typed-then-tapped-home");

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

    // Double-click every step: the two clicks of a dblclick dispatch without
    // an actionability re-check between them, so the second lands before the
    // widget's self-lock re-renders — the conductor guard must absorb it.
    await page.getByTestId(RUNTIME_CHOICE("local")).dblclick();
    const onDevice = page.getByTestId(PROVIDER_CHOICE("on-device"));
    await expect(onDevice).toBeVisible({ timeout: 15_000 });
    await onDevice.dblclick();
    const skip = page.getByTestId(TUTORIAL_CHOICE("skip"));
    await expect(skip).toBeVisible({ timeout: 30_000 });
    await skip.dblclick();

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
    // re-offers the runtime CHOICE, and that re-offer must be UNLOCKED (a
    // second, fresh widget row — the greeting row locked itself on the first
    // pick).
    const differentWay = page.getByTestId("choice-__first_run__:error:restart");
    await expect(differentWay).toBeVisible({ timeout: 30_000 });
    await screenshot(page, "first-run-post-failed");
    await differentWay.click();
    await expect(page.getByTestId(RUNTIME_CHOICE("local"))).toHaveCount(2, {
      timeout: 30_000,
    });

    // Retry: re-pick local → the conductor seeds a FRESH provider turn (the
    // original provider row is locked) → on-device → tutorial → home.
    await page.getByTestId(RUNTIME_CHOICE("local")).last().click();
    await expect(page.getByTestId(PROVIDER_CHOICE("on-device"))).toHaveCount(
      2,
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

    // Nothing was persisted (no POST yet) → the conductor re-seeds a fresh,
    // fully interactive onboarding: unlocked composer + unlocked runtime CHOICE.
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
