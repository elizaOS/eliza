/**
 * The route x viewport matrix that defines homepage visual-regression coverage.
 *
 * `visual.spec.ts` drives its captures from these lists, and
 * `scripts/check-snapshot-inventory.ts` derives the exact set of committed
 * baseline filenames from the same lists. Both consumers must read this module
 * rather than restate the matrix: a second copy is what let the `not-found`
 * route ship with baselines the CI inventory gate then rejected.
 */

export const VISUAL_ROUTES = [
  { path: "/", name: "landing" },
  { path: "/downloads", name: "downloads" },
  { path: "/login", name: "login" },
  { path: "/connected", name: "connected" },
  { path: "/get-started", name: "get-started" },
  { path: "/leaderboard", name: "leaderboard" },
  { path: "/profile/edit", name: "profile-edit", authed: true },
  // "*" is the App.tsx catch-all; exercised via a representative unknown path.
  { path: "*", name: "not-found", goto: "/this-page-does-not-exist" },
] as const;

export const VISUAL_VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

/** The only Playwright project declared in `playwright.config.ts`. */
const SNAPSHOT_PROJECT = "chromium";

/**
 * Playwright suffixes baselines with `process.platform`. Only Linux baselines
 * are committed, because the hosted runner that arbitrates the pixel diff is
 * the sole platform whose captures every contributor must reproduce.
 */
const SNAPSHOT_PLATFORM = "linux";

/**
 * Filenames the tracked snapshot directory must contain, exactly — sorted so
 * callers can diff or print the inventory deterministically.
 */
export function expectedSnapshotNames(): string[] {
  const names: string[] = [];
  for (const viewport of VISUAL_VIEWPORTS) {
    for (const route of VISUAL_ROUTES) {
      names.push(
        `${route.name}-${viewport.name}-${SNAPSHOT_PROJECT}-${SNAPSHOT_PLATFORM}.png`,
      );
    }
  }
  return names.sort();
}
