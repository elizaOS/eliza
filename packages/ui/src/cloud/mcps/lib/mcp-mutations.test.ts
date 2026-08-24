/**
 * Unit tests for MCP mutations: validates mutation hook exports.
 */
import { describe, expect, it } from "vitest";
import {
  useCreateMcp,
  useDeleteMcp,
  usePublishMcp,
  useUnpublishMcp,
  useUpdateMcp,
} from "./mcp-mutations.ts";

describe("mcp-mutations", () => {
  it("exports all MCP mutation hook functions", () => {
    expect(typeof useCreateMcp).toBe("function");
    expect(typeof useUpdateMcp).toBe("function");
    expect(typeof useDeleteMcp).toBe("function");
    expect(typeof usePublishMcp).toBe("function");
    expect(typeof useUnpublishMcp).toBe("function");
  });
});
