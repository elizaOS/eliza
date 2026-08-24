/** Verifies the agent-surface capability dispatcher through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers capabilities.ts directly: membership against the shared capability-id
 * set, per-capability parameter validation errors, list-element filtering,
 * focus/highlight state flow, and pass-through of ViewAgentRegistry action
 * results. Drives the real ViewAgentRegistry with real DOM nodes under jsdom.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
} from "./capabilities";
import { ViewAgentRegistry } from "./registry";
import type {
  AgentActionResult,
  AgentElementSnapshot,
  AgentSurfaceSnapshot,
} from "./types";
import { AGENT_SURFACE_CAPABILITY_IDS } from "./types";

function makeRegistry() {
  return new ViewAgentRegistry("capabilities-view", "gui");
}

function registerInput(registry: ViewAgentRegistry, id: string) {
  const input = document.createElement("input");
  document.body.appendChild(input);
  registry.register({ id, role: "text-input", label: id }, () => input);
  return input;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isAgentSurfaceCapability", () => {
  it("accepts every capability id in the shared agent-surface set", () => {
    for (const capability of AGENT_SURFACE_CAPABILITY_IDS) {
      expect(isAgentSurfaceCapability(capability)).toBe(true);
    }
  });

  it("rejects unknown and selector-path capabilities", () => {
    // "fill-input" is a standard view-interact capability handled by selector
    // fallback, NOT routed to the agent-surface handler.
    expect(isAgentSurfaceCapability("fill-input")).toBe(false);
    expect(isAgentSurfaceCapability("")).toBe(false);
    expect(isAgentSurfaceCapability("AGENT-CLICK")).toBe(false);
    expect(isAgentSurfaceCapability("list-elements ")).toBe(false);
    expect(isAgentSurfaceCapability("teleport")).toBe(false);
  });
});

describe("handleAgentSurfaceCapability", () => {
  describe("list-elements", () => {
    it("returns all elements in registry order when no filters are given", () => {
      const registry = makeRegistry();
      registry.register({ id: "first", label: "First" }, () => null);
      registry.register({ id: "second", label: "Second" }, () => null);

      const result = handleAgentSurfaceCapability(
        registry,
        "list-elements",
        undefined,
      ) as AgentElementSnapshot[];

      expect(result.map((e) => e.id)).toEqual(["first", "second"]);
      for (const element of result) {
        expect(typeof element.fillable).toBe("boolean");
        expect(typeof element.clickable).toBe("boolean");
      }
    });

    it("returns an empty array for an empty registry", () => {
      const registry = makeRegistry();
      const result = handleAgentSurfaceCapability(
        registry,
        "list-elements",
        undefined,
      ) as AgentElementSnapshot[];
      expect(result).toEqual([]);
    });

    it("filters by role, group, both, and ignores non-string filter values", () => {
      const registry = makeRegistry();
      registry.register(
        {
          id: "send.amount",
          role: "text-input",
          label: "Amount",
          group: "send",
        },
        () => null,
      );
      registry.register(
        { id: "send.submit", role: "button", label: "Submit", group: "send" },
        () => null,
      );
      registry.register(
        { id: "nav.home", role: "link", label: "Home", group: "nav" },
        () => null,
      );

      const byRole = handleAgentSurfaceCapability(registry, "list-elements", {
        role: "button",
      }) as AgentElementSnapshot[];
      expect(byRole.map((e) => e.id)).toEqual(["send.submit"]);

      const byGroup = handleAgentSurfaceCapability(registry, "list-elements", {
        group: "nav",
      }) as AgentElementSnapshot[];
      expect(byGroup.map((e) => e.id)).toEqual(["nav.home"]);

      const byBoth = handleAgentSurfaceCapability(registry, "list-elements", {
        role: "text-input",
        group: "send",
      }) as AgentElementSnapshot[];
      expect(byBoth.map((e) => e.id)).toEqual(["send.amount"]);

      const noMatch = handleAgentSurfaceCapability(registry, "list-elements", {
        role: "toggle",
        group: "send",
      }) as AgentElementSnapshot[];
      expect(noMatch).toEqual([]);

      // A non-string role is treated as absent (no filtering), not an error.
      const numericRole = handleAgentSurfaceCapability(
        registry,
        "list-elements",
        {
          role: 42,
        },
      ) as AgentElementSnapshot[];
      expect(numericRole).toHaveLength(3);
    });
  });

  it("get-agent-state returns the full view snapshot", () => {
    const registry = makeRegistry();
    registry.register({ id: "only", label: "Only" }, () => null);

    const snapshot = handleAgentSurfaceCapability(
      registry,
      "get-agent-state",
      undefined,
    ) as AgentSurfaceSnapshot;

    expect(snapshot.viewId).toBe("capabilities-view");
    expect(snapshot.viewType).toBe("gui");
    expect(snapshot.elementCount).toBe(1);
    expect(snapshot.focusedId).toBeNull();
    expect(snapshot.elements.map((e) => e.id)).toEqual(["only"]);
  });

  describe("describe-element", () => {
    it("throws without an id parameter (absent, empty object, or non-string)", () => {
      const registry = makeRegistry();
      expect(() =>
        handleAgentSurfaceCapability(registry, "describe-element", undefined),
      ).toThrow(/requires an `id` parameter/);
      expect(() =>
        handleAgentSurfaceCapability(registry, "describe-element", {}),
      ).toThrow(/requires an `id` parameter/);
      expect(() =>
        handleAgentSurfaceCapability(registry, "describe-element", { id: 7 }),
      ).toThrow(/requires an `id` parameter/);
    });

    it("describes a registered element and throws for an unregistered one", () => {
      const registry = makeRegistry();
      registry.register(
        { id: "send.amount", role: "text-input", label: "Amount" },
        () => null,
      );

      const described = handleAgentSurfaceCapability(
        registry,
        "describe-element",
        { id: "send.amount" },
      ) as AgentElementSnapshot;
      expect(described).toMatchObject({
        id: "send.amount",
        role: "text-input",
        label: "Amount",
      });

      expect(() =>
        handleAgentSurfaceCapability(registry, "describe-element", {
          id: "ghost",
        }),
      ).toThrow(/No element registered with id "ghost"/);
    });
  });

  describe("get-focus", () => {
    it("reports a null focus when nothing is focused", () => {
      const registry = makeRegistry();
      const result = handleAgentSurfaceCapability(
        registry,
        "get-focus",
        undefined,
      ) as { focusedId: string | null; element: AgentElementSnapshot | null };
      expect(result.focusedId).toBeNull();
      expect(result.element).toBeNull();
    });

    it("reports the focused element's id and its snapshot", () => {
      const registry = makeRegistry();
      const input = registerInput(registry, "amount");
      input.focus();

      const result = handleAgentSurfaceCapability(
        registry,
        "get-focus",
        undefined,
      ) as { focusedId: string | null; element: AgentElementSnapshot | null };
      expect(result.focusedId).toBe("amount");
      expect(result.element?.id).toBe("amount");
      expect(result.element?.focused).toBe(true);
    });
  });

  describe("agent-click", () => {
    it("throws without an id parameter", () => {
      const registry = makeRegistry();
      expect(() =>
        handleAgentSurfaceCapability(registry, "agent-click", {}),
      ).toThrow(/agent-click requires an `id` parameter/);
      expect(() =>
        handleAgentSurfaceCapability(registry, "agent-click", { id: 42 }),
      ).toThrow(/agent-click requires an `id` parameter/);
    });

    it("dispatches a real DOM click on a registered button", () => {
      const registry = makeRegistry();
      const button = document.createElement("button");
      document.body.appendChild(button);
      const clicked = vi.fn();
      button.addEventListener("click", clicked);
      registry.register(
        { id: "submit", role: "button", label: "Submit" },
        () => button,
      );

      const result = handleAgentSurfaceCapability(registry, "agent-click", {
        id: "submit",
      }) as AgentActionResult;
      expect(result.ok).toBe(true);
      expect(clicked).toHaveBeenCalledOnce();
    });

    it("passes through refusals for non-clickable and unregistered ids", () => {
      const registry = makeRegistry();
      const div = document.createElement("div");
      document.body.appendChild(div);
      registry.register(
        { id: "metric", role: "metric", label: "Balance" },
        () => div,
      );

      const refused = handleAgentSurfaceCapability(registry, "agent-click", {
        id: "metric",
      }) as AgentActionResult;
      expect(refused).toMatchObject({ ok: false, id: "metric" });
      expect(refused.reason).toContain("not clickable");

      const missing = handleAgentSurfaceCapability(registry, "agent-click", {
        id: "ghost",
      }) as AgentActionResult;
      expect(missing).toMatchObject({
        ok: false,
        id: "ghost",
        reason: "element not found",
      });
    });
  });

  describe("agent-fill", () => {
    it("validates parameters before touching the registry", () => {
      const registry = makeRegistry();
      const input = registerInput(registry, "amount");

      expect(() =>
        handleAgentSurfaceCapability(registry, "agent-fill", {}),
      ).toThrow(/agent-fill requires an `id` parameter/);
      expect(() =>
        handleAgentSurfaceCapability(registry, "agent-fill", { id: "amount" }),
      ).toThrow(/agent-fill requires a string `value` parameter/);
      expect(() =>
        handleAgentSurfaceCapability(registry, "agent-fill", {
          id: "amount",
          value: 10,
        }),
      ).toThrow(/agent-fill requires a string `value` parameter/);
      expect(input.value).toBe("");
    });

    it("fills a registered native input through the registry", () => {
      const registry = makeRegistry();
      const input = registerInput(registry, "amount");

      const result = handleAgentSurfaceCapability(registry, "agent-fill", {
        id: "amount",
        value: "10",
      }) as AgentActionResult;
      expect(result).toEqual({ ok: true, id: "amount", value: "10" });
      expect(input.value).toBe("10");
    });

    it("passes through sensitive-field and options-whitelist refusals", () => {
      const registry = makeRegistry();
      const password = document.createElement("input");
      password.type = "password";
      password.value = "correct horse";
      document.body.appendChild(password);
      registry.register(
        { id: "login.password", role: "text-input", label: "Password" },
        () => password,
      );
      const select = document.createElement("select");
      document.body.appendChild(select);
      registry.register(
        {
          id: "chain",
          role: "select",
          label: "Chain",
          options: ["eth", "sol"],
        },
        () => select,
      );

      const sensitive = handleAgentSurfaceCapability(registry, "agent-fill", {
        id: "login.password",
        value: "new password",
      }) as AgentActionResult;
      expect(sensitive.ok).toBe(false);
      expect(sensitive.reason).toContain("sensitive");
      expect(password.value).toBe("correct horse");

      const offWhitelist = handleAgentSurfaceCapability(
        registry,
        "agent-fill",
        {
          id: "chain",
          value: "doge",
        },
      ) as AgentActionResult;
      expect(offWhitelist.ok).toBe(false);
      expect(offWhitelist.reason).toContain("must be one of");
    });
  });

  describe("agent-focus", () => {
    it("throws without an id parameter", () => {
      const registry = makeRegistry();
      expect(() =>
        handleAgentSurfaceCapability(registry, "agent-focus", {}),
      ).toThrow(/agent-focus requires an `id` parameter/);
    });

    it("moves real focus to the element, visible through get-focus", () => {
      const registry = makeRegistry();
      const input = registerInput(registry, "amount");

      const result = handleAgentSurfaceCapability(registry, "agent-focus", {
        id: "amount",
      }) as AgentActionResult;
      expect(result).toEqual({ ok: true, id: "amount" });
      expect(document.activeElement).toBe(input);

      const focus = handleAgentSurfaceCapability(
        registry,
        "get-focus",
        undefined,
      ) as { focusedId: string | null };
      expect(focus.focusedId).toBe("amount");
    });
  });

  describe("agent-scroll-to", () => {
    it("throws without an id parameter", () => {
      const registry = makeRegistry();
      expect(() =>
        handleAgentSurfaceCapability(registry, "agent-scroll-to", {}),
      ).toThrow(/agent-scroll-to requires an `id` parameter/);
    });

    it("reports not-found for an unregistered id", () => {
      const registry = makeRegistry();
      const result = handleAgentSurfaceCapability(registry, "agent-scroll-to", {
        id: "ghost",
      }) as AgentActionResult;
      expect(result).toMatchObject({
        ok: false,
        id: "ghost",
        reason: "element not found",
      });
    });

    it("delegates to the element's scrollIntoView", () => {
      const registry = makeRegistry();
      const panel = document.createElement("div");
      document.body.appendChild(panel);
      registry.register(
        { id: "panel", role: "region", label: "Panel" },
        () => panel,
      );

      // jsdom does not implement scrollIntoView; shim it to observe the call.
      const original = Element.prototype.scrollIntoView;
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      try {
        const result = handleAgentSurfaceCapability(
          registry,
          "agent-scroll-to",
          { id: "panel" },
        ) as AgentActionResult;
        expect(result).toEqual({ ok: true, id: "panel" });
        expect(scrollIntoView).toHaveBeenCalledOnce();
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });
  });

  describe("set-highlight", () => {
    it("defaults to on when params are omitted", () => {
      const registry = makeRegistry();
      const result = handleAgentSurfaceCapability(
        registry,
        "set-highlight",
        undefined,
      ) as { highlighting: boolean };
      expect(result).toEqual({ highlighting: true });
      expect(registry.isHighlighting()).toBe(true);
    });

    it("turns off only on an explicit on:false and reports resulting state", () => {
      const registry = makeRegistry();

      const off = handleAgentSurfaceCapability(registry, "set-highlight", {
        on: false,
      }) as { highlighting: boolean };
      expect(off).toEqual({ highlighting: false });
      expect(registry.isHighlighting()).toBe(false);

      // Only the exact value false disables; any other truthy param keeps it on.
      const truthyParam = handleAgentSurfaceCapability(
        registry,
        "set-highlight",
        {
          on: "yes",
        },
      ) as { highlighting: boolean };
      expect(truthyParam).toEqual({ highlighting: true });

      const explicitOn = handleAgentSurfaceCapability(
        registry,
        "set-highlight",
        {
          on: true,
        },
      ) as { highlighting: boolean };
      expect(explicitOn).toEqual({ highlighting: true });
      expect(registry.isHighlighting()).toBe(true);
    });
  });

  it("throws on a capability outside the agent-surface set", () => {
    const registry = makeRegistry();
    expect(() =>
      handleAgentSurfaceCapability(registry, "teleport", {}),
    ).toThrow(/Unknown agent-surface capability "teleport"/);
  });
});
