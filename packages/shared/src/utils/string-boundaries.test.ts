/** Exercises the deterministic string-boundary scanners, including adversarial long runs. */

import { describe, expect, it } from "vitest";
import {
  trimBoundaryCharacters,
  trimEndCharacters,
  trimStartCharacters,
} from "./string-boundaries";

describe("string boundary scanners", () => {
  it("preserves ordinary boundary semantics", () => {
    expect(trimStartCharacters("///path", "/")).toBe("path");
    expect(trimEndCharacters("path///", "/")).toBe("path");
    expect(trimBoundaryCharacters("---view---", "-")).toBe("view");
  });

  it("handles 100k-character boundary runs without backtracking", () => {
    const run = "/".repeat(100_000);
    expect(trimStartCharacters(`${run}path`, "/")).toBe("path");
    expect(trimEndCharacters(`path${run}`, "/")).toBe("path");
    expect(trimBoundaryCharacters(`${run}path${run}`, "/")).toBe("path");
  });
});
