/**
 * Unit coverage for the boot-config React surface: AppBootContext's
 * module-init default, useBootConfig's provider-driven reads and nesting
 * precedence, live updates when a provider's value changes, and the
 * context/store split — the hook reads the React context, never the
 * process-global boot-config store.
 */
// @vitest-environment jsdom

import { cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AppBootContext, useBootConfig } from "./boot-config-react.hooks";
import {
  type AppBootConfig,
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "./boot-config-store";

afterEach(cleanup);

const HOST_CONFIG: AppBootConfig = {
  ...DEFAULT_BOOT_CONFIG,
  apiBase: "https://host.example/api",
};

const NESTED_CONFIG: AppBootConfig = {
  ...DEFAULT_BOOT_CONFIG,
  apiBase: "https://nested.example/api",
};

const hostWrapper = ({ children }: { children: ReactNode }) => (
  <AppBootContext.Provider value={HOST_CONFIG}>
    {children}
  </AppBootContext.Provider>
);

/** Renders the apiBase the hook actually returned so DOM asserts are possible. */
function Probe() {
  const config = useBootConfig();
  return <span data-testid="probe-api-base">{config.apiBase ?? "none"}</span>;
}

describe("AppBootContext default", () => {
  it("serves DEFAULT_BOOT_CONFIG to a consumer rendered without a provider", () => {
    const { result } = renderHook(() => useBootConfig());
    expect(result.current).toBe(DEFAULT_BOOT_CONFIG);
  });
});

describe("useBootConfig", () => {
  it("returns exactly the value supplied by the nearest enclosing provider", () => {
    const { result } = renderHook(() => useBootConfig(), {
      wrapper: hostWrapper,
    });
    expect(result.current).toBe(HOST_CONFIG);
    expect(result.current.apiBase).toBe("https://host.example/api");
  });

  it("prefers the innermost provider when providers nest", () => {
    function NestedWrapper({ children }: { children: ReactNode }) {
      return (
        <AppBootContext.Provider value={HOST_CONFIG}>
          <AppBootContext.Provider value={NESTED_CONFIG}>
            {children}
          </AppBootContext.Provider>
        </AppBootContext.Provider>
      );
    }

    const { result } = renderHook(() => useBootConfig(), {
      wrapper: NestedWrapper,
    });
    expect(result.current).toBe(NESTED_CONFIG);
  });

  it("propagates a changed provider value to consumers on rerender", () => {
    const view = (config: AppBootConfig) => (
      <AppBootContext.Provider value={config}>
        <Probe />
      </AppBootContext.Provider>
    );

    const { container, rerender } = render(view(HOST_CONFIG));
    expect(container.textContent).toBe("https://host.example/api");

    rerender(view(NESTED_CONFIG));
    expect(container.textContent).toBe("https://nested.example/api");
  });

  it("reads the context, not the process-global boot-config store", () => {
    const STORE_KEY = Symbol.for("elizaos.app.boot-config");
    const WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";
    const slot = globalThis as Record<PropertyKey, unknown>;
    const resetGlobalStore = () => {
      delete slot[STORE_KEY];
      delete slot[WINDOW_KEY];
    };

    resetGlobalStore();
    try {
      // The store is live and points somewhere else entirely.
      const globalOnly: AppBootConfig = {
        ...DEFAULT_BOOT_CONFIG,
        apiBase: "https://global-store.example/api",
      };
      setBootConfig(globalOnly);
      expect(getBootConfig()).toBe(globalOnly);

      // The hook still resolves through the context default: hosts must
      // publish via <AppBootContext.Provider>, not setBootConfig alone.
      const { result } = renderHook(() => useBootConfig());
      expect(result.current).toBe(DEFAULT_BOOT_CONFIG);
    } finally {
      resetGlobalStore();
    }
  });
});
