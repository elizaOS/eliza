/**
 * Coverage for platform.
 */
import { describe, expect, it } from "vitest";
import { isBrowser, isIOS, isAndroid } from "./platform.js";
describe("platform", () => {
  it("isBrowser false in node", () => {
    expect(isBrowser()).toBe(false);
  });
  it("isIOS false in node", () => {
    expect(isIOS()).toBe(false);
  });
  it("isAndroid false in node", () => {
    expect(isAndroid()).toBe(false);
  });
});
