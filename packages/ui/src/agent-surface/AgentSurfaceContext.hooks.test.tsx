// @vitest-environment jsdom
/**
 * AgentSurfaceContext.hooks — the shared agent-surface context object and the
 * `useAgentSurface` hook. Driven through the real React runtime with
 * @testing-library/react under jsdom: default-null outside any provider,
 * exact-reference propagation, innermost-provider precedence, live updates on
 * value change, multi-consumer sharing, and wiring through the production
 * `AgentSurfaceProvider`. No module mocks — registries are the real
 * `ViewAgentRegistry` class.
 */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSurfaceProvider } from "./AgentSurfaceContext";
import {
  AgentSurfaceContext,
  type AgentSurfaceContextValue,
  useAgentSurface,
} from "./AgentSurfaceContext.hooks";
import { ViewAgentRegistry } from "./registry";

afterEach(cleanup);

function makeValue(
  viewId: string,
  viewType: AgentSurfaceContextValue["viewType"] = "gui",
): AgentSurfaceContextValue {
  return {
    registry: new ViewAgentRegistry(viewId, viewType),
    viewId,
    viewType,
  };
}

function providerWrapper(
  value: AgentSurfaceContextValue,
): (props: { children?: React.ReactNode }) => React.JSX.Element {
  return function Wrapper({ children }) {
    return (
      <AgentSurfaceContext.Provider value={value}>
        {children}
      </AgentSurfaceContext.Provider>
    );
  };
}

describe("useAgentSurface", () => {
  it("returns null when rendered outside any provider", () => {
    const { result } = renderHook(() => useAgentSurface());
    expect(result.current).toBeNull();
  });

  it("returns the exact provider value object by reference", () => {
    const value = makeValue("chat-main");
    const { result } = renderHook(() => useAgentSurface(), {
      wrapper: providerWrapper(value),
    });
    expect(result.current).toBe(value);
    expect(result.current?.viewId).toBe("chat-main");
    expect(result.current?.viewType).toBe("gui");
    expect(result.current?.registry).toBe(value.registry);
  });

  it("carries a live ViewAgentRegistry, not a copy", () => {
    const value = makeValue("live-store-view");
    const { result } = renderHook(() => useAgentSurface(), {
      wrapper: providerWrapper(value),
    });
    const surface = result.current;
    if (!surface) throw new Error("hook returned null inside a provider");
    const registry = surface.registry;
    expect(registry).toBeInstanceOf(ViewAgentRegistry);

    const el = document.createElement("button");
    const unregister = registry.register(
      { id: "send", label: "Send", role: "button" },
      () => el,
    );
    expect(registry.size()).toBe(1);
    expect(registry.snapshot().elements.map((element) => element.id)).toEqual([
      "send",
    ]);

    unregister();
    expect(registry.size()).toBe(0);
  });

  it("prefers the innermost provider when providers are nested", () => {
    const outer = makeValue("outer-view", "tui");
    const inner = makeValue("inner-view", "xr");
    const { result } = renderHook(() => useAgentSurface(), {
      wrapper: ({ children }: { children?: React.ReactNode }) => (
        <AgentSurfaceContext.Provider value={outer}>
          <AgentSurfaceContext.Provider value={inner}>
            {children}
          </AgentSurfaceContext.Provider>
        </AgentSurfaceContext.Provider>
      ),
    });
    expect(result.current).toBe(inner);
    expect(result.current?.viewId).toBe("inner-view");
    expect(result.current?.viewType).toBe("xr");
    expect(result.current).not.toBe(outer);
  });

  it("re-renders consumers with the new value when the provider value changes", () => {
    let setValue: (next: AgentSurfaceContextValue) => void = () => {};
    function Wrapper({ children }: { children?: React.ReactNode }) {
      const [value, set] = React.useState<AgentSurfaceContextValue>(
        makeValue("before"),
      );
      setValue = set;
      return (
        <AgentSurfaceContext.Provider value={value}>
          {children}
        </AgentSurfaceContext.Provider>
      );
    }
    const { result } = renderHook(() => useAgentSurface(), {
      wrapper: Wrapper,
    });
    expect(result.current?.viewId).toBe("before");

    const next = makeValue("after", "tui");
    act(() => setValue(next));
    expect(result.current).toBe(next);
    expect(result.current?.viewType).toBe("tui");
  });

  it("shares one value reference across simultaneous consumers", () => {
    const seen: Array<AgentSurfaceContextValue | null> = [];
    function Probe() {
      seen.push(useAgentSurface());
      return null;
    }
    const value = makeValue("shared-view");
    render(
      <AgentSurfaceContext.Provider value={value}>
        <Probe />
        <Probe />
      </AgentSurfaceContext.Provider>,
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(value);
    expect(seen[1]).toBe(value);
  });
});

describe("AgentSurfaceContext", () => {
  it("serves the same value through the legacy Consumer path", () => {
    const value = makeValue("consumer-view");
    let observed: AgentSurfaceContextValue | null | undefined;
    render(
      <AgentSurfaceContext.Provider value={value}>
        <AgentSurfaceContext.Consumer>
          {(surface) => {
            observed = surface;
            return null;
          }}
        </AgentSurfaceContext.Consumer>
      </AgentSurfaceContext.Provider>,
    );
    expect(observed).toBe(value);
  });

  it("delivers the real provider's registry to descendants", () => {
    const { result } = renderHook(() => useAgentSurface(), {
      wrapper: ({ children }: { children?: React.ReactNode }) => (
        <AgentSurfaceProvider viewId="provider-view" viewType="gui">
          {children}
        </AgentSurfaceProvider>
      ),
    });
    const surface = result.current;
    if (!surface) throw new Error("hook returned null inside a provider");
    expect(surface.viewId).toBe("provider-view");
    expect(surface.viewType).toBe("gui");
    expect(surface.registry).toBeInstanceOf(ViewAgentRegistry);
    expect(surface.registry.viewId).toBe("provider-view");

    const el = document.createElement("input");
    const unregister = surface.registry.register(
      { id: "amount", label: "Amount", role: "number-input" },
      () => el,
    );
    expect(surface.registry.size()).toBe(1);
    unregister();
    expect(surface.registry.size()).toBe(0);
  });
});
