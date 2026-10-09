/**
 * Real-browser proof that stale Steward session recovery cannot overtake a
 * fresh phone OTP login. HTTP authority is fixed at the network boundary; the
 * shipped /login route, storage client, and React state machine run unchanged.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  createStewardSessionToken,
  seedStewardSession,
} from "./helpers/test-auth";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

test.use({ video: "on" });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const PROVIDERS = {
  passkey: false,
  email: true,
  sms: true,
  siwe: false,
  siws: false,
  google: true,
  discord: false,
  github: false,
  twitter: false,
  oauth: ["google"],
};

async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.jpg`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path, type: "jpeg", quality: 90, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/jpeg" });
}

for (const viewport of VIEWPORTS) {
  test(`phone OTP waits for stale-session recovery at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await seedStewardSession(page, {
      jwt: true,
      subject: "older-session-user",
    });

    const frontendEvents: string[] = [];
    page.on("console", (message) =>
      frontendEvents.push(`console:${message.type()}:${message.text()}`),
    );
    page.on("requestfailed", (request) =>
      frontendEvents.push(
        `requestfailed:${request.method()}:${request.url()}:${request.failure()?.errorText ?? "unknown"}`,
      ),
    );
    page.on("response", (response) =>
      frontendEvents.push(
        `response:${response.request().method()}:${response.status()}:${response.url()}`,
      ),
    );

    await page.route("**/auth/providers", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PROVIDERS),
      }),
    );

    let releaseRecovery: (() => void) | undefined;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let sessionRequests = 0;
    await page.route("**/api/auth/steward-session", async (route) => {
      sessionRequests += 1;
      await recoveryGate;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: "Older session expired",
          code: "invalid_steward_token",
        }),
      });
    });

    let smsSendRequests = 0;
    await page.route("**/auth/sms/send", async (route) => {
      smsSendRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          expiresAt: "2099-01-01T00:05:00.000Z",
        }),
      });
    });
    let smsVerifyRequests = 0;
    await page.route("**/auth/sms/verify", async (route) => {
      smsVerifyRequests += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Unexpected verify" }),
      });
    });

    await page.goto("/login?error=oauth_failed&reason=server_error");
    await expect(page).toHaveURL(/\/login$/, { timeout: 45_000 });
    await expect(
      page.getByRole("status", { name: "Loading sign-in options" }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Phone number" }),
    ).toHaveCount(0);
    await page.waitForTimeout(250);
    await screenshot(page, testInfo, `${viewport.name}-1-recovery-pending`);

    releaseRecovery?.();
    await expect(page.getByText("Older session expired")).toBeVisible();
    const phone = page.getByRole("textbox", { name: "Phone number" });
    await expect(phone).toBeVisible();
    await phone.fill("4155552671");
    await page.getByRole("button", { name: "Text me a code" }).click();

    await expect(page.getByText("Enter the text code")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Six-digit code" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(sessionRequests).toBe(1);
    expect(smsSendRequests).toBe(1);
    expect(smsVerifyRequests).toBe(0);
    await screenshot(page, testInfo, `${viewport.name}-2-code-required`);

    const logPath = testInfo.outputPath(`${viewport.name}-frontend.log`);
    await writeFile(logPath, `${frontendEvents.join("\n")}\n`, "utf8");
    await testInfo.attach(`${viewport.name}-frontend-log`, {
      path: logPath,
      contentType: "text/plain",
    });

    const video = page.video();
    if (video) {
      await page.close();
      const artifact = await saveBrowserVideoArtifact({
        video,
        testInfo,
        basename: `${viewport.name}-phone-login-recovery-walkthrough`,
      });
      await testInfo.attach(`${viewport.name}-walkthrough`, artifact);
    }
  });
}

