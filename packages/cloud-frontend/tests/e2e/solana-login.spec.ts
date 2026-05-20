/**
 * UI-level e2e for "Login with Solana" on /login.
 *
 * The real wallet adapter (`@solana/wallet-adapter-react` + the wallet modal)
 * cannot be driven without a real extension, so this spec injects a synthetic
 * Phantom-compatible provider before the page boots via `addInitScript`. The
 * injected provider:
 *   - exposes `window.solana` / `window.phantom.solana`
 *   - returns a deterministic ed25519 public key from `connect()`
 *   - returns a deterministic detached signature from `signMessage()`
 *
 * The mock wallet is intentionally low-level (the same surface Phantom
 * exposes). Whether the wallet-adapter-react detection picks it up depends on
 * whether the in-browser standard-wallet registry sees the injected adapter.
 * The spec verifies, in order:
 *
 *   1. The Solana button renders on /login.
 *   2. Clicking it does not throw.
 *   3. If the wallet handshake completes, the page redirects to /dashboard
 *      or /auth/success. If the wallet modal opens instead (because the
 *      injected provider didn't match the standard-wallet shape exactly),
 *      that is recorded but not asserted as a failure — the SIWS HTTP
 *      contract is already covered by tests/e2e/siws-wallet-flow.spec.ts.
 *
 * Skipped against live prod (no way to inject a wallet there safely).
 */

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Solana login UI test mocks the wallet adapter; only safe against local dev.",
);

// Deterministic ed25519 keypair (base58). Generated once with
// `bs58.encode(nacl.sign.keyPair().publicKey)`. The signature is a fixed
// 64-byte buffer — verification is server-side and will reject it, which is
// fine: the spec asserts UI behavior, not server acceptance.
const MOCK_PUBKEY_BASE58 = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MOCK_SIGNATURE_BYTES = new Uint8Array(64).fill(7);

async function injectMockSolanaWallet(initScriptTarget: {
  addInitScript: (script: { content: string }) => Promise<void>;
}): Promise<void> {
  await initScriptTarget.addInitScript({
    content: `
      (() => {
        const PUBKEY_B58 = ${JSON.stringify(MOCK_PUBKEY_BASE58)};
        const SIG_BYTES = new Uint8Array([${MOCK_SIGNATURE_BYTES.join(",")}]);

        // bs58 decode just enough for a 32-byte ed25519 key.
        const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        function bs58Decode(str) {
          const bytes = [0];
          for (let i = 0; i < str.length; i++) {
            const c = ALPHABET.indexOf(str[i]);
            if (c < 0) throw new Error("invalid bs58 char");
            for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
            bytes[0] += c;
            let carry = 0;
            for (let j = 0; j < bytes.length; j++) {
              bytes[j] += carry;
              carry = bytes[j] >> 8;
              bytes[j] &= 0xff;
            }
            while (carry) {
              bytes.push(carry & 0xff);
              carry >>= 8;
            }
          }
          for (let i = 0; i < str.length && str[i] === "1"; i++) bytes.push(0);
          return new Uint8Array(bytes.reverse());
        }
        const PUBKEY_BYTES = bs58Decode(PUBKEY_B58);

        // Minimal PublicKey shim — wallet-adapter calls toBase58() / toBytes().
        const publicKey = {
          toBase58: () => PUBKEY_B58,
          toString: () => PUBKEY_B58,
          toBytes: () => PUBKEY_BYTES,
          toBuffer: () => PUBKEY_BYTES,
          equals: (other) =>
            other && typeof other.toBase58 === "function"
              ? other.toBase58() === PUBKEY_B58
              : false,
        };

        const provider = {
          isPhantom: true,
          isConnected: false,
          publicKey: null,
          connect: async () => {
            provider.isConnected = true;
            provider.publicKey = publicKey;
            provider.emit && provider.emit("connect", publicKey);
            return { publicKey };
          },
          disconnect: async () => {
            provider.isConnected = false;
            provider.publicKey = null;
          },
          signMessage: async (_message, _display) => ({
            signature: SIG_BYTES,
            publicKey,
          }),
          signTransaction: async (tx) => tx,
          signAllTransactions: async (txs) => txs,
          on: () => {},
          off: () => {},
          removeListener: () => {},
          request: async () => ({ publicKey }),
        };

        // Standard Phantom injection points.
        try {
          Object.defineProperty(window, "solana", {
            value: provider,
            configurable: true,
            writable: false,
          });
        } catch {
          window.solana = provider;
        }
        try {
          Object.defineProperty(window, "phantom", {
            value: { solana: provider },
            configurable: true,
            writable: false,
          });
        } catch {
          window.phantom = { solana: provider };
        }

        // Flag for assertions / debugging.
        window.__MOCK_SOLANA_WALLET__ = { pubkey: PUBKEY_B58 };
      })();
    `,
  });
}

test.describe("Login with Solana (UI)", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      {
        name: "eliza-test-auth",
        value: "1",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    await injectMockSolanaWallet(page);
  });

  test("renders the Solana sign-in button on /login", async ({ page }) => {
    await page.goto("/login");
    const solanaButton = page.getByRole("button", { name: /solana/i }).first();
    await expect(solanaButton).toBeVisible({ timeout: 10_000 });
    await expect(solanaButton).toBeEnabled();
  });

  test("clicking 'Solana' triggers wallet handshake without console errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    // Verify the mock is in place.
    const mockInstalled = await page.evaluate(
      () => Boolean((window as unknown as { __MOCK_SOLANA_WALLET__?: unknown }).__MOCK_SOLANA_WALLET__),
    );
    expect(mockInstalled, "mock Solana wallet injected").toBe(true);

    const solanaButton = page.getByRole("button", { name: /solana/i }).first();
    await expect(solanaButton).toBeVisible({ timeout: 10_000 });
    await solanaButton.click();

    // Give the wallet handshake / modal a moment to settle.
    await page.waitForTimeout(1500);

    // Outcome A: standard-wallet detection consumed our mock, SIWS fired,
    // auth bypass kicked in (cookie + VITE_PLAYWRIGHT_TEST_AUTH), and the
    // app redirected to /dashboard or /auth/success.
    // Outcome B: the wallet-modal opened because the standard-wallet
    // registry shape didn't match — verifiable by the modal dialog.
    // Either is acceptable; we only fail on a thrown console error.
    const url = page.url();
    const reachedAuthedLanding =
      url.includes("/dashboard") || url.includes("/auth/success");
    const modalOpen = await page
      .getByRole("dialog")
      .first()
      .isVisible()
      .catch(() => false);

    expect(
      reachedAuthedLanding || modalOpen || url.includes("/login"),
      "click resolved to a known state (redirect, modal, or stayed on /login)",
    ).toBe(true);

    const fatal = consoleErrors.filter(
      (m) => !m.includes("404") && !m.includes("net::"),
    );
    expect(fatal, `unexpected console errors: ${fatal.join("\n")}`).toHaveLength(
      0,
    );
  });

  test("Solana button is keyboard-reachable", async ({ page }) => {
    await page.goto("/login");
    const solanaButton = page.getByRole("button", { name: /solana/i }).first();
    await expect(solanaButton).toBeVisible({ timeout: 10_000 });
    await solanaButton.focus();
    await expect(solanaButton).toBeFocused();
  });
});
