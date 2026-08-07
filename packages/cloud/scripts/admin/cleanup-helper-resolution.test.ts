/**
 * Repository contract for how `packages/cloud` scripts locate the workspace
 * recursive-delete helper.
 *
 * The helper exists once, at `packages/scripts/rm-path-recursive.mjs`, and each
 * caller rebuilds the path from its own directory with a hand-counted `..`
 * chain. A miscount is invisible until cleanup actually runs, because the
 * failure is a spawned Node process exiting on a missing module at the very end
 * of an otherwise successful provisioning run — both callers had already
 * drifted to a `packages/cloud/rm-path-recursive.mjs` that has never existed.
 * This replays each caller's real declaration chain against the real repository
 * layout so a miscounted hop fails here instead of on a live Hetzner host.
 *
 * Deterministic: reads source from disk and touches the filesystem only to test
 * for existence. No network, no SSH, no cloud API.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_FILENAME = "rm-path-recursive.mjs";
const scriptsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(scriptsRoot, "..", "..", "..");
const canonicalHelper = resolve(
  repoRoot,
  "packages",
  "scripts",
  HELPER_FILENAME,
);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.mjs")) {
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Replay the `const X = resolve(...)` / `join(...)` declarations a script makes,
 * seeded with the `scriptDir` every caller derives from `import.meta.url`.
 * A declaration referencing a binding this evaluator cannot supply is skipped
 * rather than guessed, so an unresolvable caller surfaces as a miss below.
 */
function evaluateDeclarations(
  filePath: string,
  source: string,
): Record<string, string> {
  const scope: Record<string, string> = { scriptDir: dirname(filePath) };
  const declaration = /const (\w+) = (resolve|join)\(([\s\S]*?)\);/g;
  for (const [, name, fn, argsSource] of source.matchAll(declaration)) {
    const args = argsSource
      .split(",")
      .map((argument) => argument.trim())
      .filter((argument) => argument.length > 0)
      .map((argument) =>
        argument.startsWith('"') ? JSON.parse(argument) : scope[argument],
      );
    if (args.some((argument) => typeof argument !== "string")) continue;
    scope[name] = fn === "resolve" ? resolve(...args) : join(...args);
  }
  return scope;
}

describe("packages/cloud cleanup-helper resolution", () => {
  test("the canonical workspace helper exists where callers resolve it", () => {
    expect(existsSync(canonicalHelper)).toBe(true);
  });

  test("every cloud script resolves the helper to that same real file", () => {
    const callers = sourceFiles(scriptsRoot).filter((file) =>
      readFileSync(file, "utf8").includes(HELPER_FILENAME),
    );

    // A caller that stops using the helper is fine; zero callers would mean
    // this contract silently stopped guarding anything.
    expect(callers.length).toBeGreaterThan(0);

    const fromRepo = (path: string) =>
      relative(repoRoot, path).replaceAll("\\", "/");

    const offenders = callers.flatMap((caller) => {
      const scope = evaluateDeclarations(caller, readFileSync(caller, "utf8"));
      const resolved = Object.values(scope).find((value) =>
        value.endsWith(HELPER_FILENAME),
      );
      if (!resolved) {
        return [`${fromRepo(caller)} -> (no resolvable helper declaration)`];
      }
      if (resolved !== canonicalHelper || !existsSync(resolved)) {
        return [`${fromRepo(caller)} -> ${fromRepo(resolved)}`];
      }
      return [];
    });

    expect(offenders).toEqual([]);
  });
});
