/**
 * Unit tests for credits hook: validates useCreditsBalance export.
 */
import { describe, expect, it } from "vitest";
import { useCreditsBalance } from "./credits.ts";

describe("credits", () => {
  it("exports useCreditsBalance hook function", () => {
    expect(typeof useCreditsBalance).toBe("function");
  });
});
