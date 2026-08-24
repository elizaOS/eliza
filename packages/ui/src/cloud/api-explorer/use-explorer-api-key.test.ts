/**
 * Unit tests for use-explorer-api-key: validates hook export.
 */
import { describe, expect, it } from "vitest";
import { useExplorerApiKey } from "./use-explorer-api-key.ts";

describe("use-explorer-api-key", () => {
  it("exports useExplorerApiKey hook function", () => {
    expect(typeof useExplorerApiKey).toBe("function");
  });
});
