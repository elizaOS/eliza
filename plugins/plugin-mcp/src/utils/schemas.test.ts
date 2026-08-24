/**
 * Type-guard tests for the MCP model-selection schemas.
 *
 * Materiality: these guards gate tool/resource dispatch on model-produced
 * JSON. A selection with an empty serverName/toolName would otherwise be
 * treated as a real target and route a tool call to the wrong server (or to
 * no server at all). The guards are deliberately structural — extra fields
 * must not fail a selection, while missing/empty required fields must.
 */
import { describe, expect, it } from "vitest";
import { isResourceSelection, isToolSelectionArgument, isToolSelectionName } from "./schemas";

describe("isToolSelectionName", () => {
  it("accepts a minimal valid selection", () => {
    expect(isToolSelectionName({ serverName: "fs", toolName: "read" })).toBe(true);
  });

  it("tolerates optional fields and extra properties", () => {
    expect(
      isToolSelectionName({
        serverName: "fs",
        toolName: "read",
        reasoning: "needed for the task",
        noToolAvailable: false,
        extra: 1,
      })
    ).toBe(true);
  });

  it("rejects non-object values", () => {
    expect(isToolSelectionName(null)).toBe(false);
    expect(isToolSelectionName(undefined)).toBe(false);
    expect(isToolSelectionName("fs")).toBe(false);
    expect(isToolSelectionName(42)).toBe(false);
    expect(isToolSelectionName([])).toBe(false);
  });

  it("rejects empty or missing required string fields", () => {
    expect(isToolSelectionName({ serverName: "", toolName: "read" })).toBe(false);
    expect(isToolSelectionName({ serverName: "fs", toolName: "" })).toBe(false);
    expect(isToolSelectionName({ serverName: "fs" })).toBe(false);
    expect(isToolSelectionName({ toolName: "read" })).toBe(false);
  });

  it("rejects non-string required fields", () => {
    expect(isToolSelectionName({ serverName: 1, toolName: "read" })).toBe(false);
    expect(isToolSelectionName({ serverName: "fs", toolName: null })).toBe(false);
  });
});

describe("isToolSelectionArgument", () => {
  it("accepts an empty tool-arguments object", () => {
    expect(isToolSelectionArgument({ toolArguments: {} })).toBe(true);
  });

  it("accepts populated tool arguments", () => {
    expect(isToolSelectionArgument({ toolArguments: { path: "/tmp", force: true } })).toBe(true);
  });

  it("rejects missing, null, or non-object toolArguments", () => {
    expect(isToolSelectionArgument({})).toBe(false);
    expect(isToolSelectionArgument({ toolArguments: null })).toBe(false);
    expect(isToolSelectionArgument({ toolArguments: "path" })).toBe(false);
    expect(isToolSelectionArgument(null)).toBe(false);
  });
});

describe("isResourceSelection", () => {
  it("accepts a minimal valid resource selection", () => {
    expect(isResourceSelection({ serverName: "fs", uri: "file:///tmp/a.txt" })).toBe(true);
  });

  it("tolerates optional fields and extra properties", () => {
    expect(
      isResourceSelection({
        serverName: "fs",
        uri: "file:///tmp/a.txt",
        reasoning: "context",
        noResourceAvailable: false,
        extra: true,
      })
    ).toBe(true);
  });

  it("rejects empty or missing uri/serverName", () => {
    expect(isResourceSelection({ serverName: "fs", uri: "" })).toBe(false);
    expect(isResourceSelection({ serverName: "", uri: "file:///x" })).toBe(false);
    expect(isResourceSelection({ serverName: "fs" })).toBe(false);
    expect(isResourceSelection({ uri: "file:///x" })).toBe(false);
  });

  it("rejects non-object values", () => {
    expect(isResourceSelection("file:///x")).toBe(false);
    expect(isResourceSelection(undefined)).toBe(false);
  });
});
