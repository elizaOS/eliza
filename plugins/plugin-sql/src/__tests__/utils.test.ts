/**
 * Unit tests for SQL plugin filesystem path utilities.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandTildePath } from "../utils";

describe("expandTildePath", () => {
  it("expands ~/ relative to HOME directory when available", () => {
    const home = process.env.HOME || process.cwd();
    expect(expandTildePath("~/data/db")).toBe(path.join(home, "data/db"));
    expect(expandTildePath("~")).toBe(home);
  });

  it("handles non-tilde absolute and relative paths without alteration", () => {
    expect(expandTildePath("/var/data/db")).toBe("/var/data/db");
    expect(expandTildePath("./local/db")).toBe("./local/db");
  });

  it("safely handles non-string and empty inputs", () => {
    expect(expandTildePath("")).toBe("");
    expect(expandTildePath(null as unknown as string)).toBe("");
    expect(expandTildePath(undefined as unknown as string)).toBe("");
  });
});
