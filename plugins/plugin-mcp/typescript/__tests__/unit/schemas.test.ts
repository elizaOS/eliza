import { describe, expect, it } from "vitest";
import {
  isResourceSelection,
  isToolSelectionArgument,
  isToolSelectionName,
} from "../../src/utils/schemas";

describe("Schema Type Guards", () => {
  describe("isToolSelectionName", () => {
    it("should return true for valid tool selection names", () => {
      const valid = {
        serverName: "github",
        toolName: "get_file_contents",
        reasoning: "User wants to read a file",
      };
      expect(isToolSelectionName(valid)).toBe(true);
    });

    it("should return true without optional fields", () => {
      const valid = {
        serverName: "github",
        toolName: "get_file_contents",
      };
      expect(isToolSelectionName(valid)).toBe(true);
    });

    it("should return false for missing serverName", () => {
      expect(isToolSelectionName({ toolName: "test" })).toBe(false);
    });

    it("should return false for missing toolName", () => {
      expect(isToolSelectionName({ serverName: "test" })).toBe(false);
    });

    it("should return false for empty serverName", () => {
      expect(isToolSelectionName({ serverName: "", toolName: "test" })).toBe(false);
    });

    it("should return false for empty toolName", () => {
      expect(isToolSelectionName({ serverName: "test", toolName: "" })).toBe(false);
    });

    it("should return false for null", () => {
      expect(isToolSelectionName(null)).toBe(false);
    });

    it("should return false for non-objects", () => {
      expect(isToolSelectionName("string")).toBe(false);
      expect(isToolSelectionName(123)).toBe(false);
    });
  });

  describe("isToolSelectionArgument", () => {
    it("should return true for valid tool selection arguments", () => {
      const valid = {
        toolArguments: {
          owner: "facebook",
          repo: "react",
        },
      };
      expect(isToolSelectionArgument(valid)).toBe(true);
    });

    it("should return true for empty toolArguments", () => {
      const valid = { toolArguments: {} };
      expect(isToolSelectionArgument(valid)).toBe(true);
    });

    it("should return false for missing toolArguments", () => {
      expect(isToolSelectionArgument({})).toBe(false);
    });

    it("should return false for non-object toolArguments", () => {
      expect(isToolSelectionArgument({ toolArguments: "string" })).toBe(false);
    });

    it("should return false for null toolArguments", () => {
      expect(isToolSelectionArgument({ toolArguments: null })).toBe(false);
    });
  });

  describe("isResourceSelection", () => {
    it("should return true for valid resource selections", () => {
      const valid = {
        serverName: "docs",
        uri: "docs://readme",
        reasoning: "User wants documentation",
      };
      expect(isResourceSelection(valid)).toBe(true);
    });

    it("should return true without optional fields", () => {
      const valid = {
        serverName: "docs",
        uri: "docs://readme",
      };
      expect(isResourceSelection(valid)).toBe(true);
    });

    it("should return false for missing serverName", () => {
      expect(isResourceSelection({ uri: "test" })).toBe(false);
    });

    it("should return false for missing uri", () => {
      expect(isResourceSelection({ serverName: "test" })).toBe(false);
    });

    it("should return false for empty serverName", () => {
      expect(isResourceSelection({ serverName: "", uri: "test" })).toBe(false);
    });

    it("should return false for empty uri", () => {
      expect(isResourceSelection({ serverName: "test", uri: "" })).toBe(false);
    });
  });
});