for (const viewport of VIEWPORTS) {
  test(`Network phone sign-in waits for account switch at ${viewport.name}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    if (!baseURL) throw new Error("Missing local renderer URL");
    const managed = new URL(baseURL);
    managed.hostname = "cloud.eliza.app";
    managed.protocol = "https:";
    managed.port = "";
    await page.route(`${managed.origin}/**`, async (route) => {
      const source = new URL(route.request().url());
      const local = new URL(baseURL);
      source.protocol = local.protocol;
      source.hostname = local.hostname;
      source.port = local.port;
      await route.fulfill({
        response: await route.fetch({ url: source.toString() }),
      });
    });
    await page.route("https://api.eliza.app/**", (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Outside this local sign-in fixture" },
      }),
    );

    await seedStewardSession(page, {
      jwt: true,
      subject: "previous-network-owner",
    });
    await page.route("**/auth/providers", (route) =>
      route.fulfill({ json: PROVIDERS }),
    );
    let releaseLogout: () => void = () => {};
    const logoutGate = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    let logoutStarted = false;
    await page.route("**/api/auth/logout", async (route) => {
      logoutStarted = true;
      await logoutGate;
      await route.fulfill({ json: { success: true } });
    });
    let sent = 0;
    await page.route("**/auth/sms/send", async (route) => {
      sent++;
      await route.fulfill({
        json: { ok: true, expiresAt: "2099-01-01T00:05:00.000Z" },
      });
    });
    const token = createStewardSessionToken({
      jwt: true,
      subject: "verified-network-owner",
    });
    let attempts = 0;
    await page.route("**/auth/sms/verify", async (route) => {
      attempts++;
      if (attempts === 1)
        await route.fulfill({
          status: 400,
          json: { error: "The test code was rejected." },
        });
      else await route.fulfill({ json: { token } });
    });
    const syncs: Record<string, unknown>[] = [];
    await page.route("**/api/auth/steward-session", async (route) => {
      const method = route.request().method();
      if (method === "POST") {
        syncs.push(route.request().postDataJSON());
        await route.fulfill({ json: { success: true } });
      } else if (method === "DELETE") {
        await route.fulfill({ json: { success: true } });
      } else {
        await route.fulfill({ status: 401, json: { error: "No session" } });
      }
    });
    try {
      await page.goto(
        `${managed.origin}/network/sign-in?switchAccount=1&returnTo=%2Fbilling`,
      );
      await expect.poll(() => logoutStarted).toBe(true);
      await expect(
        page.getByRole("heading", { name: "Sign in to The Network" }),
      ).toBeVisible();
      await screenshot(
        page,
        testInfo,
        `${viewport.name}-network-switch-pending`,
      );
      await expect(
        page.getByRole("textbox", { name: "Phone number" }),
      ).toHaveCount(0);
      expect(sent).toBe(0);
      expect(syncs).toHaveLength(0);
      releaseLogout();
      const phone = page.getByRole("textbox", { name: "Phone number" });
      await expect(phone).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Email address" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /Google|wallet|passkey/i }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await screenshot(page, testInfo, `${viewport.name}-network-phone`);
      await phone.fill("2025550123");
      await page.getByRole("button", { name: "Text me a code" }).click();
      const code = page.getByRole("textbox", { name: "Six-digit code" });
      await expect(code).toBeVisible();
      await code.fill("000000");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByText("The test code was rejected.")).toBeVisible();
      expect(syncs).toHaveLength(0);
      await screenshot(page, testInfo, `${viewport.name}-network-code-retry`);
      await code.fill("123456");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect.poll(() => syncs.length).toBe(1);
      expect(syncs[0]).toMatchObject({ token, verifiedPhone: "+12025550123" });
      await expect(page).toHaveURL(/\/join(?:[?#]|$)/);
      expect(sent).toBe(1);
      expect(attempts).toBe(2);
      await screenshot(page, testInfo, `${viewport.name}-network-join-handoff`);
      const video = page.video();
      if (video) {
        await page.close();
        await testInfo.attach(
          `${viewport.name}-network-walkthrough`,
          await saveBrowserVideoArtifact({
            video,
            testInfo,
            basename: `${viewport.name}-network-phone-walkthrough`,
          }),
        );
      }
    } finally {
      releaseLogout();
    }
  });
}
