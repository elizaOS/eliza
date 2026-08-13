import { describe, expect, it } from "vitest";
import {
  parseRelationshipsQuery,
  parseRelationshipsQueryInteger,
} from "./relationships-routes.ts";

describe("parseRelationshipsQueryInteger", () => {
  it("preserves omitted values and parses complete unsigned decimals", () => {
    expect(parseRelationshipsQueryInteger(null)).toBeUndefined();
    expect(parseRelationshipsQueryInteger("25", { min: 1 })).toBe(25);
    expect(parseRelationshipsQueryInteger("0", { min: 0 })).toBe(0);
    expect(parseRelationshipsQueryInteger("0007", { min: 0 })).toBe(7);
  });

  it("rejects incomplete, signed, and below-minimum values", () => {
    for (const value of ["", "12abc", "1.5", "1e2", "+2", "-1"]) {
      expect(parseRelationshipsQueryInteger(value, { min: 0 })).toBeUndefined();
    }
    expect(parseRelationshipsQueryInteger("0", { min: 1 })).toBeUndefined();
  });
});

describe("parseRelationshipsQuery", () => {
  it("preserves omitted query values", () => {
    expect(parseRelationshipsQuery(undefined)).toEqual({
      search: null,
      platform: null,
      limit: undefined,
      offset: undefined,
      scope: undefined,
    });
  });

  it("parses valid values and omits invalid pagination values", () => {
    expect(
      parseRelationshipsQuery(
        "/api/relationships/graph?search=alice&platform=web&limit=10&offset=0&scope=relevant",
      ),
    ).toEqual({
      search: "alice",
      platform: "web",
      limit: 10,
      offset: 0,
      scope: "relevant",
    });
    expect(
      parseRelationshipsQuery(
        "/api/relationships/graph?limit=10abc&offset=1.5",
      ),
    ).toMatchObject({ limit: undefined, offset: undefined });
  });
});
