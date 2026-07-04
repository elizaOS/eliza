/**
 * Storybook decorator that seeds auth + app state so home-widget stories render
 * populated.
 */
import type { Decorator } from "@storybook/react";
import { useEffect, useRef, useState } from "react";
import {
  __setAuthStatusForTests,
  type AuthStatusState,
} from "../hooks/useAuthStatus";
import {
  HOME_WIDGET_MOCK_PLUGINS,
  installHomeWidgetFetchMock,
  seedHomeWidgetAppStore,
  seedHomeWidgetNotifications,
} from "../widgets/__fixtures__/home-widget-mock-data";
import { MockAppProvider } from "./mock-providers";

/**
 * Authenticated local session for stories. Since #11084 (#11107/#11122) every
 * home/sidebar widget poller gates on `useIsAuthenticated()` before fetching;
 * stories have no auth backend, so without seeding this the shared snapshot
 * stays `loading` forever and every gated widget renders null (the play
 * functions then poll to the test timeout). Mirrors the home-screen e2e's
 * `home-screen-fixture.auth-stub.ts`.
 */
const STORY_AUTHENTICATED_SESSION: AuthStatusState = {
  phase: "authenticated",
  identity: { id: "story-owner", displayName: "Story Owner", kind: "owner" },
  session: { id: "story-session", kind: "local", expiresAt: null },
  access: { mode: "local", passwordConfigured: false, ownerConfigured: true },
};

/**
 * Publish the authenticated session BEFORE `children` render (a `useState`
 * initializer runs synchronously ahead of the child tree) and restore the
 * previous snapshot on unmount — so gated widget loaders run during the story
 * and later tests in the same jsdom module see the untouched snapshot.
 */
export function WithAuthenticatedSession({
  children,
}: {
  children: React.ReactNode;
}) {
  const restoreAuth = useRef<(() => void) | null>(null);
  useState(() => {
    restoreAuth.current = __setAuthStatusForTests(STORY_AUTHENTICATED_SESSION);
    return null;
  });
  useEffect(() => () => restoreAuth.current?.(), []);
  return <>{children}</>;
}

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
    __setAuthStatusForTests({
      phase: "authenticated",
      identity: {
        id: "story-owner",
        displayName: "Story Owner",
        kind: "owner",
      },
      session: { id: "story-session", kind: "local", expiresAt: null },
      access: {
        mode: "local",
        passwordConfigured: false,
        ownerConfigured: true,
        role: "OWNER",
      },
    });
    seedHomeWidgetAppStore();
    seedHomeWidgetNotifications();
    restoreFetch.current = installHomeWidgetFetchMock();
    return null;
  });
  useEffect(
    () => () => {
      restoreFetch.current?.();
      __setAuthStatusForTests({ phase: "loading" });
    },
    [],
  );
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
    <WithAuthenticatedSession>
      <SeededHomeWidgetData>
        <div className="w-[360px] bg-accent/20 p-3">
          <Story />
        </div>
      </SeededHomeWidgetData>
    </WithAuthenticatedSession>
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
