/**
 * Rendered browser evidence for the passkey sign-in error routing contract
 * (#19088). The real `/login` route runs against a Chromium CDP virtual
 * platform authenticator, so the capability probe resolves `usable` through the
 * production WebAuthn path rather than a stub; only the Steward
 * `/auth/passkey/login/options` response is fixed at the network boundary, the
 * established ui-smoke pattern.
 *
 * Two rendered outcomes are pinned. A `500` from the login-options probe must
 * surface the failure in place and must NOT send a "Set up your passkey" OTP
 * email — the defect this PR fixes, where every sign-in failure was read as
 * "this user has no credential". A `404` — the only response that actually
 * means "no account or no passkeys" — must still enter enrollment.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

test.use({ video: "on" });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const PROVIDERS = {
  passkey: true,
  email: true,
  siwe: false,
  siws: false,
  google: true,
  discord: true,
  github: false,
  twitter: false,
  oauth: [],
};

const EMAIL = "person@example.com";

async function enableVirtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

for (const viewport of VIEWPORTS) {
  test(`passkey login-options failure never starts OTP enrollment at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await enableVirtualAuthenticator(page);

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
    // Any OTP send is a contract violation for the 500 case; fail loudly rather
    // than letting a real request escape the fixture.
    let otpSendCount = 0;
    await page.route("**/auth/email/otp**", (route) => {
      otpSendCount += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    let loginOptionsStatus = 500;
    await page.route("**/auth/passkey/login/options", (route) =>
      route.fulfill({
        status: loginOptionsStatus,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error:
            loginOptionsStatus === 404
              ? "No passkey registered"
              : "Passkey service unavailable",
        }),
      }),
    );

    await page.goto("/login");
    const emailInput = page.getByPlaceholder("you@example.com");
    await expect(emailInput).toBeVisible();
    const passkeyButton = page.getByRole("button", { name: /Passkey/i });
    await expect(passkeyButton).toBeVisible();
    await screenshot(page, testInfo, `${viewport.name}-1-rest`);

    await emailInput.fill(EMAIL);
    await passkeyButton.click();

    // Server failure: the error is surfaced in place, enrollment is not entered.
    await expect(page.getByText("Passkey service unavailable")).toBeVisible();
    await expect(page.getByText("Set up your passkey")).toHaveCount(0);
    expect(otpSendCount, "a 500 must not send a passkey-setup OTP").toBe(0);
    await expect(passkeyButton).toBeEnabled();
    await expect(passkeyButton).toContainText("Passkey");
    await passkeyButton.hover();
    await expect(passkeyButton).toHaveCSS("color", "rgb(0, 0, 0)");
    await screenshot(page, testInfo, `${viewport.name}-2-server-failure`);

    // The one response that genuinely means "no credential" still enrolls.
    loginOptionsStatus = 404;
    await page.reload();
    const emailAfterReload = page.getByPlaceholder("you@example.com");
    await expect(emailAfterReload).toBeVisible();
    await emailAfterReload.fill(EMAIL);
    await page.getByRole("button", { name: /Passkey/i }).click();
    await expect(page.getByText("Set up your passkey")).toBeVisible();
    expect(otpSendCount, "a 404 must send exactly one setup OTP").toBe(1);
    await screenshot(
      page,
      testInfo,
      `${viewport.name}-3-no-credential-enrolls`,
    );

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
        basename: `${viewport.name}-walkthrough`,
      });
      await testInfo.attach(`${viewport.name}-walkthrough`, artifact);
    }
  });
}
