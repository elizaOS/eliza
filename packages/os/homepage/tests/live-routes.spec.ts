import { expect, type Page, test } from "playwright/test";
import { captureScreenshotWithQualityRetry } from "./screenshot-quality";

const ROUTES = [
  { path: "/", heading: /The agentic operating system/i },
  { path: "/hardware/usb", heading: /^ElizaOS USB$/i },
  { path: "/hardware/usb-plastic", heading: /^Branded USB key$/i },
  { path: "/hardware/case", heading: /^Raspberry Pi case$/i },
  { path: "/hardware/raspberry-pi", heading: /^Custom Raspberry Pi \+ case$/i },
  { path: "/hardware/mini-pc", heading: /^ElizaOS mini PC$/i },
  { path: "/hardware/phone", heading: /^ElizaOS Phone$/i },
  { path: "/hardware/box", heading: /^ElizaOS Box$/i },
  { path: "/hardware/chibi-usb", heading: /^Chibi USB key$/i },
  { path: "/checkout", heading: /^ElizaOS USB$/i },
  { path: "/checkout/success", heading: /^Pre-order received\.$/i },
  { path: "/checkout/cancel", heading: /^Checkout canceled\.$/i },
] as const;

const ALLOWED_CONSOLE_NOISE: RegExp[] = [/favicon/i];
const ALLOWED_NETWORK_NOISE: RegExp[] = [
  /favicon/i,
  /google-analytics|googletagmanager|posthog|sentry\.io/i,
];

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
  const response = await page.goto(route.path, { waitUntil: "networkidle" });
  expect(response, `no response for ${route.path}`).not.toBeNull();
  expect(response?.status(), `bad status for ${route.path}`).toBeLessThan(400);

  await expect(page.locator("#main")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: route.heading }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^Page Not Found$/i }),
  ).toHaveCount(0);

  await captureScreenshotWithQualityRetry(page, `route ${route.path}`, {
    fullPage: true,
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

test.describe("live elizaOS homepage routes", () => {
  for (const route of ROUTES) {
    test(`${route.path} loads clean without API mocks`, async ({ page }) => {
      await expectCleanRoute(page, route);
    });
  }
});
