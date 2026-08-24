/**
 * Coverage for error-handling.
 */
import { describe, expect, it } from "vitest";
import { extractErrorMessage } from "./error-handling.js";
describe("error-handling", () => {
  it("extracts from Error", () => {
    expect(extractErrorMessage(new Error("oops"))).toBe("oops");
  });
  it("extracts from string", () => {
    expect(extractErrorMessage("fail")).toBe("fail");
  });
  it("extracts from object", () => {
    expect(extractErrorMessage({ message: "msg" })).toBe("msg");
  });
  it("unknown", () => {
    expect(extractErrorMessage(null)).toBe("Unknown error");
  });
});
