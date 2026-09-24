/**
 * Exercises the real Cockpit renderer against the keyless fixture's disabled
 * PTY policy, including retry and close without a fabricated live session.
 */
import { expect, test } from "@playwright/test";
import {
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test("Cockpit renders and retries the disabled PTY policy without a session", async ({
  page,
}) => {
  const sessionRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/pty/sessions")) {
      sessionRequests.push(request.method());
    }
  });
  await seedAppStorage(page);
  await hideChatOverlay(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/cockpit");

  const launch = page.getByRole("button", {
    name: "Open Fast interactive terminal",
    exact: true,
  });
  const denial = page.getByTestId("cockpit-terminal-error");
  const waitForDenial = () =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/pty/sessions" &&
        response.request().method() === "POST",
    );
  const firstResponse = waitForDenial();
  await launch.click();
  expect((await firstResponse).status()).toBe(403);
  await expect(denial).toContainText("Interactive PTY sessions are disabled");
  await expect(page.locator(".xterm")).toHaveCount(0);

  const retryResponse = waitForDenial();
  await page.getByTestId("cockpit-terminal-retry").click();
  expect((await retryResponse).status()).toBe(403);
  await expect(denial).toBeVisible();
  await page.getByTestId("cockpit-terminal-close").click();
  await expect(page.getByTestId("cockpit-terminal-overlay")).toHaveCount(0);
  await expect(launch).toBeVisible();
  expect(sessionRequests).toEqual(["POST", "POST"]);
  expect(pageErrors).toEqual([]);
});
