import { expect, type Page, test } from "@playwright/test";
import {
  assertReadyChecks,
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
    path: "/apps/phone",
    readyChecks: [{ selector: '[data-testid="phone-shell"]' }],
  },
  {
    name: "contacts",
    path: "/apps/contacts",
    readyChecks: [{ selector: '[data-testid="contacts-shell"]' }],
  },
  {
    name: "wifi",
    path: "/apps/wifi",
    readyChecks: [{ selector: '[data-testid="wifi-shell"]' }],
  },
  {
    name: "messages",
    path: "/apps/messages",
    readyChecks: [{ selector: '[data-testid="messages-shell"]' }],
  },
  {
    name: "device settings",
    path: "/apps/device-settings",
    readyChecks: [{ selector: '[data-testid="device-settings-shell"]' }],
  },
] as const;

const RED_ERROR_TEXT =
  /Could not open app|Something went wrong|Cannot read properties|Unhandled Runtime Error|Traceback|TypeError:|ReferenceError:/i;
const BENIGN_SHIM_ISSUES = [
  /"Keyboard" plugin is not implemented on web/i,
  /\[Eliza\] Network plugin not available: Cannot read properties of undefined \(reading 'addListener'\)/i,
];

test.use({ userAgent: ANDROID_ELIZA_UA });

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

test("AOSP system apps render and expose safe controls", async ({ page }) => {
  const issues = installIssueGuards(page);

  for (const routeCase of ANDROID_SYSTEM_APP_CASES) {
    await test.step(routeCase.name, async () => {
      await openAppWindow(page, routeCase);
      await expectNoIssues(page, issues.splice(0), routeCase.name);
    });
  }
});

test("Phone, Contacts, WiFi, Messages, and Device Settings handle core interactions", async ({
  page,
}) => {
  const issues = installIssueGuards(page);
  const byName = new Map(ANDROID_SYSTEM_APP_CASES.map((route) => [route.name, route]));

  await openAppWindow(page, byName.get("phone")!);
  await page.getByTestId("phone-dial-key-1").click();
  await page.getByTestId("phone-dial-key-2").click();
  await page.getByTestId("phone-dial-key-3").click();
  await page.getByTestId("phone-dial-backspace").click();
  await expect(page.getByLabel("Number being dialed")).toContainText("12");
  await page.getByRole("tab", { name: "Recent" }).click();
  await expect(page.getByText("No recent calls.")).toBeVisible();
  const phoneContactsTab = page.getByRole("tab", { name: "Contacts" });
  if (await phoneContactsTab.isEnabled()) {
    await phoneContactsTab.click();
    await expect(page.getByText("No contacts with phone numbers.")).toBeVisible();
  } else {
    await expect(phoneContactsTab).toBeDisabled();
  }
  await expectNoIssues(page, issues.splice(0), "phone interactions");

  await openAppWindow(page, byName.get("contacts")!);
  await page.getByTestId("contacts-search").fill("ada");
  await page.getByTestId("contacts-new").click();
  await page.getByPlaceholder("Full name").fill("Ada Lovelace");
  await page.getByPlaceholder("+1 555 123 4567").fill("+1 555 0100");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("contacts-shell")).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "contacts interactions");

  await openAppWindow(page, byName.get("wifi")!);
  await page.getByTestId("wifi-scan").click();
  await expect(page.getByText("Wi-Fi is off")).toBeVisible();
  await expect(page.getByText("No networks found")).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "wifi interactions");

  await openAppWindow(page, byName.get("messages")!);
  await page.getByTestId("messages-new").click();
  await page.getByTestId("messages-compose-address").fill("+1 555 0101");
  await page.getByTestId("messages-compose-body").fill("QA SMS draft");
  await expect(page.getByTestId("messages-send")).toBeEnabled();
  await page.getByTestId("messages-refresh").click();
  await expectNoIssues(page, issues.splice(0), "messages interactions");

  await openAppWindow(page, byName.get("device settings")!);
  await page.getByTestId("device-settings-brightness").fill("67");
  const mediaVolume = page.getByTestId("device-settings-volume-music");
  if (await mediaVolume.isVisible().catch(() => false)) {
    await mediaVolume.fill("8");
  }
  await page.getByTestId("device-settings-refresh").click();
  await expectNoIssues(page, issues.splice(0), "device settings interactions");
});
