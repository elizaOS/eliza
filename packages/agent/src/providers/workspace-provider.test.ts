/**
 * Verifies that workspace instructions are scoped to workspace-capable planner
 * contexts instead of inflating unrelated general action turns.
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceProvider } from "./workspace-provider.ts";

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
