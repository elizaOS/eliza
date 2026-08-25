/**
 * Behavior coverage for ballot-id boundary validation.
 *
 * Ballot route `:id` params must be rejected with 400 before any repository
 * lookup so Postgres UUID casts never surface as internal 500s. This pins the
 * contract: empty ids and non-UUID strings are typed client errors, and
 * well-formed UUIDs pass through untouched (misses stay a separate 404).
 */
import { describe, expect, test } from "bun:test";
import { parseBallotIdParam } from "./ballot-id";

describe("parseBallotIdParam", () => {
  test("rejects a missing id as a client error", () => {
    expect(parseBallotIdParam(undefined)).toEqual({
      ok: false,
      error: "Missing ballot id",
    });
  });

  test("rejects an empty id as a client error", () => {
    expect(parseBallotIdParam("")).toEqual({
      ok: false,
      error: "Missing ballot id",
    });
  });

  test("rejects a non-UUID string", () => {
    expect(parseBallotIdParam("not-a-uuid")).toEqual({
      ok: false,
      error: "Invalid ballot id",
    });
  });

  test("rejects a UUID with trailing garbage", () => {
    expect(
      parseBallotIdParam("11111111-1111-4111-8111-111111111111junk"),
    ).toEqual({
      ok: false,
      error: "Invalid ballot id",
    });
  });

  test("rejects a UUID with the wrong version nibble", () => {
    // v6 is outside the [1-5] version range the API accepts.
    expect(parseBallotIdParam("11111111-1111-6111-8111-111111111111")).toEqual({
      ok: false,
      error: "Invalid ballot id",
    });
  });

  test("accepts a well-formed UUID", () => {
    expect(parseBallotIdParam("11111111-1111-4111-8111-111111111111")).toEqual({
      ok: true,
      id: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("accepts an uppercase well-formed UUID (case-insensitive)", () => {
    expect(
      parseBallotIdParam("11111111-1111-4111-8111-111111111111".toUpperCase()),
    ).toEqual({
      ok: true,
      id: "11111111-1111-4111-8111-111111111111".toUpperCase(),
    });
  });
});
