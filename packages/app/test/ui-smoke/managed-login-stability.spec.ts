/**
 * Real-browser regression for the managed Cloud login's navigation ownership.
 * The fixture proxies the local renderer behind the canonical app hostname so
 * production hostname gates run unchanged while all application bytes remain
 * exact-head and local; network-bound auth provider discovery is deterministic.
 */

import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const PROVIDERS = {
  passkey: false,
  email: true,
  sms: false,
  siwe: true,
  siws: true,
  google: true,
  discord: true,
  github: true,
  twitter: false,
  oauth: [],
};

const STABILITY_WINDOW_MS = 5_500;
const SURFACES = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
] as const;

async function installManagedOriginProxy(
  page: Page,
  localBaseUrl: string,
): Promise<string> {
  const local = new URL(localBaseUrl);
  const managed = new URL(localBaseUrl);
  managed.hostname = "cloud.eliza.app";

  await page.route(`${managed.origin}/**`, async (route) => {
    const target = new URL(route.request().url());
    target.protocol = local.protocol;
    target.hostname = local.hostname;
    target.port = local.port;
    const response = await route.fetch({ url: target.toString() });
    await route.fulfill({ response });
  });
  await page.route("**/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PROVIDERS),
    });
  });

  return managed.origin;
}

for (const surface of SURFACES) {
  for (const entryPath of ["/", "/login?intent=launch"] as const) {
    test(`signed-out managed entry ${entryPath} settles on one login document (${surface.name})`, async ({
      page,
      baseURL,
    }, testInfo) => {
      if (!baseURL) throw new Error("Playwright baseURL is required");
      await page.setViewportSize(surface.viewport);
      const managedOrigin = await installManagedOriginProxy(page, baseURL);
      const documentRequests: string[] = [];
      const failures: string[] = [];
      const consoleMessages: Array<{ type: string; text: string }> = [];

      page.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        ) {
          documentRequests.push(request.url());
        }
      });
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("console", (message) => {
        consoleMessages.push({ type: message.type(), text: message.text() });
      });
      page.on("requestfailed", (request) => {
        failures.push(
          `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
        );
      });

      await page.goto(`${managedOrigin}${entryPath}`);
      const heading = page.getByRole("heading", { name: "Sign in to Eliza" });
      await expect(heading).toBeVisible();
      await expect(page.getByText("Taking you to Eliza sign in")).toHaveCount(
        0,
      );
      const stableHeading = await heading.elementHandle();
      if (!stableHeading) throw new Error("Login heading did not mount");
      await stableHeading.evaluate((element) => {
        element.setAttribute("data-login-stability-probe", "mounted");
      });

      // This spans the managed handoff fallback deadline. The former path
      // remounted after five seconds even when no bridgeable session existed.
      await page.waitForTimeout(STABILITY_WINDOW_MS);

      await expect(heading).toHaveAttribute(
        "data-login-stability-probe",
        "mounted",
      );
      expect(
        await stableHeading.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(new URL(page.url()).hostname).toBe("cloud.eliza.app");
      expect(new URL(page.url()).pathname).toBe("/login");
      expect(
        documentRequests.map((url) => new URL(url).hostname),
        "the signed-out path must never load an auth-bridge document",
      ).toEqual(["cloud.eliza.app"]);
      expect(failures).toEqual([]);

      if (process.env.E2E_RECORD === "1") {
        await page.screenshot({
          path: testInfo.outputPath(`${surface.name}-stable-login.png`),
          fullPage: true,
        });
        await writeFile(
          testInfo.outputPath(`${surface.name}-frontend-observations.json`),
          `${JSON.stringify(
            {
              head: process.env.GITHUB_SHA ?? "local-exact-head",
              entryPath,
              finalUrl: page.url(),
              documentRequests,
              failures,
              consoleMessages,
              stabilityWindowMs: STABILITY_WINDOW_MS,
              stableHeadingConnected: await stableHeading.evaluate(
                (element) => element.isConnected,
              ),
            },
            null,
            2,
          )}\n`,
        );
      }
    });
  }
}
