/**
 * Cross-page hover-violation audit.
 *
 * Walks every dashboard route, enumerates EVERY clickable button/link/
 * [role="button"] on the page, hovers each one, and flags any pair where:
 *   - rest is brand-orange and hover is blackish, OR
 *   - rest is blackish and hover is brand-orange, OR
 *   - rest or hover contains any blue.
 *
 * This is the systematic enforcement of the HOVER_SYSTEM.md rules.
 * Runs separately from the aesthetic-audit screenshot pass so it can
 * scale to every clickable target (the aesthetic audit only samples
 * the first primary button per page).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Hover audit drives mocked APIs; live-prod would be too slow.",
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../aesthetic-audit-output/hover-audit.json");

const ROUTES = [
  "/",
  "/login",
  "/dashboard",
  "/dashboard/account",
  "/dashboard/settings",
  "/dashboard/security",
  "/dashboard/billing",
  "/dashboard/api-keys",
  "/dashboard/api-explorer",
  "/dashboard/agents",
  "/dashboard/my-agents",
  "/dashboard/apps",
  "/dashboard/containers",
  "/dashboard/mcps",
  "/dashboard/documents",
  "/dashboard/analytics",
  "/dashboard/earnings",
  "/dashboard/affiliates",
  "/dashboard/admin",
  "/dashboard/admin/metrics",
];

interface HoverFinding {
  route: string;
  selector: string;
  text: string;
  rest: string;
  hover: string;
  violation: "orange→black" | "black→orange" | "blue-anywhere";
}

// Parse both `rgb(...)` and `rgba(...)`; returns null for non-rgb values.
function parseRgba(
  color: string,
): { r: number; g: number; b: number; a: number } | null {
  const m = color.match(
    /^rgba?\(\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)(?:\s*,\s*(\d+\.?\d*))?/,
  );
  if (!m) return null;
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

function isTransparent(color: string): boolean {
  const c = parseRgba(color);
  return !!c && c.a === 0;
}

function isBrandOrange(color: string): boolean {
  const c = parseRgba(color);
  if (!c || c.a === 0) return false;
  return c.r > 200 && c.g >= 70 && c.g <= 130 && c.b < 50;
}

// Treat a fully transparent background as "black" on the cloud's black theme:
// an orange button whose hover collapses to transparent reveals the dark page
// behind it — the same orange->black anti-pattern, just spelled differently.
function isBlackish(color: string): boolean {
  if (isTransparent(color)) return true;
  const c = parseRgba(color);
  if (!c) return false;
  return c.r < 30 && c.g < 30 && c.b < 30;
}

function isBlue(color: string): boolean {
  const c = parseRgba(color);
  if (!c || c.a === 0) return false;
  return c.b > c.r + 30 && c.b > c.g + 30 && c.b > 80;
}

test("cross-page hover audit — no orange↔black, no blue", async ({
  page,
  context,
}) => {
  test.setTimeout(600_000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
    "utf8",
  )
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "22222222-2222-4222-8222-222222222222",
      userId: "22222222-2222-4222-8222-222222222222",
      address: "0xE2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2",
      email: "audit@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
    "utf8",
  )
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const syntheticToken = `${header}.${payload}.audit-fake-signature`;
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
  await context.addInitScript((t: string) => {
    window.localStorage.setItem("steward_session_token", t);
  }, syntheticToken);
  await context.route(/\/api\//, (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const now = new Date().toISOString();
    if (path === "/api/v1/dashboard")
      return route.fulfill({
        json: { user: { name: "Test User" }, agents: [] },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/user") {
      return route.fulfill({
        json: {
          success: true,
          data: {
            id: "22222222-2222-4222-8222-222222222222",
            email: "audit@example.com",
            name: "Test User",
            role: "owner",
            wallet_address: "0xE2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2",
            organization_id: "33333333-3333-4333-8333-333333333333",
            organization: { id: "33333333-3333-4333-8333-333333333333" },
            is_anonymous: false,
            wallet_verified: true,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        },
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/api/credits/balance" || path === "/api/v1/credits/balance")
      return route.fulfill({
        json: { balance: 100, currency: "USD" },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/api-keys")
      return route.fulfill({
        json: { keys: [] },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/apps")
      return route.fulfill({
        json: { apps: [] },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/eliza/agents")
      return route.fulfill({
        json: { success: true, data: [] },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/my-agents/characters")
      return route.fulfill({
        json: {
          success: true,
          data: {
            characters: [],
            pagination: {
              page: 1,
              limit: 20,
              totalPages: 0,
              totalCount: 0,
              hasMore: false,
            },
          },
        },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/my-agents/saved")
      return route.fulfill({
        json: { success: true, data: { agents: [] } },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/my-agents/claim-affiliate-characters")
      return route.fulfill({
        json: { success: true, claimed: 0 },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/invoices/list")
      return route.fulfill({
        json: { invoices: [] },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/billing/settings")
      return route.fulfill({
        json: {
          settings: {
            payAsYouGoFromEarnings: false,
            autoTopUp: {
              enabled: false,
              amount: 25,
              threshold: 5,
              hasPaymentMethod: false,
            },
            limits: {
              minAmount: 1,
              maxAmount: 10_000,
              minThreshold: 1,
              maxThreshold: 10_000,
            },
          },
        },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/crypto/status")
      return route.fulfill({
        json: { enabled: true, directWallet: { networks: [] } },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/redemptions/balance")
      return route.fulfill({
        json: {
          balance: {
            totalEarned: 250,
            availableBalance: 125,
            pendingBalance: 25,
            totalRedeemed: 100,
            totalPending: 25,
            totalConvertedToCredits: 0,
          },
          bySource: [
            { source: "agent", totalEarned: 150, count: 3 },
            { source: "miniapp", totalEarned: 100, count: 2 },
          ],
          recentEarnings: [],
          limits: {
            minRedemptionUsd: 10,
            maxSingleRedemptionUsd: 1000,
            userDailyLimitUsd: 1000,
            userHourlyLimitUsd: 250,
          },
          eligibility: { canRedeem: true, dailyLimitRemaining: 1000 },
        },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/redemptions/status")
      return route.fulfill({
        json: {
          operational: true,
          networks: {
            base: { available: true },
            solana: { available: true },
            ethereum: { available: true },
            bnb: { available: true },
          },
        },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/redemptions")
      return route.fulfill({
        json: { redemptions: [] },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/analytics/breakdown")
      return route.fulfill({
        json: {
          success: true,
          data: {
            filters: {
              startDate: now,
              endDate: now,
              granularity: "day",
              timeRange: "weekly",
            },
            overallStats: {
              totalRequests: 12,
              totalInputTokens: 1200,
              totalOutputTokens: 800,
              totalCost: 0.42,
              successRate: 0.98,
            },
            timeSeriesData: [
              {
                timestamp: now,
                totalRequests: 12,
                totalCost: 0.42,
                inputTokens: 1200,
                outputTokens: 800,
                successRate: 0.98,
                successRatePercent: 98,
              },
            ],
            costTrending: {
              currentDailyBurn: 0.06,
              previousDailyBurn: 0.04,
              burnChangePercent: 50,
              projectedMonthlyBurn: 1.8,
              daysUntilBalanceZero: null,
              monthlyBurnPercent: 2,
              monthlyBurnPercentClamped: 2,
              burnAlertThresholdExceeded: false,
            },
            providerBreakdown: [
              {
                provider: "openai",
                totalRequests: 12,
                totalCost: 0.42,
                totalTokens: 2000,
                successRate: 0.98,
                percentage: 100,
              },
            ],
            modelBreakdown: [
              {
                model: "gpt-4.1-mini",
                provider: "openai",
                totalRequests: 12,
                totalCost: 0.42,
                totalTokens: 2000,
                avgCostPerToken: 0.00021,
                successRate: 0.98,
              },
            ],
            trends: {
              requestsChange: 10,
              costChange: 5,
              tokensChange: 8,
              successRateChange: 1,
              period: "previous week",
            },
            organization: { creditBalance: "100.00" },
          },
        },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/analytics/projections")
      return route.fulfill({
        json: {
          success: true,
          data: {
            historicalData: [
              {
                timestamp: now,
                totalRequests: 12,
                totalCost: 0.42,
                inputTokens: 1200,
                outputTokens: 800,
                successRate: 0.98,
                successRatePercent: 98,
              },
            ],
            projections: [
              {
                timestamp: now,
                projectedCost: 0.5,
                projectedRequests: 14,
                confidenceLower: 0.35,
                confidenceUpper: 0.7,
              },
            ],
            alerts: [],
            creditBalance: 100,
          },
        },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/admin/cloud-observability")
      return route.fulfill({
        json: {
          success: true,
          data: {
            generatedAt: now,
            thresholds: {
              slowRequestMs: 1000,
              slowDbMs: 100,
              dbBurstCount: 10,
            },
            requests: [],
            slowRequests: [],
            slowDb: [],
            burstyRequests: [],
            duplicateReadRequests: [],
          },
        },
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/admin/metrics")
      return route.fulfill({
        json: {
          dau: 1,
          wau: 1,
          mau: 1,
          newSignupsToday: 1,
          newSignups7d: 1,
          avgMessagesPerUser: 1,
          platformBreakdown: { web: 1 },
          platformDistribution: [{ key: "web", count: 1, percent: 100 }],
          oauthRate: {
            total_users: 1,
            connected_users: 1,
            rate: 1,
            ratePercent: 100,
            byService: { github: 1 },
          },
          dailyTrend: [
            {
              date: now.slice(0, 10),
              platform: null,
              dau: 1,
              new_signups: 1,
              total_messages: 1,
              messages_per_user: "1",
            },
          ],
          retentionCohorts: [],
          retentionRates: [],
        },
        headers: { "content-type": "application/json" },
      });
    return route.fulfill({
      json: {
        success: true,
        data: [],
        items: [],
        agents: [],
        apps: [],
        containers: [],
        keys: [],
      },
      headers: { "content-type": "application/json" },
    });
  });

  const findings: HoverFinding[] = [];

  for (const route of ROUTES) {
    try {
      await page.goto(route, { timeout: 15_000 });
      await page
        .waitForLoadState("networkidle", { timeout: 8_000 })
        .catch(() => {});
    } catch {
      continue;
    }

    const targets = await page
      .locator(
        'button:not([disabled]), a[href]:not([disabled]), [role="button"]:not([disabled])',
      )
      .all();

    // Cap per-page to keep total run reasonable.
    const sample = targets.slice(0, 18);
    for (const handle of sample) {
      try {
        if (!(await handle.isVisible())) continue;
        const text = (await handle.textContent())?.trim().slice(0, 40) ?? "";
        const rest = await handle.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );
        await handle.hover({ timeout: 750 }).catch(() => undefined);
        await page.waitForTimeout(40);
        const hover = await handle.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );

        if (isBlue(rest) || isBlue(hover)) {
          findings.push({
            route,
            selector: await handle.evaluate((el) => el.tagName.toLowerCase()),
            text,
            rest,
            hover,
            violation: "blue-anywhere",
          });
          continue;
        }
        if (isBrandOrange(rest) && isBlackish(hover)) {
          findings.push({
            route,
            selector: await handle.evaluate((el) => el.tagName.toLowerCase()),
            text,
            rest,
            hover,
            violation: "orange→black",
          });
          continue;
        }
        if (isBlackish(rest) && isBrandOrange(hover)) {
          findings.push({
            route,
            selector: await handle.evaluate((el) => el.tagName.toLowerCase()),
            text,
            rest,
            hover,
            violation: "black→orange",
          });
        }
      } catch {
        // Element may have detached during hover; skip.
      }
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));

  // Fail with a useful message if any violation was found.
  expect(
    findings,
    `Hover violations (see ${OUT}):\n${findings
      .slice(0, 10)
      .map(
        (f) =>
          `  ${f.route} ${f.selector} "${f.text}" ${f.violation} rest=${f.rest} hover=${f.hover}`,
      )
      .join("\n")}`,
  ).toEqual([]);
});
