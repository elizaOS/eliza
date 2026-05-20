/**
 * Chroma test fixtures for MetaMask wallet integration.
 *
 * Uses @avalix/chroma to create browser contexts with
 * the MetaMask extension pre-loaded for E2E testing.
 */

import { createWalletTest, expect } from '@avalix/chroma';

export const test = createWalletTest({
  wallets: [{ type: 'metamask' }],
});

export type { BrowserContext, Page } from '@playwright/test';
export { expect };
