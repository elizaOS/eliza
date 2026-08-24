/** Verifies useAgentElement through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers the hook contract against a real ViewAgentRegistry: inert agentProps
 * outside a provider, attribute stamping (role fallback, aria-label mirroring,
 * sensitive/status markers), registry registration/unregistration across the
 * element lifetime, ref-driven uncontrolled fill versus controlled
 * onFill/onActivate wiring frozen at first render per id, and deferred
 * subscriber notifications for rendered-field changes.
 */
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSurfaceContext } from "./AgentSurfaceContext.hooks";
import { ViewAgentRegistry } from "./registry";
import type { AgentElementDescriptor } from "./types";
import { useAgentElement } from "./useAgentElement";

function makeWrapper(registry: ViewAgentRegistry) {
  return function AgentSurfaceWrapper({ children }: { children: ReactNode }) {
    return (
      <AgentSurfaceContext.Provider
        value={{
          registry,
          viewId: registry.viewId,
          viewType: registry.viewType,
        }}
      >
        {children}
      </AgentSurfaceContext.Provider>
    );
  };
}

function renderWithRegistry(
  registry: ViewAgentRegistry,
  descriptor: AgentElementDescriptor,
) {
  return renderHook(
    ({ d }: { d: AgentElementDescriptor }) => useAgentElement(d),
    {
      initialProps: { d: descriptor },
      wrapper: makeWrapper(registry),
    },
  );
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("useAgentElement", () => {
  it("returns valid inert props outside a provider", () => {
    const { result } = renderHook(() =>
      useAgentElement({ id: "solo", label: "Solo" }),
    );

    expect(result.current.agentProps).toEqual({
      "data-agent-id": "solo",
      "data-agent-role": "region",
      "data-agent-label": "Solo",
    });
    expect(result.current.ref.current).toBeNull();
  });

  it("stamps role, status and the sensitive marker for a full descriptor", () => {
    const registry = new ViewAgentRegistry("hook-view", "gui");
    const { result } = renderHook(
      () =>
        useAgentElement({
          id: "send",
          role: "button",
          label: "Send",
          status: "active",
          sensitive: true,
        }),
      { wrapper: makeWrapper(registry) },
    );

    expect(result.current.agentProps).toEqual({
      "data-agent-id": "send",
      "data-agent-role": "button",
      "data-agent-label": "Send",
      "aria-label": "Send",
      "data-agent-sensitive": "true",
      "data-state": "active",
    });
  });

  it("mirrors the label into aria-label only for accessible-name roles", () => {
    const registry = new ViewAgentRegistry("hook-view", "gui");
    const interactive = renderHook(
      () => useAgentElement({ id: "bio", role: "textarea", label: "Bio" }),
      { wrapper: makeWrapper(registry) },
    );
    expect(interactive.result.current.agentProps["aria-label"]).toBe("Bio");

    const display = renderHook(
      () =>
        useAgentElement({ id: "balance", role: "metric", label: "Balance" }),
      { wrapper: makeWrapper(registry) },
    );
    expect("aria-label" in display.result.current.agentProps).toBe(false);
    expect(display.result.current.agentProps["data-agent-role"]).toBe("metric");
  });

  it("registers with the active registry on mount and unregisters on unmount", () => {
    const registry = new ViewAgentRegistry("hook-view", "gui");
    const view = renderWithRegistry(registry, {
      id: "panel",
      label: "Panel",
    });

    expect(registry.size()).toBe(1);
    expect(registry.describe("panel")).toMatchObject({
      id: "panel",
      role: "region",
      label: "Panel",
      fillable: false,
      clickable: false,
    });

    view.unmount();
    expect(registry.size()).toBe(0);
  });

  it("gives the registry a live handle through ref so uncontrolled fills drive the DOM", () => {
    const registry = new ViewAgentRegistry("hook-view", "gui");
    const input = document.createElement("input");
    document.body.appendChild(input);

    const view = renderWithRegistry(registry, {
      id: "amount",
      role: "text-input",
      label: "Amount",
    });
    // Attach after mount: the registered getter must resolve the node lazily.
    view.result.current.ref.current = input;

    expect(registry.fill("amount", "42")).toEqual({
      ok: true,
      id: "amount",
      value: "42",
    });
    expect(input.value).toBe("42");
    expect(registry.describe("amount")?.value).toBe("42");

    view.unmount();
  });

  it("routes controlled fills and reads through onFill/getValue instead of the DOM", () => {
    const registry = new ViewAgentRegistry("hook-view", "gui");
    const onFill = vi.fn();
    const input = document.createElement("input");
    input.value = "dom-value";
    document.body.appendChild(input);

    const view = renderWithRegistry(registry, {
      id: "note",
      role: "text-input",
      label: "Note",
      getValue: () => "stored-value",
      onFill,
    });
    view.result.current.ref.current = input;

    expect(registry.fill("note", "typed")).toEqual({
      ok: true,
      id: "note",
      value: "typed",
    });
    expect(onFill).toHaveBeenCalledExactlyOnceWith("typed");
    expect(input.value).toBe("dom-value");
    expect(registry.describe("note")?.value).toBe("stored-value");

    view.unmount();
  });

  it("keeps first-render handler wiring for an id so a late onFill cannot hijack an uncontrolled element", () => {
    const registry = new ViewAgentRegistry("hook-view", "gui");
    const onFill = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);

    const view = renderWithRegistry(registry, {
      id: "grow",
      role: "text-input",
      label: "Grow",
    });
    view.result.current.ref.current = input;

    view.rerender({
      d: { id: "grow", role: "text-input", label: "Grow", onFill },
    });

    expect(registry.fill("grow", "late").ok).toBe(true);
    expect(onFill).not.toHaveBeenCalled();
    expect(input.value).toBe("late");

    view.unmount();
  });

  it("activates through onActivate without a mounted node", () => {
    const registry = new ViewAgentRegistry("hook-view", "gui");
    const onActivate = vi.fn();

    const view = renderWithRegistry(registry, {
      id: "tab.save",
      role: "tab",
      label: "Save",
      onActivate,
    });
    expect(view.result.current.ref.current).toBeNull();

    expect(registry.click("tab.save")).toEqual({
      ok: true,
      id: "tab.save",
    });
    expect(onActivate).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it("coalesces mount notifications and bumps subscribers only when rendered fields change", async () => {
    const registry = new ViewAgentRegistry("hook-view", "gui");
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    const view = renderWithRegistry(registry, {
      id: "live",
      label: "One",
    });

    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getVersion()).toBe(2);

    view.rerender({ d: { id: "live", label: "One" } });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    view.rerender({ d: { id: "live", label: "Two" } });
    expect(view.result.current.agentProps["data-agent-label"]).toBe("Two");
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.describe("live")?.label).toBe("Two");

    view.rerender({ d: { id: "live", label: "Two", status: "error" } });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    view.unmount();
  });
});
