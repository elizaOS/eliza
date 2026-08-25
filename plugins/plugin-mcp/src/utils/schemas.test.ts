import { describe, expect, it } from "vitest";
import { isResourceSelection, isToolSelectionArgument, isToolSelectionName } from "./schemas";

describe("isToolSelectionName", () => {
  it("accepts a selection with non-empty server and tool names", () => {
    expect(isToolSelectionName({ serverName: "mcp-server", toolName: "read" })).toBe(true);
  });

  it("rejects non-objects and null", () => {
    expect(isToolSelectionName(null)).toBe(false);
    expect(isToolSelectionName("mcp-server")).toBe(false);
    expect(isToolSelectionName(undefined)).toBe(false);
    expect(isToolSelectionName([1])).toBe(false);
  });

  it("rejects empty or missing required names", () => {
    expect(isToolSelectionName({ serverName: "", toolName: "read" })).toBe(false);
    expect(isToolSelectionName({ serverName: "srv", toolName: "" })).toBe(false);
    expect(isToolSelectionName({ serverName: "srv" })).toBe(false);
    expect(isToolSelectionName({ toolName: "read" })).toBe(false);
    expect(isToolSelectionName({})).toBe(false);
  });

  it("ignores optional reasoning/noToolAvailable fields", () => {
    expect(
      isToolSelectionName({
        serverName: "srv",
        toolName: "read",
        reasoning: "because",
        noToolAvailable: false,
      })
    ).toBe(true);
  });
});

describe("isToolSelectionArgument", () => {
  it("accepts a plain object toolArguments", () => {
    expect(isToolSelectionArgument({ toolArguments: { query: "x", limit: 5 } })).toBe(true);
    expect(isToolSelectionArgument({ toolArguments: {} })).toBe(true);
  });

  it("rejects null, missing, and non-object toolArguments", () => {
    expect(isToolSelectionArgument({ toolArguments: null })).toBe(false);
    expect(isToolSelectionArgument({})).toBe(false);
    expect(isToolSelectionArgument({ toolArguments: "query" })).toBe(false);
    expect(isToolSelectionArgument({ toolArguments: 42 })).toBe(false);
  });

  it("rejects array toolArguments despite typeof object", () => {
    // The declared JSON schema types toolArguments as { "type": "object" },
    // which excludes arrays; the guard must match the schema.
    expect(isToolSelectionArgument({ toolArguments: [1, 2] })).toBe(false);
  });

  it("rejects non-object frames", () => {
    expect(isToolSelectionArgument(null)).toBe(false);
    expect(isToolSelectionArgument([{ toolArguments: {} }])).toBe(false);
    expect(isToolSelectionArgument("x")).toBe(false);
  });
});

describe("isResourceSelection", () => {
  it("accepts a selection with non-empty server name and uri", () => {
    expect(isResourceSelection({ serverName: "mcp-server", uri: "mem://topic/1" })).toBe(true);
  });

  it("rejects empty or missing required fields", () => {
    expect(isResourceSelection({ serverName: "", uri: "mem://x" })).toBe(false);
    expect(isResourceSelection({ serverName: "srv", uri: "" })).toBe(false);
    expect(isResourceSelection({ serverName: "srv" })).toBe(false);
    expect(isResourceSelection({})).toBe(false);
    expect(isResourceSelection(null)).toBe(false);
  });

  it("ignores optional fields", () => {
    expect(
      isResourceSelection({
        serverName: "srv",
        uri: "mem://x",
        reasoning: "r",
        noResourceAvailable: true,
      })
    ).toBe(true);
  });
});
