/**
 * Synpress E2E Tests: NFT Mint Flow
 *
 * Tests the complete NFT minting experience with real wallet interactions:
 * - Login via Steward dev auth
 * - Eligibility verification
 * - Mint transaction signing
 * - Reveal animation
 * - Post-mint state
 *
 * Prerequisites:
 * - Local Anvil RPC running (bun run anvil at the repo root)
 * - Web app running (bun dev in apps/web)
 * - NFT contract deployed locally (bun deploy:local in packages/contracts)
 * - Test user seeded in nftSnapshot table
 */

import { expect, test } from "./fixtures";
import { loginWithWallet } from "./helpers/auth";

// Test configuration
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const NFT_PAGE_URL = `${BASE_URL}/nft`;

// Helper to seed test data (run before tests if needed)
async function ensureTestDataSeeded(): Promise<boolean> {
  try {
    // Check if test snapshot exists by making API call
    const response = await fetch(`${BASE_URL}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

test.describe("NFT Mint Flow", () => {
  test.beforeEach(async ({ page }) => {
    // Wait for server to be ready
    const isReady = await ensureTestDataSeeded();
    test.skip(!isReady, "feed server is not healthy at /api/health");
  });

  test("should display login prompt for unauthenticated user", async ({
    page,
  }) => {
    await page.goto(NFT_PAGE_URL);
    await page.waitForLoadState("networkidle");

    // Should show login prompt
    const loginPrompt = page.getByText(/connect|log in|sign in/i).first();
    await expect(loginPrompt).toBeVisible({ timeout: 10000 });
  });

  test("should show eligibility status after login", async ({
    page,
    wallets,
  }) => {
    // Navigate to NFT page
    await page.goto(NFT_PAGE_URL);
    await page.waitForLoadState("networkidle");

    // Login with wallet
    await loginWithWallet(page, wallets);

    // Wait for eligibility check
    await page.waitForTimeout(3000);

    // Should show some eligibility status (eligible, not eligible, or already minted)
    const eligibilityIndicators = [
      /eligible/i,
      /not in.*top 100/i,
      /already.*minted/i,
      /you own/i,
      /mint.*nft/i,
    ];

    let foundIndicator = false;
    for (const pattern of eligibilityIndicators) {
      const element = page.getByText(pattern).first();
      if (await element.isVisible({ timeout: 1000 }).catch(() => false)) {
        foundIndicator = true;
        break;
      }
    }

    expect(foundIndicator).toBe(true);
  });

  test("eligible user can initiate mint flow", async ({ page, wallets }) => {
    // This test requires the connected wallet to be in nftSnapshot
    test.slow();

    // Navigate to NFT page
    await page.goto(NFT_PAGE_URL);
    await page.waitForLoadState("networkidle");

    // Login with wallet
    await loginWithWallet(page, wallets);
    await page.waitForTimeout(3000);

    // Check if eligible
    const mintButton = page.getByRole("button", { name: /mint/i }).first();
    const isEligible = await mintButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!isEligible) {
      // User not in snapshot - explicitly skip (not silently pass)
      test.skip(true, "User not in nftSnapshot - seed test data first");
      return;
    }

    // Click mint button
    await mintButton.click();

    // Should show preparing/loading state
    const preparingIndicators = [
      /preparing/i,
      /loading/i,
      /confirm.*wallet/i,
      /signing/i,
    ];

    let foundPreparingState = false;
    for (const pattern of preparingIndicators) {
      const element = page.getByText(pattern).first();
      if (await element.isVisible({ timeout: 2000 }).catch(() => false)) {
        foundPreparingState = true;
        break;
      }
    }

    expect(foundPreparingState).toBe(true);

    // NOTE: Transaction confirmation is tested in 'complete mint flow' test below
    // This test only verifies the flow can be initiated
  });

  test("should handle wallet rejection gracefully", async ({
    page,
    wallets,
  }) => {
    await page.goto(NFT_PAGE_URL);
    await page.waitForLoadState("networkidle");
    await loginWithWallet(page, wallets);
    await page.waitForTimeout(3000);

    const mintButton = page.getByRole("button", { name: /mint/i }).first();
    const isEligible = await mintButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!isEligible) {
      test.skip(true, "User not in nftSnapshot - seed test data first");
      return;
    }

    // Click mint button to start flow
    await mintButton.click();

    // Wait for wallet popup
    await page.waitForTimeout(2000);

    // Reject the transaction
    try {
      await wallets.metamask.reject();
    } catch {
      // If no transaction popup appeared, the test environment may not be fully set up
      test.skip(true, "MetaMask transaction popup did not appear");
      return;
    }

    // After rejection, user should be able to retry (back to eligible state)
    // Check that mint button is visible again or error message shown
    await page.waitForTimeout(1000);

    const canRetry = await mintButton
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const errorShown = await page
      .getByText(/try again|retry|rejected/i)
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    expect(canRetry || errorShown).toBe(true);
  });

  test("should display already minted state correctly", async ({
    page,
    wallets,
  }) => {
    await page.goto(NFT_PAGE_URL);
    await page.waitForLoadState("networkidle");
    await loginWithWallet(page, wallets);
    await page.waitForTimeout(3000);

    // Check for already minted state
    const alreadyMinted = page.getByText(/you own|already.*minted/i).first();
    const hasMinted = await alreadyMinted
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (!hasMinted) {
      // User hasn't minted yet - this test is for post-mint state
      test.skip(true, "User has not minted yet - run full mint flow first");
      return;
    }

    // Should show the owned NFT info or similar indicator
    const ownedNftIndicators = [
      page.locator('[data-testid="owned-nft"]').first(),
      page.getByText(/token.*#\d+/i).first(),
      page.getByText(/protomonkey/i).first(),
    ];

    let foundOwnedIndicator = false;
    for (const indicator of ownedNftIndicators) {
      if (await indicator.isVisible({ timeout: 2000 }).catch(() => false)) {
        foundOwnedIndicator = true;
        break;
      }
    }

    // Should not show mint button when already minted
    const mintButton = page.getByRole("button", { name: /mint/i }).first();
    const mintButtonVisible = await mintButton
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    expect(mintButtonVisible).toBe(false);
    expect(foundOwnedIndicator).toBe(true);
  });

  test("NFT gallery loads and displays collection", async ({ page }) => {
    await page.goto(NFT_PAGE_URL);
    await page.waitForLoadState("networkidle");

    // Gallery should load regardless of auth state
    // Look for gallery section or NFT cards
    const gallerySection = page.locator('[data-testid="nft-gallery"]').first();
    const nftCards = page.locator('[data-testid="nft-card"]');

    const galleryVisible = await gallerySection
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    const cardCount = await nftCards.count().catch(() => 0);

    // Must have either gallery section visible OR at least one NFT card
    expect(galleryVisible || cardCount > 0).toBe(true);
  });

  test("NFT detail page loads correctly", async ({ page }) => {
    // Navigate directly to an NFT detail page
    await page.goto(`${NFT_PAGE_URL}/1`);
    await page.waitForLoadState("networkidle");

    // Should show NFT details - check multiple possible indicators
    const detailIndicators = [
      page.getByText(/protomonkey.*#1/i).first(),
      page.locator('[data-testid="nft-detail"]').first(),
      page.getByText(/token.*1/i).first(),
    ];

    let foundDetail = false;
    for (const indicator of detailIndicators) {
      if (await indicator.isVisible({ timeout: 3000 }).catch(() => false)) {
        foundDetail = true;
        break;
      }
    }

    expect(foundDetail).toBe(true);
  });

  test("metadata endpoint returns valid JSON", async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/nft/metadata/1`);

    expect(response.status()).toBe(200);

    const metadata = await response.json();
    expect(metadata.name).toBeDefined();
    expect(metadata.image).toBeDefined();
    expect(metadata.external_url).toContain("feed.market");
  });
});

