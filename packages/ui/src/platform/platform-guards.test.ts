// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const isElectrobunRuntime = vi.hoisted(() => vi.fn(() => false));
vi.mock("../bridge/electrobun-runtime", () => ({ isElectrobunRuntime }));

import { getActiveViewModality, getFrontendPlatform } from "./platform-guards";

const w = window as unknown as Record<string, unknown>;

describe("getActiveViewModality", () => {
  afterEach(() => {
    delete w.__elizaXRContext;
  });

  it("returns gui by default on a non-XR surface", () => {
    delete w.__elizaXRContext;
    expect(getActiveViewModality()).toBe("gui");
  });

  it("returns xr when the WebXR view host context is present", () => {
    w.__elizaXRContext = { viewId: "wallet" };
    expect(getActiveViewModality()).toBe("xr");
  });
});

describe("getFrontendPlatform", () => {
  afterEach(() => {
    isElectrobunRuntime.mockReturnValue(false);
  });

  it("reports desktop when the Electrobun runtime is detected (not the dead __ELECTROBUN__ flag)", () => {
    // Regression: the old check read window.__ELECTROBUN__, which the shell
    // sets nowhere, so desktop was mis-reported as "web". It must use the
    // real isElectrobunRuntime() signal instead.
    isElectrobunRuntime.mockReturnValue(true);
    expect(getFrontendPlatform()).toBe("desktop");
  });

  it("does not report desktop when not in the Electrobun runtime", () => {
    isElectrobunRuntime.mockReturnValue(false);
    // jsdom + no Capacitor native platform → web.
    expect(getFrontendPlatform()).toBe("web");
  });
});
