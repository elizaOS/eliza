/** A screen-time total under one minute must not print as zero minutes. */
import { describe, expect, it } from "vitest";
import { formatSeconds } from "./screen-time.ts";

describe("formatSeconds", () => {
  it("prints leftover seconds when the total is under one minute", () => {
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(59)).toBe("59s");
  });

  it("keeps zero and whole minutes", () => {
    expect(formatSeconds(0)).toBe("0m");
    expect(formatSeconds(60)).toBe("1m");
    expect(formatSeconds(3600)).toBe("1h 0m");
  });
});
