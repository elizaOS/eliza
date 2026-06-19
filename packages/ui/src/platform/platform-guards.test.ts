// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { getActiveViewModality } from "./platform-guards";

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
