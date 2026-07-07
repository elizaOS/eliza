/**
 * Guards the pre-auth surface: scans the real route source for `public: true`
 * handlers (scanPublicRoutes / publicRouteKey) and pins the set against a
 * reviewed baseline so any new unauthenticated route fails until it is justified
 * and recorded. Runs against the on-disk source tree with real git change
 * detection (mocked only in the fail-closed case) and real fixture files.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { publicRouteKey, scanPublicRoutes } from "./public-route-audit.ts";

const BASELINE_PATH = join(
  import.meta.dirname,
  "public-route-audit.baseline.json",
);

// The git-unavailable test writes an untracked `public: true` fixture under
// SCAN_ROOTS. If a prior run crashed before its `finally` cleanup, that file
// would survive and `ls-files --others` would inject it into the baseline-match
// scan below (which runs first), false-failing with a spurious "added" route.
// Clear any leftover before the suite so a crashed run can't poison this one.
const FIXTURE_DIR = join(import.meta.dirname, "__tmp-public-route-audit");
beforeAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

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

  it("fails closed to a full scan when git change detection is unavailable", async () => {
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
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => {
        throw new Error("git unavailable");
      }),
    }));

    try {
      const audit = await import("./public-route-audit.ts");
      const keys = audit.scanPublicRoutes().map(audit.publicRouteKey);
      expect(
        keys.some((key) => key.includes("/__public-route-audit-fixture")),
        "scanner must not pass baseline-only when git diff data is missing",
      ).toBe(true);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("ships the baseline next to the compiled module (build:dist copies it)", () => {
    // The compiled dist/api/public-route-audit.js resolves the baseline as a
    // sibling file; tsc only emits .ts sources, so the JSON must be copied by
    // the build script or every dist consumer hits ENOENT.
    const packageJson = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["build:dist"]).toContain(
      "src/api/public-route-audit.baseline.json",
    );
  });
});
