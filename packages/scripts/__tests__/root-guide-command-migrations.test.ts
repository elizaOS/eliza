/**
 * Validates documented command migrations against live manifests and paths.
 * The deterministic parser exercises annotations and command arguments so
 * prose in the guide cannot silently remove a replacement from validation.
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
  const remainder = guide.split("### Removed root command migrations")[1];
  if (remainder === undefined)
    throw new Error("Missing command migrations section");
  const section = remainder.split(/\n#{1,3} /, 1)[0];
  const targets: MigrationTarget[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `bun run ")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const replacement = cells[2] ?? "";
    const match = replacement.match(/^`([^`]+)`(?:\s|$)/);
    if (!match) continue; // Retired commands may have no executable replacement.
    const command = match[1];
    const cwdRun = command.match(/^bun run --cwd (\S+) ([^\s-]\S*)(?:\s|$)/);
    const rootRun = command.match(/^bun run ([^\s-]\S*)(?:\s|$)/);
    const bunTest = command.match(/^bun test ([^\s-]\S*)(?:\s|$)/);
    const nodeRun = command.match(/^node (\S+)/);
    if (cwdRun) {
      targets.push({ raw: command, packageDir: cwdRun[1], script: cwdRun[2] });
    } else if (rootRun) {
      targets.push({ raw: command, packageDir: ".", script: rootRun[1] });
    } else if (bunTest) {
      targets.push({ raw: command, packageDir: ".", testFile: bunTest[1] });
    } else if (nodeRun) {
      targets.push({ raw: command, packageDir: ".", testFile: nodeRun[1] });
    } else {
      throw new Error(`Unsupported migration command: ${command}`);
    }
  }
  return targets;
}

describe("root guide removed-command migrations", () => {
  const guide = readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
  const targets = parseMigrationTargets(guide);

  it("validates annotated replacements and commands with arguments", () => {
    const parsed = parseMigrationTargets(
      [
        "### Removed root command migrations",
        "| `bun run old` | `bun run test:plugin 'plugin-example'` (requires credentials) |",
        "| `bun run old-ui` | `bun run --cwd packages/app test:e2e` (requires browsers) |",
        "## Another table",
        "| `bun run unrelated` | `bun run unrelated` |",
      ].join("\n"),
    );
    expect(
      parsed.map(({ packageDir, script }) => ({ packageDir, script })),
    ).toEqual([
      { packageDir: ".", script: "test:plugin" },
      { packageDir: "packages/app", script: "test:e2e" },
    ]);
  });

  it("rejects executable replacements it cannot validate", () => {
    expect(() =>
      parseMigrationTargets(
        "### Removed root command migrations\n| `bun run old` | `bun run --filter foo test` |",
      ),
    ).toThrow("Unsupported migration command");
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
