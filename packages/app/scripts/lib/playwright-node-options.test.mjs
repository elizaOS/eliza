/**
 * Verifies that Playwright source-mode child processes inherit a stable,
 * idempotent Node option set while preserving caller-supplied options.
 */

import { describe, expect, it } from "vitest";
import { withElizaSourceNodeOptions } from "./playwright-node-options.mjs";

describe("withElizaSourceNodeOptions", () => {
  it("adds the source condition and TypeScript resolver", () => {
    expect(withElizaSourceNodeOptions(undefined)).toBe(
      "--conditions=eliza-source --import tsx",
    );
  });

  it("preserves existing options and adds each requirement once", () => {
    expect(withElizaSourceNodeOptions("--max-old-space-size=4096")).toBe(
      "--max-old-space-size=4096 --conditions=eliza-source --import tsx",
    );
  });

  it("is idempotent for the split import syntax", () => {
    const options = "--trace-warnings --conditions=eliza-source --import tsx";
    expect(withElizaSourceNodeOptions(options)).toBe(options);
  });

  it("recognizes the equals import syntax without adding a second loader", () => {
    const options = "--import=tsx --conditions=eliza-source";
    expect(withElizaSourceNodeOptions(options)).toBe(options);
  });
});
