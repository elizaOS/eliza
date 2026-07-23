/**
 * Guards the builtin view mutation ratchet: first-party pages with local
 * mutation controls must have semantic action coverage, while diagnostic views
 * stay explicitly exempt.
 *
 * The registered-action set is scanned live from source (the same
 * `registered-action-inventory` scanner the action-catalog generator and the
 * repo-level view->action ratchet use, #14369) unioned with the canonical
 * prompt-spec names, so a renamed/deleted action fails this test instead of
 * silently passing against a hand-maintained list — the drift class that
 * mis-filed #14365/#14366/#14367.
 *
 * The completeness sweep (#16944) walks the real pages directory, so a new
 * mutating shell page fails here until it is baseline-mapped or exempted.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRegisteredActionInventory } from "../../../prompts/scripts/registered-action-inventory.js";
import {
  BUILTIN_VIEW_MUTATION_BASELINE,
  SHELL_PAGE_SWEEP_EXEMPTIONS,
  validateBuiltinViewMutationCoverage,
  validateShellPageSweepCompleteness,
} from "./builtin-view-action-ratchet";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

/** Canonical spec names cover REPLY-style actions whose `name:` is spec-derived. */
function canonicalSpecActionNames(): string[] {
  const specsDir = path.join(repoRoot, "packages/prompts/specs/actions");
  const names: string[] = [];
  for (const file of readdirSync(specsDir)) {
    if (!file.endsWith(".json")) continue;
    const spec = JSON.parse(
      readFileSync(path.join(specsDir, file), "utf8"),
    ) as { actions?: { name?: unknown }[] };
    for (const item of spec.actions ?? []) {
      if (typeof item.name === "string") names.push(item.name);
    }
  }
  return names;
}

const REGISTERED_ACTIONS = new Set([
  ...collectRegisteredActionInventory(repoRoot).map((entry) => entry.name),
  ...canonicalSpecActionNames(),
]);

function readRepoSource(sourcePath: string): string {
  return readFileSync(path.join(repoRoot, sourcePath), "utf8");
}

const PAGES_DIR = "packages/ui/src/components/pages";

/**
 * Enumerates every shell page module the completeness sweep must account for:
 * .ts/.tsx sources under the pages directory, recursive, minus tests, stories,
 * and the Playwright __e2e__ harness.
 */
function collectShellPageFiles(relDir: string = PAGES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, relDir))) {
    const rel = `${relDir}/${entry}`;
    if (statSync(path.join(repoRoot, rel)).isDirectory()) {
      if (entry === "__e2e__") continue;
      out.push(...collectShellPageFiles(rel));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(test|stories)\.(ts|tsx)$/.test(entry) || entry.endsWith(".d.ts")) {
      continue;
    }
    out.push(rel);
  }
  return out;
}

describe("builtin view action ratchet (#14369)", () => {
  it("passes for the current builtin mutation baseline", () => {
    const result = validateBuiltinViewMutationCoverage({
      readSource: readRepoSource,
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewId: "tasks",
          semanticActions: ["SCHEDULED_TASKS"],
        }),
        expect.objectContaining({
          viewId: "plugins-page",
          semanticActions: [
            "APP",
            "SETTINGS",
            "PLUGIN",
            "SECRETS",
            "RUNTIME",
            "CONNECTOR",
          ],
        }),
        expect.objectContaining({
          viewId: "memories",
          semanticActions: ["MEMORY"],
        }),
        expect.objectContaining({
          viewId: "automations",
          semanticActions: ["SCHEDULED_TASKS", "TRIGGER"],
        }),
        expect.objectContaining({
          viewId: "logs",
          exempt: true,
        }),
      ]),
    );
  });

  it("fails when a builtin view gains an unmapped local mutation", () => {
    const tasks = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "tasks",
    );
    if (!tasks) throw new Error("tasks baseline entry missing");
    const sourceWithNewButton = `${readRepoSource(tasks.sourceFiles[0])}
      export function InjectedLocalOnlyButton() {
        return <button onClick={() => window.localStorage.setItem("x", "1")}>Local only</button>;
      }
    `;

    const result = validateBuiltinViewMutationCoverage({
      baseline: [tasks],
      readSource: () => sourceWithNewButton,
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "tasks",
        code: "new-local-mutation",
      }),
    ]);
  });

  it.each(["documents", "files", "memories", "automations", "triggers"])(
    "fails when the %s view gains an unmapped local mutation",
    (viewId) => {
      const entry = BUILTIN_VIEW_MUTATION_BASELINE.find(
        (candidate) => candidate.viewId === viewId,
      );
      if (!entry) throw new Error(`${viewId} baseline entry missing`);
      // Real page sources plus one synthetic local-only handler on the first
      // file — the exact regression class the ratchet exists to catch.
      const injected = `${readRepoSource(entry.sourceFiles[0])}
        export function InjectedLocalOnlyButton() {
          return <button onClick={() => window.localStorage.setItem("x", "1")}>Local only</button>;
        }
      `;
      const readSource = (sourcePath: string) =>
        sourcePath === entry.sourceFiles[0]
          ? injected
          : readRepoSource(sourcePath);

      const result = validateBuiltinViewMutationCoverage({
        baseline: [entry],
        readSource,
        registeredActions: REGISTERED_ACTIONS,
      });

      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        expect.objectContaining({ viewId, code: "new-local-mutation" }),
      ]);
    },
  );

  it("fails when a non-exempt builtin mapping references an unregistered action", () => {
    const result = validateBuiltinViewMutationCoverage({
      baseline: [
        {
          viewId: "synthetic",
          sourceFiles: ["synthetic.tsx"],
          semanticActions: ["MISSING_ACTION"],
          maxMutationSites: 1,
        },
      ],
      readSource: () => "<button onClick={save}>Save</button>",
      registeredActions: REGISTERED_ACTIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "synthetic",
        code: "missing-semantic-action",
      }),
    ]);
  });
});

