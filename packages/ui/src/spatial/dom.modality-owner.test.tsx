/** Verifies shell-level modality owner (#9946) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers `detectDomModality` / `setShellModality` (#9946): a shell owns the
 * active modality, and an invalid shell value falls back to gui. Reads window
 * globals under jsdom.
 */

import { afterEach, describe, expect, it } from "vitest";
import { detectDomModality, setShellModality } from "./dom.tsx";

afterEach(() => {
  delete (window as { __elizaShellModality?: unknown }).__elizaShellModality;
});

describe("shell-level modality owner (#9946)", () => {
  it("defaults to gui with no shell signal", () => {
    expect(detectDomModality()).toBe("gui");
  });

  it("reads the shell-declared modality once a shell owns it", () => {
    const dispose = setShellModality("xr");
    expect(detectDomModality()).toBe("xr");
    dispose();
    expect(detectDomModality()).toBe("gui");
  });

  it("ignores an invalid shell modality value (falls back to gui)", () => {
    (window as { __elizaShellModality?: unknown }).__elizaShellModality =
      "hologram";
    expect(detectDomModality()).toBe("gui");
  });
});
