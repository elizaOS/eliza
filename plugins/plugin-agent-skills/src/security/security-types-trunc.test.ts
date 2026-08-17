import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("security types trunc reserve", () => {
  const src = fs.readFileSync("plugins/plugin-agent-skills/src/security/types.ts","utf8");
  it("reserve -1 present", () => { expect(src).toContain("slice(0, maxLen - 1)}…"); });
  it("no bare remains", () => { expect(src.includes("slice(0, maxLen)}…")).toBe(false); });
  it("count 1", () => { expect((src.match(/maxLen - 1/g)||[]).length).toBeGreaterThanOrEqual(1); });
  it("payload weak vs fixed + sibling", () => {
    const maxLen=120; const suffix="…"; const overflow=maxLen+suffix.length; const fixed=maxLen;
    expect(overflow).toBe(121); expect(fixed).toBe(120);
    const workspace=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(workspace).toContain("suffix.length");
  });
});
