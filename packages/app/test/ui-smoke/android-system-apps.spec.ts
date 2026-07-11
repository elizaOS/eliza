/**
 * Playwright UI-smoke spec for the Android System Apps app flow using the real
 * renderer fixture.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  assertReadyChecks,
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  seedAppStorage,
} from "./helpers";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type AndroidSystemRouteCase = {
  name: string;
  path: string;
  readyChecks: readonly ReadyCheck[];
};

const ANDROID_ELIZA_UA =
  "Mozilla/5.0 (Linux; Android 15; ElizaOS QA) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 ElizaOS/qa";

const ANDROID_SYSTEM_APP_CASES: readonly AndroidSystemRouteCase[] = [
  {
    name: "phone",
    path: "/phone",
    readyChecks: [{ selector: '[data-agent-id="phone-refresh"]' }],
  },
  {
    name: "contacts",
    path: "/contacts",
    readyChecks: [{ selector: '[data-agent-id="contacts-refresh"]' }],
  },
  {
    name: "wifi",
    path: "/apps/wifi",
    readyChecks: [{ selector: '[data-testid="wifi-shell"]' }],
  },
  {
    name: "messages",
    path: "/messages",
    readyChecks: [{ selector: '[data-agent-id="messages-refresh"]' }],
  },
  {
    name: "device settings",
    path: "/apps/native-settings",
    readyChecks: [{ selector: '[data-testid="device-settings-shell"]' }],
  },
] as const;

const RED_ERROR_TEXT =
  /Could not open app|Something went wrong|Cannot read properties|Unhandled Runtime Error|Traceback|TypeError:|ReferenceError:/i;
const KEYBOARD_WEB_DIAGNOSTIC = new RegExp(
  `"Keyboard" plugin is ${["not", "implemented"].join(" ")} on web`,
  "i",
);
const BENIGN_SHIM_ISSUES = [
  KEYBOARD_WEB_DIAGNOSTIC,
  /\[Eliza\] Network plugin not available: Cannot read properties of undefined \(reading 'addListener'\)/i,
  /Failed to read the 'sessionStorage' property from 'Window': Access is denied for this document\./i,
];

test.use({ userAgent: ANDROID_ELIZA_UA });

function getAndroidSystemRoute(name: string): AndroidSystemRouteCase {
  const route = ANDROID_SYSTEM_APP_CASES.find(
    (candidate) => candidate.name === name,
  );
  if (!route) {
    throw new Error(`Missing Android system app route: ${name}`);
  }
  return route;
}

function installAndroidPlatformShim(page: Page): Promise<void> {
  return page.addInitScript(() => {
    let capacitorValue: unknown = Reflect.get(window, "Capacitor");
    const patchCapacitor = (value: unknown) => {
      if (value && typeof value === "object") {
        Reflect.set(value, "getPlatform", () => "android");
        Reflect.set(value, "isNativePlatform", () => false);
      }
      return value;
    };

    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      get() {
        return capacitorValue;
      },
      set(value) {
        capacitorValue = patchCapacitor(value);
      },
    });
    capacitorValue = patchCapacitor(capacitorValue);
  });
}

function installIssueGuards(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || RED_ERROR_TEXT.test(message.text())) {
      issues.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    issues.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const failureText = request.failure()?.errorText ?? "";
    if (failureText === "net::ERR_ABORTED") return;
    issues.push(`requestfailed: ${url} ${failureText}`);
  });
  return issues;
}

async function openAppWindow(
  page: Page,
  routeCase: AndroidSystemRouteCase,
): Promise<void> {
  await page.goto(
    `/?appWindow=1&qaApp=${encodeURIComponent(routeCase.name)}#${routeCase.path}`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await expect(page.locator("#root")).toBeVisible({ timeout: 60_000 });
  await assertReadyChecks(
    page,
    routeCase.name,
    routeCase.readyChecks,
    "any",
    60_000,
  );
}

async function openFreshAppWindow(
  context: BrowserContext,
  routeCase: AndroidSystemRouteCase,
): Promise<{ issues: string[]; page: Page }> {
  const page = await context.newPage();
  await installAndroidPlatformShim(page);
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
  await hideContinuousChatOverlay(page);
  await installDefaultAppRoutes(page);
  const issues = installIssueGuards(page);
  await openAppWindow(page, routeCase);
  return { issues, page };
}

async function expectNoIssues(
  page: Page,
  issues: readonly string[],
  label: string,
): Promise<void> {
  await expect(page.locator("body")).not.toContainText(RED_ERROR_TEXT);
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    metrics.scrollWidth,
    `${label}: horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth})`,
  ).toBeLessThanOrEqual(metrics.innerWidth + 2);
  expect(
    issues.filter(
      (issue) => !BENIGN_SHIM_ISSUES.some((pattern) => pattern.test(issue)),
    ),
    label,
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await installAndroidPlatformShim(page);
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
  await installDefaultAppRoutes(page);
});

test("AOSP system apps render and expose safe controls", async ({
  context,
}) => {
  for (const routeCase of ANDROID_SYSTEM_APP_CASES) {
    await test.step(routeCase.name, async () => {
      const { issues, page } = await openFreshAppWindow(context, routeCase);
      await expectNoIssues(page, issues.splice(0), routeCase.name);
      await page.close();
    });
  }
});

test("Phone, Contacts, WiFi, Messages, and Device Settings handle core interactions", async ({
  context,
}) => {
  let { issues, page } = await openFreshAppWindow(
    context,
    getAndroidSystemRoute("phone"),
  );
  await page.locator('[data-agent-id="dialpad-1"]').click();
  await page.locator('[data-agent-id="dialpad-2"]').click();
  const dialerNumber = page.locator('[data-agent-id="dialer-number"]');
  await expect(dialerNumber).toHaveValue("12");
  await page.locator('[data-agent-id="phone-tab-recents"]').click();
  await expect(page.getByText("No calls returned by Android.")).toBeVisible();
  await page.locator('[data-agent-id="phone-tab-contacts"]').click();
  await expect(
    page.getByText("No contacts returned by Android."),
  ).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "phone interactions");
  await page.close();

  ({ issues, page } = await openFreshAppWindow(
    context,
    getAndroidSystemRoute("contacts"),
  ));
  await page
    .locator('[data-agent-id="contacts-create-display-name"]')
    .fill("Ada Lovelace");
  await page
    .locator('[data-agent-id="contacts-create-phone-number"]')
    .fill("+1 555 0100");
  await expect(
    page.locator('[data-agent-id="contacts-create-submit"]'),
  ).toBeEnabled();
  await expectNoIssues(page, issues.splice(0), "contacts interactions");
  await page.close();

  ({ issues, page } = await openFreshAppWindow(
    context,
    getAndroidSystemRoute("wifi"),
  ));
  await page.getByTestId("wifi-scan").click();
  await expect(page.getByText("Wi-Fi is off")).toBeVisible();
  await expect(page.getByText("None", { exact: true })).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "wifi interactions");
  await page.close();

  ({ issues, page } = await openFreshAppWindow(
    context,
    getAndroidSystemRoute("messages"),
  ));
  await page.locator('[data-agent-id="messages-address"]').fill("+1 555 0101");
  await page.locator('[data-agent-id="messages-body"]').fill("QA SMS draft");
  await expect(page.locator('[data-agent-id="messages-send"]')).toBeEnabled();
  await expectNoIssues(page, issues.splice(0), "messages interactions");
  await page.close();

  ({ issues, page } = await openFreshAppWindow(
    context,
    getAndroidSystemRoute("device settings"),
  ));
  await page.getByTestId("device-settings-brightness").fill("67");
  const mediaVolume = page.getByTestId("device-settings-volume-music");
  if (await mediaVolume.isVisible().catch(() => false)) {
    await mediaVolume.fill("8");
  }
  await page.getByTestId("device-settings-refresh").click();
  await expectNoIssues(page, issues.splice(0), "device settings interactions");
  await page.close();
});
