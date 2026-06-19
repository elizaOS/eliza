// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentSurfaceCapability } from "./capabilities";
import {
  getOrCreateViewRegistry,
  getViewRegistry,
  removeViewRegistry,
  ViewAgentRegistry,
} from "./registry";
import type { AgentElementSnapshot, AgentSurfaceSnapshot } from "./types";

function makeRegistry() {
  return new ViewAgentRegistry("test-view", "gui");
}

afterEach(() => {
  document.body.innerHTML = "";
  removeViewRegistry("test-view", "gui");
});

describe("ViewAgentRegistry", () => {
  it("registers, snapshots, and unregisters elements", () => {
    const registry = makeRegistry();
    const button = document.createElement("button");
    document.body.appendChild(button);

    const unregister = registry.register(
      { id: "send", role: "button", label: "Send" },
      () => button,
    );
    expect(registry.size()).toBe(1);

    const snap = registry.snapshot();
    expect(snap.elements).toHaveLength(1);
    expect(snap.elements[0]).toMatchObject({
      id: "send",
      role: "button",
      label: "Send",
      clickable: true,
      fillable: false,
    });

    unregister();
    expect(registry.size()).toBe(0);
  });

  it("orders elements by descriptor order then registration order", () => {
    const registry = makeRegistry();
    const a = document.createElement("div");
    const b = document.createElement("div");
    registry.register({ id: "a", label: "A", order: 200 }, () => a);
    registry.register({ id: "b", label: "B", order: 50 }, () => b);
    const ids = registry.snapshot().elements.map((e) => e.id);
    expect(ids).toEqual(["b", "a"]);
  });

  it("clicks via onActivate when provided, else dispatches a DOM click", () => {
    const registry = makeRegistry();
    const onActivate = vi.fn();
    registry.register(
      { id: "controlled", role: "button", label: "Controlled", onActivate },
      () => null,
    );
    expect(registry.click("controlled")).toEqual({
      ok: true,
      id: "controlled",
    });
    expect(onActivate).toHaveBeenCalledOnce();

    const domClick = vi.fn();
    const button = document.createElement("button");
    button.addEventListener("click", domClick);
    registry.register(
      { id: "dom", role: "button", label: "Dom" },
      () => button,
    );
    expect(registry.click("dom").ok).toBe(true);
    expect(domClick).toHaveBeenCalledOnce();
  });

  it("fills native inputs and fires input/change events", () => {
    const registry = makeRegistry();
    const input = document.createElement("input");
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    registry.register(
      { id: "amount", role: "text-input", label: "Amount" },
      () => input,
    );
    const result = registry.fill("amount", "42");
    expect(result).toEqual({ ok: true, id: "amount", value: "42" });
    expect(input.value).toBe("42");
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("rejects fills that violate the options whitelist", () => {
    const registry = makeRegistry();
    const select = document.createElement("select");
    registry.register(
      {
        id: "chain",
        role: "select",
        label: "Chain",
        options: ["eth", "sol"],
      },
      () => select,
    );
    const bad = registry.fill("chain", "doge");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("must be one of");
  });

  it("refuses to fill non-fillable elements and click non-clickable ones", () => {
    const registry = makeRegistry();
    const div = document.createElement("div");
    registry.register(
      { id: "metric", role: "metric", label: "Balance" },
      () => div,
    );
    expect(registry.fill("metric", "x").ok).toBe(false);
    expect(registry.click("metric").ok).toBe(false);
  });

  it("reports the focused element id", () => {
    const registry = makeRegistry();
    const input = document.createElement("input");
    document.body.appendChild(input);
    registry.register(
      { id: "field", role: "text-input", label: "Field" },
      () => input,
    );
    expect(registry.getFocusedId()).toBeNull();
    input.focus();
    expect(registry.getFocusedId()).toBe("field");
  });

  it("notifies subscribers on mutation and highlight toggles", () => {
    const registry = makeRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.register({ id: "x", label: "X" }, () => null);
    expect(listener).toHaveBeenCalledTimes(1);
    registry.setHighlight(true);
    expect(listener).toHaveBeenCalledTimes(2);
    registry.setHighlight(true); // no-op, same state
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("handleAgentSurfaceCapability", () => {
  it("lists, describes, fills, clicks and reads focus through the bridge", () => {
    const registry = getOrCreateViewRegistry("test-view", "gui");
    const input = document.createElement("input");
    const button = document.createElement("button");
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    document.body.append(input, button);
    registry.register(
      { id: "amount", role: "text-input", label: "Amount", group: "send" },
      () => input,
    );
    registry.register(
      { id: "submit", role: "button", label: "Submit", group: "send" },
      () => button,
    );

    const all = handleAgentSurfaceCapability(
      registry,
      "list-elements",
      undefined,
    ) as AgentElementSnapshot[];
    expect(all.map((e) => e.id).sort()).toEqual(["amount", "submit"]);

    const buttonsOnly = handleAgentSurfaceCapability(
      registry,
      "list-elements",
      {
        role: "button",
      },
    ) as AgentElementSnapshot[];
    expect(buttonsOnly.map((e) => e.id)).toEqual(["submit"]);

    const state = handleAgentSurfaceCapability(
      registry,
      "get-agent-state",
      undefined,
    ) as AgentSurfaceSnapshot;
    expect(state.elementCount).toBe(2);

    handleAgentSurfaceCapability(registry, "agent-fill", {
      id: "amount",
      value: "10",
    });
    expect(input.value).toBe("10");

    handleAgentSurfaceCapability(registry, "agent-click", { id: "submit" });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("throws on missing required params instead of silently defaulting", () => {
    const registry = getOrCreateViewRegistry("test-view", "gui");
    expect(() =>
      handleAgentSurfaceCapability(registry, "agent-fill", { id: "x" }),
    ).toThrow(/requires a string `value`/);
    expect(() =>
      handleAgentSurfaceCapability(registry, "describe-element", {}),
    ).toThrow(/requires an `id`/);
  });

  it("exposes the same registry instance through the module map", () => {
    const a = getOrCreateViewRegistry("test-view", "gui");
    const b = getViewRegistry("test-view", "gui");
    expect(a).toBe(b);
  });
});
