/**
 * Unit tests for browser tabs renderer registry and preload script in
 * packages/shared/src/utils/browser-tabs-renderer-registry.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_TAB_PRELOAD_SCRIPT,
  type BrowserTabsRendererImpl,
  getBrowserTabsRendererImpl,
  setBrowserTabsRendererImpl,
} from "./browser-tabs-renderer-registry.js";

describe("browser-tabs-renderer-registry", () => {
  const REGISTRY_KEY = "__ELIZA_BROWSER_TABS_REGISTRY__";

  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[REGISTRY_KEY];
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>)[REGISTRY_KEY];
  });

  describe("setBrowserTabsRendererImpl and getBrowserTabsRendererImpl", () => {
    it("returns null when no renderer implementation is registered", () => {
      expect(getBrowserTabsRendererImpl()).toBeNull();
    });

    it("registers and retrieves a renderer implementation", async () => {
      const mockImpl: BrowserTabsRendererImpl = {
        evaluate: vi.fn().mockResolvedValue({ ok: true, result: 42 }),
        getTabRect: vi
          .fn()
          .mockResolvedValue({ x: 0, y: 0, width: 800, height: 600 }),
      };

      setBrowserTabsRendererImpl(mockImpl);
      expect(getBrowserTabsRendererImpl()).toBe(mockImpl);

      const evalRes = await getBrowserTabsRendererImpl()?.evaluate(
        "tab-1",
        "1 + 1",
        1000,
      );
      expect(evalRes).toEqual({ ok: true, result: 42 });
      expect(mockImpl.evaluate).toHaveBeenCalledWith("tab-1", "1 + 1", 1000);

      const rectRes = await getBrowserTabsRendererImpl()?.getTabRect("tab-1");
      expect(rectRes).toEqual({ x: 0, y: 0, width: 800, height: 600 });
      expect(mockImpl.getTabRect).toHaveBeenCalledWith("tab-1");
    });

    it("clears the registry when null is passed", () => {
      const mockImpl: BrowserTabsRendererImpl = {
        evaluate: vi.fn().mockResolvedValue({ ok: true }),
        getTabRect: vi.fn().mockResolvedValue(null),
      };

      setBrowserTabsRendererImpl(mockImpl);
      expect(getBrowserTabsRendererImpl()).toBe(mockImpl);

      setBrowserTabsRendererImpl(null);
      expect(getBrowserTabsRendererImpl()).toBeNull();
      expect(
        (globalThis as unknown as Record<string, unknown>)[REGISTRY_KEY],
      ).toBeUndefined();
    });
  });

  describe("BROWSER_TAB_PRELOAD_SCRIPT", () => {
    it("exports a valid JavaScript IIFE string containing required hooks", () => {
      expect(typeof BROWSER_TAB_PRELOAD_SCRIPT).toBe("string");
      expect(BROWSER_TAB_PRELOAD_SCRIPT.length).toBeGreaterThan(1000);

      // Verify core contracts and global bridge installations
      expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("window.__elizaTabExec");
      expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("window.__elizaTabKit");
      expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("__electrobunSendToHost");
      expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("scanLoginForms");
    });
  });
});
