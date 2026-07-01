import type { Decorator } from "@storybook/react";
import { useEffect, useRef, useState } from "react";
import {
  HOME_WIDGET_MOCK_PLUGINS,
  installHomeWidgetFetchMock,
  seedHomeWidgetAppStore,
  seedHomeWidgetNotifications,
} from "../widgets/__fixtures__/home-widget-mock-data";
import { MockAppProvider } from "./mock-providers";

/**
 * Seed the home-widget data BEFORE the widget subtree renders, so each widget's
 * mount-time fetch + the app/notification stores see populated, attention-worthy
 * data. `useState`'s initializer runs synchronously on first render (ahead of
 * the children); the `useEffect` cleanup restores `window.fetch` on unmount.
 * This is the same fixture set the home-screen e2e drives — one source of mock
 * truth for the home widgets across stories AND tests.
 */
function SeededHomeWidgetData({ children }: { children: React.ReactNode }) {
  const restoreFetch = useRef<(() => void) | null>(null);
  useState(() => {
    seedHomeWidgetAppStore();
    seedHomeWidgetNotifications();
    restoreFetch.current = installHomeWidgetFetchMock();
    return null;
  });
  useEffect(() => () => restoreFetch.current?.(), []);
  return <>{children}</>;
}

/**
 * Decorator for individual home-widget stories: provides the mock app context
 * (plugin snapshot the WidgetHost resolves from) + the seeded fetch/notification
 * data, and frames the widget on the flat wallpaper surface it sits on at home
 * (approximated by a plain accent-tinted background — no card chrome, since
 * widgets are chromeless per #10708).
 */
export const withSeededHomeWidget: Decorator = (Story) => (
  <MockAppProvider
    value={{ plugins: HOME_WIDGET_MOCK_PLUGINS, conversations: [] }}
  >
    <SeededHomeWidgetData>
      <div className="w-[360px] bg-accent/20 p-3">
        <Story />
      </div>
    </SeededHomeWidgetData>
  </MockAppProvider>
);

/**
 * Story-gate play helpers — dependency-free (no `@storybook/test`, which this
 * repo does not install). A play that throws is caught by the gate as a broken
 * story, so these are real fail-when-broken assertions.
 *
 * NOTE on timing: the determinism shim FIXES `Date.now()` (so a Date-based
 * deadline never advances) but keeps `setTimeout` real — so poll with a bounded
 * count of real `setTimeout` ticks, never wall-clock arithmetic.
 */
export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`[story] ${message}`);
}

/** Poll (real 100ms ticks) for an element by data-testid; throw on timeout. */
export async function waitForTestId(
  root: HTMLElement,
  testId: string,
  tries = 80,
): Promise<HTMLElement> {
  for (let i = 0; i < tries; i += 1) {
    const el = root.querySelector(`[data-testid="${testId}"]`);
    if (el instanceof HTMLElement) return el;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`[story] timed out waiting for [data-testid="${testId}"]`);
}
