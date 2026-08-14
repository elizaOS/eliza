/**
 * Browser proof for privacy-preserving passkey recovery. The real `/login`
 * route and Steward SDK run against Chromium's virtual platform authenticator;
 * only Steward HTTP responses are fixed at the network boundary.
 *
 * Canonical Steward returns discoverable-credential options with an empty
 * allow-list instead of revealing whether an email has an account or passkey.
 * With no matching virtual credential, the browser-owned ceremony rejects. The
 * UI must offer explicit recovery without sending email until the user chooses
 * Magic Link or Set up passkey. The accent button retains its accessible text
 * token on hover, and a same-mounted retry ending in a hard 500 must clear the
 * recovery actions.
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

async function enableEmptyVirtualAuthenticator(page: Page): Promise<void> {
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

function contrastRatio(foreground: string, background: string): number {
  const channels = (color: string): number[] => {
    const values = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    if (values?.length !== 3) {
      throw new Error(`Unsupported computed color: ${color}`);
    }
    return values;
  };
  const luminance = (color: string): number => {
    const [red, green, blue] = channels(color).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const viewport of VIEWPORTS) {
  test(`passkey recovery stays explicit at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await enableEmptyVirtualAuthenticator(page);

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

    let otpSendCount = 0;
    await page.route("**/auth/email/otp**", (route) => {
      otpSendCount += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    let magicLinkSendCount = 0;
    await page.route("**/auth/email/send", (route) => {
      magicLinkSendCount += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      });
    });

    let optionsMode: "discoverable" | "server-error" = "discoverable";
    await page.route("**/auth/passkey/login/options", (route) => {
      if (optionsMode === "server-error") {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "User verification service unavailable",
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          challenge: "AAECAwQFBgcICQoLDA0ODw",
          challengeId: "AAECAwQFBgcICQoLDA0ODw",
          rpId: "127.0.0.1",
          timeout: 250,
          userVerification: "required",
          allowCredentials: [],
        }),
      });
    });

    await page.goto("/login");
    const emailInput = page.getByPlaceholder("you@example.com");
    const passkeyButton = page.getByRole("button", { name: /^Passkey$/ });
    await expect(emailInput).toBeVisible();
    await emailInput.fill(EMAIL);

    const expectedHoverStyle = await passkeyButton.evaluate((button) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent-foreground)";
      probe.style.backgroundColor = "var(--accent-hover)";
      probe.style.position = "fixed";
      probe.style.pointerEvents = "none";
      button.appendChild(probe);
      const style = getComputedStyle(probe);
      const resolved = {
        color: style.color,
        backgroundColor: style.backgroundColor,
      };
      probe.remove();
      return resolved;
    });
    await passkeyButton.hover();
    await expect(passkeyButton).toHaveCSS("color", expectedHoverStyle.color);
    await expect(passkeyButton).toHaveCSS(
      "background-color",
      expectedHoverStyle.backgroundColor,
    );
    const computedHoverStyle = await passkeyButton.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
      };
    });
    const hoverContrast = contrastRatio(
      computedHoverStyle.color,
      computedHoverStyle.backgroundColor,
    );
    expect(hoverContrast).toBeGreaterThanOrEqual(4.5);
    frontendEvents.push(
      `passkey-hover-style:${JSON.stringify({ ...computedHoverStyle, contrast: hoverContrast })}`,
    );
    await screenshot(page, testInfo, `${viewport.name}-0-passkey-hover`);

    await passkeyButton.click();

    await expect(page.getByText("Passkey not completed")).toBeVisible();
    await expect(
      page.getByText(
        "No passkey was available, or the request was cancelled. Choose how you want to continue.",
      ),
    ).toBeVisible();
    expect(
      otpSendCount,
      "ambiguous WebAuthn failure must not send setup OTP",
    ).toBe(0);
    expect(
      magicLinkSendCount,
      "ambiguous WebAuthn failure must not send a magic link",
    ).toBe(0);
    await screenshot(page, testInfo, `${viewport.name}-1-explicit-recovery`);

    optionsMode = "server-error";
    await passkeyButton.click();
    await expect(
      page.getByText("User verification service unavailable"),
    ).toBeVisible();
    await expect(page.getByText("Passkey not completed")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Set up passkey" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Use Magic Link" }),
    ).toHaveCount(0);
    expect(otpSendCount, "same-mount 500 must not send setup OTP").toBe(0);
    expect(magicLinkSendCount, "same-mount 500 must not send magic link").toBe(
      0,
    );
    await screenshot(
      page,
      testInfo,
      `${viewport.name}-2-same-mount-server-error`,
    );

    optionsMode = "discoverable";
    await page.reload();
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByRole("button", { name: /^Passkey$/ }).click();
    await page.getByRole("button", { name: "Set up passkey" }).click();
    await expect(page.getByText("Set up your passkey")).toBeVisible();
    expect(otpSendCount, "explicit setup intent sends exactly one OTP").toBe(1);
    expect(magicLinkSendCount).toBe(0);
    await screenshot(page, testInfo, `${viewport.name}-3-setup-otp`);

    optionsMode = "discoverable";
    await page.reload();
    const emailForMagicLink = page.getByPlaceholder("you@example.com");
    await emailForMagicLink.fill(EMAIL);
    await page.getByRole("button", { name: /^Passkey$/ }).click();
    await page.getByRole("button", { name: "Use Magic Link" }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    expect(magicLinkSendCount, "explicit Magic Link intent sends once").toBe(1);
    expect(otpSendCount).toBe(1);

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
