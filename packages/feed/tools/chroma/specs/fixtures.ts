/**
 * Chroma test fixtures for MetaMask wallet integration
 *
 * Uses @avalix/chroma to create browser contexts with the MetaMask
 * extension pre-loaded for E2E testing.
 *
 * @see https://github.com/avalix-labs/chroma
 */

import { createWalletTest, expect } from "@avalix/chroma";

/**
 * Extended test with MetaMask wallet fixtures
 *
 * Provides:
 * - wallets: Object with MetaMask wallet methods (importMnemonic, authorize, approveTx, etc.)
 * - page: Playwright Page with extension context attached
 * - walletContext: Persistent browser context with MetaMask extension loaded
 */
export const test = createWalletTest({
  wallets: [{ type: "metamask" }],
});

/**
 * Re-export common types from Playwright
 */
export type { BrowserContext, Page } from "@playwright/test";
export { expect };
