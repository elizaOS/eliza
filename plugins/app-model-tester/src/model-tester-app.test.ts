import { describe, expect, it, vi } from "vitest";

const registerAppShellPage = vi.hoisted(() => vi.fn());
const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerAppShellPage,
}));

vi.mock("@elizaos/ui/components/apps/overlay-app-registry", () => ({
  registerOverlayApp,
}));

vi.mock("./ModelTesterAppView.js", () => ({
  ModelTesterAppView: () => null,
  ModelTesterTuiView: () => null,
}));

describe("model tester app registration", () => {
  it("registers the overlay and shell pages when imported", async () => {
    const { MODEL_TESTER_APP_NAME, modelTesterApp } = await import(
      "./model-tester-app"
    );

    expect(modelTesterApp).toMatchObject({
      name: MODEL_TESTER_APP_NAME,
      displayName: "Model Tester",
      category: "system",
    });
    expect(modelTesterApp.loader).toEqual(expect.any(Function));
    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(modelTesterApp);
    expect(registerAppShellPage).toHaveBeenCalledTimes(2);
    expect(registerAppShellPage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "model-tester",
        pluginId: MODEL_TESTER_APP_NAME,
        path: "/model-tester",
      }),
    );
    expect(registerAppShellPage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "model-tester.tui",
        pluginId: MODEL_TESTER_APP_NAME,
        path: "/model-tester/tui",
      }),
    );
  });
});