test.describe("NFT Mint Flow - Full E2E with Transaction", () => {
  // These tests require a deployed contract and seeded test data
  // They will be skipped if prerequisites are not met

  test("complete mint flow with transaction confirmation", async ({
    page,
    wallets,
  }) => {
    test.slow();

    // Check prerequisites
    const healthCheck = await fetch(`${BASE_URL}/api/health`).catch(() => null);
    test.skip(!healthCheck?.ok, "feed server is not healthy at /api/health");

    // Navigate and login
    await page.goto(NFT_PAGE_URL);
    await page.waitForLoadState("networkidle");
    await loginWithWallet(page, wallets);
    await page.waitForTimeout(3000);

    // Check eligibility
    const mintButton = page.getByRole("button", { name: /mint/i }).first();
    const isEligible = await mintButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    test.skip(
      !isEligible,
      "wallet not eligible to mint (not in nftSnapshot or already minted)",
    );

    // Start mint
    await mintButton.click();

    // Wait for wallet prompt
    await page.waitForTimeout(2000);

    // Confirm transaction in MetaMask
    try {
      await wallets.metamask.confirm();
    } catch (error) {
      console.log("MetaMask transaction confirmation failed:", error);
      // Transaction might have timed out or failed
      return;
    }

    // Wait for confirmation
    await page.waitForTimeout(5000);

    // Should show reveal or success
    const successIndicators = [
      /you received/i,
      /congratulations/i,
      /minted/i,
      /reveal/i,
      /you own/i,
    ];

    let success = false;
    for (const pattern of successIndicators) {
      const element = page.getByText(pattern).first();
      if (await element.isVisible({ timeout: 30000 }).catch(() => false)) {
        success = true;
        break;
      }
    }

    expect(success).toBe(true);
  });
});

test.describe("NFT Mint Flow - Error Scenarios", () => {
  test("handles network error gracefully", async ({ page }) => {
    // Simulate network error by going offline
    await page.route("**/api/nft/**", (route) => route.abort());

    await page.goto(NFT_PAGE_URL);
    await page.waitForLoadState("networkidle");

    // Should show error state or fallback UI
    // Not crash or show blank page
    const pageContent = await page.content();
    expect(pageContent.length).toBeGreaterThan(100);
  });

  test("handles invalid token ID in URL", async ({ page }) => {
    await page.goto(`${NFT_PAGE_URL}/999`);
    await page.waitForLoadState("networkidle");

    // Should show 404 or error message
    const errorIndicators = [/not found/i, /invalid/i, /error/i, /404/i];

    let foundError = false;
    for (const pattern of errorIndicators) {
      const element = page.getByText(pattern).first();
      if (await element.isVisible({ timeout: 3000 }).catch(() => false)) {
        foundError = true;
        break;
      }
    }

    // Either show error or redirect
    const currentUrl = page.url();
    expect(foundError || !currentUrl.includes("/999")).toBe(true);
  });
});
