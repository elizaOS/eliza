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
  { name: "compact", width: 431, height: 788 },
] as const;

const NARROW_VIEWPORT = { name: "narrow-es", width: 320, height: 844 } as const;

const PROVIDERS = {
  passkey: false,
  email: true,
  siwe: true,
  siws: true,
  google: true,
  discord: true,
  github: true,
  twitter: true,
  telegram: true,
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

async function expectKeyboardFocusDelta(
  locator: Locator,
  focus: () => Promise<void>,
): Promise<void> {
  // Wait for the target's prior focus transition to settle before capturing
  // its resting colors. This is needed when walking backward through a dialog,
  // without coupling the test to a fixed transition delay.
  await expect
    .poll(() =>
      locator.evaluate((element) =>
        element
          .getAnimations({ subtree: true })
          .every((animation) => animation.playState === "finished"),
      ),
    )
    .toBe(true);
  const resting = await readFocusStyle(locator);
  await focus();
  await expect(locator).toBeFocused();
  await expect(locator).toHaveCSS("border-color", /.+/);

  expect(
    await locator.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  await expect
    .poll(async () => {
      const settled = await readFocusStyle(locator);
      return {
        backgroundChanged: settled.backgroundColor !== resting.backgroundColor,
        borderChanged: settled.borderColor !== resting.borderColor,
      };
    })
    .toEqual({ backgroundChanged: true, borderChanged: true });
}

async function installProviderFixture(
  page: Page,
  providers: Record<string, unknown> = PROVIDERS,
): Promise<void> {
  await page.route("**/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providers),
    });
  });
}

async function expectCompactLoginGeometry(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  const providerGroup = page.getByRole("group", {
    name: "or continue with",
  });
  const providerButtons = providerGroup.getByRole("button");
  await expect(providerButtons).toHaveCount(6);

  const main = page.getByRole("main");
  const card = main.locator("..");
  const cardBox = await card.boundingBox();
  expect(cardBox).not.toBeNull();
  if (!cardBox) throw new Error("Login card did not produce a layout box");
  expect(cardBox.y).toBeGreaterThanOrEqual(0);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height + 1);

  const documentGeometry = await page.evaluate(() => ({
    bodyScrollHeight: document.body.scrollHeight,
    documentScrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
  expect(documentGeometry.bodyScrollHeight).toBeLessThanOrEqual(
    documentGeometry.viewportHeight + 1,
  );
  expect(documentGeometry.documentScrollHeight).toBeLessThanOrEqual(
    documentGeometry.viewportHeight + 1,
  );

  const boxes = await providerButtons.evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(boxes.slice(0, 3).every((box) => box.y === boxes[0]?.y)).toBe(true);
  expect(boxes.slice(3).every((box) => box.y === boxes[3]?.y)).toBe(true);
  expect(boxes[3]?.y).toBeGreaterThan(boxes[0]?.y ?? 0);

  const termsBox = await page
    .getByRole("link", { name: "Terms", exact: true })
    .boundingBox();
  const privacyBox = await page
    .getByRole("link", { name: "Privacy Policy" })
    .boundingBox();
  expect(termsBox).not.toBeNull();
  expect(privacyBox).not.toBeNull();
  if (!termsBox || !privacyBox) {
    throw new Error("Login legal links did not produce layout boxes");
  }
  const legalLinkVerticalOverlap =
    Math.min(termsBox.y + termsBox.height, privacyBox.y + privacyBox.height) -
    Math.max(termsBox.y, privacyBox.y);
  expect(legalLinkVerticalOverlap).toBeGreaterThan(0);
  expect(privacyBox.x).toBeGreaterThan(termsBox.x);
}

test("passkey actions stay contained and keyboard-visible at the 320px locale floor", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(NARROW_VIEWPORT);
  await installProviderFixture(page, { ...PROVIDERS, passkey: true });
  await page.route("**/auth/passkey/login/options", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "No passkey found" }),
    }),
  );
  await page.route("**/auth/email/otp**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.goto("/login?lang=es");
  const email = page.getByPlaceholder("tu@ejemplo.com");
  const passkey = page.getByRole("button", { name: "Passkey", exact: true });
  const magicLink = page.getByRole("button", {
    name: "Enlace mágico",
    exact: true,
  });
  await expect(email).toBeVisible();
  await expect(magicLink).toBeVisible();

  const card = page.getByRole("main").locator("..");
  const [cardBox, passkeyBox, magicLinkBox] = await Promise.all([
    card.boundingBox(),
    passkey.boundingBox(),
    magicLink.boundingBox(),
  ]);
  expect(cardBox).not.toBeNull();
  expect(passkeyBox).not.toBeNull();
  expect(magicLinkBox).not.toBeNull();
  if (!cardBox || !passkeyBox || !magicLinkBox) {
    throw new Error("Narrow login actions did not produce layout boxes");
  }
  for (const actionBox of [passkeyBox, magicLinkBox]) {
    expect(actionBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width + 1,
    );
  }
  expect(magicLinkBox.y).toBeGreaterThan(passkeyBox.y);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(NARROW_VIEWPORT.width);

  await email.fill("persona@example.com");
  await email.focus();
  await expectKeyboardFocusDelta(passkey, () => page.keyboard.press("Tab"));
  await page.keyboard.press("Enter");

  const code = page.getByPlaceholder("123456");
  await expect(code).toBeVisible();
  await code.fill("123456");
  await code.focus();
  const createPasskey = page.getByRole("button", { name: "Create passkey" });
  const existingPasskey = page.getByRole("button", {
    name: "Usar una clave de acceso existente",
  });
  const back = page.getByRole("button", { name: /Back$/ });
  const resend = page.getByRole("button", { name: "Resend code" });
  for (const target of [createPasskey, existingPasskey, back, resend]) {
    await expectKeyboardFocusDelta(target, () => page.keyboard.press("Tab"));
  }

  await page.screenshot({
    path: testInfo.outputPath("narrow-es-passkey-focus.png"),
    fullPage: true,
  });
});

