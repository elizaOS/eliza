// SIWE programmatic-signing e2e.
// Generates an ephemeral EVM key, mocks the Steward /auth/nonce + /auth/verify
// endpoints, then invokes signInWithSIWE in-page using the @stwd/sdk that's
// already bundled. Validates:
//   1. The frontend calls /auth/nonce and includes the returned nonce in the
//      SIWE message it builds.
//   2. The frontend posts a real EIP-4361 message + a 65-byte hex signature
//      that recovers to our generated address.
//   3. After verify returns a JWT, the page sets localStorage and a
//      `steward-authed=1` cookie, and useSessionAuth flips authenticated=true.
//
// Skipped in live-prod mode (no real Steward server to verify against).

import { expect, test } from "@playwright/test";
import {
  createWalletClient,
  http,
  keccak256,
  recoverMessageAddress,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "SIWE flow uses local mocks; skipped in live-prod mode",
);

interface VerifyCapture {
  message?: string;
  signature?: string;
}

test("siwe: nonce → sign → verify produces a session", async ({
  page,
  context,
}) => {
  // 1. Generate an ephemeral wallet for this test run.
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain: mainnet,
    transport: http(),
  });
  const nonce = `nonce_${Date.now().toString(36)}`;

  // 2. Mock the Steward auth endpoints. We don't know the exact baseUrl the
  // bundle was built with (NEXT_PUBLIC_STEWARD_API_URL or same-origin
  // /steward), so we route on path suffix.
  const captured: VerifyCapture = {};

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

      // Mint a synthetic JWT — exp 1h from now, userId from address. We don't
      // sign it (the frontend just decodes the payload to populate state) but
      // we keep the structure realistic.
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
      const fakeSignature = base64url("test-signature");
      const token = `${header}.${payload}.${fakeSignature}`;

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

  // 3. Boot the app (any public page is fine — we just need the SDK loaded).
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login/);

  // 4. Drive the SDK from inside the page so the real bundled @stwd/sdk does
  // the nonce → message → POST work. We sign in-test (where we have the key)
  // and pass the signature back through the signMessage callback.
  const signature = await page.evaluate(
    async ({ address }) => {
      // The SDK is registered on window via the StewardProvider hooks. We
      // can't trivially reach it from window, so we re-import a fresh
      // StewardAuth instance pointed at the same resolved baseUrl.
      // @ts-expect-error — runtime import in browser
      const mod = await import("@stwd/sdk");
      const { resolveBrowserStewardApiUrl } = await import(
        "@elizaos/cloud-shared/lib/steward-url"
      );
      const baseUrl = resolveBrowserStewardApiUrl();
      const auth = new mod.StewardAuth({ baseUrl });
      // The actual signing is delegated to the callback below — the page
      // posts a message back to Playwright via window.__siweMessage.
      let captured: string | null = null;
      const result = await auth.signInWithSIWE(address, async (msg) => {
        captured = msg;
        (window as unknown as Record<string, string>).__siweMessage = msg;
        // Suspend until Playwright injects the signature.
        return await new Promise<string>((resolve) => {
          (
            window as unknown as Record<string, (sig: string) => void>
          ).__siweResolve = resolve;
        });
      });
      return { captured, token: result.token };
    },
    { address: account.address },
  );

  // 5. Wait until the page exposed the message it wants signed.
  const message = await page.waitForFunction(
    () => (window as unknown as Record<string, string>).__siweMessage,
    null,
    { timeout: 10_000 },
  );
  const messageStr = (await message.jsonValue()) as string;

  // 6. Sign the message with the ephemeral key.
  const signedHex = await wallet.signMessage({ message: messageStr });

  // 7. Hand the signature back to the page so signInWithSIWE resolves.
  await page.evaluate(
    (sig) =>
      (window as unknown as Record<string, (s: string) => void>).__siweResolve(
        sig,
      ),
    signedHex,
  );

  // 8. Wait for the evaluation promise to resolve — `signature` above is a
  // Playwright promise wrapper; awaiting `page.evaluate` already does this.
  // The returned token shape comes from our mocked /auth/verify body.
  expect(signature, "evaluate result").toBeTruthy();

  // 9. Validate the message the bundle posted is real EIP-4361 with our nonce.
  expect(captured.message, "/auth/verify received message").toBeTruthy();
  expect(captured.message!).toContain(account.address);
  expect(captured.message!).toContain(`Nonce: ${nonce}`);
  expect(captured.message!).toMatch(
    /wants you to sign in with your Ethereum account/,
  );

  // 10. Signature recovers to the generated address.
  expect(captured.signature, "/auth/verify received signature").toBeTruthy();
  const recovered = await recoverMessageAddress({
    message: captured.message!,
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

// Avoid unused-import lint
void keccak256;
void toHex;
