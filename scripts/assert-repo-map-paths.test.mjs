/**
 * Drives assert-repo-map-paths against the real root AGENTS.md map section.
 * Fails if the shipped guide drops a required top-level path or ownership rule.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  REQUIRED_CATEGORIES,
  REQUIRED_MAP_PATHS,
  assertRepoMapPaths,
  extractRepositoryMapSection,
} from "./assert-repo-map-paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE = join(ROOT, "AGENTS.md");

describe("assert-repo-map-paths", () => {
  test("real AGENTS.md repository map lists every required path and category", () => {
    const guide = readFileSync(GUIDE, "utf8");
    const map = extractRepositoryMapSection(guide);
    expect(map.length).toBeGreaterThan(500);

    const result = assertRepoMapPaths(guide);
    if (!result.ok) {
      expect(result.errors).toEqual([]);
    }
    expect(result.ok).toBe(true);
    expect(REQUIRED_MAP_PATHS.length).toBeGreaterThan(40);
    expect(REQUIRED_CATEGORIES).toContain("local runtime state");
  });

  test("rejects a guide missing a local-state path", () => {
    const guide = readFileSync(GUIDE, "utf8");
    const stripped = guide.replaceAll(".smithers", "REMOVED_SMITHERS");
    const result = assertRepoMapPaths(stripped);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes(".smithers"))).toBe(true);
  });
});
