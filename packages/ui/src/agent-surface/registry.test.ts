/** Verifies ViewAgentRegistry through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers ViewAgentRegistry: registering/snapshotting/unregistering agent
 * elements per (view, modality) and routing agent-surface capabilities against
 * the registered snapshot. Uses real DOM nodes under jsdom.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentSurfaceCapability } from "./capabilities";
import {
  getOrCreateViewRegistry,
  getViewRegistry,
  removeViewRegistry,
  retainViewRegistry,
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

  it("redacts and refuses to fill sensitive fields", () => {
    const registry = makeRegistry();
    const password = document.createElement("input");
    password.type = "password";
    password.value = "correct horse";
    document.body.appendChild(password);
    registry.register(
      { id: "login.password", role: "text-input", label: "Password" },
      () => password,
    );

    const snapshot = registry.snapshot().elements[0];
    expect(snapshot).toMatchObject({
      id: "login.password",
      sensitive: true,
      valueRedacted: true,
    });
    expect("value" in snapshot).toBe(false);

    const result = registry.fill("login.password", "new password");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("sensitive element");
    expect(password.value).toBe("correct horse");
  });

  it("honors explicit sensitive descriptors without a mounted DOM node", () => {
    const registry = makeRegistry();
    const onFill = vi.fn();
    registry.register(
      {
        id: "api-key",
        role: "text-input",
        label: "Public provider key",
        sensitive: true,
        getValue: () => "sk-live",
        onFill,
      },
      () => null,
    );

    const snapshot = registry.describe("api-key");
    expect(snapshot).toMatchObject({
      id: "api-key",
      sensitive: true,
      valueRedacted: true,
    });
    expect(snapshot && "value" in snapshot).toBe(false);
    expect(registry.fill("api-key", "sk-next").ok).toBe(false);
    expect(onFill).not.toHaveBeenCalled();
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

  it("defers lifecycle registration notifications but keeps explicit highlight changes synchronous", async () => {
    const registry = makeRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.register({ id: "x", label: "X" }, () => null);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    registry.setHighlight(true);
    expect(listener).toHaveBeenCalledTimes(2);
    registry.setHighlight(true); // no-op, same state
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // #20728/#20974: cleanup order is not a safe lifecycle boundary. Once sealed,
  // a teardown mutation must advance internal state WITHOUT notifying a
  // subscriber already committed for deletion; an unregister that wins the
  // cleanup race queues delivery so the later seal can still cancel it.
  it("stops notifying subscribers once the last provider retainer is released", async () => {
    const registry = getOrCreateViewRegistry("test-view", "gui");
    const listener = vi.fn();
    registry.subscribe(listener);

    const release = retainViewRegistry(registry);
    expect(registry.isNotifying()).toBe(true);

    // A live registration still notifies the subscriber.
    const unregister = registry.register(
      { id: "live", label: "Live" },
      () => null,
    );
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    const versionAfterRegister = registry.getVersion();

    // Provider teardown (parent cleanup) runs first and seals the registry.
    release();
    expect(registry.isNotifying()).toBe(false);

    // Descendant `useAgentElement` cleanup then mutates the store: the element is
    // removed and the version still advances, but the subscriber is NOT notified.
    unregister();
    expect(registry.size()).toBe(0);
    expect(registry.getVersion()).toBe(versionAfterRegister + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    // Highlight/touch mutations during teardown are likewise silent.
    registry.setHighlight(true);
    registry.touch();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps notifying while an overlapping provider retainer remains, and re-enables on re-retain (Strict Mode replay)", () => {
    const registry = getOrCreateViewRegistry("test-view", "gui");
    const listener = vi.fn();
    registry.subscribe(listener);

    const releaseA = retainViewRegistry(registry);
    const releaseB = retainViewRegistry(registry);

    // One of two overlapping providers unmounts: registry stays active.
    releaseA();
    expect(registry.isNotifying()).toBe(true);
    registry.touch();
    expect(listener).toHaveBeenCalledTimes(1);

    // Last provider unmounts: sealed.
    releaseB();
    expect(registry.isNotifying()).toBe(false);

    // Strict Mode replays effects on the identical instance: re-retaining the
    // same registry unseals it so live subscribers resume receiving updates.
    const releaseReplay = retainViewRegistry(registry);
    expect(registry.isNotifying()).toBe(true);
    registry.touch();
    expect(listener).toHaveBeenCalledTimes(2);
    releaseReplay();
  });

  it("cancels an unregister notification when provider teardown runs afterward", async () => {
    const registry = getOrCreateViewRegistry("test-view", "gui");
    const listener = vi.fn();
    registry.subscribe(listener);
    const release = retainViewRegistry(registry);
    const unregister = registry.register(
      { id: "racing-child", label: "Racing child" },
      () => null,
    );
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    // Mirror the browser ordering from #20974: descendant cleanup first,
    // provider cleanup second, then the queued notification gets a turn.
    unregister();
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();

    expect(registry.size()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("still notifies a live view after an element unregisters", async () => {
    const registry = getOrCreateViewRegistry("test-view", "gui");
    const listener = vi.fn();
    registry.subscribe(listener);
    const release = retainViewRegistry(registry);
    const unregister = registry.register(
      { id: "conditional-child", label: "Conditional child" },
      () => null,
    );
    await Promise.resolve();
    listener.mockClear();

    unregister();
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledOnce();
    release();
  });

  it("coalesces registration and descriptor lifecycle notifications after passive effects", async () => {
    const registry = makeRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.register({ id: "field", label: "Field" }, () => null);
    registry.touchDeferred();

    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    expect(registry.getVersion()).toBe(2);
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

  // The signal the server-side view-scoped action handler keys on to throw a
  // typed VIEW_SCOPED_ACTION_ELEMENT_MISSING error (#13589): a fill/click/focus
  // against an UNMOUNTED useAgentElement id must resolve to `{ ok: false,
  // reason: "element not found" }`, never a thrown capability error and never a
  // silent success. This pins the cross-boundary contract on the UI side.
  it("reports { ok:false, reason } for a missing element id (never silent, never throw)", () => {
    const registry = getOrCreateViewRegistry("test-view", "gui");
    // No elements registered → every action targets an unmounted id.
    for (const capability of [
      "agent-fill",
      "agent-click",
      "agent-focus",
    ] as const) {
      const params =
        capability === "agent-fill"
          ? { id: "ghost", value: "x" }
          : { id: "ghost" };
      const result = handleAgentSurfaceCapability(
        registry,
        capability,
        params,
      ) as { ok: boolean; reason?: string };
      expect(result.ok).toBe(false);
      expect(result.reason ?? "").toMatch(/not found|not mounted/i);
    }
  });

  it("exposes the same registry instance through the module map", () => {
    const a = getOrCreateViewRegistry("test-view", "gui");
    const b = getViewRegistry("test-view", "gui");
    expect(a).toBe(b);
  });
});
