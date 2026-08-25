/**
 * Unit tests for the browser `fast-redact` shim. The suite drives the real
 * default-exported factory (not a mock) and records its no-op contract: every
 * options branch returns the same identity redactor, `restore` is identity,
 * and `serialize` is ignored rather than compiling a string-path redactor.
 */
import { describe, expect, it } from "vitest";

import fastRedact from "./fast-redact.js";

describe("fast-redact factory", () => {
  it("exports a function as the default", () => {
    expect(fastRedact).toBeTypeOf("function");
  });

  it("returns the same singleton for an empty options object and no arguments", () => {
    const omitted = fastRedact();
    const empty = fastRedact({});
    expect(omitted).toBeTypeOf("function");
    expect(empty).toBe(omitted);
  });

  it("returns the same singleton when paths is missing, undefined, or empty", () => {
    const missing = fastRedact({});
    expect(fastRedact({ paths: undefined })).toBe(missing);
    expect(fastRedact({ paths: [] })).toBe(missing);
  });

  it("returns the same singleton for a single path and for several paths", () => {
    const empty = fastRedact();
    expect(fastRedact({ paths: ["password"] })).toBe(empty);
    expect(fastRedact({ paths: ["password", "token", "user.secret"] })).toBe(
      empty,
    );
  });

  it("still returns the singleton when a path list contains an empty string", () => {
    expect(fastRedact({ paths: [""] })).toBe(fastRedact());
  });
});

describe("fast-redact identity redactor", () => {
  it("returns primitives unchanged", () => {
    const redact = fastRedact({ paths: ["secret"] });
    expect(redact("plain")).toBe("plain");
    expect(redact(0)).toBe(0);
    expect(redact(false)).toBe(false);
  });

  it("returns null and undefined unchanged", () => {
    const redact = fastRedact();
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it("returns the same object and array references without mutating them", () => {
    const redact = fastRedact({ paths: ["password", "nested.token"] });
    const payload = {
      password: "hunter2",
      nested: { token: "abc", keep: 1 },
    };
    const items = [{ password: "x" }];

    expect(redact(payload)).toBe(payload);
    expect(payload).toEqual({
      password: "hunter2",
      nested: { token: "abc", keep: 1 },
    });
    expect(redact(items)).toBe(items);
    expect(items).toEqual([{ password: "x" }]);
  });

  it("does not redact listed paths: the factory never compiles a censor", () => {
    const redact = fastRedact({ paths: ["password"] });
    const payload = { password: "visible", ok: true };
    expect(redact(payload)).toEqual({ password: "visible", ok: true });
  });
});

describe("fast-redact restore", () => {
  it("exposes restore as an identity function on the singleton", () => {
    const redact = fastRedact();
    expect(redact.restore).toBeTypeOf("function");
    expect(fastRedact({ paths: ["secret"] }).restore).toBe(redact.restore);
  });

  it("restore returns the same reference for objects and primitives", () => {
    const restore = fastRedact().restore;
    expect(restore).toBeTypeOf("function");
    const payload = { password: "hunter2" };
    expect(restore?.(payload)).toBe(payload);
    expect(restore?.("plain")).toBe("plain");
    expect(restore?.(null)).toBe(null);
    expect(restore?.(undefined)).toBe(undefined);
  });

  it("restore of a value that was never redacted is still identity", () => {
    const redact = fastRedact({ paths: ["missing"] });
    const payload = { other: 1 };
    const restored = redact.restore?.(redact(payload));
    expect(restored).toBe(payload);
  });
});

describe("fast-redact serialize option is ignored", () => {
  it("does not stringify when serialize is a function", () => {
    const payload = { password: "hunter2" };
    const redact = fastRedact({
      paths: ["password"],
      serialize: (value: unknown) => JSON.stringify(value),
    });
    expect(redact(payload)).toBe(payload);
    expect(typeof redact(payload)).toBe("object");
  });

  it("does not change the redactor when serialize is false", () => {
    const payload = { token: "abc" };
    const redact = fastRedact({ paths: ["token"], serialize: false });
    expect(redact).toBe(fastRedact());
    expect(redact(payload)).toBe(payload);
  });
});
