import { expect, test } from "@playwright/test";
import { installHomeMocks } from "./home-mocks";

declare global {
  interface Window {
    __mockVrmStreamController: ReadableStreamDefaultController<Uint8Array>;
  }
}

test("VRM loader syncs with onboarding UI and handles fallback", async ({ page }) => {
  await installHomeMocks(page, { onboardingComplete: false });
  
  // Intercept the VRM request to delay it so we can observe the loader, then fail it to test fallback.
  await page.route((url) => url.pathname.endsWith(".vrm") || url.pathname.includes("/api/avatar/vrm"), async (route) => {
    // Wait slightly more than the timeout to ensure the overlay assertion fires during the load.
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ status: 500, body: "Internal Server Error" });
  });

  // Load the app with the query flag to force VRM behavior during E2E
  await page.goto("/?test_force_vrm=1");

  // App is mounted. Onboarding UI should be hidden (opacity 0)
  // We locate it via its unique container class. 
  const overlay = page.getByTestId("onboarding-ui-overlay").first();
  await overlay.waitFor({ state: "attached" });
  // The element exists in the DOM, so evaluating opacity is safer.
  await expect(overlay).toHaveCSS("opacity", "0");
  
  // A loader should be visible while the VRM request is hanging.
  const progressBar = page.getByTestId("avatar-loader-progress").first();
  await expect(progressBar).toBeVisible();

  // Eventually the mocked route aborts, triggering the fallback path.
  // Verify that the UI fades in due to `onRevealStart` being called even in fallback!
  await expect(overlay).toHaveCSS("opacity", "1", { timeout: 3000 });
});
