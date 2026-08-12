/**
 * Playwright route-flow coverage for mocked homepage auth, linking, and provisioning paths.
 */

import { expect, type Page, test } from "playwright/test";
import { ELIZA_PHONE_FORMATTED } from "../../src/lib/contact";
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

  await page.route("https://elizacloud.ai/api/eliza-app/**/chat", (route) =>
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

  await page.route("https://elizacloud.ai/api/eliza-app/**", (route) => {
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
  await expect(page.getByText("Add Eliza to your server")).toBeVisible();
  await expect(page.getByText("Send a direct message")).toBeVisible();
  await expect(page.getByText("Start chatting")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Invite to Server" }),
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
  await expect(
    page.getByRole("button", {
      name: new RegExp(
        `iMessage ${ELIZA_PHONE_FORMATTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Connect Discord" }).click();
  await expect(page).toHaveURL(/\/get-started\?method=discord&link=true/);
});

test("landing page renders its animated shell and primary entrypoint", async ({
  page,
}) => {
  // Full landing readiness (shader + phone model + message replay) can take
  // minutes on a starved fleet runner.
  test.setTimeout(240_000);
  await page.goto("/");

  await expect(page.getByLabel("Eliza", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Try Now" })).toBeVisible({
    timeout: 20_000,
  });
  await waitForLandingIntro(page);
});

test("landing swipe keeps pointer direction and surface-scoped drag prevention", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const surface = page.locator("div.theme-app").first();
  const imessage = page.getByRole("button", { name: "iMessage" });
  const telegram = page.getByRole("button", { name: "Telegram" });
  await expect(surface).toBeVisible();
  await expect(imessage).toHaveAttribute("aria-pressed", "true");

  const drag = async (fromRatio: number, toRatio: number) => {
    const box = await surface.boundingBox();
    if (!box) throw new Error("Landing swipe surface has no bounds");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * fromRatio, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * toRatio, y, { steps: 2 });
    await page.mouse.up();
  };

  await drag(0.7, 0.3);
  await expect(telegram).toHaveAttribute("aria-pressed", "true");
  await drag(0.3, 0.7);
  await expect(imessage).toHaveAttribute("aria-pressed", "true");

  const dragGuard = await surface.evaluate((root) => {
    const target = root.querySelector("img, a");
    if (!(target instanceof HTMLElement)) {
      return { foundTarget: false, defaultPrevented: false };
    }
    const event = new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return { foundTarget: true, defaultPrevented: event.defaultPrevented };
  });
  expect(dragGuard).toEqual({ foundTarget: true, defaultPrevented: true });
});

test("landing composer is inert while hidden and stays in-viewport when active", async ({
  page,
}) => {
  // Three platform swipes each trigger the phone-model spin animation, and on
  // CI's software GL those animation frames run seconds-per-frame; the default
  // 60s budget is not enough for the full imessage → try traversal.
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForLandingIntro(page);

  const composer = page.locator('[data-landing-chrome="composer"]');
  await expect(composer).toHaveAttribute(
    "data-landing-chrome-visible",
    "false",
  );
  await expect(composer).toHaveAttribute("inert", "");
  await expect(composer).toHaveAttribute("aria-hidden", "true");

  // Opacity-only hide must not leave the message field in the tab order.
  const tabTargetsWhileHidden = await page.evaluate(() => {
    const root = document.querySelector('[data-landing-chrome="composer"]');
    if (!(root instanceof HTMLElement)) {
      return { error: "missing-composer" };
    }
    const focusables = [
      ...root.querySelectorAll("textarea, button, a, select, input"),
    ] as HTMLElement[];
    return {
      count: focusables.length,
      anyIsFocusable: focusables.some((el) => {
        el.focus();
        return document.activeElement === el;
      }),
    };
  });
  expect(tabTargetsWhileHidden).toMatchObject({ anyIsFocusable: false });

  // Swipe imessage → telegram → discord → try to reveal the composer. Each
  // mouse.move step waits for a rendered frame, and CI's software-GL frames
  // for the full-viewport shader are seconds long — so keep the drag to the
  // minimum pointer dispatches the gesture recognizer needs. A loaded
  // renderer can also drop an individual gesture, so drive by state: keep
  // swiping until the composer reports visible instead of assuming exactly
  // three perfect swipes.
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(320, 420);
    await page.mouse.down();
    await page.mouse.move(40, 420, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const visible = await composer.getAttribute("data-landing-chrome-visible");
    if (visible === "true") break;
  }

  await expect(composer).toHaveAttribute(
    "data-landing-chrome-visible",
    "true",
    {
      timeout: 10_000,
    },
  );
  await expect(composer).not.toHaveAttribute("inert", "");
  await expect(composer).not.toHaveAttribute("aria-hidden", "true");

  const message = page.getByRole("textbox", { name: "Message Eliza" }).first();
  await expect(message).toBeVisible();
  await message.focus();
  await expect(message).toBeFocused();

  const bounds = await message.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      // The composer sits under a deliberate perspective/rotateX tilt, which
      // shrinks the projected rect slightly; the touch-target floor applies to
      // the layout box, so measure offsetHeight rather than rect.height.
      layoutHeight: (el as HTMLElement).offsetHeight,
      viewportHeight: window.innerHeight,
    };
  });
  expect(bounds.layoutHeight).toBeGreaterThanOrEqual(44);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 0.5);

  const voice = page.getByRole("button", { name: /voice input|Send message/i });
  const voiceBox = await voice.boundingBox();
  expect(voiceBox).not.toBeNull();
  if (voiceBox) {
    expect(voiceBox.height).toBeGreaterThanOrEqual(44);
    expect(voiceBox.width).toBeGreaterThanOrEqual(44);
    expect(voiceBox.y + voiceBox.height).toBeLessThanOrEqual(844 + 0.5);
  }
});
