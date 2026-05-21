/**
 * Shared injected-Ethereum login helper for Playwright specs.
 *
 * Spawns a deterministic-key EOA in the page context, exposes a
 * full EIP-1193 `window.ethereum` provider (eth_requestAccounts /
 * eth_accounts / personal_sign), and signs Steward's SIWE challenge
 * the moment it lands. Real wallet round-trip — no localStorage shortcuts.
 *
 * Usage:
 *
 *   import { installInjectedEthereum, loginWithInjectedEthereum } from
 *     "./_helpers/injected-eth";
 *
 *   await installInjectedEthereum(page);
 *   await page.goto("/login");
 *   await loginWithInjectedEthereum(page);   // returns when /dashboard loaded
 */

import type { Page } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const DEFAULT_ACCOUNT_ADDRESS =
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * Install a working EIP-1193 provider on `window.ethereum` BEFORE the
 * application bundle loads. The provider signs personal_sign messages
 * with viem so SIWE challenges from Steward verify against the wallet
 * address that `eth_accounts` reports.
 */
export async function installInjectedEthereum(
  page: Page,
  privateKey: `0x${string}` = DEFAULT_PRIVATE_KEY,
): Promise<void> {
  const account = privateKeyToAccount(privateKey);

  await page.addInitScript(
    ({ pk, addr }) => {
      const sleep = (ms: number) =>
        new Promise<void>((r) => setTimeout(r, ms));
      const win = window as unknown as Record<string, unknown> & {
        __injectedEthSign?: (msg: string) => Promise<string>;
      };

      const provider = {
        isMetaMask: false,
        isInjectedTest: true,
        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            return [addr];
          }
          if (method === "eth_chainId") return "0x1";
          if (method === "net_version") return "1";
          if (method === "personal_sign") {
            const message = (params?.[0] as string) ?? "";
            win.__siweMessage = message;
            // Wait for the host page to publish a viem-backed signer.
            for (let i = 0; i < 50; i++) {
              if (typeof win.__injectedEthSign === "function") break;
              await sleep(20);
            }
            if (typeof win.__injectedEthSign !== "function") {
              throw new Error(
                "[injected-eth] host never published __injectedEthSign",
              );
            }
            return win.__injectedEthSign(message);
          }
          throw new Error(`[injected-eth] unsupported method ${method}`);
        },
        on: () => undefined,
        removeListener: () => undefined,
      };

      Object.defineProperty(window, "ethereum", {
        value: provider,
        writable: false,
        configurable: false,
      });
      // Some apps key off this for chain detection.
      win.PHANTOM_TEST_PRIVATE_KEY = pk;
      void pk;
    },
    { pk: privateKey, addr: account.address },
  );

  // Publish a viem-backed signer into the page context so personal_sign
  // round-trips real signatures.
  await page.exposeFunction("__publishSiweSig", () => {});
  await page.evaluate((pk: string) => {
    // The signer is installed once viem is reachable on the page; rather
    // than ship viem to the browser, the spec posts a signature back via
    // page.evaluate on demand. The helper signs via Node-side viem and
    // assigns the result through __injectedEthSign.
    (window as unknown as Record<string, unknown>).__injectedEthPK = pk;
  }, privateKey);
}

/**
 * Click the "Ethereum" button on /login and complete the SIWE handshake.
 * Resolves when the URL settles on /dashboard (or /auth/success).
 */
export async function loginWithInjectedEthereum(
  page: Page,
  privateKey: `0x${string}` = DEFAULT_PRIVATE_KEY,
): Promise<void> {
  const account = privateKeyToAccount(privateKey);
  // Hook the personal_sign callback BEFORE clicking so the inner
  // promise resolves the moment Steward publishes the challenge.
  await page.evaluate(
    ({ addr }) => {
      const win = window as unknown as {
        __injectedEthSign?: (msg: string) => Promise<string>;
        __injectedEthPK: string;
      };
      // We can't ship viem to the browser; instead, route the sign call
      // back to the test runner via window.postMessage and let the spec
      // sign with Node-side viem. The spec listens on the console and
      // posts the signature back into `window.__siweSignature`.
      win.__injectedEthSign = (msg: string) =>
        new Promise((resolve) => {
          console.log(`[injected-eth] PERSONAL_SIGN_REQUEST:${addr}:${msg}`);
          const interval = setInterval(() => {
            const sig = (
              window as unknown as Record<string, unknown>
            ).__siweSignature as string | undefined;
            if (sig) {
              clearInterval(interval);
              resolve(sig);
            }
          }, 30);
        });
    },
    { addr: account.address },
  );

  // Listen for the sign request, sign Node-side, and inject the result.
  page.on("console", async (msg) => {
    const text = msg.text();
    if (!text.startsWith("[injected-eth] PERSONAL_SIGN_REQUEST:")) return;
    const [, , , siweMessage] = text.split(":");
    const message = text.slice(
      "[injected-eth] PERSONAL_SIGN_REQUEST:".length +
        account.address.length +
        1,
    );
    void siweMessage;
    const signature = await account.signMessage({ message });
    await page.evaluate((sig: string) => {
      (window as unknown as Record<string, unknown>).__siweSignature = sig;
    }, signature);
  });

  await page.getByRole("button", { name: /^Ethereum$/i }).click();
  // Steward verifies, mints a token, and redirects.
  await page.waitForURL(/\/(dashboard|auth\/success)/, { timeout: 30_000 });
}
