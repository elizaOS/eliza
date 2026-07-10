/**
 * Verifies that Playwright source-mode child processes inherit a stable,
 * idempotent Node option set while preserving caller-supplied options.
 */

import { describe, expect, it } from "vitest";
import { withElizaSourceNodeOptions } from "./playwright-node-options.mjs";

describe("withElizaSourceNodeOptions", () => {
  it("adds the source condition", () => {
    expect(withElizaSourceNodeOptions(undefined)).toBe(
      "--conditions=eliza-source",
    );
  });

  it("preserves existing options", () => {
    expect(withElizaSourceNodeOptions("--max-old-space-size=4096")).toBe(
      "--max-old-space-size=4096 --conditions=eliza-source",
    );
  });

  it("is idempotent", () => {
    const options = "--trace-warnings --conditions=eliza-source";
    expect(withElizaSourceNodeOptions(options)).toBe(options);
  });
});
