/**
 * Unit tests for use-api-keys: validates query key constant and hook export.
 */
import { describe, expect, it } from "vitest";
import { API_KEYS_QUERY_KEY, useApiKeys } from "./use-api-keys.ts";

describe("use-api-keys", () => {
  it("exports API_KEYS_QUERY_KEY constant array", () => {
    expect(API_KEYS_QUERY_KEY).toEqual(["api-keys"]);
  });

  it("exports useApiKeys hook function", () => {
    expect(typeof useApiKeys).toBe("function");
  });
});
