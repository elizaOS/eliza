/**
 * Checked-in inventory so paid legacy chain/market/EVM/Solana/Birdeye proxies
 * cannot silently skip the shared combined-admission adapter (#30252).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAID_LEGACY_PROXY_EXECUTE_ROUTES = [
  "v1/chain/nfts/[chain]/[address]/route.ts",
  "v1/chain/tokens/[chain]/[address]/route.ts",
  "v1/chain/transfers/[chain]/[address]/route.ts",
  "v1/market/candles/[chain]/[address]/route.ts",
  "v1/market/portfolio/[chain]/[address]/route.ts",
  "v1/market/price/[chain]/[address]/route.ts",
  "v1/market/token/[chain]/[address]/route.ts",
  "v1/market/trades/[chain]/[address]/route.ts",
  "v1/proxy/evm-rpc/[chain]/route.ts",
  "v1/proxy/solana-rpc/route.ts",
  "v1/solana/assets/[address]/route.ts",
  "v1/solana/rpc/route.ts",
  "v1/solana/token-accounts/[address]/route.ts",
  "v1/solana/transactions/[address]/route.ts",
] as const;
const PAID_LEGACY_PROXY_BIRDEYE_ROUTE = "v1/apis/birdeye/[...path]/route.ts";
const PAID_LEGACY_PROXY_RPC_ROUTE = "v1/rpc/[chain]/route.ts";
const EXEMPT_LEGACY_PROXY_ROUTES = [
  "v1/proxy/birdeye/[...path]/route.ts",
] as const;

const apiRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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

describe("paid legacy proxy combined-admission inventory (#30252)", () => {
  test("every executeWithBody paid route uses the shared adapter exactly", () => {
    expect(new Set(PAID_LEGACY_PROXY_EXECUTE_ROUTES).size).toBe(
      PAID_LEGACY_PROXY_EXECUTE_ROUTES.length,
    );
    for (const relative of PAID_LEGACY_PROXY_EXECUTE_ROUTES) {
      const source = readFileSync(path.join(apiRoot, relative), "utf8");
      expect(source, relative).toContain(
        "executePaidProxyWithCombinedAdmission(",
      );
      expect(source, relative).not.toContain(
        'from "@/lib/services/proxy/engine"',
      );
      expect(source, relative).not.toMatch(/\bexecuteWithBody\s*\(/);
      expect(source, relative).not.toContain("requireAuthOrApiKeyWithOrg(");
      expect(source, relative).not.toContain("creditsService.reserve(");
      const calls =
        source.split("executePaidProxyWithCombinedAdmission(").length - 1;
      expect(calls, relative).toBe(1);
    }
  });

  test("direct Birdeye paid handling resolves standing through the same adapter", () => {
    const source = readFileSync(
      path.join(apiRoot, PAID_LEGACY_PROXY_BIRDEYE_ROUTE),
      "utf8",
    );
    expect(source).toContain("resolvePaidProxyCombinedAdmission");
    expect(source).not.toContain("requireUserOrApiKeyWithOrg");
    expect(source).not.toContain("creditsService.deductCredits");
  });

  test("canonical RPC uses the shared combined admission helper", () => {
    const source = readFileSync(
      path.join(apiRoot, PAID_LEGACY_PROXY_RPC_ROUTE),
      "utf8",
    );
    expect(source).toContain("resolvePaidProxyCombinedAdmission");
    expect(source).not.toContain("requireGenerativeRouteCaller(");
  });

  test("public redirect, read-only, and internal routes stay exempt", () => {
    for (const relative of EXEMPT_LEGACY_PROXY_ROUTES) {
      const source = readFileSync(path.join(apiRoot, relative), "utf8");
      expect(source, relative).toContain("c.redirect");
      expect(source, relative).not.toContain(
        "executePaidProxyWithCombinedAdmission",
      );
      expect(source, relative).not.toContain("requireGenerativeRouteCaller");
    }

    const paid = new Set<string>([
      ...PAID_LEGACY_PROXY_EXECUTE_ROUTES,
      PAID_LEGACY_PROXY_BIRDEYE_ROUTE,
      PAID_LEGACY_PROXY_RPC_ROUTE,
    ]);
    const unexpected: string[] = [];
    for (const file of walkRouteFiles(apiRoot)) {
      const relative = posixFromApi(file);
      if (!relative.endsWith("/route.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (source.includes("executeWithBody(") && !paid.has(relative)) {
        unexpected.push(relative);
      }
    }
    expect(unexpected).toEqual([]);
  });
});
