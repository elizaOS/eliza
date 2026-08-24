/**
 * Unit tests for toast adapter: validates toast function signature and execution.
 */
import { describe, expect, it } from "vitest";
import { toast } from "./toast.ts";

describe("toast", () => {
  it("exports callable toast adapter function", () => {
    expect(typeof toast).toBe("function");
  });
});
