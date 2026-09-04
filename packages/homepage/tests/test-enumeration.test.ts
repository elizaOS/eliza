/**
 * The `test` script names every suite by path instead of globbing, and `bun
 * test` silently ignores a path that does not exist — so the list can drift in
 * both directions without the command ever failing. It had: an entry for
 * `tests/snapshot-inventory.test.ts`, deleted in #28109, and no entry for
 * `tests/use-eliza-app-provisioning-chat.test.ts`, whose 16 assertions ran
 * nowhere.
 *
 * This pins the list against the files on disk, in both directions.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");

const enumerated = new Set(
  Array.from(
    (
      JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
        scripts: Record<string, string>;
      }
    ).scripts.test.matchAll(
      /(?:tests|edge)\/[^\s&]+\.test\.(?:tsx|mjs|cjs|ts)/g,
    ),
    (match) => match[0],
  ),
);

function collectTests(relativeDir: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(packageRoot, relative), {
      withFileTypes: true,
    })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "e2e") continue;
        walk(next);
        continue;
      }
      if (/\.test\.(tsx|mjs|cjs|ts)$/.test(entry.name)) found.push(next);
    }
  };
  walk(relativeDir);
  return found;
}

// `tests/e2e` is Playwright's directory (`test:e2e`), not part of the bun run.
const onDisk = [...collectTests("tests"), ...collectTests("edge")].sort();

describe("the test script enumerates every suite exactly once", () => {
  test("finds suites on disk to compare against", () => {
    expect(onDisk.length).toBeGreaterThan(0);
  });

  test("runs every suite that exists", () => {
    const missing = onDisk.filter((file) => !enumerated.has(file));
    expect(
      missing,
      `${missing.join(", ")} exist but are absent from the \`test\` script, so they run nowhere`,
    ).toEqual([]);
  });

  test("names no suite that has been deleted", () => {
    const stale = [...enumerated].filter((file) => {
      try {
        return !statSync(join(packageRoot, file)).isFile();
      } catch {
        return true;
      }
    });
    expect(
      stale,
      `${stale.join(", ")} are named in the \`test\` script but do not exist; bun skips them silently`,
    ).toEqual([]);
  });
});
