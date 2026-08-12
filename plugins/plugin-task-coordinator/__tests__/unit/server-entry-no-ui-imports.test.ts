/**
 * Regression contract: the server-side plugin entry (`src/index.ts` →
 * `dist/index.js`) must not statically import any browser-only React components
 * or `@elizaos/ui` modules. The headless cloud agent image loads
 * `dist/index.js` in Node, and the Dockerfile deliberately excludes the
 * `@elizaos/ui` radix/three/recharts tree from the runtime-dep closure. A
 * transitive `@radix-ui/react-slot` import through a re-exported GUI component
 * crashes the plugin at boot with `Cannot find package '@radix-ui/react-slot'`
 * (issues #18031, #18347).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY_PATH = resolve(__dirname, "../../src/index.ts");

/** Browser-only modules that must stay out of the server entry static graph. */
const BROWSER_ONLY_MODULES = [
  "ProjectSwitcher",
  "CodingAgentTasksPanel",
  "CodingAgentControlChip",
  "CodingAgentSettingsSection",
  "OrchestratorView",
  "OrchestratorWorkbench",
  "CockpitRoute",
  "CockpitSessionPane",
  "CockpitInteractiveTerminal",
  "TaskCoordinatorView",
  "PtyConsoleBase",
  "register-slots",
  "register",
  "ui",
  "task-coordinator-view-bundle",
] as const;

/** Side-effect or barrel imports that pull browser UI into the server entry. */
const BROWSER_ONLY_PATHS = [
  "./components/",
  "./register-slots",
  "./register",
  "./ui",
  "./task-coordinator-view-bundle",
] as const;

function relativeImportPattern(moduleName: string): RegExp {
  const escaped = moduleName.replaceAll(".", String.raw`\.`);
  return new RegExp(
    String.raw`(?:import|export)\s+(?:\*|\{[^}]*\})?\s*(?:type\s+)?(?:[^"'\n]*\s+from\s+)?["']\.\/${escaped}(?:\.(?:tsx?|jsx?))?["']`,
  );
}

function sideEffectImportPattern(moduleName: string): RegExp {
  const escaped = moduleName.replaceAll(".", String.raw`\.`);
  return new RegExp(String.raw`import\s+["']\.\/${escaped}(?:\.(?:tsx?|jsx?))?["']`);
}

function starExportPattern(moduleName: string): RegExp {
  const escaped = moduleName.replaceAll(".", String.raw`\.`);
  return new RegExp(
    String.raw`export\s+\*\s+from\s+["']\.\/${escaped}(?:\.(?:tsx?|jsx?))?["']`,
  );
}

describe("server entry — no browser/UI imports (#18031, #18347)", () => {
  const source = readFileSync(ENTRY_PATH, "utf8");

  it("does not re-export browser-only components by name", () => {
    for (const moduleName of BROWSER_ONLY_MODULES) {
      expect(source, `named re-export of ${moduleName}`).not.toMatch(
        relativeImportPattern(moduleName),
      );
    }
  });

  it("does not star-export browser-only modules", () => {
    for (const moduleName of BROWSER_ONLY_MODULES) {
      expect(source, `export * from ./${moduleName}`).not.toMatch(
        starExportPattern(moduleName),
      );
    }
  });

  it("does not side-effect import browser-only modules", () => {
    for (const moduleName of BROWSER_ONLY_MODULES) {
      expect(source, `import "./${moduleName}"`).not.toMatch(
        sideEffectImportPattern(moduleName),
      );
    }
  });

  it("does not import or export .tsx view components from relative paths", () => {
    expect(source).not.toMatch(
      /(?:import|export)\s+(?:\*|\{[^}]*\})?\s*(?:type\s+)?(?:[^"'\n]*\s+from\s+)?["']\.\/[^"']+\.tsx["']/,
    );
  });

  it("does not import browser-only barrel paths", () => {
    for (const path of BROWSER_ONLY_PATHS) {
      const escaped = path.replaceAll("/", String.raw`\/`).replaceAll(".", String.raw`\.`);
      expect(source, `import from ${path}`).not.toMatch(
        new RegExp(String.raw`(?:import|export)\s+[^"']*["']${escaped}`),
      );
    }
  });

  it("does not import from @elizaos/ui", () => {
    expect(source).not.toMatch(/from\s+["']@elizaos\/ui/);
  });

  it("does not import React or react-dom", () => {
    expect(source).not.toMatch(/from\s+["']react(?:-dom)?["']/);
  });
});
