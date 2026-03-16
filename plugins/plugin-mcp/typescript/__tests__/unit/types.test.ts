import { describe, expect, it } from "vitest";
import { assertNonEmptyString, assertNonNull, assertObject, assertString } from "../../src/types";

describe("Type Assertions", () => {
  describe("assertNonNull", () => {
    it("should return the value for non-null values", () => {
      expect(assertNonNull("test", "message")).toBe("test");
      expect(assertNonNull(0, "message")).toBe(0);
      expect(assertNonNull(false, "message")).toBe(false);
      expect(assertNonNull({}, "message")).toEqual({});
    });

    it("should throw for null", () => {
      expect(() => assertNonNull(null, "value is null")).toThrow("value is null");
    });

    it("should throw for undefined", () => {
      expect(() => assertNonNull(undefined, "value is undefined")).toThrow("value is undefined");
    });
  });

  describe("assertString", () => {
    it("should return the string for string values", () => {
      expect(assertString("test", "message")).toBe("test");
      expect(assertString("", "message")).toBe("");
    });

    it("should throw for non-string values", () => {
      expect(() => assertString(123, "not a string")).toThrow("not a string");
      expect(() => assertString(null, "not a string")).toThrow("not a string");
      expect(() => assertString({}, "not a string")).toThrow("not a string");
    });
  });

  describe("assertNonEmptyString", () => {
    it("should return the string for non-empty strings", () => {
      expect(assertNonEmptyString("test", "message")).toBe("test");
    });

    it("should throw for empty strings", () => {
      expect(() => assertNonEmptyString("", "empty string")).toThrow("empty string");
    });

    it("should throw for non-string values", () => {
      expect(() => assertNonEmptyString(123, "not a string")).toThrow("not a string");
    });
  });

  describe("assertObject", () => {
    it("should return the object for valid objects", () => {
      const obj = { foo: "bar" };
      expect(assertObject(obj, "message")).toEqual(obj);
    });

    it("should throw for null", () => {
      expect(() => assertObject(null, "null value")).toThrow("null value");
    });

    it("should throw for arrays", () => {
      expect(() => assertObject([], "array value")).toThrow("array value");
    });

    it("should throw for primitives", () => {
      expect(() => assertObject("string", "string value")).toThrow("string value");
      expect(() => assertObject(123, "number value")).toThrow("number value");
    });
  });
});
