// @vitest-environment jsdom

/**
 * Covers `detectDomModality` / `setShellModality` (#9946): a shell owns the
 * active modality (gui/tui), a present XR context wins over it, and an invalid
 * shell value falls back to gui. Reads window globals under jsdom.
 */

import { afterEach, describe, expect, it } from "vitest";
import { detectDomModality, setShellModality } from "./dom.tsx";

afterEach(() => {
  delete (window as { __elizaShellModality?: unknown }).__elizaShellModality;
  delete (window as { __elizaXRContext?: unknown }).__elizaXRContext;
});

describe("shell-level modality owner (#9946)", () => {
  it("defaults to gui with no shell signal", () => {
    expect(detectDomModality()).toBe("gui");
  });

  it("reads the shell-declared modality once a shell owns it", () => {
    const dispose = setShellModality("tui");
    expect(detectDomModality()).toBe("tui");
    dispose();
    expect(detectDomModality()).toBe("gui");
  });

  it("lets a headset (XR context) win over the shell signal", () => {
    setShellModality("gui");
    (window as { __elizaXRContext?: unknown }).__elizaXRContext = {};
    expect(detectDomModality()).toBe("xr");
  });

  it("ignores an invalid shell modality value (falls back to gui)", () => {
    (window as { __elizaShellModality?: unknown }).__elizaShellModality =
      "hologram";
    expect(detectDomModality()).toBe("gui");
  });
});
