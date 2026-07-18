/**
 * Coverage lane composing the co-located suite(s) below for the changed-file
 * gate — one lane per suite so each keeps its own isolated vitest module graph
 * (a combined lane polluted the shared coding-tools registry across suites).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "./file.test.ts";

describe("file-regression-lane.test.ts composition", () => {
  it("imports its co-located suite from this directory", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const suite of ["file.test.ts"]) {
      expect(existsSync(path.join(here, suite))).toBe(true);
    }
  });
});
