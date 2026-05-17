import { describe, expect, it } from "vitest";
import { PostLogExportRequestSchema } from "./diagnostics-routes.js";

describe("PostLogExportRequestSchema", () => {
  it("accepts json format with no filters", () => {
    expect(PostLogExportRequestSchema.parse({ format: "json" })).toEqual({
      format: "json",
    });
  });

  it("accepts csv format with all filters", () => {
    const parsed = PostLogExportRequestSchema.parse({
      format: "csv",
      source: "agent",
      level: "warn",
      tags: ["security", "audit"],
      since: 1_700_000_000_000,
      limit: 500,
    });
    expect(parsed.format).toBe("csv");
    expect(parsed.tags).toEqual(["security", "audit"]);
  });

  it("accepts a single string for tags (handler picks first non-empty)", () => {
    expect(
      PostLogExportRequestSchema.parse({ format: "json", tags: "audit" }).tags,
    ).toBe("audit");
  });

  it("accepts since as a string", () => {
    expect(
      PostLogExportRequestSchema.parse({
        format: "json",
        since: "2025-01-01T00:00:00Z",
      }).since,
    ).toBe("2025-01-01T00:00:00Z");
  });

  it("rejects unknown format", () => {
    expect(() =>
      PostLogExportRequestSchema.parse({ format: "yaml" }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostLogExportRequestSchema.parse({ format: "json", encrypt: true }),
    ).toThrow();
  });
});
