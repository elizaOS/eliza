import { describe, expect, it } from "vitest";
import { formatSubagentName } from "./subagent-display";

describe("formatSubagentName", () => {
  it("formats built-in sub-agents with leading uppercase labels", () => {
    expect(formatSubagentName("general")).toBe("General");
    expect(formatSubagentName("explore")).toBe("Explore");
    expect(formatSubagentName("vision")).toBe("Vision");
    expect(formatSubagentName("verify")).toBe("Verify");
    expect(formatSubagentName("verify-detect")).toBe("Verify Detect");
    expect(formatSubagentName("verify-manifest")).toBe("Verify Manifest");
    expect(formatSubagentName("computer")).toBe("Computer");
  });

  it("capitalizes custom sub-agent names", () => {
    expect(formatSubagentName("security-review")).toBe("Security-review");
    expect(formatSubagentName("Docs")).toBe("Docs");
  });

  it("falls back to Sub-agent for empty names", () => {
    expect(formatSubagentName("")).toBe("Sub-agent");
  });
});
