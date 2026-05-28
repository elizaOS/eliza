/**
 * Playwright Authentication Setup
 *
 * This setup file handles authentication for E2E tests that require admin access.
 * It creates an authenticated state that can be reused across tests.
 *
 * Following Playwright 2025 best practices:
 * - Authenticate once in setup project
 * - Save authentication state to file
 * - Reuse state in all tests via storageState config
 *
 * @see https://playwright.dev/docs/auth
 */

import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test as setup } from "@playwright/test";
import { installPlaywrightDevAuth } from "./dev-auth";

const authFile = path.join(__dirname, "../../../.playwright/auth.json");
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL?.replace(/\/api$/, "") ||
  "http://127.0.0.1:3400";

/**
 * Authenticate with Privy and wait for successful login
 */
async function authenticateWithPrivy(
  page: Page,
  email: string,
  password: string | undefined,
) {
  // Navigate to home page with dev mode forced to ensure app loads
  // Wait for navigation to complete, including any redirects
  await page.goto("/?dev=true", { waitUntil: "domcontentloaded" });

  // Wait for any redirects to complete (page might redirect to /feed)
  try {
    await page.waitForURL("**/?dev=true**", { timeout: 5000 }).catch(() => {
      // If redirected, wait for the new URL to be ready
      return page.waitForLoadState("domcontentloaded");
    });
  } catch (_e) {
    // Continue if URL check times out - page might have redirected
    await page.waitForLoadState("domcontentloaded");
  }

  // Wait for React to hydrate before checking for "Coming Soon"
  // Give the page time to initialize and run useEffect hooks
  await page.waitForTimeout(2000);

  // Check for Coming Soon state after React has hydrated
  const comingSoon = await page
    .locator("text=Coming Soon")
    .isVisible()
    .catch(() => false);
  if (comingSoon) {
    console.log(
      '❌ Page is showing "Coming Soon" - localhost detection failed or dev mode not working',
    );
    // Try to force reload with dev parameter
    console.log("🔄 Reloading page with dev=true...");
    await page.goto("/?dev=true", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000); // Wait for React hydration
    if (
      await page
        .locator("text=Coming Soon")
        .isVisible()
        .catch(() => false)
    ) {
      throw new Error(
        'Page is showing "Coming Soon" preventing login flow - dev mode may not be working in CI',
      );
    }
  }

  // Wait for page to load completely (networkidle is better for SPAs than domcontentloaded)
  // In CI, networkidle can be flaky if there are background requests
  try {
    await page.waitForLoadState("networkidle", { timeout: 30000 });
  } catch (_e) {
    console.log("⚠️  Network idle timed out, continuing...");
  }

  // First, check if the "Privy not configured" warning banner is visible
  // This indicates NEXT_PUBLIC_PRIVY_APP_ID was not set at build time
  const warningBanner = page.locator(
    '[data-testid="privy-not-configured-warning"]',
  );
  const warningVisible = await warningBanner
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (warningVisible) {
    console.log(
      '❌ CRITICAL: "Privy not configured" warning banner is visible!',
    );
    console.log(
      "   This means NEXT_PUBLIC_PRIVY_APP_ID was NOT set when the app was built.",
    );
    console.log("");
    console.log("   To fix this:");
    console.log(
      "   1. Verify the GitHub secret NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) is set",
    );
    console.log(
      '   2. Check the "Build production" step logs for the secret availability check',
    );
    console.log(
      '   3. The secret should show as "SET (X chars, starts with cl...)"',
    );
    throw new Error(
      "Privy not configured: NEXT_PUBLIC_PRIVY_APP_ID was not set at build time",
    );
  }

  // Wait for Privy SDK to be loaded - with extended timeout for CI
  try {
    type WindowWithPrivy = Window & {
      privy?: unknown;
    };
    await page.waitForFunction(
      () => {
        const win = window as WindowWithPrivy;
        return (
          win.privy !== undefined ||
          document.querySelector('script[src*="privy"]') !== null ||
          document.querySelector("[data-privy]") !== null
        );
      },
      { timeout: 45000 },
    );
    console.log("✅ Privy SDK detected");
  } catch (_e) {
    console.log("❌ Privy SDK check timed out");

    // Diagnostic code - wrap in try-catch to handle case where page is already closed
    // This can happen if the test timeout is exceeded during the waitForFunction
    let diagnosticInfo = {
      hasPrivyScript: false,
      hasPrivyRoot: false,
      hasWarningBanner: false,
    };
    let content = "";
    let scripts: string[] = [];

    try {
      // Check if page is still usable before trying to get diagnostics
      if (!page.isClosed()) {
        diagnosticInfo = await page
          .evaluate(() => {
            const hasPrivyScript =
              document.querySelector('script[src*="privy"]') !== null;
            const hasPrivyRoot =
              document.querySelector("[data-privy-root]") !== null;
            const hasWarningBanner =
              document.querySelector(
                '[data-testid="privy-not-configured-warning"]',
              ) !== null;
            return { hasPrivyScript, hasPrivyRoot, hasWarningBanner };
          })
          .catch(() => ({
            hasPrivyScript: false,
            hasPrivyRoot: false,
            hasWarningBanner: false,
          }));

        content = await page
          .content()
          .catch(() => "(page content unavailable)");
        scripts = await page
          .evaluate(() => {
            const scriptTags = Array.from(document.querySelectorAll("script"));
            return scriptTags
              .map((s) => s.src)
              .filter((src) => src)
              .slice(0, 10);
          })
          .catch(() => []);
      } else {
        console.log(
          "⚠️  Page is already closed - cannot get detailed diagnostics",
        );
      }
    } catch (diagError) {
      console.log(
        "⚠️  Could not gather diagnostics (page may be closed):",
        diagError instanceof Error ? diagError.message : String(diagError),
      );
    }

    console.log("📋 Privy diagnostics:");
    console.log(
      `   - Privy script tag: ${diagnosticInfo.hasPrivyScript ? "FOUND" : "NOT FOUND"}`,
    );
    console.log(
      `   - Privy root element: ${diagnosticInfo.hasPrivyRoot ? "FOUND" : "NOT FOUND"}`,
    );
    console.log(
      `   - Warning banner: ${diagnosticInfo.hasWarningBanner ? "VISIBLE (Privy not configured!)" : "not visible"}`,
    );
    if (content) {
      console.log(`📄 Page content preview: ${content.substring(0, 500)}...`);
    }
    if (scripts.length > 0) {
      console.log("📜 Script tags found:", scripts);
    }

    if (!diagnosticInfo.hasPrivyScript && !diagnosticInfo.hasPrivyRoot) {
      throw new Error(
        "Privy SDK failed to load - NEXT_PUBLIC_PRIVY_APP_ID may not have been set at build time.\n" +
          'Check the CI "Build production" step logs for the secret availability check.',
      );
    }
    throw new Error(
      "Privy SDK failed to load - cannot proceed with authentication",
    );
  }

  // Wait for the login button to be enabled (not disabled)
  // This ensures Privy is ready and the button is clickable
  // The button is disabled when Privy's `ready` state is false
  console.log("⏳ Waiting for login button to be enabled (Privy ready)...");
  try {
    await page.waitForFunction(
      () => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const loginBtn = buttons.find((btn) => {
          const text = btn.textContent?.toLowerCase() || "";
          return (
            text.includes("connect wallet") ||
            text.includes("connect") ||
            text.includes("log in") ||
            text.includes("login") ||
            text.includes("sign in")
          );
        });

        // Button exists and is NOT disabled (meaning Privy is ready)
        return (
          loginBtn !== undefined && !(loginBtn as HTMLButtonElement).disabled
        );
      },
      { timeout: 45000 },
    );
    console.log("✅ Login button is enabled (Privy ready)");
  } catch (_e) {
    console.log("❌ Login button enabled check timed out");
    // Log what buttons we found
    const buttons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("button"))
        .map((b) => ({
          text: b.textContent?.trim(),
          disabled: b.disabled,
        }))
        .slice(0, 10);
    });
    console.log("Buttons found:", buttons);
    throw new Error(
      "Login button never became enabled - Privy might not be initialized correctly",
    );
  }

  // Give React time to hydrate and render components
  await page.waitForTimeout(2000);

  // Check current URL - page might have redirected to /feed
  const currentUrl = page.url();
  console.log(`📍 Current URL: ${currentUrl}`);

  // Check for authentication indicators first
  const isAlreadyLoggedIn = await page
    .evaluate(() => {
      const hasUserMenu =
        document.querySelector('[data-testid="user-menu"]') !== null;
      const hasProfile = Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent?.includes("Profile"),
      );
      const hasToken = window.localStorage.getItem("privy:token") !== null;
      return (hasUserMenu || hasProfile) && hasToken;
    })
    .catch(() => false);

  if (isAlreadyLoggedIn) {
    console.log("✅ Already authenticated - skipping login flow");
    return;
  }

  // If we're on /feed, we're good - the GlobalLoginModal should be available or we can find a login button
  if (currentUrl.includes("/feed") && !isAlreadyLoggedIn) {
    console.log("ℹ️  Redirected to /feed - continuing login flow from here");
  }

  // Check for Coming Soon state which would prevent login
  const comingSoonAgain = await page
    .locator("text=Coming Soon")
    .isVisible()
    .catch(() => false);
  if (comingSoonAgain) {
    console.log(
      '❌ Page is showing "Coming Soon" - localhost detection failed',
    );
    throw new Error('Page is showing "Coming Soon" preventing login flow');
  }

  // Look for login button or modal input
  // Use comprehensive selectors matching chroma helper
  const emailInput = page
    .locator('input[type="email"], input[name="email"]')
    .first();

  // Check if modal is ALREADY open
  let isLoginModalOpen = await emailInput
    .isVisible({ timeout: 2000 })
    .catch(() => false);
  console.log(`ℹ️ Email input visible initially: ${isLoginModalOpen}`);

  if (!isLoginModalOpen) {
    // Find login button - wait for it to be enabled (not disabled)
    // This ensures Privy is ready before we try to click
    console.log("🔍 Looking for enabled login button...");

    const loginButton = page
      .locator(
        'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button:has-text("Connect Wallet"), button:has-text("Connect"), [data-testid="privy-login"]',
      )
      .first();

    // Wait for button to be visible AND enabled
    // The button is disabled when Privy's `ready` state is false
    try {
      await expect(loginButton).toBeVisible({ timeout: 15000 });
      console.log("✅ Login button is visible");

      // Wait for button to be enabled (Privy ready)
      await page
        .waitForFunction(
          () => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const btn = buttons.find((b) => {
              const text = b.textContent?.toLowerCase() || "";
              return (
                text.includes("connect wallet") ||
                text.includes("connect") ||
                text.includes("log in") ||
                text.includes("login") ||
                text.includes("sign in")
              );
            });
            return btn !== null && !(btn as HTMLButtonElement).disabled;
          },
          { timeout: 15000 },
        )
        .catch(() => {
          console.log(
            "⚠️  Button enabled check timed out, will try clicking anyway",
          );
        });

      console.log("🖱️ Clicking login button...");
      // Now click the button - it should be enabled
      await loginButton.click({ timeout: 10000 });
      await page.waitForTimeout(2000); // Wait for modal to open

      // Re-check email input after click
      isLoginModalOpen = await emailInput
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      console.log(`ℹ️ Email input visible after click: ${isLoginModalOpen}`);
    } catch (e) {
      console.log("⚠️  Login button click failed, trying force click:", e);

      // Fallback: Try force click if normal click failed
      try {
        const isVisible = await loginButton
          .isVisible({ timeout: 5000 })
          .catch(() => false);
        if (isVisible) {
          await loginButton.click({ timeout: 10000, force: true });
          await page.waitForTimeout(2000);

          // Re-check email input after force click
          isLoginModalOpen = await emailInput
            .isVisible({ timeout: 5000 })
            .catch(() => false);
          console.log(
            `ℹ️ Email input visible after force click: ${isLoginModalOpen}`,
          );
        }
      } catch (forceError) {
        console.log("⚠️  Force click also failed:", forceError);
        // Re-check in case modal opened despite error
        isLoginModalOpen = await emailInput
          .isVisible({ timeout: 2000 })
          .catch(() => false);
      }
    }
  }

  if (!isLoginModalOpen) {
    // One last check if we missed the logged-in state
    const loggedInNow = await page
      .evaluate(() => {
        const hasUserMenu =
          document.querySelector('[data-testid="user-menu"]') !== null;
        return hasUserMenu;
      })
      .catch(() => false);

    if (loggedInNow) {
      console.log("✅ Logged in detected late");
      return;
    }

    // Additional debugging - check for Privy elements
    const privyElements = await page
      .evaluate(() => {
        const privyModal = document.querySelector(
          '[data-privy-modal], [class*="privy"], [id*="privy"]',
        );
        const allButtons = Array.from(document.querySelectorAll("button")).map(
          (b) => ({
            text: b.textContent?.trim(),
            visible: b.offsetParent !== null,
            enabled: !b.disabled,
          }),
        );
        return {
          hasPrivyModal: privyModal !== null,
          buttons: allButtons.slice(0, 10),
        };
      })
      .catch(() => ({ hasPrivyModal: false, buttons: [] }));

    // Debugging output
    const title = await page.title();
    const content = await page.content();
    console.log(`❌ Debug - Page Title: ${title}`);
    console.log(`❌ Debug - Page Content Start: ${content.substring(0, 200)}`);
    console.log(`❌ Debug - Privy modal found: ${privyElements.hasPrivyModal}`);
    console.log(
      "❌ Debug - First 10 buttons:",
      JSON.stringify(privyElements.buttons, null, 2),
    );

    // On localhost, app should auto-open modal. If not, something is wrong.
    throw new Error("Could not find login button or open login modal on page");
  }

  // Fill in email
  console.log(`⌨️ Filling email: ${email}`);
  await emailInput.fill(email);
  await page.waitForTimeout(500);

  // Find the modal context from the email input to ensure we target the button INSIDE the modal
  const modalContext = emailInput.locator(
    'xpath=ancestor::*[contains(@class, "Dialog") or @role="dialog"][1]',
  );

  let submitButton;
  if (await modalContext.isVisible().catch(() => false)) {
    // Look for submit button inside the modal
    submitButton = modalContext.locator('button[type="submit"]').first();
    if (!(await submitButton.isVisible().catch(() => false))) {
      submitButton = modalContext
        .locator("button")
        .filter({ hasText: /Continue|Log in|Submit/i })
        .first();
    }
  } else {
    // Fallback: look for any visible submit button
    submitButton = page.locator('button[type="submit"]').first();
  }

  if (await submitButton.isVisible().catch(() => false)) {
    console.log("🖱️ Clicking submit button");
    await submitButton.click();
  } else {
    console.log("⚠️  Submit button not found in modal, trying fallback");
    // Fallback: try to find Continue button
    await page.locator('button:has-text("Continue")').first().click();
  }

  await page.waitForTimeout(2000);

  // If password is required, fill it in
  if (password) {
    const passwordInput = page.locator('input[type="password"]').first();
    const passwordVisible = await passwordInput
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (passwordVisible) {
      console.log("⌨️ Filling password");
      await passwordInput.fill(password);
      await page.waitForTimeout(500);

      const submitButton = page.locator('button[type="submit"]').first();
      await submitButton.click();
      await page.waitForTimeout(2000);
    }
  }

  // Check for OTP screen (if required)
  const otpText = page.getByText("Enter confirmation code").first();
  const otpInput = page
    .locator(
      'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[data-privy-otp-input]',
    )
    .first();

  // Increase timeout for OTP detection - emails can be slow
  const isOtpScreen =
    (await otpText.isVisible({ timeout: 10000 }).catch(() => false)) ||
    (await otpInput.isVisible({ timeout: 5000 }).catch(() => false));

  if (isOtpScreen) {
    console.log("ℹ️ OTP screen detected");

    // Try to get OTP from environment (CI/CD or .env)
    const otp = process.env.PRIVY_TEST_OTP;

    if (otp) {
      console.log(`⌨️ Filling OTP from environment: ${otp}`);
      // Privy often uses 6 separate inputs or one input.
      // Best strategy is to focus the input and type the code

      if (await otpInput.isVisible()) {
        await otpInput.click(); // Focus
        await page.waitForTimeout(100);
        await page.keyboard.type(otp);
      } else {
        // Try typing blindly if input is hidden/custom
        await page.keyboard.type(otp);
      }
      await page.waitForTimeout(1000);

      // Click verify if button exists (sometimes auto-submits)
      const verifyButton = page
        .locator('button:has-text("Verify"), button[type="submit"]')
        .first();
      if (await verifyButton.isVisible()) {
        await verifyButton.click();
      }
      await page.waitForTimeout(2000);
    } else {
      console.log(
        "❌ OTP required but PRIVY_TEST_OTP not found in environment",
      );
      // Note: OTP codes are typically time-sensitive and can't be automated easily without a fixed test secret
      throw new Error(
        "Authentication failed: OTP screen detected. Please use a test account that does not require OTP or provide PRIVY_TEST_OTP if applicable.",
      );
    }
  }

  // Wait for successful authentication using Playwright's recommended approach
  // Use expect().toBeVisible() which is more reliable than waitForFunction
  // This matches Playwright best practices for verification
  try {
    await expect(page.locator('[data-testid="user-menu"]')).toBeVisible({
      timeout: 30000,
    });
    console.log("✅ Authentication successful - user menu visible");
  } catch (_error) {
    // Fallback: check for access token in localStorage as secondary verification
    type WindowWithAccessToken = Window & {
      __accessToken?: unknown;
    };
    const hasToken = await page.evaluate(() => {
      const win = window as WindowWithAccessToken;
      return (
        window.localStorage.getItem("privy:token") !== null ||
        win.__accessToken !== undefined
      );
    });

    if (hasToken) {
      console.log(
        "✅ Authentication successful - token found (user menu may not be visible yet)",
      );
    } else {
      throw new Error(
        "Authentication verification failed: no user menu and no token found",
      );
    }
  }
}

