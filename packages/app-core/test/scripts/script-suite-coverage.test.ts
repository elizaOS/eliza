/**
 * The vitest exclude list carves out `scripts/**` suites that use node:test or
 * bun:test, and its own comment promises the carve-out "no longer means 'runs
 * nowhere'" because `bun run test:script-suites` executes them. Nothing checked
 * that promise: `scripts/mobile-auth-simulator-smoke-endstate.test.mjs` was
 * excluded from vitest and absent from that list, so its 12 assertions ran in
 * no lane at all.
 *
 * These tests hold both halves of the contract — every excluded runner-based
 * suite is executed somewhere, and no exclusion names a file that is gone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config.ts";

const packageRoot = join(import.meta.dirname, "..", "..");
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as { scripts: Record<string, string> };

const scriptSuites = packageJson.scripts["test:script-suites"] ?? "";
const enumerated = new Set(
  Array.from(
    scriptSuites.matchAll(/scripts\/[^\s&]+\.test\.(?:mjs|ts)/g),
    (match) => match[0],
  ),
);

const excluded = (config.test?.exclude ?? []) as string[];
// Literal `scripts/…` paths only: the glob entries (**/*.e2e.test.ts and the
// like) describe categories, not individual runner-based suites.
const literalScriptExclusions = excluded.filter(
  (entry) => entry.startsWith("scripts/") && !entry.includes("*"),
);

describe("test:script-suites covers every excluded scripts/ suite", () => {
  it("finds literal scripts/ exclusions to check", () => {
    expect(literalScriptExclusions.length).toBeGreaterThan(0);
  });

  it.each(literalScriptExclusions)("%s runs somewhere", (entry) => {
    // Windows-only exclusions still run on every Linux lane, so they need no
    // entry in test:script-suites. They are the platform-gated arm of the
    // exclude array, which is absent from `excluded` off Windows.
    expect(
      enumerated.has(entry),
      `${entry} is excluded from vitest but not in test:script-suites, so it runs in no lane. ` +
        "Add it there or drop the exclusion.",
    ).toBe(true);
  });

  it.each(literalScriptExclusions)("%s still exists", (entry) => {
    expect(
      existsInPackage(entry),
      `${entry} is excluded from vitest but no longer exists; drop the stale entry.`,
    ).toBe(true);
  });

  it.each([...enumerated])("%s is a real file", (entry) => {
    expect(
      existsInPackage(entry),
      `${entry} is listed in test:script-suites but missing`,
    ).toBe(true);
  });
});

function existsInPackage(relativePath: string): boolean {
  try {
    readFileSync(join(packageRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}
