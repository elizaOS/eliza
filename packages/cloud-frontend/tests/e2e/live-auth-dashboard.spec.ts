// Live authenticated dashboard smoke for the local cloud frontend pointed at
// a real cloud API. This is intentionally opt-in because it creates a fresh
// wallet-backed account/API key in the target backend.
//
// Enable with the local Playwright server, not CLOUD_E2E_LIVE_URL:
//   CLOUD_E2E_LIVE_AUTH=1 \
//   PLAYWRIGHT_API_URL=https://api.elizacloud.ai \
//   bun run test:e2e tests/e2e/live-auth-dashboard.spec.ts

import {
  STEWARD_AUTHED_COOKIE,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
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
const API_BASE_URL = resolveApiBaseUrl();
const PROXY_TARGET =
  process.env.PLAYWRIGHT_API_URL?.trim() ||
  process.env.VITE_API_PROXY_TARGET?.trim() ||
  "";

const LIVE_DASHBOARD_ROUTES = [
  "/dashboard",
  "/dashboard/account",
  "/dashboard/security",
  "/dashboard/settings",
  "/dashboard/billing",
  "/dashboard/agents",
  "/dashboard/my-agents",
  "/dashboard/apps",
  "/dashboard/mcps",
  "/dashboard/documents",
  "/dashboard/analytics",
  "/dashboard/earnings",
  "/dashboard/affiliates",
  "/dashboard/containers",
  "/dashboard/api-explorer",
] as const;

// These routes currently require a browser Steward session cookie rather than
// the wallet-issued bearer key this suite creates. Keep them explicit so the
// remaining live-login gap is visible instead of silently untested.
const LIVE_SESSION_ONLY_DASHBOARD_ROUTES = ["/dashboard/api-keys"] as const;

test.setTimeout(120_000);

interface NonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: string | number;
  version: string;
  statement?: string;
}

interface WalletVerifyResponse {
  apiKey: string;
  address: string;
  user: { id: string; wallet_address: string | null; organization_id: string };
  organization: { id: string; name: string; slug: string } | null;
}

function resolveApiBaseUrl(): string {
  const explicit = process.env.CLOUD_E2E_LIVE_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return "https://api.elizacloud.ai";
}

function endpoint(path: string): string {
  return `${API_BASE_URL}${path}`;
}

