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
const REGISTERED_VIEWS = new Set(["cloud-apps"]);

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
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.coverage).toEqual(
      expect.arrayContaining([
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
          viewId: "tasks",
          observedMutationSites: 26,
          semanticActions: ["SCHEDULED_TASKS", "APP", "VIEWS"],
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
    // Append an unmapped control to each REAL source so the named-affordance
    // inventory still matches and the only drift is the injected mutation.
    const injectedButton = `
      export function InjectedLocalOnlyButton() {
        return <button onClick={() => window.localStorage.setItem("x", "1")}>Local only</button>;
      }
    `;

    const result = validateBuiltinViewMutationCoverage({
      baseline: [tasks],
      readSource: (path) => `${readRepoSource(path)}${injectedButton}`,
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    // The injected-button source replaces EVERY file of the consolidated tasks
    // entry, so the named-affordance inventory also drifts; the ratchet must at
    // minimum flag the unmapped local mutation.
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewId: "tasks",
          code: "new-local-mutation",
        }),
      ]),
    );
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
        registeredViews: REGISTERED_VIEWS,
      });

      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        expect.objectContaining({ viewId, code: "new-local-mutation" }),
      ]);
    },
  );

  it("fails with stale-baseline when observed drops below the pinned count (#16951)", () => {
    const automations = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "automations",
    );
    if (!automations) throw new Error("automations baseline entry missing");
    // Blank one file of the multi-file aggregate: the remaining files land
    // below the pinned total, which must surface as a stale baseline rather
    // than silently accruing headroom for future local-only mutations.
    const readSource = (sourcePath: string) =>
      sourcePath === automations.sourceFiles[0]
        ? "export const nowInert = true;"
        : readRepoSource(sourcePath);

    const result = validateBuiltinViewMutationCoverage({
      baseline: [automations],
      readSource,
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "automations",
        code: "stale-baseline",
        message: expect.stringContaining("pin maxMutationSites"),
      }),
    ]);
  });

  it("reports only missing-source when a baseline file cannot be read", () => {
    const automations = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "automations",
    );
    if (!automations) throw new Error("automations baseline entry missing");
    // With a file unreadable the partial count is meaningless, so the
    // stale-baseline check must stay quiet instead of piling on.
    const result = validateBuiltinViewMutationCoverage({
      baseline: [automations],
      readSource: (sourcePath) =>
        sourcePath === automations.sourceFiles[0]
          ? null
          : readRepoSource(sourcePath),
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "automations",
        code: "missing-source",
      }),
    ]);
  });

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
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "synthetic",
        code: "missing-semantic-action",
      }),
    ]);
  });

  it("inventories every direct and mounted Projects apps-segment mutation with explicit authority", () => {
    const myApps = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "tasks",
    );
    if (!myApps?.mutationAffordances) {
      throw new Error("tasks mutation inventory missing");
    }

    const claimedByFile = new Map<string, number>();
    for (const affordance of myApps.mutationAffordances) {
      claimedByFile.set(
        affordance.sourceFile,
        (claimedByFile.get(affordance.sourceFile) ?? 0) + 1,
      );
    }

    expect(Object.fromEntries(claimedByFile)).toEqual({
      "packages/ui/src/components/pages/TasksPageView.tsx": 3,
      "packages/ui/src/components/settings/AppsManagementSection.tsx": 23,
    });
    expect(
      myApps.mutationAuthorities?.map((authority) => ({
        action: authority.semanticAction,
        operations: [...authority.actionOperations],
      })),
    ).toEqual([
      {
        action: "APP",
        operations: [
          "create",
          "launch",
          "list",
          "load_from_directory",
          "relaunch",
          "stop",
        ],
      },
      { action: "VIEWS", operations: ["show"] },
      { action: "SCHEDULED_TASKS", operations: ["list"] },
    ]);
    expect(myApps.mountedSourceFiles).toEqual([
      expect.objectContaining({
        sourceFile:
          "packages/ui/src/components/settings/AppsManagementSection.tsx",
        mountedBy: "packages/ui/src/components/pages/TasksPageView.tsx",
      }),
    ]);
    expect(
      myApps.mutationAffordances.find(
        (affordance) => affordance.id === "cloud-apps.open",
      )?.viewTarget,
    ).toEqual({
      id: "cloud-apps",
      sourceSignature:
        '.find((page) => page.id === "cloud-apps")?.path ?? null',
    });
  });

  it("fails when the VIEWS.show target is absent from the server view registry", () => {
    const myApps = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "tasks",
    );
    if (!myApps) throw new Error("tasks baseline entry missing");
    const withoutCloudApps = new Set(
      [...REGISTERED_VIEWS].filter((viewId) => viewId !== "cloud-apps"),
    );

    const result = validateBuiltinViewMutationCoverage({
      baseline: [myApps],
      readSource: readRepoSource,
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: withoutCloudApps,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "tasks",
        code: "mutation-view-target-drift",
        message: expect.stringContaining("registered server view inventory"),
      }),
    ]);
  });

  it("fails when the Cloud Apps control stops selecting its declared view target", () => {
    const myApps = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "tasks",
    );
    if (!myApps) throw new Error("tasks baseline entry missing");
    const page = "packages/ui/src/components/pages/TasksPageView.tsx";
    const source = readRepoSource(page).replace(
      '.find((page) => page.id === "cloud-apps")?.path ?? null',
      '.find((page) => page.id === "cloud-deployments")?.path ?? null',
    );

    const result = validateBuiltinViewMutationCoverage({
      baseline: [myApps],
      readSource: (sourcePath) =>
        sourcePath === page ? source : readRepoSource(sourcePath),
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "tasks",
        code: "mutation-view-target-drift",
      }),
    ]);
  });

  it("fails when the mounted app-management child gains an uninventoried mutation", () => {
    const myApps = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "tasks",
    );
    if (!myApps) throw new Error("tasks baseline entry missing");
    const child =
      "packages/ui/src/components/settings/AppsManagementSection.tsx";
    const injected = `${readRepoSource(child)}
      export function InjectedAppMutation() {
        return <button onClick={() => window.localStorage.setItem("x", "1")}>Local only</button>;
      }
    `;

    const result = validateBuiltinViewMutationCoverage({
      baseline: [myApps],
      readSource: (sourcePath) =>
        sourcePath === child ? injected : readRepoSource(sourcePath),
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewId: "tasks",
          code: "new-local-mutation",
        }),
        expect.objectContaining({
          viewId: "tasks",
          code: "mutation-inventory-count",
          message: expect.stringContaining("add or remove named operations"),
        }),
      ]),
    );
  });

  it("fails when a named Projects apps-segment operation drifts away from its source", () => {
    const myApps = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "tasks",
    );
    if (!myApps) throw new Error("tasks baseline entry missing");
    const page = "packages/ui/src/components/pages/TasksPageView.tsx";
    const source = readRepoSource(page).replace(
      "onClick={() => navigateBrowserPath(cloudStudioPath)}",
      "onClick={() => navigateBrowserPath(String(cloudStudioPath))}",
    );

    const result = validateBuiltinViewMutationCoverage({
      baseline: [myApps],
      readSource: (sourcePath) =>
        sourcePath === page ? source : readRepoSource(sourcePath),
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "tasks",
        code: "mutation-signature-drift",
        message: expect.stringContaining("cloud-apps.open"),
      }),
    ]);
  });

  it("fails closed when a named Projects apps-segment affordance lacks operation authority", () => {
    const myApps = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "tasks",
    );
    if (!myApps?.mutationAffordances) {
      throw new Error("tasks mutation inventory missing");
    }
    const [first, ...rest] = myApps.mutationAffordances;
    if (!first) throw new Error("tasks mutation inventory is empty");

    const result = validateBuiltinViewMutationCoverage({
      baseline: [
        {
          ...myApps,
          mutationAffordances: [{ ...first, actionOperations: [] }, ...rest],
        },
      ],
      readSource: readRepoSource,
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewId: "tasks",
          code: "mutation-action-drift",
          message: expect.stringContaining("has no declared authority"),
        }),
      ]),
    );
  });

  it("fails when the mounted Projects apps-segment child is no longer mounted", () => {
    const myApps = BUILTIN_VIEW_MUTATION_BASELINE.find(
      (entry) => entry.viewId === "tasks",
    );
    if (!myApps) throw new Error("tasks baseline entry missing");
    const page = "packages/ui/src/components/pages/TasksPageView.tsx";
    const source = readRepoSource(page).replace(
      "<AppsManagementSection />",
      "<div />",
    );

    const result = validateBuiltinViewMutationCoverage({
      baseline: [myApps],
      readSource: (sourcePath) =>
        sourcePath === page ? source : readRepoSource(sourcePath),
      registeredActions: REGISTERED_ACTIONS,
      registeredViews: REGISTERED_VIEWS,
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        viewId: "tasks",
        code: "mutation-mount-drift",
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
