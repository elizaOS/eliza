/**
 * Pins the approval-request path-id boundary validation: malformed ids must
 * be rejected as typed client errors before any repository lookup so Postgres
 * UUID casts never surface as internal 500s on public or authenticated routes.
 */
import { describe, expect, test } from "bun:test";
import { parseApprovalRequestIdParam } from "./approval-request-id";

const VALID_ID = "3f7f4c9e-1a2b-4c3d-8e5f-6a7b8c9d0e1f";

describe("parseApprovalRequestIdParam", () => {
  test("rejects an absent id as a missing-param client error", () => {
    expect(parseApprovalRequestIdParam(undefined)).toEqual({
      ok: false,
      error: "Missing approval request id",
    });
    expect(parseApprovalRequestIdParam("")).toEqual({
      ok: false,
      error: "Missing approval request id",
    });
  });

  test("rejects non-UUID strings as invalid", () => {
    expect(parseApprovalRequestIdParam("not-a-uuid")).toEqual({
      ok: false,
      error: "Invalid approval request id",
    });
    expect(parseApprovalRequestIdParam("123")).toEqual({
      ok: false,
      error: "Invalid approval request id",
    });
    expect(parseApprovalRequestIdParam("3f7f4c9e-1a2b-4c3d-8e5f")).toEqual({
      ok: false,
      error: "Invalid approval request id",
    });
  });

  test("rejects UUIDs with a version digit outside 1-5", () => {
    // Version 6+ UUIDs are not supported by the shared validator.
    expect(
      parseApprovalRequestIdParam("3f7f4c9e-1a2b-6c3d-8e5f-6a7b8c9d0e1f"),
    ).toEqual({
      ok: false,
      error: "Invalid approval request id",
    });
  });

  test("accepts a well-formed UUID v4", () => {
    expect(parseApprovalRequestIdParam(VALID_ID)).toEqual({
      ok: true,
      id: VALID_ID,
    });
  });

  test("accepts a well-formed UUID v1", () => {
    const v1 = "3f7f4c9e-1a2b-1c3d-8e5f-6a7b8c9d0e1f";
    expect(parseApprovalRequestIdParam(v1)).toEqual({ ok: true, id: v1 });
  });

  test("accepts an uppercase UUID", () => {
    expect(parseApprovalRequestIdParam(VALID_ID.toUpperCase())).toEqual({
      ok: true,
      id: VALID_ID.toUpperCase(),
    });
  });
});
