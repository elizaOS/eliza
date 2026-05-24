import { expect, type Page, test } from "playwright/test";
import { captureScreenshotWithQualityRetry } from "./screenshot-quality";

const ROUTES = [
  { path: "/", heading: /Your Eliza, everywhere/i },
  { path: "/leaderboard", landmark: ".theme-app" },
  { path: "/login", url: /\/get-started$/ },
  { path: "/get-started", heading: /Anywhere you want her to be/i },
  { path: "/connected", url: /\/get-started$/ },
] as const;

const ALLOWED_CONSOLE_NOISE: RegExp[] = [
  /favicon/i,
  /Failed to load resource: the server responded with a status of 404/i,
];

const ALLOWED_NETWORK_NOISE: RegExp[] = [
  /favicon/i,
  /google-analytics|googletagmanager|posthog|sentry\.io/i,
];

test.setTimeout(60_000);

interface Captured {
  pageErrors: string[];
  consoleErrors: string[];
  failedResponses: Array<{ url: string; status: number }>;
}

function collect(page: Page): Captured {
  const captured: Captured = {
    pageErrors: [],
    consoleErrors: [],
    failedResponses: [],
  };

  page.on("pageerror", (error) =>
    captured.pageErrors.push(error.message ?? String(error)),
  );
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ALLOWED_CONSOLE_NOISE.some((allowed) => allowed.test(text))) return;
    captured.consoleErrors.push(text);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    if (ALLOWED_NETWORK_NOISE.some((allowed) => allowed.test(response.url()))) {
      return;
    }
    captured.failedResponses.push({ status, url: response.url() });
  });

  return captured;
}

async function expectCleanRoute(page: Page, route: (typeof ROUTES)[number]) {
  const captured = collect(page);
  const response = await page.goto(route.path, {
    waitUntil: "domcontentloaded",
  });
  expect(response, `no response for ${route.path}`).not.toBeNull();
  expect(response?.status(), `bad status for ${route.path}`).toBeLessThan(400);
  await page.waitForTimeout(1_000);

  if ("url" in route) {
    await expect(page).toHaveURL(route.url);
  }
  if ("heading" in route) {
    await expect(
      page.getByRole("heading", { name: route.heading }),
    ).toBeVisible();
  }
  if ("landmark" in route) {
    await expect(page.locator(route.landmark).first()).toBeVisible();
  }

  await captureScreenshotWithQualityRetry(page, `route ${route.path}`, {
    fullPage: false,
    timeout: 20_000,
  });

  const problems: string[] = [];
  if (captured.pageErrors.length) {
    problems.push(`Page errors:\n${captured.pageErrors.join("\n")}`);
  }
  if (captured.consoleErrors.length) {
    problems.push(`Console errors:\n${captured.consoleErrors.join("\n")}`);
  }
  if (captured.failedResponses.length) {
    problems.push(
      `Failed responses:\n${captured.failedResponses
        .map((failure) => `${failure.status} ${failure.url}`)
        .join("\n")}`,
    );
  }
  if (problems.length) {
    throw new Error(
      `Route ${route.path} did not load cleanly:\n${problems.join("\n\n")}`,
    );
  }
}

test.describe("live homepage routes", () => {
  for (const route of ROUTES) {
    test(`${route.path} loads clean without API mocks`, async ({ page }) => {
      await expectCleanRoute(page, route);
    });
  }
});
