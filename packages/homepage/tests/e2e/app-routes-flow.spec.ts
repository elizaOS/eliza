/**
 * Playwright route-flow coverage for mocked homepage auth, linking, and provisioning paths.
 */

import { expect, type Page, test } from "playwright/test";
import { waitForLandingIntro } from "./landing-readiness";

const TEST_TOKEN = "homepage-e2e-token";

test.describe.configure({ mode: "serial" });

const mockUser = {
  id: "user_homepage_e2e",
  telegram_id: "123456",
  telegram_username: "homepage_e2e",
  telegram_first_name: "Homepage",
  discord_id: null,
  discord_username: null,
  discord_global_name: null,
  discord_avatar_url: null,
  whatsapp_id: null,
  whatsapp_name: null,
  phone_number: null,
  name: "Homepage E2E",
  avatar: null,
  organization_id: "org_homepage_e2e",
  created_at: "2026-01-01T00:00:00.000Z",
};

async function installHomepageApiMocks(page: Page) {
  let linkedPhone: string | null = null;

  await page.route("https://api.eliza.app/api/eliza-app/**/chat", (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: "assistant-welcome",
            role: "assistant",
            content: "Your AI space is ready.",
          },
        ],
        containerStatus: "ready",
      },
    }),
  );

  await page.route("https://api.eliza.app/api/eliza-app/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/eliza-app/user/me") {
      return route.fulfill({
        json: {
          user: { ...mockUser, phone_number: linkedPhone },
          organization: {
            id: "org_homepage_e2e",
            name: "Homepage E2E Org",
            credit_balance: "42.50",
          },
        },
      });
    }

    if (path === "/api/eliza-app/user/phone") {
      const body = route.request().postDataJSON() as { phone_number?: unknown };
      linkedPhone = String(body.phone_number ?? "");
      return route.fulfill({
        json: { success: true, phone_number: linkedPhone },
      });
    }

    if (path === "/api/eliza-app/auth/telegram") {
      return route.fulfill({
        json: {
          success: true,
          user: {
            id: mockUser.id,
            telegram_id: mockUser.telegram_id,
            telegram_username: mockUser.telegram_username,
            phone_number: "+15555550123",
            name: mockUser.name,
            organization_id: mockUser.organization_id,
          },
          session: {
            token: TEST_TOKEN,
            expires_at: "2026-12-31T00:00:00.000Z",
          },
          is_new_user: true,
        },
      });
    }

    return route.fulfill({ status: 404, json: { error: "Unhandled mock" } });
  });
}

async function seedAuthenticatedSession(page: Page) {
  await page.addInitScript((token) => {
    window.localStorage.setItem("eliza_app_session", token as string);
  }, TEST_TOKEN);
  try {
    await page.evaluate((token) => {
      window.localStorage.setItem("eliza_app_session", token as string);
    }, TEST_TOKEN);
  } catch {
    // The addInitScript path covers fresh navigations from about:blank and
    // cross-origin pages where localStorage cannot be touched synchronously.
  }
}

test.beforeEach(async ({ page }) => {
  await installHomepageApiMocks(page);
});

test.setTimeout(60_000);

test("login routes anonymous and authenticated users to the correct next page", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/get-started$/);
  await expect(
    page.getByRole("heading", { name: "Anywhere you want her to be." }),
  ).toBeVisible();

  await page.goto("/login?returnTo=https%3A%2F%2Fexample.com");
  await expect(page).toHaveURL(/\/get-started$/);

  await seedAuthenticatedSession(page);
  await page.goto("/login");
  await expect(page).toHaveURL(/\/connected$/);
  await expect(page.getByRole("heading", { name: "Connected." })).toBeVisible();
});

