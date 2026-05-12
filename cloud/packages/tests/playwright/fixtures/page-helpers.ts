import { expect, type Page, type Response } from "@playwright/test";
import { ensureLocalTestAuth } from "../../infrastructure/local-test-auth";

const DOCUMENT_OK_STATUSES = [200, 304] as const;
const PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE_NAME = "eliza-test-auth";
const STEWARD_AUTHED_COOKIE_NAME = "steward-authed";
const STEWARD_TOKEN_KEY = "steward_session_token";
const RENDER_TELEMETRY_EVENT = "eliza:render-telemetry";
const RENDER_TELEMETRY_ERRORS_KEY = "__ELIZA_PLAYWRIGHT_RENDER_TELEMETRY_ERRORS__";

interface RenderTelemetryIssue {
  source?: string;
  name?: string;
  severity?: string;
  renderCount?: number;
  threshold?: number;
  windowMs?: number;
}

function resolveBaseUrl(baseUrl?: string): URL {
  return new URL(baseUrl || process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000");
}

function base64UrlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createUnsignedStewardSessionToken(): string {
  const userId = process.env.TEST_USER_ID || "22222222-2222-4222-8222-222222222222";
  return [
    base64UrlEncode({ alg: "none", typ: "JWT" }),
    base64UrlEncode({
      userId,
      sub: userId,
      email: process.env.TEST_USER_EMAIL || "local-live-test-user@agent.local",
      walletAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
    "playwright",
  ].join(".");
}

export function expectRouteResponseOk(response: Response | null, path: string): void {
  const status = response?.status() ?? 0;
  expect(status, `${path} returned ${status}`).not.toBe(500);
  expect(DOCUMENT_OK_STATUSES, `${path} returned ${status}`).toContain(status);
}

export async function installDashboardShellAuth(page: Page, baseUrl?: string): Promise<void> {
  const url = resolveBaseUrl(baseUrl);
  await page.context().addCookies([
    {
      name: PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE_NAME,
      value: "1",
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      sameSite: "Lax",
      secure: url.protocol === "https:",
    },
  ]);
}

export async function installDashboardSessionAuth(page: Page, baseUrl?: string): Promise<void> {
  await installDashboardShellAuth(page, baseUrl);
  const url = resolveBaseUrl(baseUrl);
  const auth = await ensureLocalTestAuth();

  await page.context().addCookies([
    {
      name: auth.sessionCookieName,
      value: auth.sessionToken,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: url.protocol === "https:",
    },
    {
      name: STEWARD_AUTHED_COOKIE_NAME,
      value: "1",
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      sameSite: "Lax",
      secure: url.protocol === "https:",
    },
  ]);

  const token = createUnsignedStewardSessionToken();
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
    },
    { key: STEWARD_TOKEN_KEY, value: token },
  );
}

export async function expectDashboardShell(page: Page): Promise<void> {
  await expect(page.locator("aside").getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("This page could not be found.");
  await expect(page).not.toHaveURL(/\/login(?:[/?#]|$)/);
}

export async function expectCustomDashboardShell(page: Page): Promise<void> {
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("This page could not be found.");
  await expect(page).not.toHaveURL(/\/login(?:[/?#]|$)/);
}

export interface BadApiResponse {
  method: string;
  status: number;
  url: string;
}

export function trackBadApiResponses(page: Page, baseUrl?: string): BadApiResponse[] {
  const base = resolveBaseUrl(baseUrl);
  const badResponses: BadApiResponse[] = [];

  page.on("response", (response) => {
    let url: URL;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }

    if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) return;

    const status = response.status();
    if (status === 401 || status === 403 || status >= 500) {
      badResponses.push({
        method: response.request().method(),
        status,
        url: `${url.pathname}${url.search}`,
      });
    }
  });

  return badResponses;
}

export function expectNoBadApiResponses(
  badResponses: BadApiResponse[],
  label = "same-origin API responses",
): void {
  const formatted = badResponses.map(({ method, status, url }) => `${method} ${url} -> ${status}`);
  expect(formatted, `${label} included auth/server failures`).toEqual([]);
}

export async function installRenderTelemetryGuard(page: Page): Promise<void> {
  await page.addInitScript(
    ({ errorsKey, eventName }) => {
      const global = window as typeof window & {
        __ELIZA_PLAYWRIGHT_RENDER_TELEMETRY_INSTALLED__?: boolean;
      } & Record<string, unknown>;
      global[errorsKey] = [];
      if (global.__ELIZA_PLAYWRIGHT_RENDER_TELEMETRY_INSTALLED__) return;
      global.__ELIZA_PLAYWRIGHT_RENDER_TELEMETRY_INSTALLED__ = true;

      window.addEventListener(eventName, (event) => {
        const detail = (event as CustomEvent<RenderTelemetryIssue>).detail;
        if (detail?.severity === "error") {
          const errors = global[errorsKey];
          if (Array.isArray(errors)) errors.push(detail);
        }
      });
    },
    { errorsKey: RENDER_TELEMETRY_ERRORS_KEY, eventName: RENDER_TELEMETRY_EVENT },
  );
}

export async function expectNoRenderTelemetryErrors(page: Page, label: string): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.waitForTimeout(50);

  const errors = await page.evaluate<RenderTelemetryIssue[]>((errorsKey) => {
    const value = (window as typeof window & Record<string, unknown>)[errorsKey];
    return Array.isArray(value) ? (value as RenderTelemetryIssue[]) : [];
  }, RENDER_TELEMETRY_ERRORS_KEY);

  const formatted = errors.map(
    (issue) =>
      `${issue.name ?? "unknown"} rendered ${issue.renderCount ?? "?"} times in ${
        issue.windowMs ?? "?"
      }ms`,
  );
  expect(formatted, `${label} had render telemetry errors`).toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const offenders = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className: element.className.toString(),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter((rect) => rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1))
      .slice(0, 5);

    return { viewportWidth, scrollWidth, offenders };
  });

  expect(
    overflow.scrollWidth,
    `${label} overflows horizontally: ${JSON.stringify(overflow)}`,
  ).toBeLessThanOrEqual(overflow.viewportWidth + 1);
}

export async function smokeTestPage(page: Page, path: string): Promise<Response | null> {
  await installRenderTelemetryGuard(page);
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expectRouteResponseOk(response, path);
  await expect(page.locator("html")).toBeAttached();
  await expect.poll(() => page.evaluate(() => document.readyState)).toMatch(/interactive|complete/);
  await expectNoRenderTelemetryErrors(page, path);
  return response;
}

export async function strictSmokeTestPage(page: Page, path: string): Promise<void> {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error);
  });

  await smokeTestPage(page, path);
  expect(pageErrors).toHaveLength(0);
}
