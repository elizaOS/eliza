/**
 * Stale-reference regression check for the root guide's "Removed root command
 * migrations" table. #17012 left several rows pointing at `audit:test-integrity*`
 * scripts that no longer existed (#17003); this contract fails whenever a
 * migration target references a `bun run` script that is absent from the named
 * package manifest or a `bun test <path>` file that is gone. Deterministic:
 * reads CLAUDE.md and package manifests from the repository checkout only.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

interface MigrationTarget {
  raw: string;
  /** package dir relative to repo root ("." for the root manifest) */
  packageDir: string;
  script?: string;
  testFile?: string;
}

/** Parse every `Use instead` cell of the migrations table into checkable refs. */
function parseMigrationTargets(guide: string): MigrationTarget[] {
  const section = guide.split("### Removed root command migrations")[1];
  expect(section, "migrations section present in CLAUDE.md").toBeTruthy();
  const targets: MigrationTarget[] = [];
  for (const line of (section ?? "").split("\n")) {
    if (!line.startsWith("| `bun run ")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // | `removed` | replacement prose or `command` |
    const replacement = cells[2] ?? "";
    const match = replacement.match(/^`([^`]+)`$/);
    if (!match) continue; // prose rows ("retired ...; no replacement") are fine
    const command = match[1];
    const cwdRun = command.match(/^bun run --cwd (\S+) (\S+)$/);
    const rootRun = command.match(/^bun run (\S+)$/);
    const bunTest = command.match(/^bun test (\S+)$/);
    const nodeRun = command.match(/^node (\S+)/);
    if (cwdRun) {
      targets.push({ raw: command, packageDir: cwdRun[1], script: cwdRun[2] });
    } else if (rootRun) {
      targets.push({ raw: command, packageDir: ".", script: rootRun[1] });
    } else if (bunTest) {
      targets.push({ raw: command, packageDir: ".", testFile: bunTest[1] });
    } else if (nodeRun) {
      targets.push({ raw: command, packageDir: ".", testFile: nodeRun[1] });
    }
  }
  return targets;
}

describe("root guide removed-command migrations", () => {
  const guide = readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const targets = parseMigrationTargets(guide);

  it("parses a non-trivial migration table", () => {
    expect(targets.length).toBeGreaterThan(10);
  });

  it.each(targets.map((target) => [target.raw, target] as const))(
    "migration target `%s` still exists",
    (_raw, target) => {
      if (target.script) {
        const manifestPath = path.join(
          REPO_ROOT,
          target.packageDir,
          "package.json",
        );
        expect(
          existsSync(manifestPath),
          `manifest ${manifestPath} exists`,
        ).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          scripts?: Record<string, string>;
        };
        expect(
          manifest.scripts?.[target.script],
          `script "${target.script}" in ${target.packageDir}/package.json`,
        ).toBeTruthy();
      }
      if (target.testFile) {
        expect(
          existsSync(path.join(REPO_ROOT, target.testFile)),
          `referenced path ${target.testFile} exists`,
        ).toBe(true);
      }
    },
  );
});
