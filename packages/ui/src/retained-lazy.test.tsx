// @vitest-environment jsdom

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
          reason: "app-pause",
        }),
        expect.objectContaining({
          source: "retained-lazy",
          action: "cleanup",
          reason: "app-pause",
        }),
      ]),
    );
  });
});
