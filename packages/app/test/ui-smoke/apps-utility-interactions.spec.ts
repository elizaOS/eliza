import { expect, type Locator, type Page, test } from "@playwright/test";
import { DIRECT_ROUTE_CASES } from "./apps-session-route-cases";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  seedAppStorage,
} from "./helpers";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type RouteCase = (typeof DIRECT_ROUTE_CASES)[number];

const APP_WINDOW_ROUTE_CASES = DIRECT_ROUTE_CASES.filter(
  (routeCase) =>
    !["phone", "contacts", "wifi"].includes(routeCase.name.toLowerCase()),
);

const RED_ERROR_TEXT =
  /Could not open app|Something went wrong|Cannot read properties|Unhandled Runtime Error|Traceback|TypeError:|ReferenceError:|Failed to load VRM/i;

const BENIGN_CONSOLE_PATTERNS = [
  /THREE\.Clock: This module has been deprecated/i,
  /THREE\.WebGLShadowMap: PCFSoftShadowMap has been deprecated/i,
  /GL Driver Message .*GPU stall due to ReadPixels/i,
];

function routeReadyChecks(routeCase: RouteCase): readonly ReadyCheck[] {
  return "readyChecks" in routeCase
    ? routeCase.readyChecks
    : [{ selector: routeCase.selector }];
}

function routeTimeout(routeCase: RouteCase): number {
  return "timeoutMs" in routeCase ? routeCase.timeoutMs : 60_000;
}

function installIssueGuards(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) {
      return;
    }
    if (message.type() === "error" || RED_ERROR_TEXT.test(text)) {
      issues.push(`console ${message.type()}: ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    issues.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const pathname = new URL(url).pathname;
    const failureText = request.failure()?.errorText ?? "";
    if (failureText === "net::ERR_ABORTED") return;
    if (/\/api\/avatar\/(vrm|background)/.test(pathname)) return;
    issues.push(`requestfailed: ${url} ${failureText}`);
  });
  return issues;
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
  expect(issues, label).toEqual([]);
}

async function openAppWindow(page: Page, routeCase: RouteCase): Promise<void> {
  await page.goto(
    `/?appWindow=1&qaApp=${encodeURIComponent(routeCase.name)}#${routeCase.path}`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await expect(page.locator("#root")).toBeVisible({
    timeout: routeTimeout(routeCase),
  });
  await assertReadyChecks(
    page,
    routeCase.name,
    routeReadyChecks(routeCase),
    "any",
    routeTimeout(routeCase),
  );
}

async function clickIfUsable(locator: Locator): Promise<boolean> {
  if ((await locator.count()) === 0) return false;
  const target = locator.first();
  if (!(await target.isVisible().catch(() => false))) return false;
  if (!(await target.isEnabled().catch(() => false))) return false;
  await target.click();
  return true;
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
  await installDefaultAppRoutes(page);
});

