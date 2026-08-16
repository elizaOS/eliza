/**
 * Verifies workspace-provider routing and its hard per-file character bound.
 * The deterministic tests exercise the exported provider helpers directly.
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceProvider, truncate } from "./workspace-provider.ts";

describe("workspace provider routing", () => {
  it("only enters planner contexts that can act on the workspace", () => {
    const provider = createWorkspaceProvider();

    expect(provider.contexts).toEqual([
      "code",
      "files",
      "terminal",
      "automation",
    ]);
    expect(provider.contextGate).toEqual({
      anyOf: ["code", "files", "terminal", "automation"],
    });
  });
});

describe("workspace provider truncation", () => {
  it("reserves room for the suffix within the requested maximum", () => {
    const result = truncate("x".repeat(20_001), 20_000);

    expect(result).toHaveLength(20_000);
    expect(result.endsWith("[... truncated at 20,000 chars]")).toBe(true);
  });

  it("returns content at the bound unchanged", () => {
    const content = "x".repeat(20_000);

    expect(truncate(content, 20_000)).toBe(content);
  });

  it("honors bounds shorter than the suffix", () => {
    expect(truncate("longer", 4)).toBe("\n\n[.");
    expect(truncate("longer", 0)).toBe("");
  });
});
