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
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/merge-candidate-biome.yml",
);

describe("merge candidate Biome workflow", () => {
  test("checks the exact dispatched candidate with pinned repository commands", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8"));

    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.concurrency).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal GitHub Actions expression the workflow must use.
      group: "merge-candidate-biome-${{ github.run_id }}",
      "cancel-in-progress": false,
    });
    const job = workflow.jobs["candidate-tree"];
    const checkout = job.steps.find(
      (step: Record<string, unknown>) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/checkout@"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal GitHub Actions expression the checkout must use.
    expect(checkout.with.ref).toBe("${{ github.sha }}");
    expect(
      job.steps
        .map((step: Record<string, unknown>) => step.run)
        .filter(Boolean),
    ).toEqual([
      "bun run check:biome-version",
      "bun run lint:check",
      "bun run format:check",
    ]);
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
