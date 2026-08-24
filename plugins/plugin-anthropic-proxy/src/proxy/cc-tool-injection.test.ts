/**
 * Unit tests for cc-tool-injection: validates tool description stripping
 * and synthetic tool injection.
 */
import { describe, expect, it } from "vitest";
import { processToolsSection } from "./cc-tool-injection.ts";

describe("cc-tool-injection", () => {
  it("returns unchanged body when no tools section exists", () => {
    const input = '{"messages":[]}';
    const res = processToolsSection(input, true, true);
    expect(res.body).toBe(input);
    expect(res.descriptionsStripped).toBe(0);
  });

  it("injects synthetic tools into existing tools array", () => {
    const input = '{"tools":[{"name":"Bash"}]}';
    const res = processToolsSection(input, false, true);
    expect(res.syntheticToolsInjected).toBeGreaterThan(0);
    expect(res.body).toContain('"tools":[');
  });
});
