/**
 * Unit tests for workdir validation: validates task workdir path generation.
 */
import { describe, expect, it } from "vitest";
import { ensureTaskWorkdir } from "./workdir-validation.ts";

describe("workdir-validation", () => {
  it("generates and ensures distinct workspace directory for task", async () => {
    const dir = await ensureTaskWorkdir("task-unit-test-123");
    expect(dir).toContain(".eliza");
    expect(dir).toContain("workspaces");
    expect(dir).toContain("task-unit-test-123");
  });
});
