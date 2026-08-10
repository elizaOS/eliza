/**
 * Verifies the streamed Browser surface against measured viewport and input
 * contracts with the transport client deterministic at the process boundary.
 */
// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  client: {
    resizeBrowserWorkspaceTab: vi.fn().mockResolvedValue({ ok: true }),
    sendBrowserWorkspaceInput: vi.fn().mockResolvedValue({ ok: true }),
    streamBrowserWorkspaceTabFrames: vi.fn(),
  },
}));

import { type BrowserWorkspaceFrame, client } from "../../api";
import { BrowserWorkspaceStreamSurface } from "./BrowserWorkspaceStreamSurface";

beforeEach(() => {
  vi.mocked(client.resizeBrowserWorkspaceTab).mockResolvedValue({ ok: true });
  vi.mocked(client.sendBrowserWorkspaceInput).mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BrowserWorkspaceStreamSurface", () => {
  it("holds the stale default-aspect frame until Chromium matches the measured panel", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    let emitFrame: ((frame: BrowserWorkspaceFrame) => void) | undefined;

    class TestResizeObserver implements ResizeObserver {
      readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      disconnect = vi.fn();

      observe = (target: Element): void => {
        this.callback(
          [
            {
              contentRect: DOMRect.fromRect({ height: 1_049, width: 527 }),
              target,
            } as ResizeObserverEntry,
          ],
          this,
        );
      };

      unobserve = vi.fn();
    }

    try {
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
      rectSpy.mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("data-testid") ===
          "browser-workspace-stream-surface"
          ? DOMRect.fromRect({ height: 1_049, width: 527 })
          : DOMRect.fromRect();
      });
      vi.mocked(client.streamBrowserWorkspaceTabFrames).mockImplementation(
        async (_tabId, onFrame) => {
          emitFrame = onFrame;
          onFrame({
            data: "c3RhbGU=",
            height: 800,
            timestamp: 1,
            width: 1_280,
          });
          return {
            close: async () => undefined,
            done: new Promise<void>(() => {}),
          };
        },
      );

      render(<BrowserWorkspaceStreamSurface tabId="tab-1" title="Apple" />);
      const image = screen.getByRole("application", { name: "Apple" })
        .firstElementChild as HTMLImageElement;

      await waitFor(() =>
        expect(client.resizeBrowserWorkspaceTab).toHaveBeenCalledWith("tab-1", {
          deviceScaleFactor: 1,
          height: 1_049,
          width: 527,
        }),
      );
      expect(image.getAttribute("src")).toBeNull();

      act(() => {
        emitFrame?.({
          data: "bWF0Y2hlZA==",
          height: 1_049,
          timestamp: 2,
          width: 527,
        });
      });
      await waitFor(() =>
        expect(image.getAttribute("src")).toBe(
          "data:image/jpeg;base64,bWF0Y2hlZA==",
        ),
      );
    } finally {
      rectSpy.mockRestore();
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    }
  });
});
