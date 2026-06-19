// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRetainedLazyModulesForTests } from "../../retained-lazy";
import { getOverlayAppLazyComponent } from "./AppWindowRenderer.helpers";
import type { OverlayApp } from "./overlay-app-api";

describe("getOverlayAppLazyComponent", () => {
  beforeEach(() => {
    __resetRetainedLazyModulesForTests();
    (
      window as Window & {
        requestIdleCallback?: (
          cb: IdleRequestCallback,
          options?: IdleRequestOptions,
        ) => number;
      }
    ).requestIdleCallback = (cb) => {
      cb({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    };
  });

  afterEach(() => {
    cleanup();
    __resetRetainedLazyModulesForTests();
    delete (window as Partial<Window>).requestIdleCallback;
  });

  it("uses a stable retained wrapper and cleans up after pressure", async () => {
    const cleanupModule = vi.fn();
    const app: OverlayApp = {
      name: "test.overlay",
      displayName: "Test Overlay",
      description: "Test overlay",
      category: "test",
      icon: null,
      loader: async () => ({
        default: function TestOverlay() {
          return <div>Overlay loaded</div>;
        },
        cleanup: cleanupModule,
      }),
    };

    const Overlay = getOverlayAppLazyComponent(app);
    expect(Overlay).toBe(getOverlayAppLazyComponent(app));
    expect(Overlay).toBeTruthy();
    if (!Overlay) return;

    const rendered = render(
      <Overlay exitToApps={() => {}} uiTheme="light" t={(key) => key} />,
    );
    await screen.findByText("Overlay loaded");
    rendered.unmount();

    expect(cleanupModule).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupModule).toHaveBeenCalledTimes(1));
  });
});
