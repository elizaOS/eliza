/**
 * Proves a UI-only source-catalog regression reaches the unconditional CI
 * quality job and makes the root verification command fail closed.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runI18nCheck } from "../../app-core/scripts/check-i18n.mjs";
import { CONFIGS, evaluate } from "../ci-path-gate.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface WorkflowStep {
  if?: string;
  name?: string;
  run?: string;
}

interface WorkflowJob {
  if?: string;
  steps?: WorkflowStep[];
}

describe("UI source-catalog CI gate", () => {
  test("routes a UI-only catalog change through unconditional root verification", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "eliza-i18n-ci-paths-"));
    const changedFilesPath = join(sandbox, "changed-files.txt");
    writeFileSync(changedFilesPath, "packages/ui/src/i18n/locales/en.json\n");

    try {
      const classification = evaluate(CONFIGS.test, {
        eventName: "pull_request",
        labels: "",
        changedFilesPath,
      });
      expect(classification.matchesByLane.get("client")).not.toHaveLength(0);
      expect(classification.matchesByLane.get("server")).toHaveLength(0);

      const workflow = Bun.YAML.parse(
        readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"),
      ) as { jobs?: Record<string, WorkflowJob> };
      const quality = workflow.jobs?.quality;
      expect(quality).toBeDefined();
      expect(quality?.if).toBeUndefined();
      expect(
        quality?.steps?.find((step) => step.name === "Repository verification"),
      ).toMatchObject({ run: "bun run verify" });

      const rootPackage = JSON.parse(
        readFileSync(join(repoRoot, "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> };
      expect(rootPackage.scripts?.verify).toContain("bun run check:i18n");
      expect(rootPackage.scripts?.["check:i18n"]).toBe(
        "node packages/app-core/scripts/check-i18n.mjs",
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("the wired checker rejects a used key missing from the source catalog", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "eliza-i18n-missing-key-"));
    const localeDir = join(sandbox, "locales");
    const sourceDir = join(sandbox, "src");
    const allowlistPath = join(sandbox, "allowlist.json");
    mkdirSync(localeDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(localeDir, "en.json"), "{}");
    writeFileSync(join(sourceDir, "view.tsx"), 't("catalog.missing");\n');
    writeFileSync(
      allowlistPath,
      JSON.stringify({ keys: [], prefixes: [], uncatalogued: [] }),
    );

    try {
      const result = runI18nCheck({
        repoRoot: sandbox,
        localeDir,
        scanDirs: [sourceDir],
        allowlistPath,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain(
        "en.json missing 1 key(s) used in source",
      );
      expect(result.errors.join("\n")).toContain("catalog.missing");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
