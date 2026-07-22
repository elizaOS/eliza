/** Verifies model-tester-app.ts registers the overlay app and shell page on import and that its exit affordance navigates through the shell's navigate-view event (not raw history) — the UI registries and the navigate-view dispatch are mocked, so this is a deterministic check. */

import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const registerAppShellPage = vi.hoisted(() => vi.fn());
const registerOverlayApp = vi.hoisted(() => vi.fn());
const dispatchNavigateViewEvent = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/shared/events", () => ({
  dispatchNavigateViewEvent,
}));

vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerAppShellPage,
}));

vi.mock("@elizaos/ui/components/apps/overlay-app-registry", () => ({
  registerOverlayApp,
}));

vi.mock("./ModelTesterAppView.js", () => ({
  ModelTesterAppView: () => null,
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
    expect(registerAppShellPage).toHaveBeenCalledTimes(1);
    expect(registerAppShellPage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "model-tester",
        pluginId: MODEL_TESTER_APP_NAME,
        path: "/model-tester",
      }),
    );
  });

  it("exits to the apps launcher via the shell navigate-view event, never raw history", async () => {
    // The shell page hands the view an `exitToApps` prop. A view mounted under a
    // surface-realm scope may not call history.pushState directly (the #15247
    // guard denies it without the `navigate` grant); it must ask the shell. This
    // pins that contract so a regression back to raw pushState fails here rather
    // than only in the app-window e2e.
    await import("./model-tester-app");
    const registration = registerAppShellPage.mock.calls[0]?.[0] as {
      loader: () => Promise<{ default: () => ReactElement }>;
    };
    const loaded = await registration.loader();
    const element = loaded.default();
    const exitToApps = (element.props as { exitToApps: () => void }).exitToApps;

    exitToApps();

    expect(dispatchNavigateViewEvent).toHaveBeenCalledTimes(1);
    expect(dispatchNavigateViewEvent).toHaveBeenCalledWith({
      viewPath: "/apps",
    });
  });
});
