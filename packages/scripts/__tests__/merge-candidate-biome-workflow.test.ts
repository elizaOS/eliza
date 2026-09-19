/**
 * Proves the manual full-tree Biome diagnostic checks the dispatched SHA with
 * repository-pinned commands and rejects a planted bad file.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/ci.yml");

describe("merge candidate Biome workflow", () => {
  test("checks the exact dispatched candidate with pinned repository commands", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8"));

    expect(workflow.on).toEqual({
      workflow_call: null,
      workflow_dispatch: null,
    });
    const job = workflow.jobs.quality;
    const checkout = job.steps.find(
      (step: Record<string, unknown>) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/checkout@"),
    );
    expect(checkout.with.ref).toBeUndefined();
    expect(
      job.steps
        .map((step: Record<string, unknown>) => step.run)
        .filter(Boolean),
    ).toEqual(
      expect.arrayContaining(["bun run verify", "bun run format:check"]),
    );
  });

  test("the pinned Biome rejects a planted deliberately misformatted candidate", () => {
    const fixtureRoot = path.join(
      REPO_ROOT,
      "packages",
      "scripts",
      "__tests__",
      "merge-candidate-biome-",
    );
    mkdirSync(path.dirname(fixtureRoot), { recursive: true });
    const root = mkdtempSync(fixtureRoot);
    const sourceDir = path.join(root, "src");
    mkdirSync(sourceDir);
    const planted = path.join(sourceDir, "planted.ts");
    writeFileSync(planted, "export const candidate={nested:{value:1}}\n");

    try {
      const result = Bun.spawnSync([
        process.execPath,
        "x",
        "@biomejs/biome",
        "format",
        "--config-path",
        path.join(REPO_ROOT, "biome.json"),
        "--vcs-enabled=false",
        planted,
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "Formatter would have printed",
      );
      expect(result.stderr.toString()).not.toContain("No files were processed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
