/**
 * Unit tests for useRegistryCatalog: validates catalog hook export.
 */
import { describe, expect, it } from "vitest";
import { useRegistryCatalog } from "./useRegistryCatalog.ts";

describe("useRegistryCatalog", () => {
  it("exports useRegistryCatalog hook function", () => {
    expect(typeof useRegistryCatalog).toBe("function");
  });
});
