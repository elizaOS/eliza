/**
 * Tests for browser tabs renderer registry and preload script export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_TAB_PRELOAD_SCRIPT,
  type BrowserTabsRendererImpl,
  getBrowserTabsRendererImpl,
  setBrowserTabsRendererImpl,
} from "./browser-tabs-renderer-registry.ts";

describe("browser-tabs-renderer-registry", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    setBrowserTabsRendererImpl(null);
  });

  afterEach(() => {
    setBrowserTabsRendererImpl(null);
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("registers and retrieves a BrowserTabsRendererImpl instance", () => {
    const mockImpl: BrowserTabsRendererImpl = {
      evaluate: vi.fn(async () => ({ ok: true, result: 42 })),
      getTabRect: vi.fn(async () => ({ x: 0, y: 0, width: 800, height: 600 })),
    };

    setBrowserTabsRendererImpl(mockImpl);
    expect(getBrowserTabsRendererImpl()).toBe(mockImpl);
  });

  it("unregisters renderer when set to null or undefined", () => {
    const mockImpl: BrowserTabsRendererImpl = {
      evaluate: vi.fn(async () => ({ ok: true })),
      getTabRect: vi.fn(async () => null),
    };

    setBrowserTabsRendererImpl(mockImpl);
    expect(getBrowserTabsRendererImpl()).toBe(mockImpl);

    setBrowserTabsRendererImpl(null);
    expect(getBrowserTabsRendererImpl()).toBeUndefined();

    setBrowserTabsRendererImpl(mockImpl);
    setBrowserTabsRendererImpl(undefined);
    expect(getBrowserTabsRendererImpl()).toBeUndefined();
  });

  it("clears registry when passed non-object values", () => {
    setBrowserTabsRendererImpl(123 as unknown as BrowserTabsRendererImpl);
    expect(getBrowserTabsRendererImpl()).toBeUndefined();
  });

  it("exports BROWSER_TAB_PRELOAD_SCRIPT containing core runtime handlers", () => {
    expect(typeof BROWSER_TAB_PRELOAD_SCRIPT).toBe("string");
    expect(BROWSER_TAB_PRELOAD_SCRIPT.length).toBeGreaterThan(100);
    expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("__elizaTabExec");
    expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("__elizaTabKit");
    expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("__elizaWalletReply");
    expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("__elizaVaultAutofillRequest");
  });
});