/**
 * Setup: Authenticate as admin
 *
 * This runs once before all tests in projects that depend on it.
 * The authenticated state is saved to .playwright/auth.json and reused.
 */
setup("authenticate as admin", async ({ page }) => {
  setup.setTimeout(180000); // Increase timeout to 180s for auth flow in CI (includes Privy SDK load + diagnostics)
  const email = process.env.PRIVY_TEST_EMAIL?.trim();
  const password = process.env.PRIVY_TEST_PASSWORD;

  console.log(`🌐 Base URL: ${baseURL}`);
  try {
    const response = await page.request.get(`${baseURL}/api/health`);
    if (!response.ok()) {
      throw new Error(`Server health check failed: ${response.status()}`);
    }
    console.log("✅ Server health check passed");
  } catch (error) {
    console.error("❌ Server health check failed:", error);
    throw new Error(
      `Server is not responding at ${baseURL}. Please ensure the server is running.`,
    );
  }

  try {
    if (email) {
      console.log(`🔐 Authenticating with email: ${email}`);
      await authenticateWithPrivy(page, email, password);
      await page.waitForTimeout(2000);
    } else {
      console.log("🔐 Using local development auth fallback for Playwright");
      await installPlaywrightDevAuth(page, baseURL);
    }

    await page.goto("/admin?dev=true", { waitUntil: "domcontentloaded" });

    // Check that we're not redirected away (which would happen if not authenticated)
    // Use waitForURL for more reliable verification (Playwright best practice)
    try {
      await page.waitForURL("**/admin**", { timeout: 10000 });
      console.log("✅ Admin page URL verified");
    } catch {
      const currentUrl = page.url();
      if (!currentUrl.includes("/admin")) {
        throw new Error(
          `Authentication failed: redirected to ${currentUrl} instead of /admin`,
        );
      }
    }

    // The admin dashboard does background polling, so networkidle is not a
    // reliable readiness signal here. Wait for the admin stats bootstrap call
    // or the heading itself instead.
    try {
      await page
        .waitForResponse(
          (response) =>
            response.url().includes("/api/admin/stats") &&
            response.request().method() === "GET" &&
            response.ok(),
          { timeout: 15000 },
        )
        .catch(() => null);
      await expect(
        page.getByRole("heading", { name: "Admin Dashboard" }),
      ).toBeVisible({ timeout: 15000 });
      console.log("✅ Admin dashboard loaded");
    } catch (error) {
      // If heading doesn't appear, check if we were redirected or if page is still loading
      const currentUrl = page.url();
      if (!currentUrl.includes("/admin")) {
        throw new Error(
          `Admin access verification failed: redirected to ${currentUrl} instead of /admin`,
        );
      }

      // Check if we see "Access Denied" which means auth worked but user isn't admin
      const accessDenied = await page
        .getByText("Access Denied")
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      if (accessDenied) {
        // On localhost, any authenticated user should have access
        const isLocalhost =
          currentUrl.includes("localhost") || currentUrl.includes("127.0.0.1");
        if (isLocalhost) {
          throw new Error(
            "Admin access denied on localhost - this should not happen for authenticated users",
          );
        }
        throw new Error(
          "Admin access denied - user may not have admin privileges",
        );
      }

      // If we're still on /admin but heading isn't visible, page might still be loading
      // Wait a bit more and check again
      await page.waitForTimeout(2000);
      const headingVisible = await page
        .getByRole("heading", { name: "Admin Dashboard" })
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      if (!headingVisible) {
        throw new Error(
          `Admin dashboard heading not found after extended wait. Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      console.log("✅ Admin dashboard loaded (after extended wait)");
    }

    console.log("✅ Admin access verified");

    // Save authenticated state
    await page.context().storageState({ path: authFile });
    console.log(`💾 Authentication state saved to ${authFile}`);
  } catch (error) {
    console.error("❌ Authentication setup failed:", error);

    // Take a screenshot for debugging
    await page.screenshot({
      path: ".playwright/auth-failure.png",
      fullPage: true,
    });
    console.log("📸 Screenshot saved to .playwright/auth-failure.png");

    throw error;
  }
});
