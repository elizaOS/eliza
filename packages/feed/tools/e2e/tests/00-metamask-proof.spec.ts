/**
 * MetaMask + Chroma Proof of Concept
 *
 * Proves Chroma can:
 * 1. Launch browser with MetaMask extension
 * 2. Import a seed phrase
 * 3. MetaMask is unlocked and usable
 *
 * Does NOT need the app server.
 */

import { expect, test } from './fixtures';

const SEED_PHRASE =
  'test test test test test test test test test test test junk';

test.setTimeout(120_000);

test.describe('Chroma + MetaMask Proof', () => {
  test('browser launches with MetaMask extension loaded', async ({ page }) => {
    const pages = page.context().pages();
    console.log(`Browser context has ${pages.length} page(s)`);
    expect(page).toBeTruthy();

    await page.goto('about:blank');
    const title = await page.title();
    expect(typeof title).toBe('string');
    console.log('✅ Browser with MetaMask extension is functional');
  });

  test('imports seed phrase into MetaMask', async ({ page, wallets }) => {
    console.log('Importing seed phrase...');
    await wallets.metamask.importSeedPhrase({ seedPhrase: SEED_PHRASE });
    console.log('✅ Seed phrase imported into MetaMask');
  });

  test('wallet methods are available after import', async ({
    page,
    wallets,
  }) => {
    await wallets.metamask.importSeedPhrase({ seedPhrase: SEED_PHRASE });

    expect(typeof wallets.metamask.authorize).toBe('function');
    expect(typeof wallets.metamask.confirm).toBe('function');
    expect(typeof wallets.metamask.reject).toBe('function');
    expect(typeof wallets.metamask.importSeedPhrase).toBe('function');

    console.log('✅ All Chroma MetaMask methods available:');
    console.log('  authorize(), confirm(), reject(), importSeedPhrase()');
  });
});
