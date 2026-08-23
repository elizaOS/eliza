/**
 * Coverage for globals.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isVerbose, setVerbose, setYes, shouldLogVerbose } from "./globals.js";

describe("globals", () => {
  afterEach(() => {
    setVerbose(false);
    setYes(false);
  });
  it("manages verbose flag", () => {
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    expect(shouldLogVerbose()).toBe(true);
    setVerbose(false);
    expect(isVerbose()).toBe(false);
  });
  it("manages yes flag", () => {
    setYes(true);
    expect(isVerbose()).toBe(false);
  });
});
