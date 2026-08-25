/**
 * Coverage for safe diagnostic error helpers.
 */
import { describe, expect, it } from "vitest";

import {
  formatDiagnosticError,
  readDiagnosticProperty,
} from "./safe-diagnostic-error.js";

describe("readDiagnosticProperty", () => {
  it("reads own property and functions", () => {
    expect(readDiagnosticProperty({ a: 42 }, "a")).toBe(42);
    function named() {
      return undefined;
    }
    expect(readDiagnosticProperty(named, "name")).toBe("named");
  });

  it("returns undefined for non-container and primitives", () => {
    expect(readDiagnosticProperty(null, "a")).toBeUndefined();
    expect(readDiagnosticProperty(42, "a")).toBeUndefined();
    expect(readDiagnosticProperty("hello", "a")).toBeUndefined();
  });

  it("returns undefined when getter throws", () => {
    const obj = {
      get boom(): unknown {
        throw new Error("getter");
      },
    };
    expect(readDiagnosticProperty(obj, "boom")).toBeUndefined();
  });

  it("reads symbol property", () => {
    const sym = Symbol("s");
    expect(readDiagnosticProperty({ [sym]: 99 }, sym)).toBe(99);
  });
});

describe("formatDiagnosticError", () => {
  it("formats string error", () => {
    expect(formatDiagnosticError("oops")).toContain("oops");
  });

  it("formats Error object", () => {
    const err = new Error("fail");
    const out = formatDiagnosticError(err);
    expect(out).toContain("fail");
  });

  it("handles null and undefined and empty string", () => {
    expect(formatDiagnosticError(null)).toBe("null");
    expect(formatDiagnosticError(undefined)).toBe("undefined");
    expect(formatDiagnosticError("")).toBe("");
  });

  it("prefers stack, then message, then coercion", () => {
    expect(formatDiagnosticError({ stack: "at x", message: "m" })).toBe("at x");
    expect(formatDiagnosticError({ message: "m" })).toBe("m");
    expect(formatDiagnosticError(42)).toBe("42");
  });

  it("handles object with message", () => {
    const out = formatDiagnosticError({ message: "bad", code: 42 });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("handles throwing toString and hostile objects without throwing", () => {
    const obj = {
      toString(): string {
        throw new Error("toString boom");
      },
    };
    const out = formatDiagnosticError(obj);
    expect(typeof out).toBe("string");

    const hostile = {
      get stack() {
        throw new Error("trap");
      },
      get message() {
        throw new Error("trap");
      },
      toString() {
        throw new Error("trap");
      },
    };
    expect(() => formatDiagnosticError(hostile)).not.toThrow();
    expect(typeof formatDiagnosticError(hostile)).toBe("string");
  });
});
