/**
 * Unit tests for use-mcps: validates query keys and hook functions.
 */
import { describe, expect, it } from "vitest";
import {
  MCPS_QUERY_KEY,
  useBuiltinMcps,
  usePublicMcps,
  useUserMcpDetail,
  useUserMcps,
} from "./use-mcps.ts";

describe("use-mcps", () => {
  it("exports MCPS_QUERY_KEY root query constant", () => {
    expect(MCPS_QUERY_KEY).toEqual(["mcps"]);
  });

  it("exports MCP query hook functions", () => {
    expect(typeof useUserMcps).toBe("function");
    expect(typeof usePublicMcps).toBe("function");
    expect(typeof useUserMcpDetail).toBe("function");
    expect(typeof useBuiltinMcps).toBe("function");
  });
});
