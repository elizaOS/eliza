// Live Steward wallet login smoke for session-cookie-only dashboard pages.
//
// Enable with the local Playwright server, not CLOUD_E2E_LIVE_URL:
//   CLOUD_E2E_LIVE_AUTH=1 \
//   CLOUD_E2E_LIVE_STEWARD=1 \
//   PLAYWRIGHT_API_URL=https://api.elizacloud.ai \
//   bun run test:e2e tests/e2e/live-steward-wallet-login.spec.ts

import { STEWARD_AUTHED_COOKIE } from "@elizaos/shared/steward-session-client";
import {
  type ConsoleMessage,
  expect,
  type Page,
  type Request,
  type Response,
  test,
} from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  assertScreenshotNotBlank,
  captureScreenshotWithQualityRetry,
} from "./_helpers/screenshot-quality";

const LIVE_AUTH_ENABLED = process.env.CLOUD_E2E_LIVE_AUTH === "1";
const LIVE_STEWARD_ENABLED = process.env.CLOUD_E2E_LIVE_STEWARD === "1";
const API_BASE_URL = resolveApiBaseUrl();
const PROXY_TARGET =
  process.env.PLAYWRIGHT_API_URL?.trim() ||
  process.env.VITE_API_PROXY_TARGET?.trim() ||
  "";

const LIVE_STEWARD_SESSION_DASHBOARD_ROUTES = ["/dashboard/api-keys"] as const;

test.setTimeout(120_000);

function resolveApiBaseUrl(): string {
  const explicit = process.env.CLOUD_E2E_LIVE_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return "https://api.elizacloud.ai";
}

function localOrigin(): string {
  return new URL(test.info().project.use.baseURL as string).origin;
}

async function installLiveSessionForwarder(page: Page) {
  await page.route("**/api/auth/steward-session", async (route) => {
    const requestBody = route.request().postData() ?? "{}";
    const { token, refreshToken } = JSON.parse(requestBody) as {
      token?: string;
      refreshToken?: string | null;
    };

    const liveResponse = await fetch(
      `${API_BASE_URL}/api/auth/steward-session`,
      {
        method: "POST",
        body: requestBody,
        headers: {
          "Content-Type": "application/json",
          Origin: "https://elizacloud.ai",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const liveBody = await liveResponse.text();

    if (liveResponse.ok && token) {
      const origin = localOrigin();
      await page.context().addCookies([
        {
          name: "steward-token",
          value: token,
          url: origin,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
        ...(refreshToken
          ? [
              {
                name: "steward-refresh-token",
                value: refreshToken,
                url: origin,
                httpOnly: true,
                secure: false,
                sameSite: "Lax" as const,
              },
            ]
          : []),
        {
          name: STEWARD_AUTHED_COOKIE,
          value: "1",
          url: origin,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ]);
    }

    await route.fulfill({
      status: liveResponse.status,
      body: liveBody,
      headers: {
        "content-type":
          liveResponse.headers.get("content-type") ?? "application/json",
      },
    });
  });
}

async function installInjectedEthereumWallet(page: Page) {
  const account = privateKeyToAccount(generatePrivateKey());
  await page.exposeBinding("__signStewardSiwe", async (_source, message) =>
    account.signMessage({ message }),
  );
  await page.context().addInitScript((addr) => {
    const decodeHexUtf8 = (hex: string) => {
      const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
      const bytes = new Uint8Array(
        cleanHex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
      );
      return new TextDecoder().decode(bytes);
    };

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
          const message = decodeHexUtf8((params?.[0] as string) ?? "");
          return await (
            window as unknown as {
              __signStewardSiwe: (messageToSign: string) => Promise<string>;
            }
          ).__signStewardSiwe(message);
        }
        throw new Error(`Unimplemented EIP-1193 method: ${method}`);
      },
      on: () => undefined,
      removeListener: () => undefined,
      isMetaMask: false,
    };

    (window as unknown as { ethereum: unknown }).ethereum = provider;
  }, account.address);
  return account.address;
}

async function signInWithInjectedEthereumWallet(page: Page) {
  await installLiveSessionForwarder(page);
  const address = await installInjectedEthereumWallet(page);

  await page.goto("/login?returnTo=%2Fdashboard%2Fapi-keys", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: /^Ethereum$/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/api-keys(?:\?|$)/, {
    timeout: 45_000,
  });

  const cookies = await page.context().cookies(localOrigin());
  expect(
    cookies.some(
      (cookie) => cookie.name === STEWARD_AUTHED_COOKIE && cookie.value === "1",
    ),
    `expected ${STEWARD_AUTHED_COOKIE}=1 after Steward login`,
  ).toBe(true);

  return address;
}

async function expectNoRenderFailures(page: Page, route: string) {
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
  await expect(page.locator("#main, main").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("heading", { name: /^Page Not Found$/i }),
  ).toHaveCount(0);
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
  await expect(page.getByText(/Dashboard route failed/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^API Keys$/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: /Create API Key/i }).first(),
  ).toBeVisible();

  const screenshot = await captureScreenshotWithQualityRetry(page, route, {
    fullPage: true,
  });
  await assertScreenshotNotBlank(screenshot, route);
}

async function exerciseApiKeyCreateAndDelete(page: Page) {
  const keyName = `playwright-live-steward-${Date.now().toString(36)}`;
  let createdKeyId: string | null = null;

  try {
    await page
      .getByRole("button", { name: /Create API Key/i })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: /^Create API key$/i }),
    ).toBeVisible();
    await page.getByLabel(/^Name$/i).fill(keyName);
    await page.getByLabel(/^Description$/i).fill("Created by live E2E");
    await page.getByRole("button", { name: /^Read data$/i }).click();

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/api-keys") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /^Create key$/i }).click();
    const createResponse = await createResponsePromise;
    const createBody = (await createResponse.json()) as {
      apiKey?: { id?: string; name?: string };
      error?: string;
    };
    expect(createResponse.status(), JSON.stringify(createBody)).toBe(201);
    createdKeyId = createBody.apiKey?.id ?? null;
    expect(createdKeyId, JSON.stringify(createBody)).toBeTruthy();

    await expect(
      page.getByRole("heading", { name: /^API key created successfully$/i }),
    ).toBeVisible();
    await expect(page.locator("input[readonly]").last()).toHaveValue(
      /^eliza_/i,
    );
    await page.getByRole("button", { name: /^Done$/i }).click();

    const keyRow = page.getByRole("row").filter({ hasText: keyName }).first();
    await expect(keyRow).toBeVisible({ timeout: 30_000 });
    await keyRow.getByRole("button", { name: /^Open actions$/i }).click();
    await page.getByRole("menuitem", { name: /^Delete key$/i }).click();
    await expect(
      page.getByRole("heading", { name: /^Delete API Key$/i }),
    ).toBeVisible();

    const deleteResponsePromise = page.waitForResponse(
      (response) =>
        Boolean(createdKeyId) &&
        response.url().includes(`/api/v1/api-keys/${createdKeyId}`) &&
        response.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: /^Confirm$/i }).click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.status()).toBeLessThan(300);
    createdKeyId = null;
  } finally {
    if (createdKeyId) {
      await page
        .evaluate(async (id) => {
          await fetch(`/api/v1/api-keys/${id}`, {
            method: "DELETE",
            credentials: "include",
          });
        }, createdKeyId)
        .catch(() => undefined);
    }
  }
}

