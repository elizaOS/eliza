/**
 * Exercises the renderer registry's unattached, attached, and detached states.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = {};
});

import {
  getBrowserTabsRendererImpl,
  setBrowserTabsRendererImpl,
} from "../browser-tabs-renderer-registry.ts";

const fakeImpl = {
  evaluate: async () => ({ ok: true }),
  getTabRect: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
};

describe("browser-tabs-renderer-registry", () => {
  afterEach(() => {
    setBrowserTabsRendererImpl(null);
  });

  it("returns a not-attached fallback before any impl is set", () => {
    const impl = getBrowserTabsRendererImpl();
    expect(impl.evaluate).toBeDefined();
  });

  it("stores and retrieves the attached implementation", () => {
    setBrowserTabsRendererImpl(fakeImpl);
    expect(getBrowserTabsRendererImpl()).toBe(fakeImpl);
  });

  it("clears the registry when detached", () => {
    setBrowserTabsRendererImpl(fakeImpl);
    setBrowserTabsRendererImpl(null);
    expect(getBrowserTabsRendererImpl()).not.toBe(fakeImpl);
  });
});
