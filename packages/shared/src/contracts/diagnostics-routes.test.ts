/**
 * Contract tests for diagnostics export filters plus strict confirmed export
 * and delete request schemas: json/csv selection and optional filters.
 * Covers tags accepted as either an array or a single string, `since` as a
 * number or ISO string, and strict rejection of unknown formats and extra
 * fields. Pure in-process schema parsing — no server or mocks.
 */
import { describe, expect, it } from "vitest";
import * as confirmedDiagnosticsContracts from "./diagnostics-routes.js";
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

  it.each([undefined, false])("rejects export confirmation %s", (confirm) => {
    expect(
      confirmedDiagnosticsContracts.ConfirmedPostLogExportRequestSchema.safeParse(
        {
          format: "json",
          confirm,
        },
      ).success,
    ).toBe(false);
  });

  it("accepts only literal true confirmation", () => {
    expect(
      confirmedDiagnosticsContracts.ConfirmedPostLogExportRequestSchema.safeParse(
        {
          format: "json",
          confirm: true,
        },
      ).success,
    ).toBe(true);
  });
});

describe("DeleteLogsRequestSchema", () => {
  it("accepts only a strict literal-true confirmation", () => {
    expect(
      confirmedDiagnosticsContracts.DeleteLogsRequestSchema.safeParse({
        confirm: true,
      }).success,
    ).toBe(true);
    expect(
      confirmedDiagnosticsContracts.DeleteLogsRequestSchema.safeParse({})
        .success,
    ).toBe(false);
    expect(
      confirmedDiagnosticsContracts.DeleteLogsRequestSchema.safeParse({
        confirm: false,
      }).success,
    ).toBe(false);
    expect(
      confirmedDiagnosticsContracts.DeleteLogsRequestSchema.safeParse({
        confirm: true,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
