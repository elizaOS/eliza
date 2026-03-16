/**
 * AppMockProvider — Lightweight mock of useApp() for Storybook stories.
 *
 * Provides a `t(key) => key` passthrough so components using useApp().t
 * render translation keys as labels without needing the full app context.
 */

import type React from "react";
import { createContext } from "react";

const MockAppContext = createContext<{ t: (key: string) => string }>({
  t: (k: string) => k,
});

export function AppMockProvider({ children }: { children: React.ReactNode }) {
  return (
    <MockAppContext.Provider value={{ t: (k: string) => k }}>
      {children}
    </MockAppContext.Provider>
  );
}

/**
 * Storybook decorator that wraps stories in the mock app provider.
 */
export function withAppMock(Story: React.ComponentType) {
  return (
    <AppMockProvider>
      <Story />
    </AppMockProvider>
  );
}
