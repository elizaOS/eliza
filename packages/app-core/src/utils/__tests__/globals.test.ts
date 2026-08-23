import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isVerbose,
  isYes,
  logVerbose,
  setVerbose,
  setYes,
  shouldLogVerbose,
} from "./globals.ts";

describe("globals verbose/yes state", () => {
  beforeEach(() => {
    setVerbose(false);
    setYes(false);
  });

  it("tracks the verbose flag", () => {
    expect(isVerbose()).toBe(false);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
  });

  it("tracks the yes flag", () => {
    expect(isYes()).toBe(false);
    setYes(true);
    expect(isYes()).toBe(true);
  });

  it("shouldLogVerbose is true when verbose is set", () => {
    setVerbose(true);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("logVerbose is a no-op when not verbose", () => {
    expect(() => logVerbose("secret")).not.toThrow();
  });
});
