// @eliza-live-audit allow-route-fixtures
import { type APIRequestContext, expect, type Page, type Route, test } from "@playwright/test";
import { SignJWT } from "jose";
import { verifyMessage } from "viem";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

const DEFAULT_STEWARD_TEST_SECRET = "playwright-local-steward-secret";
const STEWARD_TEST_TENANT_ID = process.env.STEWARD_TENANT_ID || "elizacloud";

declare global {
  interface Window {
    __playwrightSignMessage: (message: string) => Promise<`0x${string}`>;
    ethereum?: unknown;
  }
}

interface StewardVerifyBody {
  message: string;
  signature: `0x${string}`;
}

interface StewardSessionBody {
  token?: string;
  refreshToken?: string | null;
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function stewardSecretFingerprint(secret: string): string {
  return secret ? `len=${secret.length} head=${secret.slice(0, 2)} tail=${secret.slice(-2)}` : "";
}

async function resolveWorkerStewardSecret(request: APIRequestContext): Promise<string> {
  const candidates = [
    process.env.STEWARD_SESSION_SECRET,
    process.env.STEWARD_JWT_SECRET,
    DEFAULT_STEWARD_TEST_SECRET,
  ].filter((secret): secret is string => Boolean(secret));

  const debugResponse = await request.get("/api/auth/steward-debug").catch(() => null);
  if (debugResponse?.ok()) {
    const debug = (await debugResponse.json().catch(() => null)) as { c_env?: string } | null;
    const serverFingerprint = debug?.c_env;
    const matchingSecret = candidates.find(
      (secret) => stewardSecretFingerprint(secret) === serverFingerprint,
    );
    if (matchingSecret) {
      return matchingSecret;
    }
  }

  return candidates[0] ?? DEFAULT_STEWARD_TEST_SECRET;
}

async function createStewardToken(
  address: string,
  userId: string,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    userId,
    address,
    walletAddress: address,
    walletChain: "ethereum",
    tenantId: STEWARD_TEST_TENANT_ID,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("steward")
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 15 * 60)
    .sign(new TextEncoder().encode(secret));
}

async function installMockSteward(
  page: Page,
  account: PrivateKeyAccount,
  userId: string,
  stewardSecret: string,
) {
  await page.route(/\/auth\/providers$/, (route) =>
    json(route, {
      passkey: true,
      email: true,
      siwe: true,
      siws: false,
      google: false,
      discord: false,
      github: false,
      oauth: [],
    }),
  );

  await page.route(/\/auth\/nonce$/, (route) => json(route, { nonce: "playwright123" }));

  await page.route(/\/auth\/verify$/, async (route) => {
    const rawBody = route.request().postData();
    const body = rawBody ? (JSON.parse(rawBody) as Partial<StewardVerifyBody>) : {};
    const message = body.message;
    const signature = body.signature;
    expect(message).toBeTruthy();
    expect(signature).toMatch(/^0x/);
    if (!message || !signature) throw new Error("Steward verify request was missing SIWE payload");

    const valid = await verifyMessage({
      address: account.address,
      message,
      signature,
    });
    expect(valid).toBe(true);

    const token = await createStewardToken(account.address, userId, stewardSecret);
    await json(route, {
      token,
      refreshToken: "playwright-refresh-token",
      expiresIn: 900,
      userId,
      address: account.address,
      walletChain: "ethereum",
    });
  });
}

async function installInjectedEthereumWallet(page: Page, account: PrivateKeyAccount) {
  await page.exposeFunction("__playwrightSignMessage", async (message: string) => {
    return account.signMessage({ message });
  });

  await page.addInitScript(
    ({ address }) => {
      function hexToUtf8(hex: string): string {
        const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
        const bytes = new Uint8Array(
          clean.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
        );
        return new TextDecoder().decode(bytes);
      }

      const listeners = new Map<string, Set<(payload: unknown) => void>>();
      const emit = (event: string, payload: unknown) => {
        listeners.get(event)?.forEach((listener) => listener(payload));
      };

      const provider = {
        selectedAddress: address,
        chainId: "0x1",
        request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            emit("accountsChanged", [address]);
            return [address];
          }
          if (method === "eth_chainId") return "0x1";
          if (method === "net_version") return "1";
          if (method === "wallet_getPermissions") {
            return [{ parentCapability: "eth_accounts" }];
          }
          if (method === "wallet_requestPermissions") {
            return [{ parentCapability: "eth_accounts" }];
          }
          if (method === "personal_sign") {
            const rawMessage = typeof params[0] === "string" ? params[0] : "";
            const message = rawMessage.startsWith("0x") ? hexToUtf8(rawMessage) : rawMessage;
            return window.__playwrightSignMessage(message);
          }
          throw new Error(`Unsupported ethereum method in Playwright test: ${method}`);
        },
        on: (event: string, listener: (payload: unknown) => void) => {
          const eventListeners = listeners.get(event) ?? new Set<(payload: unknown) => void>();
          eventListeners.add(listener);
          listeners.set(event, eventListeners);
        },
        removeListener: (event: string, listener: (payload: unknown) => void) => {
          listeners.get(event)?.delete(listener);
        },
      };

      window.ethereum = provider;
    },
    { address: account.address },
  );
}

test.describe("Steward wallet authentication", () => {
  test("Ethereum wallet sign-in signs through Steward and redirects to dashboard", async ({
    page,
    request,
  }) => {
    const account = privateKeyToAccount(generatePrivateKey());
    const userId = `playwright-steward-wallet-user-${Date.now()}-${account.address.slice(2, 10)}`;
    const stewardSecret = await resolveWorkerStewardSecret(request);
    const sessionPosts: StewardSessionBody[] = [];
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(message.text());
      }
    });
    await installMockSteward(page, account, userId, stewardSecret);
    await installInjectedEthereumWallet(page, account);

    page.on("request", (request) => {
      if (request.url().includes("/api/auth/steward-session") && request.method() === "POST") {
        const body = request.postData();
        if (body) sessionPosts.push(JSON.parse(body) as StewardSessionBody);
      }
    });

    await page.goto("/login?returnTo=%2Fdashboard", { waitUntil: "domcontentloaded" });

    const ethereumButton = page.getByRole("button", { name: /Ethereum/i });
    await expect(ethereumButton).toBeVisible({ timeout: 15_000 });
    const sessionResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/steward-session") &&
        response.request().method() === "POST",
    );
    await ethereumButton.click();
    const sessionResponse = await sessionResponsePromise;
    const sessionBody = await sessionResponse.text().catch(() => "<response body unavailable>");
    expect(sessionResponse.status(), sessionBody).toBe(200);

    await expect
      .poll(() => page.evaluate(() => window.location.pathname), { timeout: 30_000 })
      .toBe("/dashboard");
    await expect(page.locator("aside").getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("main").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("This page could not be found.");
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("steward_session_token")))
      .toBeTruthy();
    expect(sessionPosts.length).toBeGreaterThan(0);

    const currentUser = await page.evaluate(async () => {
      const response = await fetch("/api/v1/user", {
        headers: { Accept: "application/json" },
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    });
    expect(currentUser.status).toBe(200);
    expect(currentUser.body?.success).toBe(true);
    expect(currentUser.body?.steward_user_id).toBe(userId);
    expect(currentUser.body?.email).toBeNull();
    expect(currentUser.body?.wallet_address?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(currentUser.body?.wallet_verified).toBe(true);
    expect(currentUser.body?.organization_id).toBeTruthy();
    expect(browserErrors).toEqual([]);
  });
});
