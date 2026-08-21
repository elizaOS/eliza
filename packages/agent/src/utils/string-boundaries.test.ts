/** Exercises agent transport suffix trimming with ordinary and adversarial inputs. */

import { describe, expect, it } from "vitest";
import { trimEndCharacters } from "./string-boundaries.ts";

describe("agent string boundary scanner", () => {
  it("removes a trailing run and preserves interior characters", () => {
    expect(trimEndCharacters("https://example.test/path///", "/")).toBe(
      "https://example.test/path",
    );
  });

  it("handles a 100k-character suffix in linear time", () => {
    expect(trimEndCharacters(`base${"/".repeat(100_000)}`, "/")).toBe("base");
  });
});