describe("shell page baseline-completeness sweep (#16944)", () => {
  const realPageFiles = collectShellPageFiles();

  it("accounts for every real shell page module", () => {
    const result = validateShellPageSweepCompleteness({
      pageFiles: realPageFiles,
      readSource: readRepoSource,
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    // The sweep only means something if it actually enumerated the shell
    // pages: guard against the walk silently returning an empty/near-empty
    // list (wrong dir, over-aggressive filters).
    expect(realPageFiles.length).toBeGreaterThan(50);
    const mutating = result.inventory.filter((row) => row.mutationSites > 0);
    expect(mutating.length).toBeGreaterThan(30);
    for (const row of mutating) {
      expect(row.coveredBy != null || row.exempt).toBe(true);
    }
  });

  it("fails with an actionable message when an unlisted mutating page ships", () => {
    const syntheticPage = `${PAGES_DIR}/BrandNewLocalOnlyView.tsx`;
    const result = validateShellPageSweepCompleteness({
      pageFiles: [...realPageFiles, syntheticPage],
      readSource: (sourcePath) =>
        sourcePath === syntheticPage
          ? '<button onClick={() => window.localStorage.setItem("x", "1")}>Local only</button>'
          : readRepoSource(sourcePath),
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        sourceFile: syntheticPage,
        code: "unmapped-mutating-page",
        message: expect.stringContaining("BUILTIN_VIEW_MUTATION_BASELINE"),
      }),
    ]);
  });

  it("fails when an exemption points at a file the sweep no longer sees", () => {
    const result = validateShellPageSweepCompleteness({
      pageFiles: realPageFiles,
      exemptions: [
        ...SHELL_PAGE_SWEEP_EXEMPTIONS,
        { sourceFile: `${PAGES_DIR}/DeletedView.tsx`, reason: "gone" },
      ],
      readSource: readRepoSource,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        sourceFile: `${PAGES_DIR}/DeletedView.tsx`,
        code: "stale-exemption",
      }),
    ]);
  });

  it("fails when an exempt file stops mutating (exemption must be removed)", () => {
    const exemptFile = SHELL_PAGE_SWEEP_EXEMPTIONS[0].sourceFile;
    const result = validateShellPageSweepCompleteness({
      pageFiles: realPageFiles,
      readSource: (sourcePath) =>
        sourcePath === exemptFile
          ? "export const nowInert = true;"
          : readRepoSource(sourcePath),
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        sourceFile: exemptFile,
        code: "stale-exemption",
      }),
    ]);
  });

  it("fails when a file is both baseline-covered and exempt", () => {
    const covered = "packages/ui/src/components/pages/FilesView.tsx";
    const result = validateShellPageSweepCompleteness({
      pageFiles: realPageFiles,
      exemptions: [
        ...SHELL_PAGE_SWEEP_EXEMPTIONS,
        { sourceFile: covered, reason: "double-booked" },
      ],
      readSource: readRepoSource,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        sourceFile: covered,
        code: "conflicting-exemption",
      }),
    ]);
  });
});
