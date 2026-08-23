/**
 * Behavioral coverage for the agent-local PGlite error-compat shim: canonical
 * codes, PgliteInitError metadata, the factory helper, and getPgliteErrorCode
 * cause-chain walking, including duck-typed objects, cycles, ordering, and
 * non-canonical codes.
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

  it("is an Error subclass and leaves dataDir unset when options are omitted", () => {
    const err = new PgliteInitError(
      PGLITE_ERROR_CODES.ACTIVE_LOCK,
      "dir in use",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PgliteInitError);
    expect(err.dataDir).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it("accepts cause and dataDir together", () => {
    const cause = new Error("sqlite lock");
    const err = new PgliteInitError(
      PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
      "reset required",
      { cause, dataDir: "/var/eliza/pglite" },
    );
    expect(err.cause).toBe(cause);
    expect(err.dataDir).toBe("/var/eliza/pglite");
  });

  it("forwards cause and dataDir through the factory helper", () => {
    const cause = new Error("io");
    const err = createPgliteInitError(
      PGLITE_ERROR_CODES.CORRUPT_DATA,
      "bad image",
      { cause, dataDir: "/tmp/x" },
    );
    expect(err).toBeInstanceOf(PgliteInitError);
    expect(err.cause).toBe(cause);
    expect(err.dataDir).toBe("/tmp/x");
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

  it("reads every canonical code from a duck-typed non-Error object", () => {
    expect(getPgliteErrorCode({ code: PGLITE_ERROR_CODES.ACTIVE_LOCK })).toBe(
      PGLITE_ERROR_CODES.ACTIVE_LOCK,
    );
    expect(getPgliteErrorCode({ code: PGLITE_ERROR_CODES.CORRUPT_DATA })).toBe(
      PGLITE_ERROR_CODES.CORRUPT_DATA,
    );
    expect(
      getPgliteErrorCode({ code: PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED }),
    ).toBe(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED);
  });

  it("walks a non-Error object's cause to a matching code", () => {
    const wrapped = {
      cause: { code: PGLITE_ERROR_CODES.CORRUPT_DATA },
    };
    expect(getPgliteErrorCode(wrapped)).toBe(PGLITE_ERROR_CODES.CORRUPT_DATA);
  });

  it("continues past a non-canonical string code to a nested match", () => {
    const inner = createPgliteInitError(
      PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
      "reset",
    );
    const outer = Object.assign(new Error("wrapper"), {
      code: "ECONNREFUSED",
      cause: inner,
    });
    expect(getPgliteErrorCode(outer)).toBe(
      PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
    );
  });

  it("skips a non-string code property and walks cause", () => {
    const inner = createPgliteInitError(PGLITE_ERROR_CODES.ACTIVE_LOCK, "lock");
    expect(getPgliteErrorCode({ code: 404, cause: inner })).toBe(
      PGLITE_ERROR_CODES.ACTIVE_LOCK,
    );
  });

  it("returns the first matching code when both outer and inner match", () => {
    const inner = createPgliteInitError(
      PGLITE_ERROR_CODES.CORRUPT_DATA,
      "inner",
    );
    const outer = createPgliteInitError(
      PGLITE_ERROR_CODES.ACTIVE_LOCK,
      "outer",
      { cause: inner },
    );
    expect(getPgliteErrorCode(outer)).toBe(PGLITE_ERROR_CODES.ACTIVE_LOCK);
  });

  it("walks a deep Error cause chain", () => {
    const root = createPgliteInitError(PGLITE_ERROR_CODES.CORRUPT_DATA, "root");
    const mid = new Error("mid", { cause: root });
    const outer = new Error("outer", { cause: mid });
    expect(getPgliteErrorCode(outer)).toBe(PGLITE_ERROR_CODES.CORRUPT_DATA);
  });

  it("reads a duck-typed code from an Error cause", () => {
    const wrapper = new Error("wrap", {
      cause: { code: PGLITE_ERROR_CODES.ACTIVE_LOCK },
    });
    expect(getPgliteErrorCode(wrapper)).toBe(PGLITE_ERROR_CODES.ACTIVE_LOCK);
  });

  it("returns null for empty objects, arrays, and objects with an undefined cause", () => {
    expect(getPgliteErrorCode({})).toBeNull();
    expect(getPgliteErrorCode([])).toBeNull();
    expect(getPgliteErrorCode({ cause: undefined })).toBeNull();
    expect(getPgliteErrorCode({ code: "ECONNREFUSED" })).toBeNull();
  });

  it("returns null for primitives that are not objects", () => {
    expect(getPgliteErrorCode(0)).toBeNull();
    expect(getPgliteErrorCode(1)).toBeNull();
    expect(getPgliteErrorCode(true)).toBeNull();
    expect(getPgliteErrorCode(false)).toBeNull();
    expect(getPgliteErrorCode("")).toBeNull();
  });

  it("does not loop forever on a circular non-Error cause", () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(getPgliteErrorCode(loop)).toBeNull();
  });
});
