/**
 * Browser regression for the hosted sign-in keyboard focus treatment. The
 * real login route renders against a deterministic Steward provider response;
 * Chromium supplies actual focus matching, layout, and computed styles.
 */
import { writeFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const PROVIDERS = {
  passkey: false,
  email: true,
  siwe: true,
  siws: true,
  google: true,
  discord: true,
  github: true,
  twitter: false,
  oauth: [],
};

type FocusStyle = {
  backgroundColor: string;
  borderColor: string;
  boxShadow: string;
  color: string;
  outlineStyle: string;
};

async function readFocusStyle(locator: Locator): Promise<FocusStyle> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      color: style.color,
      outlineStyle: style.outlineStyle,
    };
  });
}

async function installProviderFixture(page: Page): Promise<void> {
  await page.route("**/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PROVIDERS),
    });
  });
}

for (const viewport of VIEWPORTS) {
  test(`all hosted sign-in targets render a focus delta at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await installProviderFixture(page);

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

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // Wallet methods are collapsed behind the single "Continue with a wallet"
    // toggle (#19217): the EVM/Solana peer buttons only join the tab order once
    // the toggle expands. The walk stays purely keyboard-driven — clicking the
    // toggle would move the sequential-focus start point past the top of the
    // form — so the toggle entry expands itself with Space AFTER its own focus
    // delta is asserted, and the walk continues into the revealed buttons.
    const walletToggle = page.getByRole("button", {
      name: "Continue with a wallet",
    });
    const targets: Array<{ locator: Locator; expandsWalletOptions?: boolean }> =
      [
        { locator: page.getByRole("textbox", { name: "Email" }) },
        { locator: page.getByRole("button", { name: "Magic Link" }) },
        { locator: page.getByRole("button", { name: "Google" }) },
        { locator: page.getByRole("button", { name: "Discord" }) },
        { locator: page.getByRole("button", { name: "GitHub" }) },
        { locator: walletToggle, expandsWalletOptions: true },
        { locator: page.getByRole("button", { name: "EVM", exact: true }) },
        { locator: page.getByRole("button", { name: "Solana", exact: true }) },
        { locator: page.getByRole("link", { name: "Terms", exact: true }) },
        { locator: page.getByRole("link", { name: "Privacy Policy" }) },
      ];

    await expect(targets[targets.length - 1].locator).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-rest.png`),
      fullPage: true,
    });

    for (const { locator: target, expandsWalletOptions } of targets) {
      const resting = await readFocusStyle(target);
      await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
      await expect(target).toHaveCSS("border-color", /.+/);
      await page.waitForTimeout(200);

      const focused = await readFocusStyle(target);
      expect(
        await target.evaluate((element) => element.matches(":focus-visible")),
      ).toBe(true);
      expect(
        focused.borderColor,
        "focus must change the rendered border",
      ).not.toBe(resting.borderColor);
      expect(
        focused.backgroundColor,
        "focus must change the rendered background",
      ).not.toBe(resting.backgroundColor);

      if (expandsWalletOptions) {
        // Keyboard activation keeps focus on the toggle, so the next Tab lands
        // on the first revealed wallet button.
        await page.keyboard.press("Space");
        await page
          .getByRole("button", { name: "EVM", exact: true })
          .waitFor({ timeout: 15_000 });
      }
    }

    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-privacy-focused.png`),
      fullPage: true,
    });
    const frontendLogPath = testInfo.outputPath(
      `${viewport.name}-frontend-network.log`,
    );
    await writeFile(
      frontendLogPath,
      `${frontendEvents.join("\n") || "No console messages or network responses."}\n`,
    );
    await testInfo.attach(`${viewport.name}-frontend-network-log`, {
      path: frontendLogPath,
      contentType: "text/plain",
    });
  });
}