test("profile editor preserves sign-in return path and generates a compatible marker", async ({
  context,
  page,
}) => {
  await page.goto("/profile/edit");
  await expect(page).toHaveURL(/\/get-started\?returnTo=%2Fprofile%2Fedit$/);

  await seedAuthenticatedSession(page);
  await page.goto("/get-started?returnTo=%2Fprofile%2Fedit");
  await expect(page).toHaveURL(/\/profile\/edit$/);

  // A completed deep-link login must not redirect unrelated future auth flows.
  await page.goto("/login");
  await expect(page).toHaveURL(/\/connected$/);

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/profile/edit");

  await expect(
    page.getByRole("heading", { name: "Link a public wallet." }),
  ).toBeVisible();
  await page
    .getByLabel("Ethereum / EVM address")
    .fill("0xd2Bb04998A32BBd6A5F666EA306F4745a606495E");
  await page.getByRole("button", { name: "Generate README marker" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Enter a valid EVM address",
  );

  await page
    .getByLabel("Ethereum / EVM address")
    .fill("0xd2Bb04998A32BBd6A5F666EA306F4745a606495f");
  await page.getByRole("button", { name: "Generate README marker" }).click();

  const generated = page.getByLabel("Generated wallet linking comment");
  await expect(generated).toContainText("<!-- WALLET-LINKING-BEGIN");
  await expect(generated).toContainText('"chain": "ethereum"');
  await expect(generated).toContainText(
    '"address": "0xd2Bb04998A32BBd6A5F666EA306F4745a606495f"',
  );
  await expect(generated).toContainText("WALLET-LINKING-END -->");

  await page.getByRole("button", { name: "Copy hidden comment" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("WALLET-LINKING-BEGIN");
});

test("get-started covers method selection, phone input, country dropdown, and direct messaging options", async ({
  page,
}) => {
  await page.goto("/get-started");
  await expect(
    page.getByRole("heading", { name: "Anywhere you want her to be." }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^iMessage$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Ready to chat!" }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(
    "I also want to use Telegram",
  );

  await page.getByRole("button", { name: "Back" }).dispatchEvent("click");
  await page.getByRole("button", { name: /^WhatsApp$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Chat on WhatsApp!" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Back" }).dispatchEvent("click");
  await page.getByRole("button", { name: /^Telegram$/ }).dispatchEvent("click");
  await expect(
    page.getByRole("heading", { name: "Message Eliza on Telegram" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open Telegram/i }),
  ).toBeVisible();
});

test("get-started preserves touch targets and exposes glass phone-input focus", async ({
  page,
}) => {
  await page.goto("/get-started");

  const home = page.getByRole("link", { name: "Home" });
  await expect
    .poll(async () => (await home.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);

  await page.getByRole("button", { name: /^iMessage$/ }).click();
  const back = page.getByRole("button", { name: "Back" });
  await expect
    .poll(async () => (await back.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);

  await seedAuthenticatedSession(page);
  // In link mode the page injects the real telegram.org widget script, which
  // (whenever the network wins the race) overwrites this mock and leaves the
  // flow stuck on the real popup at "Connecting...". Abort the widget request
  // so the deterministic mock always answers.
  await page.route("https://telegram.org/**", (route) => route.abort());
  await page.addInitScript(() => {
    Reflect.set(window, "Telegram", {
      Login: {
        auth: (
          _options: object,
          callback: (value: Record<string, unknown>) => void,
        ) =>
          callback({
            id: 123456,
            first_name: "Homepage",
            username: "homepage_e2e",
            auth_date: 1_786_500_000,
            hash: "telegram-test-hash",
          }),
      },
    });
  });
  await page.goto("/get-started?method=telegram&link=true");
  await page.getByRole("button", { name: "Connect Telegram" }).click();

  const country = page.getByLabel("Choose country");
  await country.focus();
  const focusBoxShadow = await country.evaluate((select) => {
    const wrapper = select.closest("label")?.parentElement;
    return wrapper ? getComputedStyle(wrapper).boxShadow : "";
  });
  expect(focusBoxShadow).not.toBe("none");
  expect(focusBoxShadow).not.toBe("");
});

test("get-started covers Discord callback errors and setup guide", async ({
  page,
}) => {
  await page.goto("/get-started?code=discord_code_1&state=unexpected_state");

  await expect(
    page.getByText(/Authentication failed: invalid state/i),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Discord$/ })).toBeVisible();

  await seedAuthenticatedSession(page);
  await page.goto("/get-started?guide=discord");

  await expect(
    page.getByRole("heading", { name: "Discord Setup Guide" }),
  ).toBeVisible();
  await expect(page.getByText("Install Eliza for your account")).toBeVisible();
  await expect(page.getByText("Send a direct message")).toBeVisible();
  await expect(page.getByText("Start chatting")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Install for DMs" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open DM" })).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/connected$/);
});

test("connected page exercises account menu, copy controls, link-phone form, and connection buttons", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedAuthenticatedSession(page);
  await page.goto("/connected");

  await expect(page.getByRole("heading", { name: "Connected." })).toBeVisible();
  await expect(page.getByText("$42.50")).toBeVisible();

  await page.getByLabel("Open user menu").click();
  await expect(page.getByText("Homepage E2E")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByLabel("Copy Telegram link").click({ force: true });
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("t.me/");

  await page.getByRole("button", { name: /^iMessage$/ }).click();
  await page.getByLabel("Choose country").selectOption("CA");
  await page.getByLabel("Phone number").fill("416 555 0123");
  await page.getByRole("button", { name: "Link Phone" }).click();
  await expect(page.getByLabel("Phone number", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^iMessage$/ })).toBeVisible();
  await expect(page.getByText("+1 (808) 788-1821")).toHaveCount(0);

  await page.getByRole("button", { name: "Connect Discord" }).click();
  await expect(page).toHaveURL(/\/get-started\?method=discord&link=true/);
});

