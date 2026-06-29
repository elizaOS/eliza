import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicRouteKey, scanPublicRoutes } from "./public-route-audit.ts";

const BASELINE_PATH = join(
  import.meta.dirname,
  "public-route-audit.baseline.json",
);

/**
 * Security gate (#9948): a `public: true` route bypasses the central auth gate,
 * so the set of them is pinned. Adding a new one fails this test until it's
 * recorded in the baseline (a deliberate, reviewed decision). Regenerate after
 * an intentional change with `UPDATE_PUBLIC_ROUTE_BASELINE=1`.
 */
describe("public:true route allowlist (#9948)", () => {
  it("matches the reviewed baseline — new public routes must be justified", () => {
    const current = scanPublicRoutes().map(publicRouteKey);

    if (process.env.UPDATE_PUBLIC_ROUTE_BASELINE === "1") {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    }

    const baseline: string[] = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

    const added = current.filter((k) => !baseline.includes(k));
    const removed = baseline.filter((k) => !current.includes(k));

    expect(
      added,
      `New public:true route(s) not in the baseline. Each bypasses isAuthorized() — justify it, then run UPDATE_PUBLIC_ROUTE_BASELINE=1 to record it:\n${added.join("\n")}`,
    ).toEqual([]);
    // Removals are good (fewer unauthenticated surfaces) but must prune the
    // baseline so it stays an honest ledger.
    expect(
      removed,
      `public:true route(s) removed from source but still in the baseline — run UPDATE_PUBLIC_ROUTE_BASELINE=1 to prune:\n${removed.join("\n")}`,
    ).toEqual([]);
  });

  it("finds the known wallet signing routes (scanner sanity)", () => {
    const keys = scanPublicRoutes().map(publicRouteKey);
    expect(
      keys.some((k) => k.includes("/wallet/evm/personal-sign")),
      "scanner should detect the wallet personal-sign public route",
    ).toBe(true);
  });
});
