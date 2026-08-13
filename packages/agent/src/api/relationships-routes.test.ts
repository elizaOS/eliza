/**
 * Exercises the relationships route query boundary with pure helpers and a
 * mocked graph service; no live HTTP server, database, or model is used.
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleRelationshipsRoutes,
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

  it("rejects decimal values that cannot be represented safely", () => {
    expect(
      parseRelationshipsQueryInteger(String(Number.MAX_SAFE_INTEGER), {
        min: 0,
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      parseRelationshipsQueryInteger(String(Number.MAX_SAFE_INTEGER + 1), {
        min: 0,
      }),
    ).toBeUndefined();
    expect(
      parseRelationshipsQueryInteger("999999999999999999999999999999", {
        min: 0,
      }),
    ).toBeUndefined();
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

  it("passes only validated pagination values to the graph service", async () => {
    const snapshot = { people: [], relationships: [], stats: {} };
    const getGraphSnapshot = vi.fn(async () => snapshot);
    const json = vi.fn();
    const error = vi.fn();
    const runtime = {
      getService: () => ({
        getGraphSnapshot,
        getPersonDetail: vi.fn(),
        getCandidateMerges: vi.fn(),
        acceptMerge: vi.fn(),
        rejectMerge: vi.fn(),
      }),
    };

    await handleRelationshipsRoutes({
      req: {
        url: "/api/relationships/graph?limit=9007199254740993&offset=4junk",
      } as never,
      res: {} as never,
      method: "GET",
      pathname: "/api/relationships/graph",
      json,
      error,
      readJsonBody: vi.fn(),
      runtime: runtime as never,
    });

    expect(getGraphSnapshot).toHaveBeenCalledWith({
      search: null,
      platform: null,
      limit: undefined,
      offset: undefined,
      scope: undefined,
    });
    expect(json).toHaveBeenCalledWith({}, { data: snapshot }, 200);
    expect(error).not.toHaveBeenCalled();
  });
});
