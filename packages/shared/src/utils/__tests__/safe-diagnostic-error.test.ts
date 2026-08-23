import { describe, expect, it } from "vitest";
import {
  formatDiagnosticError,
  readDiagnosticProperty,
} from "../safe-diagnostic-error.ts";

describe("readDiagnosticProperty", () => {
  it("reads properties from objects and functions", () => {
    expect(readDiagnosticProperty({ a: 1 }, "a")).toBe(1);
    function named() {
      return undefined;
    }
    expect(readDiagnosticProperty(named, "name")).toBe("named");
  });

  it("returns undefined for primitives and null", () => {
    expect(readDiagnosticProperty(null, "a")).toBeUndefined();
    expect(readDiagnosticProperty(5, "a")).toBeUndefined();
    expect(readDiagnosticProperty("x", "a")).toBeUndefined();
  });

  it("swallows getter errors", () => {
    const hostile = {
      get a() {
        throw new Error("trap");
      },
    };
    expect(readDiagnosticProperty(hostile, "a")).toBeUndefined();
  });
});

describe("formatDiagnosticError", () => {
  it("prefers stack, then message, then coercion", () => {
    expect(formatDiagnosticError({ stack: "at x", message: "m" })).toBe("at x");
    expect(formatDiagnosticError({ message: "m" })).toBe("m");
    expect(formatDiagnosticError(new Error("boom"))).toBeTruthy();
    expect(formatDiagnosticError(42)).toBe("42");
  });

  it("never throws on hostile values", () => {
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

  it("handles empty values", () => {
    expect(formatDiagnosticError(undefined)).toBe("undefined");
    expect(formatDiagnosticError(null)).toBe("null");
    expect(formatDiagnosticError("")).toBe("");
  });
});
