/**
 * Guards the pre-auth surface: scans the real route source for `public: true`
 * handlers using a full on-disk production-source scan and verifies the scanner
 * against known routes and real fixture files.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { publicRouteKey, scanPublicRoutes } from "./public-route-audit.ts";

// The git-unavailable test writes an untracked `public: true` fixture under
// SCAN_ROOTS. If a prior run crashed before its `finally` cleanup, that file
// would survive and enter the full scan below (which runs first).
// Clear any leftover before the suite so a crashed run can't poison this one.
const FIXTURE_DIR = join(import.meta.dirname, "__tmp-public-route-audit");
beforeAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

/**
 * A `public: true` route bypasses the central auth gate, so the scanner must
 * cover the complete production tree.
 */
describe("public:true route inventory (#9948)", () => {
  it("finds a known public route (scanner sanity)", () => {
    // The content-addressed media route is served pre-auth by design (the
    // sha256 hash is the capability), so it is a stable anchor proving the
    // scanner detects real `public: true` routes.
    const keys = scanPublicRoutes().map(publicRouteKey);
    expect(
      keys.some((k) => k.includes("/api/media/:filename")),
      "scanner should detect the pre-auth media route",
    ).toBe(true);
  });

  it("does not treat test fixtures as unauthenticated production routes", () => {
    const keys = scanPublicRoutes().map(publicRouteKey);
    expect(keys.some((key) => key.includes("/__tests__/"))).toBe(false);
  });

  it("includes an untracked production source file in the full scan", async () => {
    const fixtureDir = FIXTURE_DIR;
    const fixturePath = join(fixtureDir, "new-public-route.ts");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      fixturePath,
      `export const routes = [
  {
    path: "/__public-route-audit-fixture",
    public: true,
    handler: () => new Response("ok"),
  },
];
`,
    );

    vi.resetModules();
    try {
      const audit = await import("./public-route-audit.ts");
      const keys = audit.scanPublicRoutes().map(audit.publicRouteKey);
      expect(
        keys.some((key) => key.includes("/__public-route-audit-fixture")),
        "scanner must not pass baseline-only when git diff data is missing",
      ).toBe(true);
    } finally {
      vi.resetModules();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
