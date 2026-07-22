/** Verifies the browser barrel links its local stubs and iOS smoke contract. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", () => ({
  registerDetailExtension: vi.fn(),
  registerOverlayApp: vi.fn(),
  resolveAppBranding: vi.fn(),
}));
vi.mock("@elizaos/ui/api", () => ({ client: {} }));
vi.mock("@elizaos/ui/browser", () => ({ ErrorBoundary: vi.fn() }));
vi.mock("@elizaos/ui/components/apps/extensions/surface", () => ({
  SurfaceBadge: vi.fn(),
  SurfaceCard: vi.fn(),
  SurfaceEmptyState: vi.fn(),
  SurfaceGrid: vi.fn(),
  SurfaceSection: vi.fn(),
}));
vi.mock("@elizaos/ui/components/apps/extensions/surface.helpers", () => ({
  formatDetailTimestamp: vi.fn(),
  selectLatestRunForApp: vi.fn(),
  toneForHealthState: vi.fn(),
  toneForStatusText: vi.fn(),
  toneForViewerAttachment: vi.fn(),
}));
vi.mock("@elizaos/ui/components/composites/page-panel", () => ({
  PagePanel: vi.fn(),
}));
vi.mock("@elizaos/ui/components/ui/button", () => ({ Button: vi.fn() }));
vi.mock("@elizaos/ui/components/ui/input", () => ({ Input: vi.fn() }));
vi.mock("@elizaos/ui/components/ui/spinner", () => ({ Spinner: vi.fn() }));
vi.mock("@elizaos/ui/platform/ios-runtime", () => ({
  resolveIosRuntimeConfig: vi.fn(),
}));
vi.mock("@elizaos/ui/state/useApp", () => ({ useApp: vi.fn() }));
vi.mock("./api/automation-node-contributors", () => ({
  registerAutomationNodeContributor: vi.fn(),
}));
vi.mock("./platform/ios-runtime-bridge", () => ({
  IOS_FULL_BUN_SMOKE_REQUEST_KEY: "eliza:ios-full-bun-smoke:request",
  IOS_FULL_BUN_SMOKE_RESULT_KEY: "eliza:ios-full-bun-smoke:result",
  runIosFullBunSmokeIfRequested: vi.fn(),
}));
vi.mock("./runtime/desktop", () => ({
  buildLocalizedTrayMenu: vi.fn(),
  DESKTOP_TRAY_MENU_ITEMS: [],
  DesktopSurfaceNavigationRuntime: class {},
  DesktopTrayRuntime: class {},
  DetachedShellRoot: vi.fn(),
}));
vi.mock("./runtime/desktop/AppWindowRenderer", () => ({
  AppWindowRenderer: vi.fn(),
}));
vi.mock("./services/task-host-capabilities", () => ({
  getHostExecutionCapabilities: vi.fn(),
}));

describe("browser-safe app-core barrel", () => {
  it("exports the iOS smoke entrypoint, keys, and inert compatibility stubs", async () => {
    const browser = await import("./browser");
    expect(browser.IOS_FULL_BUN_SMOKE_REQUEST_KEY).toBe(
      "eliza:ios-full-bun-smoke:request",
    );
    expect(browser.IOS_FULL_BUN_SMOKE_RESULT_KEY).toBe(
      "eliza:ios-full-bun-smoke:result",
    );
    expect(browser.runIosFullBunSmokeIfRequested).toBeTypeOf("function");
    expect(browser.sendJson(null, 200, {})).toBeUndefined();
    expect(browser.sendJsonError(null, 500, "error")).toBeUndefined();
    await expect(browser.ensureRouteAuthorized()).resolves.toBe(false);
    await expect(browser.ensureCompatApiAuthorized()).resolves.toBe(false);
    await expect(browser.readCompatJsonBody()).resolves.toBeNull();
    expect(() => browser.sharedVault()).toThrow("sharedVault is server-only");
  });
});