test("landing leads with iMessage and keeps secondary channels available", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /one member every group chat needs/i }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(
      "Eliza follows the conversation, remembers what the group decides, and keeps the plan clear.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Friends · Co-parenting · Households · Trips · Communities"),
  ).toHaveCount(0);
  await expect(
    page.getByText("Tonight is split evenly", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".landing-scenario-strip")).toHaveCount(0);
  await expect(page.locator(".landing-iphone")).toHaveAttribute(
    "data-demo-scenarios",
    "5",
  );

  const textCta = page.getByRole("button", { name: "Text Eliza" });
  await expect(textCta).toBeVisible();
  await textCta.click();
  await expect(page.locator('.landing-copy-notice [role="status"]')).toHaveText(
    "Copied!",
  );
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("+18087881821");
  await expect(page.locator(".landing-copy-notice")).toHaveCount(0, {
    timeout: 3_000,
  });
  await expect(page.getByText("+1 (808) 788-1821")).toHaveCount(0);
  const callCta = page.getByRole("button", { name: "Call" });
  await expect(callCta).toBeVisible();
  await callCta.click();
  await expect(page.locator('.landing-copy-notice [role="status"]')).toHaveText(
    "Copied!",
  );
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("+18087881821");
  const channels = page.locator(".landing-secondary-channels");
  await expect(channels.locator(".landing-channel")).toHaveCount(2);
  await expect(channels.getByText("Telegram", { exact: true })).toBeVisible();
  await expect(channels.getByText("Discord", { exact: true })).toBeVisible();
  await expect(
    channels.getByRole("link", { name: /Telegram/ }),
  ).toHaveAttribute("href", /^https:\/\/t\.me\//);
  await expect(channels.getByRole("link", { name: /Discord/ })).toHaveAttribute(
    "href",
    /^https:\/\/discord\.com\//,
  );
  await expect(channels.getByRole("link", { name: /WhatsApp/ })).toHaveCount(0);

  const keyboard = page.locator(".landing-keyboard");
  await expect(keyboard).toHaveAttribute("data-open", "true", {
    timeout: 20_000,
  });
  const phoneInsets = await page.evaluate(() => {
    const composer = document.querySelector(".landing-phone-composer");
    const keyboard = document.querySelector(".landing-keyboard");
    const thread = document.querySelector(".landing-phone-thread");
    if (!composer || !keyboard || !thread) throw new Error("Phone UI missing");
    return {
      composerToKeyboard:
        keyboard.getBoundingClientRect().top -
        composer.getBoundingClientRect().bottom,
      threadMask: getComputedStyle(thread).maskImage,
    };
  });
  expect(phoneInsets.composerToKeyboard).toBeGreaterThanOrEqual(7);
  expect(phoneInsets.threadMask).toContain("linear-gradient");
});

