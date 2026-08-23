/**
 * Unit tests for the Ui Smoke Coverage app shell contract and coverage
 * guardrail.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Keeps UI-smoke exclusions explicit without coupling inventory to CI topology. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_SMOKE_DIR = path.join(HERE, "ui-smoke");
const DENY_LIST_PATH = path.join(UI_SMOKE_DIR, ".pr-deny-list.json");

const VALID_CATEGORIES = [
  "live-only",
  "dedicated-tool",
  "keyless-debt",
] as const;
type DenyCategory = (typeof VALID_CATEGORIES)[number];

interface DenyEntry {
  spec: string;
  category: DenyCategory;
  reason: string;
}

function specFileNames(): string[] {
  const specs: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
        specs.push(
          path.relative(UI_SMOKE_DIR, fullPath).split(path.sep).join("/"),
        );
      }
    }
  };
  walk(UI_SMOKE_DIR);
  return specs.sort();
}

function denyList(): DenyEntry[] {
  const parsed = JSON.parse(readFileSync(DENY_LIST_PATH, "utf8")) as {
    specs?: DenyEntry[];
  };
  if (!Array.isArray(parsed.specs)) {
    throw new Error(`${DENY_LIST_PATH}: expected a "specs" array`);
  }
  return parsed.specs;
}

describe("ui-smoke spec coverage gate", () => {
  it("the deny-list is the single source of truth: every excluded spec is real, categorized, and justified", () => {
    const specs = new Set(specFileNames());
    const entries = denyList();
    const seen = new Set<string>();

    const stale = entries.map((e) => e.spec).filter((spec) => !specs.has(spec));
    expect(
      stale,
      `Deny-list references specs that no longer exist (remove them): ${stale.join(", ")}`,
    ).toEqual([]);

    const badCategory = entries.filter(
      (e) => !VALID_CATEGORIES.includes(e.category),
    );
    expect(
      badCategory.map((e) => `${e.spec}:${e.category}`),
      `Deny-list entries with an invalid category (expected ${VALID_CATEGORIES.join(", ")})`,
    ).toEqual([]);

    const missingReason = entries.filter(
      (e) => typeof e.reason !== "string" || e.reason.trim().length === 0,
    );
    expect(
      missingReason.map((e) => e.spec),
      "Every deny-list entry must name its reason for being off the keyless PR path",
    ).toEqual([]);

    const duplicates = entries
      .map((e) => e.spec)
      .filter((spec) => {
        const dup = seen.has(spec);
        seen.add(spec);
        return dup;
      });
    expect(
      duplicates,
      `Duplicate deny-list entries: ${duplicates.join(", ")}`,
    ).toEqual([]);
  });

  it("the exclusion list never swallows the whole suite", () => {
    const denied = new Set(denyList().map((e) => e.spec));
    const allSpecs = specFileNames();
    expect(denied.size).toBeLessThan(allSpecs.length);
  });
});