function buildWalletMessage(params: {
  chain: "Ethereum";
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  chainId: string | number;
  nonce: string;
  issuedAt: Date;
}): string {
  const lines = [
    `${params.domain} wants you to sign in with your ${params.chain} account:`,
    params.address,
    "",
  ];
  if (params.statement) {
    lines.push(params.statement, "");
  }
  lines.push(
    `URI: ${params.uri}`,
    "Version: 1",
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt.toISOString()}`,
  );
  return lines.join("\n");
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: T }> {
  const response = await fetch(endpoint(path), {
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  return { response, body };
}

async function signInWithFreshEthereumKey(): Promise<WalletVerifyResponse> {
  const account = privateKeyToAccount(generatePrivateKey());
  const { response: nonceResponse, body: nonce } =
    await fetchJson<NonceResponse>("/api/auth/siwe/nonce?chainId=1");
  expect(nonceResponse.status, JSON.stringify(nonce)).toBe(200);
  expect(nonce.nonce).toMatch(/^[0-9a-f]{32}$/);

  const message = buildWalletMessage({
    chain: "Ethereum",
    domain: nonce.domain,
    address: account.address,
    statement: nonce.statement,
    uri: nonce.uri,
    chainId: nonce.chainId,
    nonce: nonce.nonce,
    issuedAt: new Date(),
  });
  const signature = await account.signMessage({ message });

  const { response: verifyResponse, body: verify } =
    await fetchJson<WalletVerifyResponse>("/api/auth/siwe/verify", {
      method: "POST",
      body: JSON.stringify({ message, signature }),
    });

  expect(verifyResponse.status, JSON.stringify(verify)).toBe(200);
  expect(verify.apiKey).toBeTruthy();
  expect(verify.address.toLowerCase()).toBe(account.address.toLowerCase());
  expect(verify.user.organization_id).toBeTruthy();
  return verify;
}

async function seedLiveDashboardSession(page: Page, apiKey: string) {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  await page.context().addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      url: origin,
      httpOnly: false,
      secure: origin.startsWith("https://"),
      sameSite: "Lax",
    },
    {
      name: STEWARD_AUTHED_COOKIE,
      value: "1",
      url: origin,
      httpOnly: false,
      secure: origin.startsWith("https://"),
      sameSite: "Lax",
    },
  ]);
  await page.context().addInitScript(
    ({ key, token }) => {
      window.localStorage.setItem(key, token);
    },
    { key: STEWARD_TOKEN_KEY, token: apiKey },
  );
}

async function expectDashboardRouteHealthy(page: Page, route: string) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  const requestFailures: string[] = [];

  const onPageError = (error: Error) => pageErrors.push(error.message);
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/^\[RenderTelemetry\]/.test(text)) return;
    if (
      text ===
        "Failed to load resource: the server responded with a status of 401 (Unauthorized)" &&
      failedResponses.every((failure) =>
        failure.includes("/api/my-agents/claim-affiliate-characters"),
      )
    ) {
      return;
    }
    consoleErrors.push(text);
  };
  const onResponse = (response: Response) => {
    if (response.status() < 400) return;
    if (/\/favicon(?:\.ico)?(?:\?|$)/i.test(response.url())) return;
    if (/\/__telemetry__\//i.test(response.url())) return;
    if (
      response.status() === 401 &&
      response.url().includes("/api/my-agents/claim-affiliate-characters")
    ) {
      return;
    }
    failedResponses.push(`${response.status()} ${response.url()}`);
  };
  const onRequestFailed = (request: Request) => {
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
  };

  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  try {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    expect(response, `no response for ${route}`).not.toBeNull();
    expect(response?.status(), `bad status for ${route}`).toBeLessThan(400);
    await page.waitForTimeout(1_500);
    await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
    await expect(page.locator("#main, main").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("heading", { name: /^Page Not Found$/i }),
    ).toHaveCount(0);
    await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
    await expect(page.getByText(/Dashboard route failed/i)).toHaveCount(0);

    const screenshot = await captureScreenshotWithQualityRetry(page, route, {
      fullPage: true,
    });
    await assertScreenshotNotBlank(screenshot, route);

    expect(
      { pageErrors, consoleErrors, failedResponses, requestFailures },
      `live dashboard route problems on ${route}`,
    ).toEqual({
      pageErrors: [],
      consoleErrors: [],
      failedResponses: [],
      requestFailures: [],
    });
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
  }
}

test.describe("live: wallet-authenticated dashboard pages", () => {
  test.skip(
    Boolean(process.env.CLOUD_E2E_LIVE_URL),
    "run against the local frontend with PLAYWRIGHT_API_URL pointing at the live API",
  );
  test.skip(
    !LIVE_AUTH_ENABLED,
    "set CLOUD_E2E_LIVE_AUTH=1 to create a real wallet-backed cloud session",
  );
  test.skip(
    !PROXY_TARGET,
    "set PLAYWRIGHT_API_URL or VITE_API_PROXY_TARGET so local /api calls hit the live backend",
  );

  test("SIWE-authenticated user can render every top-level dashboard page against the live backend", async ({
    page,
  }) => {
    for (const sessionOnlyRoute of LIVE_SESSION_ONLY_DASHBOARD_ROUTES) {
      expect(LIVE_DASHBOARD_ROUTES).not.toContain(sessionOnlyRoute);
    }

    const { apiKey } = await signInWithFreshEthereumKey();
    await seedLiveDashboardSession(page, apiKey);

    for (const route of LIVE_DASHBOARD_ROUTES) {
      const routePage = await page.context().newPage();
      try {
        await expectDashboardRouteHealthy(routePage, route);
      } finally {
        await routePage.close();
      }
    }
  });
});
