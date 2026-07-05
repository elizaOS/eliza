// @vitest-environment jsdom
//
// Capability broker (#13452): a plugin view only gets the mutating agent-surface
// capabilities its manifest grants. Two layers of coverage:
//   1. Pure classification + gate logic (fails closed, read-only always open).
//   2. The REAL path — a mounted DynamicViewLoader driven through the actual
//      view-interact registry (dispatchViewInteract → handler → client WS
//      result). No mock stands in for the broker: the assertions are on the
//      real `view:interact:result` payload the agent receives.

import {
  IMMERSIVE_WALLPAPER_SURFACE,
  resolveSurfaceManifest,
  type SurfaceManifest,
} from "@elizaos/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brokerViewInteract,
  isReadOnlyViewCapability,
  ViewCapabilityDeniedError,
  viewManifestAllowsCapability,
} from "./view-capability-broker";

const AGENT_SURFACE_GRANT: SurfaceManifest = {
  capabilities: ["agent-surface"],
};

describe("isReadOnlyViewCapability", () => {
  it("classifies every read capability read-only", () => {
    for (const cap of [
      "get-text",
      "get-state",
      "list-elements",
      "describe-element",
      "get-focus",
      "get-agent-state",
    ]) {
      expect(isReadOnlyViewCapability(cap)).toBe(true);
    }
  });

  it("classifies every mutating capability NOT read-only", () => {
    for (const cap of [
      "agent-click",
      "agent-fill",
      "agent-focus",
      "agent-scroll-to",
      "click-element",
      "fill-input",
      "focus-element",
      "refresh",
      "set-highlight",
      // An unknown/future capability fails closed (treated as mutating).
      "some-unknown-capability",
    ]) {
      expect(isReadOnlyViewCapability(cap)).toBe(false);
    }
  });
});

describe("viewManifestAllowsCapability", () => {
  it("allows read-only capabilities regardless of grants", () => {
    const noGrants = resolveSurfaceManifest({ surface: { capabilities: [] } });
    expect(viewManifestAllowsCapability(noGrants, "get-text")).toBe(true);
    expect(viewManifestAllowsCapability(noGrants, "list-elements")).toBe(true);
  });

  it("denies every mutating capability without the agent-surface grant", () => {
    const noGrants = resolveSurfaceManifest({ surface: { capabilities: [] } });
    expect(viewManifestAllowsCapability(noGrants, "agent-fill")).toBe(false);
    expect(viewManifestAllowsCapability(noGrants, "click-element")).toBe(false);
    expect(viewManifestAllowsCapability(noGrants, "refresh")).toBe(false);
  });

  it("allows mutating capabilities once agent-surface is granted", () => {
    const granted = resolveSurfaceManifest({ surface: AGENT_SURFACE_GRANT });
    expect(viewManifestAllowsCapability(granted, "agent-fill")).toBe(true);
    expect(viewManifestAllowsCapability(granted, "click-element")).toBe(true);
    expect(viewManifestAllowsCapability(granted, "refresh")).toBe(true);
  });

  it("fails closed for an unrelated grant set", () => {
    const other = resolveSurfaceManifest({
      surface: { capabilities: ["navigate", "storage", "wallpaper"] },
    });
    expect(viewManifestAllowsCapability(other, "agent-fill")).toBe(false);
  });
});

describe("brokerViewInteract", () => {
  it("delegates a granted capability to the underlying handler", async () => {
    const inner = vi.fn(async () => ({ ok: true }));
    const gated = brokerViewInteract(
      "v1",
      resolveSurfaceManifest({ surface: AGENT_SURFACE_GRANT }),
      inner,
    );
    await expect(gated("agent-fill", { id: "x", value: "y" })).resolves.toEqual(
      {
        ok: true,
      },
    );
    expect(inner).toHaveBeenCalledWith("agent-fill", { id: "x", value: "y" });
  });

  it("throws ViewCapabilityDeniedError for a denied capability, never calling the handler", async () => {
    const inner = vi.fn(async () => ({ ok: true }));
    const gated = brokerViewInteract(
      "v1",
      resolveSurfaceManifest({ surface: { capabilities: [] } }),
      inner,
    );
    await expect(gated("agent-fill", { id: "x", value: "y" })).rejects.toThrow(
      ViewCapabilityDeniedError,
    );
    expect(inner).not.toHaveBeenCalled();
  });

  it("always delegates read-only capabilities regardless of grants", async () => {
    const inner = vi.fn(async () => "text");
    const gated = brokerViewInteract(
      "v1",
      resolveSurfaceManifest({ surface: { capabilities: [] } }),
      inner,
    );
    await expect(gated("get-text")).resolves.toBe("text");
    expect(inner).toHaveBeenCalledWith("get-text", undefined);
  });
});

