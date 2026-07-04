// @vitest-environment jsdom

/**
 * Unit coverage for the retained-lazy loader: modules stay resolved across
 * unmount/remount, cache-eviction telemetry fires, and app-pause frees them.
 * React Testing Library render, no real module graph.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODULE_CACHE_TELEMETRY_EVENT,
  type ModuleCacheTelemetryEvent,
} from "./cache-telemetry";
import { APP_PAUSE_EVENT } from "./events";
import {
  __resetRetainedLazyModulesForTests,
  RetainedLazyComponent,
  type RetainedLazyModule,
} from "./retained-lazy";
import { __resetHeapPressureMonitorForTests } from "./state/heap-pressure-monitor";

interface TestProps {
  label: string;
}

describe("RetainedLazyComponent", () => {
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
    __resetHeapPressureMonitorForTests();
    delete (window as Partial<Window>).requestIdleCallback;
  });

  it("retains an inactive module and cleans it up under memory pressure", async () => {
    const cleanupModule = vi.fn();
    const loader = vi.fn(
      async (): Promise<RetainedLazyModule<TestProps>> => ({
        default: function TestPanel({ label }: TestProps) {
          return <div>{label}</div>;
        },
        cleanup: cleanupModule,
      }),
    );

    const rendered = render(
      <RetainedLazyComponent
        loader={loader}
        componentProps={{ label: "retained panel" }}
      />,
    );
    await screen.findByText("retained panel");
    rendered.unmount();

    expect(cleanupModule).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupModule).toHaveBeenCalledTimes(1));
  });

  it("does not evict an active module during memory pressure", async () => {
    const cleanupModule = vi.fn();
    const loader = vi.fn(
      async (): Promise<RetainedLazyModule<TestProps>> => ({
        default: function TestPanel({ label }: TestProps) {
          return <div>{label}</div>;
        },
        cleanup: cleanupModule,
      }),
    );

    const rendered = render(
      <RetainedLazyComponent
        loader={loader}
        componentProps={{ label: "active panel" }}
      />,
    );
    await screen.findByText("active panel");

    window.dispatchEvent(new Event("memorypressure"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(cleanupModule).not.toHaveBeenCalled();

    rendered.unmount();
    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupModule).toHaveBeenCalledTimes(1));
  });

  it("cleans up a pending module evicted before import resolution", async () => {
    const cleanupModule = vi.fn();
    let resolveLoader:
      | ((module: RetainedLazyModule<TestProps>) => void)
      | undefined;
    const loader = vi.fn(
      () =>
        new Promise<RetainedLazyModule<TestProps>>((resolve) => {
          resolveLoader = resolve;
        }),
    );

    const rendered = render(
      <RetainedLazyComponent
        loader={loader}
        componentProps={{ label: "late panel" }}
      />,
    );
    rendered.unmount();
    window.dispatchEvent(new Event("memorypressure"));

    act(() => {
      resolveLoader?.({
        default: function LatePanel({ label }: TestProps) {
          return <div>{label}</div>;
        },
        cleanup: cleanupModule,
      });
    });

    await waitFor(() => expect(cleanupModule).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("late panel")).toBeNull();
  });

  it("evicts inactive modules on app pause and emits cache telemetry", async () => {
    const events: ModuleCacheTelemetryEvent[] = [];
    const onTelemetry = (event: Event) => {
      events.push((event as CustomEvent<ModuleCacheTelemetryEvent>).detail);
    };
    window.addEventListener(MODULE_CACHE_TELEMETRY_EVENT, onTelemetry);
    const cleanupModule = vi.fn();
    const loader = vi.fn(
      async (): Promise<RetainedLazyModule<TestProps>> => ({
        default: function TestPanel({ label }: TestProps) {
          return <div>{label}</div>;
        },
        cleanup: cleanupModule,
      }),
    );

    const rendered = render(
      <RetainedLazyComponent
        loader={loader}
        cacheKey="pause-panel"
        componentProps={{ label: "pause panel" }}
      />,
    );
    await screen.findByText("pause panel");
    rendered.unmount();

    document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    await waitFor(() => expect(cleanupModule).toHaveBeenCalledTimes(1));
    window.removeEventListener(MODULE_CACHE_TELEMETRY_EVENT, onTelemetry);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "retained-lazy",
          action: "load",
        }),
        expect.objectContaining({
          source: "retained-lazy",
          action: "evict",
          key: "pause-panel",
          reason: "app-pause",
        }),
        expect.objectContaining({
          source: "retained-lazy",
          action: "cleanup",
          key: "pause-panel",
          reason: "app-pause",
        }),
      ]),
    );
  });

  it("surfaces onError with a working retry when the loader rejects (never blank)", async () => {
    let attempt = 0;
    const loader = vi.fn(async (): Promise<RetainedLazyModule<TestProps>> => {
      attempt += 1;
      if (attempt === 1) throw new Error("bundle 404");
      return {
        default: function OkPanel({ label }: TestProps) {
          return <div>{label}</div>;
        },
      };
    });

    render(
      <RetainedLazyComponent
        loader={loader}
        componentProps={{ label: "recovered lazy" }}
        onError={(error, retry) => (
          <div>
            <span data-testid="lazy-error">{error.message}</span>
            <button type="button" onClick={retry}>
              retry-lazy
            </button>
          </div>
        )}
      />,
    );

    const retryButton = await screen.findByText("retry-lazy");
    expect(screen.getByTestId("lazy-error").textContent).toBe("bundle 404");

    await act(async () => {
      retryButton.click();
    });

    await screen.findByText("recovered lazy");
    expect(screen.queryByTestId("lazy-error")).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("surfaces onError when the module has no renderable default export (mode 3, not blank)", async () => {
    const loader = vi.fn(
      async () =>
        ({ default: undefined }) as unknown as RetainedLazyModule<TestProps>,
    );

    render(
      <RetainedLazyComponent
        loader={loader}
        componentProps={{ label: "x" }}
        onError={(error) => <div data-testid="lazy-error">{error.message}</div>}
      />,
    );

    const node = await screen.findByTestId("lazy-error");
    expect(node.textContent).toContain(
      "did not export a default React component",
    );
  });

  it("evicts inactive modules on live heap pressure and emits the heap value (#10196)", async () => {
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 950, jsHeapSizeLimit: 1000 },
    });
    const events: ModuleCacheTelemetryEvent[] = [];
    const onTelemetry = (event: Event) => {
      events.push((event as CustomEvent<ModuleCacheTelemetryEvent>).detail);
    };
    window.addEventListener(MODULE_CACHE_TELEMETRY_EVENT, onTelemetry);
    const cleanupModule = vi.fn();
    const loader = vi.fn(
      async (): Promise<RetainedLazyModule<TestProps>> => ({
        default: function TestPanel({ label }: TestProps) {
          return <div>{label}</div>;
        },
        cleanup: cleanupModule,
      }),
    );

    const rendered = render(
      <RetainedLazyComponent
        loader={loader}
        componentProps={{ label: "heap panel" }}
      />,
    );
    await screen.findByText("heap panel");
    rendered.unmount();

    // The real heap-driven signal (the never-fired `memorypressure` is replaced
    // by HEAP_PRESSURE_EVENT, sourced from the heap monitor).
    document.dispatchEvent(new CustomEvent("eliza:heap-pressure"));
    await waitFor(() => expect(cleanupModule).toHaveBeenCalledTimes(1));
    window.removeEventListener(MODULE_CACHE_TELEMETRY_EVENT, onTelemetry);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "retained-lazy",
          action: "evict",
          reason: "heap-pressure",
          // Every cache event now carries the live heap reading.
          usedJSHeapSize: 950,
        }),
      ]),
    );
    delete (performance as { memory?: unknown }).memory;
  });
});
