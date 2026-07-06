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
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRegisteredActionInventory } from "../../../prompts/scripts/registered-action-inventory.js";
import {
  BUILTIN_VIEW_MUTATION_BASELINE,
  validateBuiltinViewMutationCoverage,
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
          semanticActions: ["APP", "SETTINGS", "PLUGIN", "SECRETS", "RUNTIME"],
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
