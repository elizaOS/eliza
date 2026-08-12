/**
 * @vitest-environment jsdom
 *
 * Proves the renderer registration entry through the REAL renderer-service
 * registry (`@elizaos/ui/platform/renderer-services` is anchored to source in
 * this package's vitest config — no mocked lifecycle) driving the REAL capture
 * controller: importing `register.ts` registers a main-scoped service without
 * starting any work, a popout/detached host never starts the capture, a main
 * host starts it, and disposing the host stops it (listeners removed, restart
 * possible). Only the HTTP client and native bridges are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // The client-lifeops / client-calendar extension modules (side-effect
  // imports of the capture) install methods onto ElizaClient.prototype at
  // module scope; give the mock a real class so those installs land.
  ElizaClient: class ElizaClient {},
  getStatus: vi.fn(async () => ({ state: "running" })),
  captureLifeOpsActivitySignal: vi.fn(async () => ({
    signal: { id: "sig-1" },
  })),
  isApiError: vi.fn((_error: unknown) => false),
  isAuthenticatedNow: vi.fn(() => true),
  subscribeAuthStatus: vi.fn(() => () => undefined),
  isElectrobunRuntime: vi.fn(() => false),
  loadDesktopWorkspaceSnapshot: vi.fn(async () => ({ supported: false })),
}));

// The four @elizaos/ui subpath specifiers (/api, /bridge, /browser, /events)
// alias to one stub file under this package's vitest config, so each mock
// carries the full export surface the capture module reads — the last mock
// registered for the shared file wins.
vi.mock("@elizaos/ui/api", () => ({
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  subscribeAuthStatus: h.subscribeAuthStatus,
  ElizaClient: h.ElizaClient,
  isElectrobunRuntime: h.isElectrobunRuntime,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
}));
vi.mock("@elizaos/ui/bridge", () => ({
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  subscribeAuthStatus: h.subscribeAuthStatus,
  ElizaClient: h.ElizaClient,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
}));
vi.mock("@elizaos/ui/events", () => ({
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  subscribeAuthStatus: h.subscribeAuthStatus,
  ElizaClient: h.ElizaClient,
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
}));
vi.mock("@elizaos/ui/browser", () => ({
  loadDesktopWorkspaceSnapshot: h.loadDesktopWorkspaceSnapshot,
  isElectrobunRuntime: h.isElectrobunRuntime,
  isApiError: h.isApiError,
  isAuthenticatedNow: h.isAuthenticatedNow,
  subscribeAuthStatus: h.subscribeAuthStatus,
  ElizaClient: h.ElizaClient,
  APP_PAUSE_EVENT: "eliza:app-pause",
  APP_RESUME_EVENT: "eliza:app-resume",
  client: {
    getStatus: h.getStatus,
    captureLifeOpsActivitySignal: h.captureLifeOpsActivitySignal,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: vi.fn(() => "web"),
    isNativePlatform: vi.fn(() => false),
  },
}));

// Web-platform run: the capture never touches MobileSignals, but the module
// must still resolve without the Capacitor plugin registry.
vi.mock("@elizaos/capacitor-mobile-signals", () => ({ MobileSignals: {} }));

import {
  getRendererServiceStates,
  settleRendererServices,
  startRendererServiceHost,
} from "@elizaos/ui/platform/renderer-services";
import { isLifeOpsActivitySignalCaptureActive } from "./lifeops/activity-signals-capture.js";
// Side-effect import under test: registers the renderer service definition.
import "./register.js";

const SERVICE_ID = "personal-assistant.lifeops-activity-signals";

function serviceState() {
  return getRendererServiceStates().services.find((s) => s.id === SERVICE_ID);
}

async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("personal-assistant renderer registration entry", () => {
  let host: { dispose: () => void } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    h.getStatus.mockResolvedValue({ state: "running" });
  });

  afterEach(async () => {
    host?.dispose();
    host = undefined;
    await settle();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
  });

  it("registers the main-scoped service at import time without starting capture", () => {
    const state = serviceState();
    expect(state).toBeDefined();
    expect(state?.shells).toEqual(["main"]);
    // No host installed in this environment yet: nothing may have started.
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("never starts the capture in popout or detached window shells", async () => {
    host = startRendererServiceHost({ shell: "popout" });
    await settleRendererServices();
    expect(serviceState()?.status).toBe("ineligible");
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(h.getStatus).not.toHaveBeenCalled();
    host.dispose();

    host = startRendererServiceHost({ shell: "detached" });
    await settleRendererServices();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(h.getStatus).not.toHaveBeenCalled();
  });

  it("starts the capture under a main-shell host and stops it on dispose", async () => {
    const removeDoc = vi.spyOn(document, "removeEventListener");

    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(serviceState()?.status).toBe("running");
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    await settle();
    // The real capture probed the runtime and posted presence.
    expect(h.getStatus).toHaveBeenCalled();
    expect(h.captureLifeOpsActivitySignal).toHaveBeenCalled();

    host.dispose();
    host = undefined;
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    expect(removeDoc).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    removeDoc.mockRestore();
  });

  it("re-initializes on host replacement (old capture stopped, new one running)", async () => {
    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    const firstProbeCount = h.getStatus.mock.calls.length;

    // A replacement host (repeated boot / shell HMR) must stop the old
    // instance and start a fresh one — not stack a second capture.
    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);
    expect(serviceState()?.status).toBe("running");
    await settle();
    expect(h.getStatus.mock.calls.length).toBeGreaterThan(firstProbeCount);
  });

  it("tears down on pagehide (page teardown)", async () => {
    host = startRendererServiceHost({ shell: "main" });
    await settleRendererServices();
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(true);

    window.dispatchEvent(new Event("pagehide"));
    expect(isLifeOpsActivitySignalCaptureActive()).toBe(false);
    host = undefined;
  });
});
