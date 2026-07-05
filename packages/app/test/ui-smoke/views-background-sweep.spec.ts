// Real-browser sweep of the unified-background contract (#9143 / #13452 /
// #13538) across the `backgroundPolicy: "shared"` surfaces BEYOND Settings.
// settings-background.spec.ts already owns the Settings no-opaque-ancestor +
// shader assertion end to end (its own routed-shell mount setup); this spec
// runs the SAME assertion — via the shared `assertNoOpaqueBackgroundAncestor`
// helper, parameterized by a per-view shell selector — on the OTHER shared
// surface the #13538 backgrounds catalog can regress: the /chat overlay. That
// generalizes the guard so a new catalog background can't reintroduce an opaque
// layer over the wallpaper on the chat surface, at desktop and mobile.
//
// Scope note: only views declaring `backgroundPolicy: "shared"` (chat, settings,
// launcher) sit on the unified fixed wallpaper; every OTHER view is `"opaque"` by
// design (App.tsx normalizeBackgroundPolicy default) and correctly paints its own
// `bg-bg`, so this no-opaque-ancestor rule does not apply to them — asserting it
// there would be a false positive. Settings is deliberately NOT re-tested here:
// its shared-shell mount needs the dedicated settings route+bridge setup that
// settings-background.spec.ts already provides, and duplicating it would add no
// coverage. The VIEW_CASES table + parameterized helper are the seam for adding
// the launcher (or any future shared surface) without re-deriving the assertion.
// Each shared surface is seeded over a known shader wallpaper so the fixed
// background actually mounts.

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

// Only `backgroundPolicy: "shared"` surfaces belong here (see the scope note in
// the header). Settings is owned by settings-background.spec.ts; this sweep adds
// the OTHER shared surface — /chat — and is the drop-in seam for the launcher.
const VIEW_CASES: readonly ViewCase[] = [
  {
    name: "chat",
    path: "/chat",
    // The /chat route floats the ContinuousChatOverlay over the ambient home;
    // the overlay is the stable per-view marker to walk up from.
    shellSelector: '[data-testid="continuous-chat-overlay"]',
    readySelector: '[data-testid="chat-composer-textarea"]',
  },
];

const VIEWPORTS = [
  { name: "desktop", size: { width: 1280, height: 900 } },
  { name: "mobile", size: { width: 390, height: 844 } },
] as const;

/**
 * A "running" desktop status bridge so the shell leaves the boot screen and
 * mounts the routed view (matches settings-background.spec.ts's ready bridge).
 */
async function installReadyDesktopStatusBridge(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(() => {
    type Bridge = {
      request?: Record<string, (params?: unknown) => Promise<unknown>>;
      onMessage?: (m: string, l: (p: unknown) => void) => void;
      offMessage?: (m: string, l: (p: unknown) => void) => void;
    };
    const win = window as Window & { __ELIZA_ELECTROBUN_RPC__?: Bridge };
    const existing = win.__ELIZA_ELECTROBUN_RPC__;
    const now = Date.now();
    const readyStatus = {
      state: "running",
      agentName: "Playwright Smoke",
      model: "ui-smoke",
      uptime: 60_000,
      startedAt: now - 60_000,
      pendingRestart: false,
      pendingRestartReasons: [],
      startup: { phase: "running", attempt: 0 },
    };
    win.__ELIZA_ELECTROBUN_RPC__ = {
      request: {
        ...(existing?.request ?? {}),
        agentGetStatus: async () => readyStatus,
        permissionsGetAll: async () => ({}),
        permissionsIsShellEnabled: async () => false,
        permissionsGetPlatform: async () => "linux",
      },
      onMessage: existing?.onMessage ?? (() => {}),
      offMessage: existing?.offMessage ?? (() => {}),
    };
  });
}

test.beforeEach(async ({ page }) => {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  // A known shader wallpaper so the fixed unified background mounts and the
  // no-opaque-ancestor assertion has a wallpaper to protect.
  await seedBackgroundStorage(page, { mode: "shader", color: "#ef5a1f" });
  await installReadyDesktopStatusBridge(page);
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