// ── Real-path: a mounted DynamicViewLoader gated by its manifest ─────────────
const { sendWsMessage } = vi.hoisted(() => ({ sendWsMessage: vi.fn() }));
vi.mock("../../api", () => ({ client: { sendWsMessage } }));

// Import after the api mock so DynamicViewLoader binds the mocked client.
const { __resetDynamicViewLoaderCacheForTests, DynamicViewLoader } =
  await import("./DynamicViewLoader");

describe("DynamicViewLoader capability broker (real interact path #13452)", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent ?? "";
      },
    });
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: { escape: (v: string) => v.replaceAll('"', '\\"') },
    });
    sendWsMessage.mockClear();
  });

  afterEach(() => {
    delete window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__;
    sendWsMessage.mockClear();
    cleanup();
    __resetDynamicViewLoaderCacheForTests();
    vi.restoreAllMocks();
  });

  // A view module exporting its own interact handler. The broker sits IN FRONT
  // of it, so a denied capability must never reach this spy.
  function mountView(
    viewId: string,
    surface: SurfaceManifest | undefined,
    interact: (
      capability: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function Panel() {
        // A native field so DOM-level fill/click have a real target too.
        return (
          <section>
            <h1>Panel {viewId}</h1>
            <input name="field" defaultValue="" />
          </section>
        );
      },
      interact,
    }));
    return render(
      <DynamicViewLoader
        bundleUrl={`https://capability.example.test/assets/${viewId}.js`}
        viewId={viewId}
        viewType="gui"
        surface={surface}
      />,
    );
  }

  it("DENIES a mutating capability on a view WITHOUT the agent-surface grant — agent sees an explicit failure, module never runs", async () => {
    const moduleInteract = vi.fn(async () => ({ moduleRan: true }));
    mountView("ungranted.view", { capabilities: [] }, moduleInteract);
    await screen.findByText("Panel ungranted.view");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await act(async () => {
      await dispatchViewInteract(
        "ungranted.view",
        "gui",
        "agent-fill",
        { id: "field", value: "pwn" },
        "req-denied",
      );
    });

    // The denial is OBSERVABLE: a real `success: false` result reaches the agent,
    // not a fabricated no-op.
    await waitFor(() => {
      expect(sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "view:interact:result",
          requestId: "req-denied",
          success: false,
          error: expect.stringContaining("not granted capability"),
        }),
      );
    });
    // And the view's own interact handler was never invoked for the denied cap.
    expect(moduleInteract).not.toHaveBeenCalled();
  });

  it("ALLOWS the same mutating capability on a view WITH the agent-surface grant", async () => {
    const moduleInteract = vi.fn(async () => ({ moduleRan: true }));
    mountView(
      "granted.view",
      { capabilities: ["agent-surface"] },
      moduleInteract,
    );
    await screen.findByText("Panel granted.view");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await act(async () => {
      await dispatchViewInteract(
        "granted.view",
        "gui",
        // A standard DOM-level fill capability — handled by the loader itself,
        // proving the broker admits it through to the real handler path.
        "fill-input",
        { name: "field", value: "hello" },
        "req-allowed",
      );
    });

    await waitFor(() => {
      expect(sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "view:interact:result",
          requestId: "req-allowed",
          success: true,
        }),
      );
    });
  });

  it("read-only introspection succeeds even on an un-manifested view (default no grants)", async () => {
    const moduleInteract = vi.fn(async () => ({}));
    // No `surface` prop at all → default manifest, zero grants.
    mountView("readonly.view", undefined, moduleInteract);
    await screen.findByText("Panel readonly.view");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await act(async () => {
      await dispatchViewInteract(
        "readonly.view",
        "gui",
        "get-text",
        undefined,
        "req-read",
      );
    });

    await waitFor(() => {
      expect(sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "view:interact:result",
          requestId: "req-read",
          success: true,
          result: expect.stringContaining("Panel readonly.view"),
        }),
      );
    });
  });

  it("a view granted the immersive-wallpaper manifest does NOT get agent-surface — unrelated grants never unlock mutation", async () => {
    // IMMERSIVE_WALLPAPER_SURFACE grants wallpaper + background:apply but NOT
    // agent-surface — proving unrelated grants do not unlock mutation.
    const moduleInteract = vi.fn(async () => ({ moduleRan: true }));
    mountView("immersive.view", IMMERSIVE_WALLPAPER_SURFACE, moduleInteract);
    await screen.findByText("Panel immersive.view");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await act(async () => {
      await dispatchViewInteract(
        "immersive.view",
        "gui",
        "agent-click",
        { id: "field" },
        "req-immersive",
      );
    });

    await waitFor(() => {
      expect(sendWsMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "req-immersive",
          success: false,
          error: expect.stringContaining("not granted capability"),
        }),
      );
    });
    expect(moduleInteract).not.toHaveBeenCalled();
  });
});
