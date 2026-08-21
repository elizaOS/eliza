/**
 * Checked-in inventory so a new money mutation cannot silently use a bare
 * RateLimitPresets helper (#22982).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const MONEY_MUTATION_ROUTES = [
  "admin/redemptions/route.ts",
  "auto-top-up/trigger/route.ts",
  "billing/checkout/verify/route.ts",
  "crypto/direct-payments/[id]/attach-tx/route.ts",
  "crypto/direct-payments/[id]/confirm/route.ts",
  "crypto/direct-payments/route.ts",
  "crypto/payments/[id]/confirm/route.ts",
  "crypto/payments/route.ts",
  "crypto/webhook/route.ts",
  "stripe/create-checkout-session/route.ts",
  "stripe/webhook/route.ts",
  "v1/app-credits/checkout/route.ts",
  "v1/app-credits/verify/route.ts",
  "v1/apps/[id]/charges/[chargeId]/checkout/route.ts",
  "v1/apps/[id]/charges/route.ts",
  "v1/apps/[id]/domains/buy/route.ts",
  "v1/apps/[id]/earnings/withdraw/route.ts",
  "v1/billing/resources/[id]/cancel/route.ts",
  "v1/billing/settings/route.ts",
  "v1/credits/checkout/route.ts",
  "v1/credits/verify/route.ts",
  "v1/earnings/payout/stripe-connect/onboard/route.ts",
  "v1/earnings/payout/stripe-connect/transfer/route.ts",
  "v1/earnings/payout/stripe-connect/webhook/route.ts",
  "v1/oxapay/webhook/route.ts",
  "v1/payment-requests/[id]/cancel/route.ts",
  "v1/payment-requests/[id]/expire/route.ts",
  "v1/payment-requests/route.ts",
  "v1/redemptions/route.ts",
  "v1/stripe/checkout/route.ts",
  "v1/stripe/webhook/route.ts",
  "v1/topup/10/route.ts",
  "v1/topup/50/route.ts",
  "v1/topup/100/route.ts",
  "v1/x402/requests/[id]/settle/route.ts",
  "v1/x402/requests/route.ts",
  "v1/x402/settle/route.ts",
  "v1/x402/verify/route.ts",
] as const;

const MONEY_PATH_MARKERS = [
  `${path.sep}auto-top-up${path.sep}`,
  `${path.sep}oxapay${path.sep}webhook${path.sep}`,
  `${path.sep}stripe${path.sep}webhook${path.sep}`,
  `${path.sep}stripe${path.sep}create-checkout-session${path.sep}`,
  `${path.sep}stripe${path.sep}checkout${path.sep}`,
  `${path.sep}crypto${path.sep}webhook${path.sep}`,
  `${path.sep}crypto${path.sep}payments${path.sep}`,
  `${path.sep}crypto${path.sep}direct-payments${path.sep}`,
  `${path.sep}x402${path.sep}`,
  `${path.sep}topup${path.sep}`,
  `${path.sep}redemptions${path.sep}`,
  `${path.sep}checkout${path.sep}`,
  `${path.sep}charges${path.sep}`,
  `${path.sep}withdraw${path.sep}`,
  `${path.sep}payout${path.sep}`,
  `${path.sep}domains${path.sep}buy${path.sep}`,
  `${path.sep}billing${path.sep}settings${path.sep}`,
  `${path.sep}billing${path.sep}resources${path.sep}`,
  `${path.sep}credits${path.sep}checkout${path.sep}`,
  `${path.sep}credits${path.sep}verify${path.sep}`,
  `${path.sep}app-credits${path.sep}`,
  `${path.sep}payment-requests${path.sep}`,
];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  "test",
  ".wrangler-dry-run",
]);

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkRouteFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function posixFromApi(file: string): string {
  return path.relative(apiRoot, file).split(path.sep).join("/");
}

describe("money mutation rate-limit inventory (#22982)", () => {
  test("every inventoried money mutation mounts moneyRateLimit", () => {
    expect(new Set(MONEY_MUTATION_ROUTES).size).toBe(
      MONEY_MUTATION_ROUTES.length,
    );

    for (const relative of MONEY_MUTATION_ROUTES) {
      const source = readFileSync(path.join(apiRoot, relative), "utf8");
      expect(source, relative).toContain("moneyRateLimit(");
      expect(source, relative).not.toContain("redisUnavailableFallback");
    }
  });

  test("money-path mutation routes cannot silently use a bare preset", () => {
    const listed = new Set<string>(MONEY_MUTATION_ROUTES);
    const discovered: string[] = [];

    for (const file of walkRouteFiles(apiRoot)) {
      const relative = posixFromApi(file);
      const marked = MONEY_PATH_MARKERS.some((marker) => file.includes(marker));
      if (!marked) continue;
      if (relative === "cron" || relative.startsWith("cron/")) continue;
      const source = readFileSync(file, "utf8");
      const mutates = /\.(post|put|patch|delete)\(/.test(source);
      if (!mutates) continue;
      discovered.push(relative);
      expect(source, relative).toContain("moneyRateLimit(");
    }

    for (const relative of discovered) {
      expect(listed.has(relative), relative).toBe(true);
    }
  });

  test("payment-request mutations cannot stay unmarked or fall-open", () => {
    const listed = new Set<string>(MONEY_MUTATION_ROUTES);

    for (const file of walkRouteFiles(apiRoot)) {
      const relative = posixFromApi(file);
      if (relative === "cron" || relative.startsWith("cron/")) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("getPaymentRequestsService")) continue;
      const mutates = /\.(post|put|patch|delete)\(/.test(source);
      if (!mutates) continue;
      expect(listed.has(relative), relative).toBe(true);
      expect(source, relative).toContain("moneyRateLimit(");
    }
  }, 30_000);
});