test.describe("live: Steward wallet session dashboard pages", () => {
  test.skip(
    Boolean(process.env.CLOUD_E2E_LIVE_URL),
    "run against the local frontend with PLAYWRIGHT_API_URL pointing at the live API",
  );
  test.skip(
    !LIVE_AUTH_ENABLED,
    "set CLOUD_E2E_LIVE_AUTH=1 to create a real wallet-backed cloud session",
  );
  test.skip(
    !LIVE_STEWARD_ENABLED,
    "set CLOUD_E2E_LIVE_STEWARD=1 to hit the live Steward wallet auth flow",
  );
  test.skip(
    !PROXY_TARGET,
    "set PLAYWRIGHT_API_URL or VITE_API_PROXY_TARGET so local /api and /steward calls hit the live backend",
  );

  test("SIWE Steward session can manage API keys through the session-only dashboard page", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedResponses: string[] = [];
    const requestFailures: string[] = [];

    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/^\[RenderTelemetry\]/.test(text)) return;
      if (
        /^Failed to load resource: the server responded with a status of 404/.test(
          text,
        )
      ) {
        return;
      }
      consoleErrors.push(text);
    });
    page.on("response", (response: Response) => {
      if (response.status() < 400) return;
      if (/\/favicon(?:\.ico)?(?:\?|$)/i.test(response.url())) return;
      if (/\/__telemetry__\//i.test(response.url())) return;
      if (
        /^https:\/\/blob\.elizacloud\.ai\/cloud-avatars\//.test(response.url())
      ) {
        return;
      }
      failedResponses.push(`${response.status()} ${response.url()}`);
    });
    page.on("requestfailed", (request: Request) => {
      const failure = request.failure();
      if (
        (request.method() === "HEAD" || request.resourceType() === "fetch") &&
        failure?.errorText === "net::ERR_ABORTED"
      ) {
        return;
      }
      requestFailures.push(
        `${request.method()} ${request.url()}${failure?.errorText ? ` (${failure.errorText})` : ""}`,
      );
    });

    for (const route of LIVE_STEWARD_SESSION_DASHBOARD_ROUTES) {
      expect(route).toBe("/dashboard/api-keys");
    }

    await signInWithInjectedEthereumWallet(page);
    await expectNoRenderFailures(page, "/dashboard/api-keys");
    await exerciseApiKeyCreateAndDelete(page);

    expect(
      { pageErrors, consoleErrors, failedResponses, requestFailures },
      "live Steward session dashboard problems",
    ).toEqual({
      pageErrors: [],
      consoleErrors: [],
      failedResponses: [],
      requestFailures: [],
    });
  });
});
