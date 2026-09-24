/**
 * Exercises the renderer-side browser-tabs registry on the real module.
 * Covers the unmounted fallback, missing window, attach, replace, detach,
 * and pass-through of evaluate/getTabRect against a live window global.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserTabsRendererImpl,
  getBrowserTabsRendererImpl,
  setBrowserTabsRendererImpl,
} from "./browser-tabs-renderer-registry.ts";

const REGISTRY_KEY = "__ELIZA_BROWSER_TABS_REGISTRY__" as const;

type RegistryWindow = {
  [REGISTRY_KEY]?: BrowserTabsRendererImpl;
};

function installWindow(): RegistryWindow {
  const w: RegistryWindow = {};
  (globalThis as { window?: RegistryWindow }).window = w;
  return w;
}

function uninstallWindow(): void {
  delete (globalThis as { window?: RegistryWindow }).window;
}

afterEach(() => {
  uninstallWindow();
});

function makeImpl(label: string): BrowserTabsRendererImpl {
  return {
    evaluate: async (id, script, timeoutMs) => ({
      ok: true,
      result: { label, id, script, timeoutMs },
    }),
    getTabRect: async (id) => {
      if (id === "missing") return null;
      return { x: 10, y: 20, width: 30, height: 40 };
    },
  };
}

describe("browser-tabs-renderer-registry", () => {
  it("returns the unmounted evaluate error when window is absent", async () => {
    uninstallWindow();
    const impl = getBrowserTabsRendererImpl();
    await expect(impl.evaluate("tab-1", "1+1", 1000)).resolves.toEqual({
      ok: false,
      error: "BrowserWorkspaceView is not mounted — cannot evaluate tab tab-1",
    });
  });

  it("returns null from getTabRect when window is absent", async () => {
    uninstallWindow();
    await expect(
      getBrowserTabsRendererImpl().getTabRect("tab-1"),
    ).resolves.toBeNull();
  });

  it("ignores set when window is absent", () => {
    uninstallWindow();
    const impl = makeImpl("orphan");
    setBrowserTabsRendererImpl(impl);
    const windowHolder = installWindow();
    expect(windowHolder[REGISTRY_KEY]).toBeUndefined();
    expect(getBrowserTabsRendererImpl()).not.toBe(impl);
  });

  it("returns the unmounted fallback when window exists but no impl is attached", async () => {
    installWindow();
    const result = await getBrowserTabsRendererImpl().evaluate(
      "alpha",
      "script",
      50,
    );
    expect(result).toEqual({
      ok: false,
      error: "BrowserWorkspaceView is not mounted — cannot evaluate tab alpha",
    });
  });

  it("attaches an impl on the window global and returns the same object", () => {
    const w = installWindow();
    const impl = makeImpl("live");
    setBrowserTabsRendererImpl(impl);
    expect(w[REGISTRY_KEY]).toBe(impl);
    expect(getBrowserTabsRendererImpl()).toBe(impl);
  });

  it("forwards evaluate arguments and result through the attached impl", async () => {
    installWindow();
    setBrowserTabsRendererImpl(makeImpl("fwd"));
    await expect(
      getBrowserTabsRendererImpl().evaluate("t1", "2+2", 2500),
    ).resolves.toEqual({
      ok: true,
      result: { label: "fwd", id: "t1", script: "2+2", timeoutMs: 2500 },
    });
  });

  it("forwards getTabRect for a present tab and a missing tab", async () => {
    installWindow();
    setBrowserTabsRendererImpl(makeImpl("rect"));
    const renderer = getBrowserTabsRendererImpl();
    await expect(renderer.getTabRect("present")).resolves.toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
    await expect(renderer.getTabRect("missing")).resolves.toBeNull();
  });

  it("replaces a previously attached impl", async () => {
    installWindow();
    setBrowserTabsRendererImpl(makeImpl("first"));
    const second = makeImpl("second");
    setBrowserTabsRendererImpl(second);
    expect(getBrowserTabsRendererImpl()).toBe(second);
    await expect(
      getBrowserTabsRendererImpl().evaluate("id", "s", 1),
    ).resolves.toMatchObject({ result: { label: "second" } });
  });

  it("detaches with null and restores the unmounted fallback", async () => {
    const w = installWindow();
    setBrowserTabsRendererImpl(makeImpl("live"));
    setBrowserTabsRendererImpl(null);
    expect(REGISTRY_KEY in w).toBe(false);
    await expect(
      getBrowserTabsRendererImpl().evaluate("gone", "", 0),
    ).resolves.toEqual({
      ok: false,
      error: "BrowserWorkspaceView is not mounted — cannot evaluate tab gone",
    });
  });

  it("deleting a missing impl is a no-op", () => {
    const w = installWindow();
    expect(() => setBrowserTabsRendererImpl(null)).not.toThrow();
    expect(w[REGISTRY_KEY]).toBeUndefined();
  });

  it("interpolates an empty tab id into the unmounted evaluate error", async () => {
    uninstallWindow();
    await expect(
      getBrowserTabsRendererImpl().evaluate("", "script", 0),
    ).resolves.toEqual({
      ok: false,
      error: "BrowserWorkspaceView is not mounted — cannot evaluate tab ",
    });
  });

  it("returns the same unmounted fallback object while detached", () => {
    uninstallWindow();
    const a = getBrowserTabsRendererImpl();
    const b = getBrowserTabsRendererImpl();
    expect(a).toBe(b);
    installWindow();
    expect(getBrowserTabsRendererImpl()).toBe(a);
  });
});
