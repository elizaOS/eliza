// SIWE programmatic-signing e2e.
//
// We can't `import('@stwd/sdk')` inside a page.evaluate (the browser can't
// resolve bare specifiers), so instead we inject a fake EIP-1193 provider
// onto window.ethereum BEFORE the bundle loads. When the user clicks the
// real "Ethereum" sign-in button in the login UI, the wallet-buttons.tsx
// path calls `provider.request({ method: "personal_sign", ... })` — our
// injected provider answers with a viem signature from an ephemeral key.
//
// The Steward /auth/nonce + /auth/verify endpoints are mocked. We assert
// that the bundled SDK posted a real EIP-4361 message with our nonce and
// that the signature recovers to the generated address.
//
// Skipped in live-prod mode.

import { expect, test } from "@playwright/test";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "SIWE flow uses local mocks; skipped in live-prod mode",
);

interface VerifyCapture {
  message?: string;
  signature?: string;
}

test("siwe: real button → real SDK → /auth/verify carries valid signature", async ({
  page,
  context,
}) => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const nonce = `nonce_${Date.now().toString(36)}`;
  const captured: VerifyCapture = {};

  // 1. Mock /auth/nonce + /auth/verify. We don't know the exact baseUrl the
  //    bundle resolved (could be same-origin /api/steward, could be an
  //    absolute steward URL), so we match on path suffix.
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
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      captured.message = body.message;
      captured.signature = body.signature;

      // Synthesize a JWT shape the bundle's storeAndReturn can decode.
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

  // 2. Inject a fake EIP-1193 provider into the page BEFORE the bundle boots.
  //    Playwright signs on its side (we have the key); the page just calls
  //    `request({ method: "personal_sign", params: [hex, address] })` and gets
  //    a real, recoverable signature back.
  await context.addInitScript(
    ({ pk: _pk, addr }) => {
      // viem can't run in addInitScript (no bundler), so we use a tiny
      // implementation. The wallet-buttons code calls personal_sign with
      // the EIP-4361 message as a 0x-prefixed hex string of UTF-8 bytes.
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
            // Decode the 0x-hex back to the UTF-8 message and POST it to a
            // sign-helper endpoint exposed by Playwright via window.__sign.
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
    { pk: privateKey, addr: account.address },
  );

  // 3. Boot the login page.
  await page.goto("/login");

  // 4. Click the EVM button (label "EVM" — wallet-buttons.tsx).
  await page.getByRole("button", { name: /^EVM$/i }).click();

  // 5. Wait until the bundle hands us a message to sign, then sign it on
  //    the test side with viem.
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

  // 6. /auth/verify should fire shortly after. Wait for our mock to capture.
  await expect
    .poll(() => captured.message, { timeout: 10_000 })
    .toContain(`Nonce: ${nonce}`);

  // 7. Validate it carried a real EIP-4361 message + recoverable signature.
  expect(captured.message ?? "").toContain(account.address);
  expect(captured.message ?? "").toMatch(
    /wants you to sign in with your Ethereum account/,
  );
  expect(captured.signature, "signature missing on /auth/verify").toBeTruthy();
  const recovered = await recoverMessageAddress({
    message: captured.message ?? "",
    signature: captured.signature as `0x${string}`,
  });
  expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
});

function base64url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
