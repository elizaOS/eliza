/**
 * Privy authentication helpers for chroma e2e tests.
 *
 * Handles wallet connection flow for E2E testing with Privy.
 * Works with both Synpress MetaMask fixtures and standard Playwright.
 *
 * @module testing/chroma/helpers/privy-auth
 */

import type { Page } from '@playwright/test';

/** Wallet methods provided by Chroma's wallets fixture */
interface WalletMethods {
  authorize: () => Promise<void>;
  confirm: () => Promise<void>;
  reject: () => Promise<void>;
  importSeedPhrase: (options: { seedPhrase: string }) => Promise<void>;
}

/**
 * Default Anvil test wallet (Account #0)
 * This wallet should be configured as admin in localnet
 */
export const DEFAULT_ANVIL_WALLET = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey:
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  seedPhrase: 'test test test test test test test test test test test junk',
  password: 'Tester@1234',
} as const;

/**
 * Waits for Privy SDK to be initialized and ready.
 */
export async function waitForPrivyReady(
  page: Page,
  timeout = 60000
): Promise<void> {
  const startTime = Date.now();

  // Wait for page to have interactive elements
  for (let i = 0; i < 30; i++) {
    const buttonCount = await page
      .locator('button')
      .count()
      .catch(() => 0);
    if (buttonCount > 0) break;
    await page.waitForTimeout(500);
  }

  // Check for Privy not configured warning
  const warningBanner = page
    .locator('[data-testid="privy-not-configured-warning"]')
    .first();
  const warningVisible = await warningBanner
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (warningVisible) {
    throw new Error(
      'Privy not configured: NEXT_PUBLIC_PRIVY_APP_ID not set during build.'
    );
  }

  // Wait for Privy UI elements to appear
  const privyIndicators = [
    'button:has-text("Log in")',
    'button:has-text("Connect Wallet")',
    '[data-testid="user-menu"]',
  ];

  const remainingTime = Math.max(timeout - (Date.now() - startTime), 10000);
  const checkInterval = 500;
  const maxAttempts = Math.floor(remainingTime / checkInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    for (const selector of privyIndicators) {
      const isVisible = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 100 })
        .catch(() => false);
      if (isVisible) return;
    }
    await page.waitForTimeout(checkInterval);
  }

  throw new Error(`Privy SDK failed to initialize within ${timeout}ms`);
}

/**
 * Checks if user is already authenticated.
 */
export async function isAuthenticated(page: Page): Promise<boolean> {
  return page
    .locator('[data-testid="user-menu"]')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
}

/**
 * Login with MetaMask wallet via Privy.
 *
 * @param page - Playwright page instance
 * @param wallets - Optional Chroma wallets object with metamask methods
 */
export async function loginWithWallet(
  page: Page,
  wallets?: { metamask?: WalletMethods }
): Promise<void> {
  // Import seed phrase into MetaMask if Chroma wallets provided
  if (wallets?.metamask?.importSeedPhrase) {
    try {
      await wallets.metamask.importSeedPhrase({
        seedPhrase: DEFAULT_ANVIL_WALLET.seedPhrase,
      });
    } catch {
      // Wallet may already be imported from a previous test
    }
  }

  await waitForPrivyReady(page);

  // Check if already logged in
  if (await isAuthenticated(page)) {
    return;
  }

  // Check if Privy modal is already open
  const privyModal = page
    .locator('[role="dialog"][aria-label*="log in" i]')
    .first();
  const modalOpen = await privyModal
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (!modalOpen) {
    // Click login button to open modal
    const loginButton = page
      .locator(
        'button:has-text("Log in"), button:has-text("Connect Wallet"), button:has-text("Sign in")'
      )
      .first();

    const loginVisible = await loginButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (loginVisible) {
      await loginButton.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(1500);
    }
  }

  // Look for "More options" to expand wallet choices
  const moreOptionsButton = page
    .locator('button:has-text("More option")')
    .first();
  if (await moreOptionsButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Use force click to bypass Next.js dev overlay interception
    await moreOptionsButton
      .click({ force: true, timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Try to select MetaMask connection option
  const walletSelectors = [
    'button:has-text("MetaMask")',
    'button:has-text("Continue with a wallet")',
    'button:has-text("Wallet")',
  ];

  let walletClicked = false;
  for (const selector of walletSelectors) {
    const walletButton = page.locator(selector).first();
    if (await walletButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await walletButton.click({ force: true, timeout: 5000 });
      walletClicked = true;
      await page.waitForTimeout(1000);
      break;
    }
  }

  // If Chroma wallets provided, auto-approve the MetaMask connection
  if (walletClicked && wallets?.metamask) {
    await wallets.metamask.authorize().catch(() => {
      // MetaMask popup may not appear if already connected
    });
    await page.waitForTimeout(2000);
  } else if (walletClicked) {
    // Wait for manual connection or timeout
    await page.waitForTimeout(3000);
  }

  // Close modal if still open
  await closePrivyModal(page);

  // Wait for authentication to complete
  await page.waitForTimeout(2000);
}

/**
 * Close Privy modal if open
 */
async function closePrivyModal(page: Page): Promise<void> {
  // First try Escape key (works for most modals)
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  // Then try clicking close button if still visible
  const closeButton = page
    .locator(
      'button[aria-label*="close" i], button:has-text("×"), svg.lucide-x'
    )
    .first();
  if (await closeButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeButton.click({ force: true, timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  // Click outside modal to close it
  await page.mouse.click(10, 10).catch(() => {});
  await page.waitForTimeout(300);
}

/**
 * Logout the current user
 */
export async function logout(page: Page): Promise<void> {
  const userMenu = page.locator('[data-testid="user-menu"]').first();
  if (!(await userMenu.isVisible({ timeout: 3000 }).catch(() => false))) {
    return; // Not logged in
  }

  await userMenu.click();
  await page.waitForTimeout(500);

  const logoutButton = page
    .locator(
      'button:has-text("Logout"), button:has-text("Log out"), button:has-text("Sign out")'
    )
    .first();

  if (await logoutButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await logoutButton.click();
    await page.waitForTimeout(2000);
  }
}

// Legacy exports for backward compatibility
export interface PrivyTestAccount {
  email: string;
  password?: string;
}

export function getPrivyTestAccount(): PrivyTestAccount {
  return { email: 'test@example.com' };
}

export function hasPrivyTestCredentials(): boolean {
  return true;
}

export function hasWalletCredentials(): boolean {
  return true;
}

export function getWalletConfig() {
  return {
    seedPhrase: DEFAULT_ANVIL_WALLET.seedPhrase,
    password: DEFAULT_ANVIL_WALLET.password,
  };
}

/**
 * @deprecated Use loginWithWallet instead
 */
export async function loginWithPrivyEmail(
  page: Page,
  _account: PrivyTestAccount
): Promise<void> {
  return loginWithWallet(page);
}
