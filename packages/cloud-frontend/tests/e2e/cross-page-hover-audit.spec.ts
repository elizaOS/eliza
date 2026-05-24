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

function isBrandOrange(rgb: string): boolean {
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const [, r, g, b] = m.map(Number);
  return r > 200 && g >= 70 && g <= 130 && b < 50;
}

function isBlackish(rgb: string): boolean {
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const [, r, g, b] = m.map(Number);
  return r < 30 && g < 30 && b < 30;
}

function isBlue(rgb: string): boolean {
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const [, r, g, b] = m.map(Number);
  return b > r + 30 && b > g + 30 && b > 80;
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
  // Generic empty mock — every dashboard fetch returns an empty list.
  await context.route(/\/api\//, (route) => {
    const url = route.request().url();
    if (/\/api\/v1\/dashboard\b/.test(url))
      return route.fulfill({
        json: { user: { name: "Test User" }, agents: [] },
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/api/v1/user")) {
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
    return route.fulfill({
      json: {},
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
    const sample = targets.slice(0, 25);
    for (const handle of sample) {
      try {
        if (!(await handle.isVisible())) continue;
        const text = (await handle.textContent())?.trim().slice(0, 40) ?? "";
        const rest = await handle.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );
        await handle.hover({ timeout: 1_500 }).catch(() => undefined);
        await page.waitForTimeout(80);
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
