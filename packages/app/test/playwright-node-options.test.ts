import { describe, expect, it } from "bun:test";
import { withElizaSourceNodeOptions } from "../scripts/lib/playwright-node-options.mjs";

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
