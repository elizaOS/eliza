import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const VISUAL_MATRIX_SPEC = path.join(HERE, "ui-smoke", "plugin-view-cases.ts");
const HMR_SPEC = path.join(HERE, "hmr", "hmr-dependency-levels.spec.ts");
const CI_WORKFLOW = path.join(REPO_ROOT, ".github/workflows/ci.yaml");
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const APP_PACKAGE_JSON = path.join(REPO_ROOT, "packages/app/package.json");

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
    case "defense":
      return "defense-of-the-agents";
    default:
      return id;
  }
}

function readHmrViewLevels(): Array<{ id: string; file: string }> {
  const source = readFileSync(HMR_SPEC, "utf8");
  return Array.from(
    source.matchAll(/name:\s*"plugin view ([^"]+)",\s*file:\s*"([^"]+)"/g),
  ).flatMap((match) => {
    const rawId = match[1];
    const file = match[2];
    if (!rawId || !file) return [];
    return [{ id: normalizedHmrViewId(rawId), file }];
  });
}

describe("plugin view HMR coverage", () => {
  it("keeps the HMR source-probe matrix in lockstep with every GUI view", () => {
    const guiCases = readGuiVisualCases();
    const hmrLevels = readHmrViewLevels();
    const guiById = new Map(guiCases.map((view) => [view.id, view]));
    const hmrById = new Map(hmrLevels.map((level) => [level.id, level]));

    const missing = guiCases
      .filter((view) => !hmrById.has(view.id))
      .map((view) => `${view.id} ${view.path}`);
    const stale = hmrLevels
      .filter((level) => !guiById.has(level.id))
      .map((level) => `${level.id} ${level.file}`);
    const missingFiles = hmrLevels
      .filter((level) => !existsSync(path.join(REPO_ROOT, level.file)))
      .map((level) => `${level.id} ${level.file}`);

    expect(guiCases.length).toBe(35);
    expect(hmrLevels.length).toBe(35);
    expect(missing, "Add HMR source probes for new GUI views.").toEqual([]);
    expect(
      stale,
      "Remove HMR probes for removed or renamed GUI views.",
    ).toEqual([]);
    expect(missingFiles, "HMR source probe file paths must exist.").toEqual([]);
  });

  it("keeps the HMR browser gate wired into CI", () => {
    const rootPackage = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const appPackage = JSON.parse(readFileSync(APP_PACKAGE_JSON, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const workflow = readFileSync(CI_WORKFLOW, "utf8");

    expect(rootPackage.scripts?.["test:hmr"]).toContain(
      "packages/app test:hmr",
    );
    expect(appPackage.scripts?.["test:hmr"]).toContain(
      "playwright.hmr.config.ts",
    );
    expect(workflow).toContain("bun run test:hmr");
  });
});