test("landing keeps content reachable on a small viewport", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-write"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForLandingIntro(page);

  // No horizontal overflow at mobile width.
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);

  await expect(page.locator(".landing-header")).toBeHidden();
  await expect(page.locator(".landing-hero-heading")).toHaveCSS(
    "clip-path",
    "inset(50%)",
  );
  await expect(page.locator(".landing-hero-actions")).toBeHidden();
  const fullScreenThread = await page
    .locator(".landing-iphone")
    .evaluate((phone) => ({
      ariaHidden: phone.getAttribute("aria-hidden"),
      borderRadius: getComputedStyle(phone).borderRadius,
      width: phone.getBoundingClientRect().width,
    }));
  expect(fullScreenThread.ariaHidden).toBeNull();
  expect(fullScreenThread.borderRadius).toBe("0px");
  expect(fullScreenThread.width).toBe(390);

  const contactSheetTrigger = page.getByRole("button", {
    name: "All the ways to reach Eliza",
  });
  await expect(contactSheetTrigger).toBeVisible();
  await contactSheetTrigger.click();

  const contactSheet = page.getByRole("dialog");
  await expect(contactSheet).toBeVisible();
  const textAction = contactSheet.getByRole("button", {
    name: "Text Eliza on iMessage",
  });
  await expect(textAction).toBeVisible();
  await expect(
    contactSheet.getByRole("button", { name: "Call Eliza" }),
  ).toBeVisible();
  await expect(
    contactSheet.getByRole("link", { name: "Message Eliza on Discord" }),
  ).toHaveAttribute("href", /^https:\/\/discord\.com\//);
  await expect(
    contactSheet.getByRole("link", { name: "Message Eliza on Telegram" }),
  ).toHaveAttribute("href", /^https:\/\/t\.me\//);
  await expect(
    contactSheet.getByRole("link", { name: "Message Eliza on WhatsApp" }),
  ).toHaveCount(0);
  await expect(
    contactSheet.getByRole("link", { name: "Sign in to Eliza Cloud" }),
  ).toBeVisible();

  const composer = page.locator(".landing-phone-composer");
  await composer.scrollIntoViewIfNeeded();
  await expect(composer).toBeVisible();

  await textAction.click();
  await expect(contactSheet).toBeHidden();
  await expect(page.locator('.landing-copy-notice [role="status"]')).toHaveText(
    "Copied!",
  );
  await page.waitForTimeout(2_250);
  await expect(page.locator(".landing-copy-notice")).toHaveCount(0);

  // Leave the real sheet open as the terminal state so recorded evidence
  // proves the mobile entrypoint and its complete option list, not just the
  // transient interaction captured in the video.
  await contactSheetTrigger.click();
  await expect(contactSheet).toBeVisible();
});

test("landing keeps clipboard rejection visible", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Text Eliza" }).click();
  await expect(page.getByRole("alert")).toHaveText("Couldn't copy");
  await page.waitForTimeout(2_250);
  await expect(page.getByRole("alert")).toHaveText("Couldn't copy");
});

test("supported-platform messaging keeps a manual copy recovery visible", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { platform: "macOS" },
    });
  });
  await page.goto("/");
  await waitForLandingIntro(page);

  await page.getByRole("button", { name: "Text" }).click();
  const landingContactStatus = page.locator(
    '.landing-copy-notice [role="status"]',
  );
  await expect(landingContactStatus).toHaveText("Messages didn't open?");

  const copyButton = page.getByRole("button", { name: "Copy phone number" });
  await expect(copyButton).toBeVisible();
  await copyButton.click();
  await expect(landingContactStatus).toHaveText("Copied!");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("+18087881821");
  await expect(page.getByText("+1 (808) 788-1821")).toHaveCount(0);

  await page.getByRole("button", { name: "Call" }).click();
  await expect(landingContactStatus).toHaveText("Phone didn't open?");
  await expect(
    page.getByRole("button", { name: "Copy phone number" }),
  ).toBeVisible();

  await page.goto("/get-started");
  await page.getByRole("button", { name: /^iMessage$/ }).click();
  await page.getByRole("button", { name: "Message Eliza" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Opening Messages. If nothing happens, copy the number.",
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          Promise.reject(new DOMException("denied", "NotAllowedError")),
      },
    });
  });
  await page.getByRole("button", { name: "Copy phone number" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn't copy the phone number",
  );

  await seedAuthenticatedSession(page);
  await page.goto("/connected");
  await page.getByRole("button", { name: /^iMessage$/ }).click();
  await page.getByLabel("Phone number").fill("416 555 0123");
  await page.getByRole("button", { name: "Link Phone" }).click();
  await page.getByRole("button", { name: /^iMessage$/ }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Opening Messages. If nothing happens, copy the number.",
  );
  await page.getByRole("button", { name: "Copy phone number" }).click();
  await expect(page.getByRole("status")).toHaveText("Phone number copied");
});

