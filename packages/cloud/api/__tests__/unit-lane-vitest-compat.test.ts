import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

/**
 * This package's unit lane (`test/run-unit-isolated.mjs`) runs every test file
 * through `bun test`, but many of those files import from `"vitest"`. Bun ships
 * a `vitest` compatibility layer that covers most of the API and silently omits
 * the rest: a missing member is `undefined`, so the first call throws at
 * collection time and the whole file reports zero passing tests rather than a
 * failed assertion. That is how `cartesia-synthesis.test.ts` sat at 0/12 —
 * erroring, not running — while CI stayed green on the count it could see.
 *
 * Pin it: every `vi.*` member the lane's own files call must actually exist on
 * the `vi` this runner provides. The expectation is derived from the live `vi`
 * object rather than a hardcoded list, so the guard relaxes on its own when bun
 * implements more of the surface, and no one has to maintain a denylist.
 */

const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// Mirrors run-unit-isolated.mjs. Kept in sync deliberately: a file the lane
// runs but this guard skips is exactly the blind spot being closed.
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo", "test"]);

function laneTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...laneTestFiles(full));
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Collect `vi.<member>(` call sites. Requiring the open paren, and dropping
 * whole-line comments, keeps prose that merely names a member — this package
 * already documents bun's missing `vi.hoisted` in two files — from being read
 * as a call site.
 */
export function viCallSites(source: string): Set<string> {
  const names = new Set<string>();
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (
      line.startsWith("//") ||
      line.startsWith("*") ||
      line.startsWith("/*")
    ) {
      continue;
    }
    for (const match of line.matchAll(/\bvi\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

describe("cloud-api unit lane / vitest compatibility", () => {
  test("every vi member the lane calls exists on the runner's vi", () => {
    const runner = vi as unknown as Record<string, unknown>;
    const offenders: string[] = [];

    for (const file of laneTestFiles(pkgRoot).sort()) {
      const source = readFileSync(file, "utf8");
      if (!/from\s+["']vitest["']/.test(source)) continue;
      for (const name of viCallSites(source)) {
        if (typeof runner[name] !== "function") {
          offenders.push(`${path.relative(pkgRoot, file)} calls vi.${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("a mention in prose is not a call site", () => {
    // Fixtures are ASSEMBLED, never written literally: this file is itself in
    // the lane the guard walks, so a literal call site here would be reported
    // as a real one. `vi.${...}(` does not match the pattern, by construction.
    const call = (member: string) => `vi.${member}("fetch", impl);`;

    // Both rules carry weight, and each catches what the other misses: the
    // open-paren rule alone reads `// use ${call("stubGlobal")} instead` as a
    // call, and the comment rule alone reads "typeof vi.hoisted" as one.
    expect([...viCallSites(`// use ${call("stubGlobal")} instead`)]).toEqual(
      [],
    );
    expect([...viCallSites(' * `typeof vi.hoisted` is "undefined"')]).toEqual(
      [],
    );
    expect([...viCallSites(call("stubGlobal"))]).toEqual(["stubGlobal"]);
  });

  test("the guard can see the lane it is guarding", () => {
    const files = laneTestFiles(pkgRoot);
    // A broken walk would vacuously pass the assertion above.
    expect(files.length).toBeGreaterThan(20);
    expect(
      files.some((f) => /from\s+["']vitest["']/.test(readFileSync(f, "utf8"))),
    ).toBe(true);
  });
});