test("companion app controls are interactive and error-free", async ({
  page,
}) => {
  const issues = installIssueGuards(page);
  let newConversationRequests = 0;
  let lastEmoteId: string | null = null;

  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "POST") {
      newConversationRequests += 1;
    }
    await route.fallback();
  });

  await page.route("**/api/emote", async (route) => {
    const raw = route.request().postData();
    const body = raw ? (JSON.parse(raw) as { emoteId?: string }) : {};
    lastEmoteId = typeof body.emoteId === "string" ? body.emoteId : null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, emoteId: lastEmoteId }),
    });
  });

  const companion = DIRECT_ROUTE_CASES.find(
    (routeCase) => routeCase.name === "companion",
  );
  expect(companion).toBeTruthy();
  await openAppWindow(page, companion as RouteCase);

  await expect(page.getByTestId("companion-vrm-canvas")).toBeVisible();
  await expect(page.getByTestId("companion-chat-dock")).toBeVisible();

  const voiceToggle = page.getByTestId("companion-voice-toggle");
  const initialVoicePressed = await voiceToggle.getAttribute("aria-pressed");
  await voiceToggle.click();
  await expect(voiceToggle).not.toHaveAttribute(
    "aria-pressed",
    initialVoicePressed ?? "",
  );

  await page.getByTestId("companion-new-chat").click();
  await expect
    .poll(() => newConversationRequests, {
      message: "new chat posts a conversation request",
    })
    .toBeGreaterThan(0);

  await page.getByTestId("companion-shell-toggle-settings").click();
  await expect(page.getByTestId("companion-settings-panel")).toBeVisible();
  await page.getByTestId("settings-companion-vrm-power-efficiency").click();
  await expect(
    page.getByTestId("settings-companion-vrm-power-efficiency"),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("settings-companion-half-framerate-always").click();
  await expect(
    page.getByTestId("settings-companion-half-framerate-always"),
  ).toHaveAttribute("aria-pressed", "true");
  const backgroundToggle = page.getByTestId(
    "settings-companion-animate-when-hidden-toggle",
  );
  const initialBackgroundChecked =
    await backgroundToggle.getAttribute("aria-checked");
  await backgroundToggle.click();
  await expect(backgroundToggle).not.toHaveAttribute(
    "aria-checked",
    initialBackgroundChecked ?? "",
  );

  await page.getByTestId("companion-shell-toggle-character").click();
  await expect(page.getByTestId("companion-character-editor")).toBeVisible();
  await page.getByTestId("companion-shell-toggle-companion").click();
  await expect(page.getByTestId("companion-chat-dock")).toBeVisible();

  await page.keyboard.press("Control+E");
  await expect(page.getByTestId("emote-picker")).toBeVisible();
  await page.getByTestId("emote-picker-search").fill("wave");
  await page.getByTestId("emote-picker-item-wave").click();
  await expect.poll(() => lastEmoteId).toBe("wave");
  await page.getByTestId("emote-picker-stop").click();
  await page.getByTestId("emote-picker-close").click();
  await expect(page.getByTestId("emote-picker")).toBeHidden();

  const canvas = page.getByTestId("companion-vrm-canvas");
  await canvas.dragTo(canvas, {
    sourcePosition: { x: 200, y: 240 },
    targetPosition: { x: 260, y: 220 },
  });

  await expectNoIssues(page, issues, "companion interactions");
});

test("utility app-window routes render without red errors or overflow", async ({
  page,
}) => {
  const issues = installIssueGuards(page);
  for (const routeCase of APP_WINDOW_ROUTE_CASES) {
    await test.step(routeCase.name, async () => {
      await openAppWindow(page, routeCase);
      await expectNoIssues(page, issues.splice(0), routeCase.name);
    });
  }
});

test("finance and commerce utility controls refresh and show fixture data", async ({
  page,
}) => {
  const issues = installIssueGuards(page);

  const hyperliquid = DIRECT_ROUTE_CASES.find(
    (routeCase) => routeCase.name === "hyperliquid",
  );
  expect(hyperliquid).toBeTruthy();
  await openAppWindow(page, hyperliquid as RouteCase);
  await clickIfUsable(page.getByRole("button", { name: "Refresh" }));
  await expect(page.getByText("BTC")).toBeVisible();
  await expect(page.getByText("ETH")).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "hyperliquid refresh");

  const polymarket = DIRECT_ROUTE_CASES.find(
    (routeCase) => routeCase.name === "polymarket",
  );
  expect(polymarket).toBeTruthy();
  await openAppWindow(page, polymarket as RouteCase);
  await clickIfUsable(page.getByRole("button", { name: "Refresh" }));
  await clickIfUsable(
    page.getByRole("button", { name: /Will the UI smoke suite stay green/i }),
  );
  await expect(
    page.getByRole("heading", {
      name: /Will the UI smoke suite stay green/i,
    }),
  ).toBeVisible();
  await expectNoIssues(page, issues.splice(0), "polymarket refresh");

  for (const name of ["shopify", "vincent"]) {
    const routeCase = DIRECT_ROUTE_CASES.find((item) => item.name === name);
    expect(routeCase).toBeTruthy();
    await openAppWindow(page, routeCase as RouteCase);
    await clickIfUsable(page.getByRole("button", { name: "Refresh" }));
    await expectNoIssues(page, issues.splice(0), `${name} refresh`);
  }
});