for (const viewport of VIEWPORTS) {
  test(`phone country menu stays opaque and scrollable at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await installProviderFixture(page, { ...PROVIDERS, sms: true });

    await page.goto("/login");
    await expectCompactLoginGeometry(page, viewport);
    const countryTrigger = page.getByRole("combobox", {
      name: "Country calling code",
    });
    await countryTrigger.click();

    const countryMenu = page.getByRole("listbox");
    await expect(countryMenu).toBeVisible();
    const menuBox = await countryMenu.boundingBox();
    expect(menuBox).not.toBeNull();
    if (!menuBox) {
      throw new Error("Country menu did not produce a layout box");
    }
    expect(menuBox.x).toBeGreaterThanOrEqual(16);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width - 16);
    const menuStyle = await countryMenu.evaluate((element) => {
      const style = getComputedStyle(element);
      const scroller = element.querySelector<HTMLElement>(
        "[data-radix-select-viewport]",
      );
      const colorParts = style.backgroundColor.match(/[\d.]+/g) ?? [];
      return {
        backgroundAlpha: style.backgroundColor.startsWith("rgba")
          ? Number(colorParts[3] ?? 0)
          : 1,
        borderColor: style.borderColor,
        scrollerClientHeight: scroller?.clientHeight ?? 0,
        scrollerOverflowY: scroller ? getComputedStyle(scroller).overflowY : "",
        scrollerScrollHeight: scroller?.scrollHeight ?? 0,
        zIndex: Number(style.zIndex),
      };
    });

    expect(menuStyle.backgroundAlpha).toBe(1);
    expect(menuStyle.borderColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(menuStyle.zIndex).toBeGreaterThanOrEqual(12_000);
    expect(menuStyle.scrollerOverflowY).toBe("auto");
    expect(menuStyle.scrollerScrollHeight).toBeGreaterThan(
      menuStyle.scrollerClientHeight,
    );
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-country-menu-open.png`),
      fullPage: true,
    });

    await page.keyboard.press("Home");
    await expect(countryMenu.getByRole("option").first()).toHaveAttribute(
      "data-highlighted",
    );
    await page.keyboard.press("End");
    const lastOption = countryMenu.getByRole("option").last();
    await expect(lastOption).toHaveAttribute("data-highlighted");
    await expect(lastOption).toBeInViewport();
  });

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

    // The wallet icon opens a trapped network chooser. The walk remains purely
    // keyboard-driven and proves the modal loop separately before Escape
    // restores focus to the trigger and the main document walk resumes.
    const walletToggle = page.getByRole("button", {
      name: "Continue with a wallet",
    });
    const mainTargets = [
      page.getByRole("textbox", { name: "Email" }),
      page.getByRole("button", { name: "Magic Link" }),
      page.getByRole("button", { name: "Google" }),
      page.getByRole("button", { name: "Discord" }),
      page.getByRole("button", { name: "GitHub" }),
      page.getByRole("button", { name: "X" }),
      page.getByRole("button", { name: "Telegram" }),
      walletToggle,
    ];
    const termsLink = page.getByRole("link", { name: "Terms", exact: true });
    const privacyLink = page.getByRole("link", { name: "Privacy Policy" });

    await expect(privacyLink).toBeVisible();
    await expectCompactLoginGeometry(page, viewport);
    await page.waitForTimeout(500);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-rest.png`),
      fullPage: true,
    });

    for (const target of mainTargets) {
      await expectKeyboardFocusDelta(target, () => page.keyboard.press("Tab"));
    }

    await page.keyboard.press("Space");
    const walletDialog = page.getByRole("dialog", {
      name: "Continue with a wallet",
    });
    const ethereum = walletDialog.getByRole("button", {
      name: "Ethereum",
      exact: true,
    });
    const solana = walletDialog.getByRole("button", {
      name: "Solana",
      exact: true,
    });
    const close = walletDialog.getByRole("button", { name: "Close" });
    await expect(walletDialog).toBeVisible();
    await expect(ethereum).toBeFocused();
    const dialogBox = await walletDialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    if (!dialogBox) throw new Error("Wallet dialog did not produce a box");
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(
      viewport.width + 1,
    );
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );

    // Move off the auto-focused first choice, then prove each modal target's
    // focus delta and the trapped order: Ethereum → Solana → Close.
    await page.keyboard.press("Tab");
    await expectKeyboardFocusDelta(ethereum, () =>
      page.keyboard.press("Shift+Tab"),
    );
    await expectKeyboardFocusDelta(solana, () => page.keyboard.press("Tab"));
    await expectKeyboardFocusDelta(close, () => page.keyboard.press("Tab"));

    await page.keyboard.press("Escape");
    await expect(walletDialog).toBeHidden();
    await expect(walletToggle).toBeFocused();
    await expectKeyboardFocusDelta(termsLink, () => page.keyboard.press("Tab"));
    await expectKeyboardFocusDelta(privacyLink, () =>
      page.keyboard.press("Tab"),
    );

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
