import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const diagnostics = [
  { title: "Build finished", body: "Ready", timestamp: 42 },
];
const clearNotificationDiagnostics = vi.fn(() => diagnostics.splice(0));
const getNotificationDiagnostics = vi.fn(() => [...diagnostics]);
const desktop = {
  clearNotificationDiagnostics,
  focusWindow: vi.fn(async () => undefined),
  getNotificationDiagnostics,
  getShellDiagnosticsState: vi.fn(async () => ({ mainWindowPresent: true })),
  minimizeWindow: vi.fn(async () => undefined),
  showWindow: vi.fn(async () => undefined),
};

vi.mock("../platforms/electrobun/src/native/desktop", () => ({
  getDesktopManager: () => desktop,
}));
vi.mock("../platforms/electrobun/src/native/loopback-port", () => ({
  findFirstAvailableLoopbackPort: async () => 31_349,
}));
vi.mock("../platforms/electrobun/src/application-menu-action-registry", () => ({
  invokeApplicationMenuAction: vi.fn(),
}));
vi.mock("../platforms/electrobun/src/main-window-runtime", () => ({
  evaluateInCurrentMainWindow: vi.fn(async (script: string) => `ran:${script}`),
  getCurrentMainWindowSnapshot: vi.fn(() => ({ present: true })),
}));
vi.mock("../platforms/electrobun/src/native/screencapture", () => ({
  getScreenCaptureManager: vi.fn(),
}));

const TOKEN = "notification-route-test-token";
const BASE_URL = "http://127.0.0.1:31349";
let stop: (() => void) | undefined;

describe("desktop test bridge notification observation route", () => {
  beforeAll(async () => {
    process.env.ELIZA_DESKTOP_TEST_BRIDGE_ENABLED = "1";
    process.env.ELIZA_DESKTOP_TEST_BRIDGE_PORT = "31349";
    process.env.ELIZA_DESKTOP_TEST_BRIDGE_TOKEN = TOKEN;
    const { startDesktopTestBridgeServer } = await import(
      "../platforms/electrobun/src/desktop-test-bridge-server"
    );
    stop = await startDesktopTestBridgeServer();
  });

  afterAll(() => {
    stop?.();
    delete process.env.ELIZA_DESKTOP_TEST_BRIDGE_ENABLED;
    delete process.env.ELIZA_DESKTOP_TEST_BRIDGE_PORT;
    delete process.env.ELIZA_DESKTOP_TEST_BRIDGE_TOKEN;
    delete process.env.ELIZA_DESKTOP_TEST_BRIDGE_URL;
  });

  it("rejects unauthenticated observation before touching DesktopManager", async () => {
    const response = await fetch(`${BASE_URL}/notifications`);
    expect(response.status).toBe(401);
    expect(getNotificationDiagnostics).not.toHaveBeenCalled();
  });

  it("keeps authenticated bridge control ingress live", async () => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    expect(await (await fetch(`${BASE_URL}/health`, { headers })).json()).toEqual({ ok: true });
    expect((await fetch(`${BASE_URL}/state`, { headers })).status).toBe(200);

    const invalidEval = await fetch(`${BASE_URL}/main-window/eval`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(invalidEval.status).toBe(400);
    const evaluated = await fetch(`${BASE_URL}/main-window/eval`, {
      method: "POST",
      headers,
      body: JSON.stringify({ script: "1 + 1" }),
    });
    expect(await evaluated.json()).toEqual({ result: "ran:1 + 1" });

    for (const action of ["show", "focus", "minimize"]) {
      expect((await fetch(`${BASE_URL}/main-window/${action}`, { method: "POST", headers })).status).toBe(200);
    }
  });

  it("observes and clears notifications through the canonical DesktopManager boundary", async () => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const observed = await fetch(`${BASE_URL}/notifications`, { headers });
    expect(observed.status).toBe(200);
    expect(await observed.json()).toEqual({ notifications: diagnostics });
    expect(getNotificationDiagnostics).toHaveBeenCalledOnce();

    const cleared = await fetch(`${BASE_URL}/notifications`, {
      method: "DELETE",
      headers,
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });
    expect(clearNotificationDiagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual([]);
  });
});
