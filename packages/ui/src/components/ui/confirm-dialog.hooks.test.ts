/**
 * Unit tests for confirm dialog hooks: validates useConfirm and usePrompt exports.
 */
import { describe, expect, it } from "vitest";
import { useConfirm, usePrompt } from "./confirm-dialog.hooks.ts";

describe("confirm-dialog.hooks", () => {
  it("exports useConfirm and usePrompt hook functions", () => {
    expect(typeof useConfirm).toBe("function");
    expect(typeof usePrompt).toBe("function");
  });
});
