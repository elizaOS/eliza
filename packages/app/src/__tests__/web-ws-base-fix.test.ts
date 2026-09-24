import { afterEach, expect, it, vi } from "vitest";

const setApiBase = vi.hoisted(() => vi.fn());
vi.mock("@elizaos/shared", () => ({ setElizaApiBase: setApiBase }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock("@elizaos/ui/bridge", () => ({ isElectrobunRuntime: () => false }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each(["ws://api.example.test", "wss://api.example.test"])(
  "preserves explicit remote endpoint %s",
  async (endpoint) => {
    vi.resetModules();
    const win = {
      location: new URL("https://app.example.test"),
      __ELIZA_WS_BASE__: endpoint,
      __ELIZAOS_WS_BASE__: "ws://127.0.0.1:31337",
    };
    vi.stubGlobal("window", win);
    await import("../web-ws-base-fix");
    expect(win.__ELIZA_WS_BASE__).toBe(endpoint);
    expect(setApiBase).not.toHaveBeenCalled();
  },
);
it("repairs the injected desktop loopback endpoint", async () => {
  vi.resetModules();
  const win = {
    location: new URL("https://app.example.test"),
    __ELIZA_WS_BASE__: "ws://127.0.0.1:31337",
  };
  vi.stubGlobal("window", win);
  await import("../web-ws-base-fix");
  expect(win.__ELIZA_WS_BASE__).toBe("wss://app.example.test");
  expect(setApiBase).toHaveBeenCalledWith("https://app.example.test");
});
