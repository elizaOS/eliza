import { describe, expect, it } from "bun:test";
import { normalizeVaultSegment } from "./connector-credential-refs";

describe("normalizeVaultSegment in plugin-google-workspace", () => {
  it("normalizes and trims characters cleanly", () => {
    expect(normalizeVaultSegment(" my-agent-123 ")).toBe("my-agent-123");
    expect(normalizeVaultSegment("___test___")).toBe("test");
    expect(normalizeVaultSegment("")).toBe("unknown");
    expect(normalizeVaultSegment("____")).toBe("unknown");
  });

  it("handles surrogate pairs and astral characters safely", () => {
    expect(normalizeVaultSegment("agent🚀test")).toBe("agent_test");
    expect(normalizeVaultSegment("agent_🚀_test")).toBe("agent___test");
    const longName = "a".repeat(70);
    expect(normalizeVaultSegment(longName).length).toBe(64);
  });
});
