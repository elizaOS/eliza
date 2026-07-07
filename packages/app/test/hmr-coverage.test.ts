/**
 * Unit tests for the Hmr Coverage app shell contract and coverage guardrail.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const VISUAL_MATRIX_SPEC = path.join(HERE, "ui-smoke", "plugin-view-cases.ts");
const HMR_SPEC = path.join(HERE, "hmr", "hmr-dependency-levels.spec.ts");
const DEV_SMOKE_WORKFLOW = path.join(
  REPO_ROOT,
  ".github/workflows/dev-smoke.yml",
);
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const APP_PACKAGE_JSON = path.join(REPO_ROOT, "packages/app/package.json");

// Documented non-workspace HMR probes: entries whose source file lives outside
// the workspace tree (so `probePathExists` legitimately fails) but that stay in
// the matrix. Empty now — the shopify + social-alpha plugin views were removed
// from the workspace (their probe levels dropped with them), and
// plugin-trajectory-logger's view source is back in the workspace tree.
const EXPECTED_NON_WORKSPACE_HMR_PROBES = new Set<string>([]);

type GuiViewCase = {
  id: string;
  path: string;
};

function readGuiVisualCases(): GuiViewCase[] {
  const source = readFileSync(VISUAL_MATRIX_SPEC, "utf8");
  const match = source.match(
    /const VIEW_CASES: ViewCase\[] = \(?\s*\[([\s\S]*?)\]\s*(?:satisfies[\s\S]*?)?\)?\s*\.map/,
  );
  expect(match?.[1], "VIEW_CASES declaration was not found").toBeTruthy();
  const viewCasesSource = match?.[1] ?? "";

  return Array.from(
    viewCasesSource.matchAll(
      /\["([^"]+)",\s*"gui",\s*"([^"]+)"(?:,\s*\{[^}]*\})?\]/g,
    ),
  ).flatMap((caseMatch) => {
    const id = caseMatch[1];
    const viewPath = caseMatch[2];
    if (!id || !viewPath) return [];
    return [{ id, path: viewPath }];
  });
}

function normalizedHmrViewId(name: string): string {
  const id = name.trim().replace(/\s+/g, "-");
  switch (id) {
    case "view-manager":
    case "manager":
      return "views-manager";
    default:
      return id;
  }
}

function readHmrViewLevels(): Array<{
  id: string;
  name: string;
  file: string;
}> {
  const source = readFileSync(HMR_SPEC, "utf8");
  return Array.from(
    source.matchAll(/name:\s*"plugin view ([^"]+)",\s*file:\s*"([^"]+)"/g),
  ).flatMap((match) => {
    const rawId = match[1];
    const file = match[2];
    if (!rawId || !file) return [];
    return [
      {
        id: normalizedHmrViewId(rawId),
        name: `plugin view ${rawId}`,
        file,
      },
    ];
  });
}

function readHmrRootGraphPluginViewNames(): Set<string> {
  const source = readFileSync(HMR_SPEC, "utf8");
  const match = source.match(
    /const PLUGIN_VIEWS_IN_ROOT_GRAPH = new Set<string>\(\[([\s\S]*?)\]\);/,
  );
  expect(
    match?.[1],
    "PLUGIN_VIEWS_IN_ROOT_GRAPH declaration was not found",
  ).toBeTruthy();
  const rootGraphSource = match?.[1] ?? "";
  return new Set(
    Array.from(rootGraphSource.matchAll(/"(plugin view [^"]+)"/g)).map(
      (entry) => entry[1],
    ),
  );
}

function readWorkflowJobBlock(workflow: string, jobName: string): string {
  const match = workflow.match(
    new RegExp(
      `\\n  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|\\n*$)`,
    ),
  );
  expect(
    match?.[1],
    `${jobName} job was not found in dev-smoke.yml`,
  ).toBeTruthy();
  return match?.[1] ?? "";
}

function probePathExists(repoRelativePath: string): boolean {
  if (existsSync(path.join(REPO_ROOT, repoRelativePath))) {
    return true;
  }
  const result = spawnSync(
    "git",
    ["cat-file", "-e", `HEAD:${repoRelativePath}`],
    {
      cwd: REPO_ROOT,
      stdio: "ignore",
    },
  );
  return result.status === 0;
}

describe("plugin view HMR coverage", () => {
  it("keeps the HMR source-probe matrix in lockstep with every GUI view", () => {
    const guiCases = readGuiVisualCases();
    const hmrLevels = readHmrViewLevels();
    const rootGraphPluginViews = readHmrRootGraphPluginViewNames();
    const guiById = new Map(guiCases.map((view) => [view.id, view]));
    const hmrById = new Map(hmrLevels.map((level) => [level.id, level]));

    const missing = guiCases
      .filter((view) => !hmrById.has(view.id))
      .map((view) => `${view.id} ${view.path}`);
    const stale = hmrLevels
      .filter((level) => !guiById.has(level.id))
      .map((level) => `${level.id} ${level.file}`);
    const missingFiles = hmrLevels
      .filter((level) => !probePathExists(level.file))
      .map((level) => `${level.id} ${level.file}`);
    const unexpectedMissingFiles = missingFiles.filter(
      (entry) => !EXPECTED_NON_WORKSPACE_HMR_PROBES.has(entry),
    );
    const resolvedNonWorkspaceDebt = Array.from(
      EXPECTED_NON_WORKSPACE_HMR_PROBES,
    ).filter((entry) => !missingFiles.includes(entry));
    const unknownRootGraphEntries = Array.from(rootGraphPluginViews).filter(
      (name) => !hmrLevels.some((level) => level.name === name),
    );
    const missingRootGraphFiles = hmrLevels
      .filter((level) => rootGraphPluginViews.has(level.name))
      .filter((level) => !probePathExists(level.file))
      .map((level) => `${level.id} ${level.file}`);

    expect(missing, "Add HMR source probes for new GUI views.").toEqual([]);
    expect(
      stale,
      "Remove HMR probes for removed or renamed GUI views.",
    ).toEqual([]);
    expect(
      unexpectedMissingFiles,
      "HMR source probe file paths must exist unless explicitly documented as a non-workspace plugin.",
    ).toEqual([]);
    expect(
      resolvedNonWorkspaceDebt,
      "Remove restored plugin probes from EXPECTED_NON_WORKSPACE_HMR_PROBES.",
    ).toEqual([]);
    expect(
      unknownRootGraphEntries,
      "PLUGIN_VIEWS_IN_ROOT_GRAPH entries must match HMR probe names.",
    ).toEqual([]);
    expect(
      missingRootGraphFiles,
      "Root-graph HMR probes must never target missing files.",
    ).toEqual([]);
  });

  it("keeps the HMR browser gate wired into CI", () => {
    const rootPackage = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const appPackage = JSON.parse(readFileSync(APP_PACKAGE_JSON, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const workflow = readFileSync(DEV_SMOKE_WORKFLOW, "utf8");
    const hmrJob = readWorkflowJobBlock(workflow, "hmr");

    expect(rootPackage.scripts?.["test:hmr"]).toContain(
      "packages/app test:hmr",
    );
    expect(appPackage.scripts?.["test:hmr"]).toContain(
      "playwright.hmr.config.ts",
    );
    expect(hmrJob).toContain("name: Vite HMR dependency-level smoke");
    expect(hmrJob).toContain("needs: changes");
    expect(hmrJob).toContain(
      "if: github.event_name != 'pull_request' || needs.changes.outputs.dev_smoke == 'true'",
    );
    expect(hmrJob).toContain("run: bun run test:hmr");
    expect(hmrJob).toContain("name: hmr-results");
    expect(hmrJob).toContain("packages/app/playwright-report/");
    expect(hmrJob).toContain("packages/app/test-results/hmr/");
  });
});
