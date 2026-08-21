/**
 * Deterministically verifies the Node export-condition boundary between the
 * Playwright collector and its package-building subprocesses.
 */
import { describe, expect, it } from "bun:test";
import {
  withElizaSourceNodeOptions,
  withoutElizaSourceNodeOptions,
} from "./playwright-node-options.mjs";

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

describe("withoutElizaSourceNodeOptions", () => {
  it("removes the source condition without inventing another option", () => {
    expect(withoutElizaSourceNodeOptions("--conditions=eliza-source")).toBe("");
  });

  it("preserves unrelated options and conditions", () => {
    expect(
      withoutElizaSourceNodeOptions(
        "--trace-warnings --conditions=eliza-source --conditions=production --max-old-space-size=4096",
      ),
    ).toBe(
      "--trace-warnings --conditions=production --max-old-space-size=4096",
    );
  });

  it("removes the space-separated source condition form", () => {
    expect(
      withoutElizaSourceNodeOptions(
        "--conditions production --conditions eliza-source --trace-warnings",
      ),
    ).toBe("--conditions production --trace-warnings");
  });

  it("accepts a missing Node options value", () => {
    expect(withoutElizaSourceNodeOptions(undefined)).toBe("");
  });
});
