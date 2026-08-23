/**
 * Coverage for the pglite error-compat shim: error code constants, constructor
 * metadata, factory helper, and cause-chain scanning in getPgliteErrorCode.
 */
import { describe, expect, it } from "vitest";
import {
  createPgliteInitError,
  getPgliteErrorCode,
  PGLITE_ERROR_CODES,
  PgliteInitError,
} from "./pglite-error-compat.ts";

describe("PGLITE_ERROR_CODES", () => {
  it("defines the three canonical error codes", () => {
    expect(PGLITE_ERROR_CODES.ACTIVE_LOCK).toBe("ELIZA_PGLITE_DATA_DIR_IN_USE");
    expect(PGLITE_ERROR_CODES.CORRUPT_DATA).toBe("ELIZA_PGLITE_CORRUPT_DATA");
    expect(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED).toBe(
      "ELIZA_PGLITE_MANUAL_RESET_REQUIRED",
    );
  });
});

describe("PgliteInitError", () => {
  it("carries code, name, and dataDir metadata", () => {
    const err = new PgliteInitError(
      PGLITE_ERROR_CODES.CORRUPT_DATA,
      "db is corrupt",
      { dataDir: "/tmp/pg" },
    );
    expect(err.name).toBe("PgliteInitError");
    expect(err.code).toBe(PGLITE_ERROR_CODES.CORRUPT_DATA);
    expect(err.dataDir).toBe("/tmp/pg");
    expect(err.message).toBe("db is corrupt");
  });

  it("exposes the cause through options", () => {
    const cause = new Error("disk read failed");
    const err = new PgliteInitError(
      PGLITE_ERROR_CODES.ACTIVE_LOCK,
      "lock held",
      { cause },
    );
    expect(err.cause).toBe(cause);
  });

  it("creates errors through the factory helper", () => {
    const err = createPgliteInitError(
      PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
      "manual reset",
    );
    expect(err).toBeInstanceOf(PgliteInitError);
    expect(err.code).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
    expect(err.dataDir).toBeUndefined();
  });
});

describe("getPgliteErrorCode", () => {
  it("reads a matching code directly", () => {
    const err = createPgliteInitError(PGLITE_ERROR_CODES.ACTIVE_LOCK, "lock");
    expect(getPgliteErrorCode(err)).toBe(PGLITE_ERROR_CODES.ACTIVE_LOCK);
  });

  it("returns null for unrelated errors", () => {
    expect(getPgliteErrorCode(new Error("boom"))).toBeNull();
    expect(getPgliteErrorCode("not an error")).toBeNull();
    expect(getPgliteErrorCode(undefined)).toBeNull();
    expect(getPgliteErrorCode(null)).toBeNull();
  });

  it("walks the cause chain to find a matching code", () => {
    const root = createPgliteInitError(
      PGLITE_ERROR_CODES.CORRUPT_DATA,
      "corrupt",
    );
    const wrapper = new Error("wrapped", { cause: root });
    expect(getPgliteErrorCode(wrapper)).toBe(PGLITE_ERROR_CODES.CORRUPT_DATA);
  });

  it("does not loop forever on circular causes", () => {
    const a = new Error("a");
    const b = new Error("b");
    a.cause = b;
    b.cause = a;
    expect(getPgliteErrorCode(a)).toBeNull();
  });

  it("ignores non-canonical codes on the chain", () => {
    const err = new Error("outer", {
      cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" }),
    });
    expect(getPgliteErrorCode(err)).toBeNull();
  });
});
