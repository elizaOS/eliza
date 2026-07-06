/**
 * Guards the builtin view mutation ratchet: first-party pages with local
 * mutation controls must have semantic action coverage, while diagnostic views
 * stay explicitly exempt.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_VIEW_MUTATION_BASELINE,
  validateBuiltinViewMutationCoverage,
} from "./builtin-view-action-ratchet";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

const REGISTERED_ACTIONS = new Set([
  "APP",
  "BACKGROUND",
  "CHARACTER",
  "PLUGIN",
  "SECRETS",
  "MODEL_SWITCH",
  "RUNTIME",
  "SCHEDULED_TASKS",
  "SETTINGS",
  "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
  "VIEW_CHARACTER_ADD_STYLE_RULE",
  "VIEW_CHARACTER_FILL_BIO",
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
