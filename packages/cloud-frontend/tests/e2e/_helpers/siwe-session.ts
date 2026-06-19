// Reusable injected-ethereum login helper for e2e specs that need an
// authenticated dashboard session. Extracted from `siwe-flow.spec.ts`
// (which still owns the end-to-end happy-path assertions).
//
// Usage:
//
//   import { loginWithInjectedEthereum } from "./_helpers/siwe-session";
//
//   test("dashboard apps surface renders", async ({ page, context }) => {
//     const { address } = await loginWithInjectedEthereum(page, context);
//     await page.goto("/dashboard/apps");
//     await expect(page.getByRole("heading", { name: /apps/i })).toBeVisible();
//   });
//
// The helper:
//   1. Mocks /auth/nonce + /auth/verify (path-suffix match).
//   2. Injects a fake EIP-1193 window.ethereum that signs via a viem key.
//   3. Clicks the EVM login button on /login.
//   4. Waits for the verify mock to fire, leaving the session token
//      installed in localStorage exactly as the production bundle would.
//
// Returns the generated address + private key so callers that need to
// recover signatures can do so.

import type { BrowserContext, Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface SiweSession {
  address: `0x${string}`;
  privateKey: `0x${string}`;
  nonce: string;
}

export async function loginWithInjectedEthereum(
  page: Page,
  context: BrowserContext,
): Promise<SiweSession> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const nonce = `nonce_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  await context.route(
    (url) => url.pathname.endsWith("/auth/nonce"),
    (route) =>
      route.fulfill({
        json: { nonce },
        headers: { "content-type": "application/json" },
      }),
  );

  await context.route(
    (url) => url.pathname.endsWith("/auth/verify"),
    (route) => {
      const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = base64url(
        JSON.stringify({
          sub: account.address.toLowerCase(),
          userId: account.address.toLowerCase(),
          address: account.address,
          email: "",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      );
      const fakeSig = base64url("test-signature");
      const token = `${header}.${payload}.${fakeSig}`;
      return route.fulfill({
        json: {
          token,
          refreshToken: "refresh_test",
          expiresIn: 3600,
          address: account.address,
          walletChain: "ethereum",
          userId: account.address.toLowerCase(),
        },
        headers: { "content-type": "application/json" },
      });
    },
  );

  await context.addInitScript(
    ({ addr }) => {
      const provider = {
        async request({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            return [addr];
          }
          if (method === "eth_chainId") return "0x1";
          if (method === "personal_sign") {
            const hex = (params?.[0] as string) ?? "";
            const bytes = new Uint8Array(
              (hex.startsWith("0x") ? hex.slice(2) : hex)
                .match(/.{2}/g)
                ?.map((b) => parseInt(b, 16)) ?? [],
            );
            const message = new TextDecoder().decode(bytes);
            const sigPromise = new Promise<string>((resolve) => {
              (
                window as unknown as Record<
                  string,
                  (msg: string) => Promise<string>
                >
              ).__siweResolve = async (sig: string) => {
                resolve(sig);
                return sig;
              };
            });
            (window as unknown as Record<string, string>).__siweMessage =
              message;
            return await sigPromise;
          }
          throw new Error(`Unimplemented EIP-1193 method: ${method}`);
        },
        on: () => undefined,
        removeListener: () => undefined,
        isMetaMask: false,
      };
      (window as unknown as Record<string, unknown>).ethereum = provider;
    },
    { addr: account.address },
  );

  await page.goto("/login");
  await page.getByRole("button", { name: /^EVM$/i }).click();

  const messageStr = (await page
    .waitForFunction(
      () =>
        (window as unknown as Record<string, string | undefined>).__siweMessage,
      null,
      { timeout: 10_000 },
    )
    .then((h) => h.jsonValue())) as string;

  const signature = await account.signMessage({ message: messageStr });

  await page.evaluate(
    (sig) =>
      (
        window as unknown as Record<string, (s: string) => Promise<string>>
      ).__siweResolve(sig),
    signature,
  );

  // Wait for the post-verify navigation to settle so callers can assume
  // the auth token is installed before they continue.
  await page.waitForURL(/\/dashboard|\/auth\/success/, { timeout: 10_000 });

  return {
    address: account.address,
    privateKey,
    nonce,
  };
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
