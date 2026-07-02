/**
 * Wallet authentication helpers for E2E tests.
 * Uses Chroma's MetaMask wallet for auth via Privy.
 */

import type { Page } from "@playwright/test";
import { SEED_PHRASE } from "./test-data";

/**
 * Structural subset of @avalix/chroma's configured MetaMask wallet that this
 * helper actually uses. The real chroma API is { extensionId, type, unlock,
 * approve, reject, importSeedPhrase } — there is no authorize()/confirm().
 */
interface ChromaWallets {
  metamask: {
    approve: () => Promise<void>;
    reject: () => Promise<void>;
    importSeedPhrase: (opts: { seedPhrase: string }) => Promise<void>;
  };
}

/**
 * Import seed phrase into MetaMask via Chroma, then authenticate via Privy.
 */
export async function loginWithWallet(
  page: Page,
  wallets?: ChromaWallets,
): Promise<void> {
  // Import seed phrase if Chroma wallets available
  if (wallets?.metamask) {
    try {
      await wallets.metamask.importSeedPhrase({ seedPhrase: SEED_PHRASE });
    } catch {
      // Already imported in this context
    }
  }

  // Wait for page to have interactive elements
  for (let i = 0; i < 30; i++) {
    if (
      (await page
        .locator("button")
        .count()
        .catch(() => 0)) > 0
    )
      break;
    await page.waitForTimeout(500);
  }

  // Check if already logged in
  if (
    await page
      .locator('[data-testid="user-menu"]')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false)
  ) {
    return;
  }

  // Click login button
  const loginButton = page
    .locator(
      'button:has-text("Log in"), button:has-text("Connect Wallet"), button:has-text("Sign in")',
    )
    .first();
  if (await loginButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await loginButton.click({ force: true, timeout: 5000 });
    await page.waitForTimeout(1500);
  }

  // Expand "More options" if needed
  const moreOptions = page.locator('button:has-text("More option")').first();
  if (await moreOptions.isVisible({ timeout: 3000 }).catch(() => false)) {
    await moreOptions.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Select MetaMask
  const walletSelectors = [
    'button:has-text("MetaMask")',
    'button:has-text("Continue with a wallet")',
    'button:has-text("Wallet")',
  ];
  let walletClicked = false;
  for (const sel of walletSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click({ force: true, timeout: 5000 });
      walletClicked = true;
      await page.waitForTimeout(1000);
      break;
    }
  }

  // Approve the connection prompt via Chroma. The catch is intentional:
  // MetaMask raises no prompt when the site is already connected.
  if (walletClicked && wallets?.metamask) {
    await wallets.metamask.approve().catch(() => {});
    await page.waitForTimeout(2000);
  } else if (walletClicked) {
    await page.waitForTimeout(3000);
  }

  // Close modal if still open
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  await page.mouse.click(10, 10).catch(() => {});
  await page.waitForTimeout(2000);
}

export async function isAuthenticated(page: Page): Promise<boolean> {
  return page
    .locator('[data-testid="user-menu"]')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
}
