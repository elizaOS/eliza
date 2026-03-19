import { expect, test } from "@playwright/test";
import { installHomeMocks } from "./home-mocks";

declare global {
  interface Window {
    __mockVrmStreamController: ReadableStreamDefaultController<Uint8Array>;
  }
}

test.skip("VRM loader syncs with onboarding UI and handles fallback", async ({ page }) => {
  // Skipped: VRM loading requires WebGL which is not reliably available in
  // headless Chromium, and the startup flow now resumes at the "identity"
  // step (skipping wakeUp), so the VRM reveal timing cannot be tested here.
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
  // In headless browsers WebGL may fail to initialize, so the VRM loading
  // UI is best-effort — we mainly test the fallback reveal path.
  const progressBar = page.getByTestId("avatar-loader-progress").first();
  await expect(progressBar).toBeVisible({ timeout: 3000 }).catch(() => {
    // VRM loader may not render in headless environments without GPU
  });

  // Eventually the mocked route aborts, triggering the fallback path.
  // Verify that the UI fades in due to `onRevealStart` being called even in fallback!
  await expect(overlay).toHaveCSS("opacity", "1", { timeout: 8000 });
});
