/**
 * Tests for LifeOpsServiceError construction, type guards, and error conversion.
 */
import { describe, expect, it } from "vitest";
import {
  isLifeOpsServiceError,
  LifeOpsServiceError,
  toLifeOpsServiceError,
} from "./service-error.ts";

describe("LifeOpsServiceError", () => {
  it("constructs an error with status, message, and optional error code", () => {
    const error = new LifeOpsServiceError(404, "Task not found", "NOT_FOUND");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(LifeOpsServiceError);
    expect(error.name).toBe("LifeOpsServiceError");
    expect(error.status).toBe(404);
    expect(error.message).toBe("Task not found");
    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("isLifeOpsServiceError", () => {
  it("returns true for instances of LifeOpsServiceError and matching shapes", () => {
    const err = new LifeOpsServiceError(400, "Invalid payload");
    expect(isLifeOpsServiceError(err)).toBe(true);

    const crossRealmErr = new Error("Cross realm error");
    crossRealmErr.name = "LifeOpsServiceError";
    (crossRealmErr as unknown as { status: number }).status = 403;
    expect(isLifeOpsServiceError(crossRealmErr)).toBe(true);
  });

  it("returns false for non-matching errors and primitives", () => {
    expect(isLifeOpsServiceError(new Error("Generic error"))).toBe(false);
    expect(isLifeOpsServiceError("String error")).toBe(false);
    expect(isLifeOpsServiceError(404)).toBe(false);
    expect(isLifeOpsServiceError(null)).toBe(false);
    expect(isLifeOpsServiceError(undefined)).toBe(false);
    expect(isLifeOpsServiceError({ status: 500 })).toBe(false);
  });
});

describe("toLifeOpsServiceError", () => {
  it("returns existing LifeOpsServiceError instance unchanged", () => {
    const original = new LifeOpsServiceError(
      401,
      "Unauthorized",
      "UNAUTHORIZED",
    );
    const converted = toLifeOpsServiceError(original);

    expect(converted).toBe(original);
    expect(converted.status).toBe(401);
  });

  it("converts standard Error instances using fallback status", () => {
    const standardErr = new Error("Connection failed");
    const converted = toLifeOpsServiceError(standardErr, 502);

    expect(converted).toBeInstanceOf(LifeOpsServiceError);
    expect(converted.status).toBe(502);
    expect(converted.message).toBe("Connection failed");
  });

  it("converts string errors and unknown values", () => {
    const fromString = toLifeOpsServiceError("Bad gateway", 502);
    expect(fromString).toBeInstanceOf(LifeOpsServiceError);
    expect(fromString.status).toBe(502);
    expect(fromString.message).toBe("Bad gateway");

    const fromNull = toLifeOpsServiceError(null);
    expect(fromNull).toBeInstanceOf(LifeOpsServiceError);
    expect(fromNull.status).toBe(500);
    expect(fromNull.message).toBe("An unknown error occurred");
  });
});
