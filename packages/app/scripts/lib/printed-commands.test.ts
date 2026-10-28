/**
 * Guard for commands the app prints at a user who is already stuck.
 *
 * `bun run start:desktop` (the Windows desktop repair banner) and
 * `bun run build-views` (the view-bundle HTTP hint) each named a script that no
 * package.json in this repository defines, so following the printed repair
 * answered with `error: Script not found "<name>"` - one failure replaced by
 * another. `bun run verify` stayed green with both in place: audit-scripts.ts
 * scopes itself to the root scripts block and never reads printed strings.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWindowsRepairSteps } from "./desktop-preflight.ts";
import { resolveElizaWorkspaceRootFromImportMeta } from "./repo-root.ts";

const repoRoot = resolveElizaWorkspaceRootFromImportMeta(import.meta.url);

function rootScriptNames(): Set<string> {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  return new Set(Object.keys(manifest.scripts ?? {}));
}

/** Every `bun run <script>` a piece of printed text tells the user to run. */
function printedScriptTargets(text: string): string[] {
  return Array.from(
    text.matchAll(/bun run (?:--cwd [^\s]+ )?([A-Za-z0-9:_-]+)/g),
    (match) => match[1],
  );
}

/** Every `node <path>` a piece of printed text tells the user to run. */
function printedNodeTargets(text: string): string[] {
  return Array.from(
    text.matchAll(/\bnode ([^\s"'`]+\.(?:ts|mjs|cjs|js))/g),
    (match) => match[1],
  );
}

describe("printed remediation commands", () => {
  it("names only scripts the root package.json defines", () => {
    const defined = rootScriptNames();
    for (const step of buildWindowsRepairSteps()) {
      for (const target of printedScriptTargets(step)) {
        expect(defined.has(target), `${step} -> ${target}`).toBe(true);
      }
    }
  });

  it("names only node entry points that exist on disk", () => {
    for (const step of buildWindowsRepairSteps()) {
      for (const target of printedNodeTargets(step)) {
        expect(existsSync(join(repoRoot, target)), `${step} -> ${target}`).toBe(
          true,
        );
      }
    }
  });

  it("keeps the repair steps a complete numbered sequence", () => {
    const steps = buildWindowsRepairSteps();
    expect(steps[0]).toBe("Repair steps (Windows):");
    expect(steps.slice(1).map((step) => step.split(".")[0])).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("keeps the view-bundle hint on a command the repository defines", () => {
    const stubSource = readFileSync(
      join(
        repoRoot,
        "packages",
        "app",
        "scripts",
        "playwright-ui-smoke-api-stub.ts",
      ),
      "utf8",
    );
    const targets = printedScriptTargets(stubSource);
    expect(targets.length).toBeGreaterThan(0);
    const defined = rootScriptNames();
    for (const target of targets) {
      expect(defined.has(target), target).toBe(true);
    }
  });
});
