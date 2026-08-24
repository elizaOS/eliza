import { afterEach, describe, expect, it } from "vitest";
import {
  isVerbose,
  isYes,
  setVerbose,
  setYes,
  shouldLogVerbose,
} from "./globals.js";

describe("globals", () => {
  afterEach(() => {
    setVerbose(false);
    setYes(false);
    delete process.env.LOG_LEVEL;
  });

  it("tracks verbose flag", () => {
    expect(isVerbose()).toBe(false);
    setVerbose(true);
    expect(isVerbose()).toBe(true);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("shouldLogVerbose respects LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "debug";
    expect(shouldLogVerbose()).toBe(true);
    process.env.LOG_LEVEL = "silent";
    expect(shouldLogVerbose()).toBe(false);
  });

  it("tracks yes flag", () => {
    expect(isYes()).toBe(false);
    setYes(true);
    expect(isYes()).toBe(true);
  });
});