test("mobile call recovery stays compact and clear of the composer", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { platform: "macOS" },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForLandingIntro(page);

  await page
    .getByRole("button", { name: "All the ways to reach Eliza" })
    .click();
  await page.getByRole("button", { name: "Call Eliza" }).click();

  const notice = page.locator(".landing-copy-notice--handoff");
  await expect(notice).toContainText("Phone didn't open?");
  await expect(
    notice.getByRole("button", { name: "Copy phone number" }),
  ).toHaveText("Copy number");

  const geometry = await page.evaluate(() => {
    const notice = document.querySelector(".landing-copy-notice--handoff");
    const status = notice?.querySelector('[role="status"]');
    const action = notice?.querySelector("button");
    const composer = document.querySelector(".landing-composer-row");
    if (!notice || !status || !action || !composer) {
      throw new Error("Mobile call recovery UI is incomplete");
    }
    return {
      notice: notice.getBoundingClientRect().toJSON(),
      status: status.getBoundingClientRect().toJSON(),
      action: action.getBoundingClientRect().toJSON(),
      composer: composer.getBoundingClientRect().toJSON(),
    };
  });
  expect(geometry.notice.width).toBeLessThanOrEqual(366);
  expect(geometry.status.height).toBeLessThan(28);
  expect(geometry.action.height).toBeGreaterThanOrEqual(40);
  expect(geometry.notice.bottom).toBeLessThanOrEqual(geometry.composer.top);
});

test("the latest manual-copy attempt owns the visible result", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { platform: "macOS" },
    });
    const attempts: Array<{
      reject: () => void;
      resolve: () => void;
    }> = [];
    Object.defineProperty(window, "__homepageCopyAttempts", {
      configurable: true,
      value: attempts,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve, reject) => {
            attempts.push({ resolve, reject });
          }),
      },
    });
  });

  const attempts = () =>
    page.evaluate(() => {
      const controls = (
        window as unknown as {
          __homepageCopyAttempts: Array<{
            reject: () => void;
            resolve: () => void;
          }>;
        }
      ).__homepageCopyAttempts;
      return controls.length;
    });
  const settle = (index: number, outcome: "resolve" | "reject") =>
    page.evaluate(
      ({ attemptIndex, attemptOutcome }) => {
        const controls = (
          window as unknown as {
            __homepageCopyAttempts: Array<{
              reject: () => void;
              resolve: () => void;
            }>;
          }
        ).__homepageCopyAttempts;
        controls[attemptIndex]?.[attemptOutcome]();
      },
      { attemptIndex: index, attemptOutcome: outcome },
    );

  await page.goto("/");
  await waitForLandingIntro(page);
  await page.getByRole("button", { name: "Text" }).click();
  const copyButton = page.getByRole("button", { name: "Copy phone number" });
  await copyButton.click();
  await copyButton.click();
  await expect.poll(attempts).toBe(2);

  await settle(1, "resolve");
  await expect(page.getByRole("status")).toHaveText("Copied!");
  await settle(0, "reject");
  await expect(page.getByRole("status")).toHaveText("Copied!");

  await page.reload();
  await waitForLandingIntro(page);
  await page.getByRole("button", { name: "Text" }).click();
  await copyButton.click();
  await copyButton.click();
  await expect.poll(attempts).toBe(2);

  await settle(1, "reject");
  await expect(page.getByRole("alert")).toHaveText("Couldn't copy");
  await settle(0, "resolve");
  await expect(page.getByRole("alert")).toHaveText("Couldn't copy");
});
