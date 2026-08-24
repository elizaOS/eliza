/**
 * Unit tests for system prompt strip: validates stripSystemConfig boundary detection.
 */
import { describe, expect, it } from "vitest";
import { stripSystemConfig } from "./system-prompt.ts";

describe("system-prompt", () => {
  it("returns unchanged body when system prompt markers are not present", () => {
    const input = '{"messages":[{"role":"user","content":"hello"}]}';
    const res = stripSystemConfig(input);
    expect(res.body).toBe(input);
    expect(res.stripped).toBe(0);
  });
});
