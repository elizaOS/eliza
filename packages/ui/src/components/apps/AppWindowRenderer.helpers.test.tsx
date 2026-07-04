// @vitest-environment jsdom

/**
 * Covers `getOverlayAppLazyComponent` — the per-loader lazy-component cache and
 * its retained-lazy warm-up — in jsdom with a stubbed `requestIdleCallback`.
 * Overlay apps are in-memory fixtures; no real plugin modules are loaded.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRetainedLazyModulesForTests } from "../../retained-lazy";
import { getOverlayAppLazyComponent } from "./AppWindowRenderer.helpers";
import type { OverlayApp, OverlayAppContext } from "./overlay-app-api";

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

  it("renders the recoverable 'Failed to load view' card when the overlay bundle fails, and Retry re-imports", async () => {
    // Regression: an overlay app whose lazy bundle rejected used to render a
    // blank white screen (fallback:null, no onError). It must now show the SAME
    // recoverable card as a remote view.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let attempt = 0;
    const app: OverlayApp = {
      name: "test.overlay.broken",
      displayName: "Broken Overlay",
      description: "Broken overlay",
      category: "test",
      icon: null,
      loader: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("Failed to fetch dynamically imported module");
        }
        return {
          default: function RecoveredOverlay() {
            return <div>Overlay recovered</div>;
          },
        };
      },
    };

    const Overlay = getOverlayAppLazyComponent(app);
    expect(Overlay).toBeTruthy();
    if (!Overlay) return;

    const { container } = render(
      <Overlay exitToApps={() => {}} uiTheme="light" t={(key) => key} />,
    );

    // The card is actually mounted — a blank screen would render none of this.
    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.getByText("Failed to load view")).toBeTruthy();
    expect(screen.getByText("View ID: test.overlay.broken")).toBeTruthy();
    expect(container.textContent).not.toBe("");

    await act(async () => {
      retry.click();
    });

    await screen.findByText("Overlay recovered");
    expect(screen.queryByText("Failed to load view")).toBeNull();
    consoleError.mockRestore();
  });

  it("renders the error card when the overlay module lacks a renderable default export", async () => {
    const app: OverlayApp = {
      name: "test.overlay.noexport",
      displayName: "No Export Overlay",
      description: "No export overlay",
      category: "test",
      icon: null,
      loader: async () => ({
        default: undefined as unknown as ComponentType<OverlayAppContext>,
      }),
    };

    const Overlay = getOverlayAppLazyComponent(app);
    expect(Overlay).toBeTruthy();
    if (!Overlay) return;

    render(<Overlay exitToApps={() => {}} uiTheme="light" t={(key) => key} />);

    await screen.findByText("Failed to load view");
    expect(screen.getByText("View ID: test.overlay.noexport")).toBeTruthy();
  });
});
