// Real-browser sweep of the unified-background contract (#9143 / #13452 /
// #13538) across MULTIPLE views, not just Settings. settings-background.spec.ts
// proved Settings' routed shell is transparent and paints no opaque `bg-bg`
// over the wallpaper; this spec runs the SAME no-opaque-ancestor assertion —
// via the shared `assertNoOpaqueBackgroundAncestor` helper, parameterized by a
// per-view shell selector — across chat / knowledge / wallet / browser at both
// desktop and mobile, so the #13538 backgrounds catalog can't reintroduce an
// opaque layer on any of them. Each view is seeded over a known shader
// wallpaper so the fixed background actually mounts.

import { expect, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  assertNoOpaqueBackgroundAncestor,
  seedBackgroundStorage,
} from "./helpers/view-background";

interface ViewCase {
  name: string;
  path: string;
  /** The shell selector the seam walk starts from (a known-rendered marker). */
  shellSelector: string;
  /** The selector to wait for before asserting (the view has mounted). */
  readySelector: string;
}

const VIEW_CASES: readonly ViewCase[] = [
  {
    name: "chat",
    path: "/chat",
    // The /chat route floats the ContinuousChatOverlay over the ambient home;
    // the overlay's composer is the stable per-view marker to walk up from.
    shellSelector: '[data-testid="continuous-chat-overlay"]',
    readySelector: '[data-testid="chat-composer-textarea"]',
  },
  {
    name: "knowledge (documents)",
    path: "/documents",
    shellSelector: '[data-testid="documents-view"]',
    readySelector: '[data-testid="documents-view"]',
  },
  {
    name: "wallet",
    path: "/wallet",
    shellSelector: '[data-testid="wallet-shell"]',
    readySelector: '[data-testid="wallet-shell"]',
  },
  {
    name: "browser",
    path: "/browser",
    shellSelector: '[data-testid="browser-workspace-address-input"]',
    readySelector: '[data-testid="browser-workspace-address-input"]',
  },
];

const VIEWPORTS = [
  { name: "desktop", size: { width: 1280, height: 900 } },
  { name: "mobile", size: { width: 390, height: 844 } },
] as const;

test.beforeEach(async ({ page }) => {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  // A known shader wallpaper so the fixed unified background mounts and the
  // no-opaque-ancestor assertion has a wallpaper to protect.
  await seedBackgroundStorage(page, { mode: "shader", color: "#ef5a1f" });
  await installDefaultAppRoutes(page);
});

for (const viewport of VIEWPORTS) {
  for (const view of VIEW_CASES) {
    test(`${viewport.name}: ${view.name} paints no opaque bg-bg over the wallpaper`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport.size);
      await openAppPath(page, view.path);

      await expect(page.locator(view.readySelector).first()).toBeVisible({
        timeout: 60_000,
      });
      // The unified shader background must be mounted behind the shell. It is
      // aria-hidden + pointer-events-none + fixed, so assert ATTACHED (painting)
      // rather than Playwright-"visible".
      await expect(page.getByTestId("app-background-shader")).toBeAttached({
        timeout: 15_000,
      });

      const seam = await assertNoOpaqueBackgroundAncestor(
        page,
        view.shellSelector,
        `${viewport.name} ${view.name}`,
      );
      expect(seam.backgroundKind).toBe("shader");

      await expectNoPageDiagnostics(page, testInfo.title);
    });
  }
}
