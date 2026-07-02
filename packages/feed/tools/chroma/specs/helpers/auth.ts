import type { Page } from "@playwright/test";
import { installSynpressDevAuth } from "./dev-auth";

interface WalletMethods {
  authorize: () => Promise<void>;
  confirm: () => Promise<void>;
  reject: () => Promise<void>;
  importSeedPhrase: (options: { seedPhrase: string }) => Promise<void>;
}

export const DEFAULT_ANVIL_WALLET = {
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  privateKey:
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  seedPhrase: "test test test test test test test test test test test junk",
  password: "Tester@1234",
} as const;

function resolveBaseUrl(page: Page): string {
  const configured =
    process.env.PLAYWRIGHT_BASE_URL ||
    process.env.TEST_BASE_URL ||
    process.env.TEST_API_URL?.replace(/\/api$/, "");
  if (configured) return configured;

  const currentUrl = page.url();
  if (currentUrl && currentUrl !== "about:blank") {
    return new URL(currentUrl).origin;
  }

  return "http://127.0.0.1:3400";
}

export async function isAuthenticated(page: Page): Promise<boolean> {
  return page
    .locator('[data-testid="user-menu"]')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
}

export async function loginWithWallet(
  page: Page,
  wallets?: { metamask?: WalletMethods },
): Promise<void> {
  if (wallets?.metamask?.importSeedPhrase) {
    await wallets.metamask
      .importSeedPhrase({ seedPhrase: DEFAULT_ANVIL_WALLET.seedPhrase })
      .catch(() => {});
  }

  if (await isAuthenticated(page)) {
    return;
  }

  await installSynpressDevAuth(page, resolveBaseUrl(page));
}

export async function logout(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.localStorage.removeItem("feed-playwright-dev-auth");
    (window as Window & { __accessToken?: string | null }).__accessToken = null;
  });
  await page.context().clearCookies();
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
