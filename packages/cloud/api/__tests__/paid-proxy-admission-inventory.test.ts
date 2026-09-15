/**
 * Locks the paid legacy proxy inventory to the shared standing guard so adding
 * or reverting a route cannot bypass combined account admission unnoticed.
 */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

process.env.MOCK_REDIS = "1";

const { isRouteAuthenticatedPaidProxyPath } = await import(
  "../src/middleware/auth"
);

const apiRoot = resolve(import.meta.dir, "..");
const paidLegacyRoutes = [
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

const GUARDED_ROUTE_CALL =
  /\b(?:executeGuardedPaidProxyWithPreflight|executeGuardedPaidProxyRequest|withGuardedPaidProxyAdmission)\s*\(/;

function materializeGeneratedPath(path: string): string {
  return path
    .replace(/:\*\{\.\+\}/g, "guarded-catch-all/tail")
    .replace(/:[^/]+/g, "guarded-param");
}

async function generatedRouteEntries(): Promise<
  Array<{ path: string; import: string }>
> {
  const source = await readFile(
    resolve(apiRoot, "src/_router.generated.ts"),
    "utf8",
  );
  const paths = [...source.matchAll(/^ {4}path: "([^"]+)",$/gm)];
  const entries = [
    ...source.matchAll(
      /^ {4}path: "([^"]+)",\n {4}shard: (?:"[^"]+"|null),\n {4}load: \(\) =>\s*import\(\s*"([^"]+)"\s*\),$/gm,
    ),
  ].map((match) => ({ path: match[1], import: match[2] }));
  expect(entries.length).toBe(paths.length);
  return entries;
}

test("all 14 paid legacy proxy routes defer local parsing to the shared guarded adapter", async () => {
  for (const route of paidLegacyRoutes) {
    const source = await readFile(resolve(apiRoot, route), "utf8");
    expect(source, route).toContain("executeGuardedPaidProxyWithPreflight");
    expect(source, route).not.toMatch(/\bexecuteWithBody\s*\(/);
  }
});

test("the shared adapter is the only cloud-api executeWithBody caller", async () => {
  const directCallers: string[] = [];
  const glob = new Bun.Glob("**/*.ts");
  for await (const file of glob.scan({ cwd: apiRoot, absolute: true })) {
    if (file.includes(".test.") || file.includes("__tests__")) continue;
    const source = await readFile(file, "utf8");
    if (/\bexecuteWithBody\s*\(/.test(source)) {
      directCallers.push(relative(apiRoot, file));
    }
  }

  expect(directCallers.sort()).toEqual(["src/lib/guarded-paid-proxy.ts"]);
});

test("canonical RPC and direct Birdeye also consume the shared guard", async () => {
  const canonicalRpc = await readFile(
    resolve(apiRoot, "v1/rpc/[chain]/route.ts"),
    "utf8",
  );
  const birdeye = await readFile(
    resolve(apiRoot, "v1/apis/birdeye/[...path]/route.ts"),
    "utf8",
  );

  expect(canonicalRpc).toContain("executeGuardedPaidProxyRequest");
  expect(birdeye).toContain("withGuardedPaidProxyAdmission");
});

test("global auth bypasses exactly the guarded generated v1 route inventory", async () => {
  const generatedV1Routes = (await generatedRouteEntries()).filter((entry) =>
    entry.path.startsWith("/api/v1/"),
  );
  const guardedAdapterRoutes = new Set<string>();
  for (const entry of generatedV1Routes) {
    const source = await readFile(
      resolve(apiRoot, "src", `${entry.import}.ts`),
      "utf8",
    );
    if (GUARDED_ROUTE_CALL.test(source)) guardedAdapterRoutes.add(entry.path);
  }

  const bypassedRoutes = new Set<string>();
  for (const entry of generatedV1Routes) {
    const pathname = materializeGeneratedPath(entry.path);
    const getBypass = isRouteAuthenticatedPaidProxyPath("GET", pathname);
    const headBypass = isRouteAuthenticatedPaidProxyPath("HEAD", pathname);
    const postBypass = isRouteAuthenticatedPaidProxyPath("POST", pathname);
    const optionsBypass = isRouteAuthenticatedPaidProxyPath(
      "OPTIONS",
      pathname,
    );
    expect(optionsBypass, entry.path).toBe(getBypass || postBypass);
    expect(headBypass, entry.path).toBe(getBypass);
    if (getBypass || postBypass) bypassedRoutes.add(entry.path);
  }

  expect([...bypassedRoutes].sort()).toEqual([...guardedAdapterRoutes].sort());
  expect(bypassedRoutes.size).toBe(16);
  for (const route of bypassedRoutes) {
    expect(guardedAdapterRoutes.has(route), route).toBe(true);
  }
});

test("every guarded mount enters standing admission before route-local validation", async () => {
  const generatedV1Routes = (await generatedRouteEntries()).filter((entry) =>
    entry.path.startsWith("/api/v1/"),
  );
  for (const entry of generatedV1Routes) {
    const source = await readFile(
      resolve(apiRoot, "src", `${entry.import}.ts`),
      "utf8",
    );
    if (!GUARDED_ROUTE_CALL.test(source)) continue;
    if (
      paidLegacyRoutes.some(
        (route) => entry.import === `../${route.slice(0, -3)}`,
      )
    ) {
      expect(source, entry.path).toContain(
        "executeGuardedPaidProxyWithPreflight",
      );
    }
  }
});
